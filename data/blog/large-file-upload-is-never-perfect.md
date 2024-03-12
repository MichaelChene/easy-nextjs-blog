---
title: '大文件上传方案永远不完美'
date: '2024/03/12'
tags: ['文件上传', 'Web Worker', '性能优化']
draft: false
summary: '大文件上传需要处理分片、断点续传、秒传和并发控制。这里记录一套前端实现，包括 Worker 池计算分片哈希、Merkle 树生成文件标识、真实上传进度，以及按批读取文件来降低内存占用。'
images: ['/m-picture/large-file-upload/merkle-tree.jpg']
layout: PostLayout
---

大文件上传的难点往往在开始传输之前就出现了。浏览器需要先读取文件、计算标识，上传时要控制并发，中断后还得确认哪些分片已经保存。即使所有请求都成功，服务端仍有校验和合并工作要完成。

增加 Worker 能缩短计算时间，也会增加内存开销；减小分片能降低失败后的重传成本，也会带来更多请求。这套实现记录了这些取舍，包括分片与哈希、并发控制、进度展示，以及续传和合并过程中需要处理的边界。方案可以不断改进，具体参数仍要结合设备、网络和存储服务来定。

## 整体实现思路

先明确两个需要支持的能力，再把它们拆成可以独立实现的步骤。

1. 秒传。文件已经存在且当前用户有权引用时，直接返回可用的文件信息。

   - 服务端记录文件摘要、大小等元数据。
   - 客户端计算文件标识，连同元数据一起提交检查。
   - 服务端核对内容标识与访问权限，命中后复用已有文件。

2. 断点续传。上传意外中断后，继续传输尚未完成的部分。

   - 客户端将文件切成分片，服务端分别保存，再按顺序合并。
   - 恢复时查询服务端已确认的分片，只上传缺失或校验失败的部分。

## 实现中的几个重点

1. 根据上传事件更新进度，并区分发送、校验和合并阶段。
2. 使用 PromisePool 限制同时执行的上传任务数。
3. 通过 WorkerPool 复用 Web Worker，并行计算分片哈希。
4. 结合分片摘要与 Merkle 树生成文件标识，减少重复扫描文件的计算开销。
5. 将最终文件的组装交给 MinIO，减少业务服务处理大文件流的负担，同时校验分片顺序、大小和完成状态。

## 实现文件切片

`File → Blob[] → ArrayBuffer[]`

先调用 `File.slice()` 得到分片 Blob，再按哈希工具的输入要求读取为 ArrayBuffer。切片描述文件中的一段数据，读取则把这段数据准备成可以参与计算的缓冲区，两步需要分开考虑。

```ts
/**
 * 分割文件
 * @param file
 * @param baseSize 默认分块大小为 1MB
 * @private
 */
function sliceFile(file: File, baseSize = 1): Blob[] {
  const chunkSize = baseSize * 1024 * 1024 // 字节，baseSize 的单位为 MiB
  if (!Number.isFinite(baseSize) || baseSize <= 0) throw new Error('分片大小必须大于 0')
  const chunks: Blob[] = []
  let startPos = 0
  while (startPos < file.size) {
    chunks.push(file.slice(startPos, startPos + chunkSize))
    startPos += chunkSize
  }
  return chunks
}
```

读取分片有两种常见写法。需要兼容较老环境时，可以使用 FileReader；目标浏览器支持 `Blob.arrayBuffer()` 时，后者通常更简洁。性能差异应结合文件大小和运行环境实测。

```ts
/**
 * 将 File 转成 ArrayBuffer
 * 此处在主线程读取 ArrayBuffer，再通过 transfer list 转移到 Worker
 * @param chunks
 * @private
 */
async function getArrayBufFromBlobs(chunks: Blob[]): Promise<ArrayBuffer[]> {
  async function readAsArrayBuffer(file: Blob) {
    return new Promise<ArrayBuffer>((rs, rj) => {
      const fileReader = new FileReader()
      fileReader.onload = (e) => rs(e.target!.result as ArrayBuffer)
      fileReader.onerror = () => rj(fileReader.error)
      fileReader.onabort = () => rj(new Error('文件读取已取消'))
      fileReader.readAsArrayBuffer(file)
    })
  }
  return await Promise.all(chunks.map((chunk: Blob) => readAsArrayBuffer(chunk)))
}

/**
 * 功能同上但语法更简洁
 * @param chunks
 */
async function getArrayBufFromBlobsV2(chunks: Blob[]): Promise<ArrayBuffer[]> {
  return Promise.all(chunks.map((chunk) => chunk.arrayBuffer()))
}
```

`Blob.slice()` 本身通常比较轻量，真正需要控制的是读取分片和计算哈希时的资源占用。`arrayBuffer()` 的读取结果异步返回，但 Promise 本身不会把后续的同步计算搬到后台线程。

`File` 和 `Blob` 支持结构化克隆，可以通过 `postMessage` 发送给 Worker，并在 Worker 中读取。它们不能放进 transfer list，但不能据此断言底层文件数据一定会完整复制。这里选择先读取 `ArrayBuffer` 再转移其所有权，发送后原缓冲区会被分离，主线程暂时无法继续读取它。[可转移对象](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Transferable_objects)、[结构化克隆支持的类型](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Structured_clone_algorithm)

无论在哪个线程读取，一次性把所有分片转成 `ArrayBuffer` 都可能占用大量内存。内存上限与浏览器、设备和运行环境有关，不能用固定的 2 GB 作为判断标准。后面的分批读取会继续处理这个问题。

## 用 Worker 计算分片哈希

分片摘要可以用来核对某个位置的数据是否已经上传。每个分片都需要读取并计算，大文件的计算总量并不会因为切片而减少。长时间在主线程执行同步哈希，仍然可能影响界面响应。

因此，这里把计算交给 Web Worker。各分片的摘要可以独立计算，适合通过 Worker 池并行处理。ArrayBuffer 可以通过 transfer list 转移所有权，避免复制缓冲区内容。池负责复用 Worker，并限制同时处理的任务数。

文件较大时，逐片计算 MD5 仍可能耗时较长。下面也保留 CRC32 的实现，用于比较更轻量的分片校验方案。

CRC32 的十六进制表示通常为 8 位，MD5 为 32 位。CRC32 只有 32 位，碰撞风险更高，不能单独作为可靠的内容唯一标识；将 CRC32 结果组合成 Merkle 树，也无法消除叶子哈希已经发生的碰撞。秒传和数据完整性检查需要后端复核，不能只相信客户端提交的哈希。性能还取决于具体实现，JavaScript 中的 CRC32 不一定能直接利用 CPU 硬件指令。

### Web Worker

先实现计算 MD5 的 Worker。它接收一个 ArrayBuffer，通过 SparkMD5 得到分片摘要，再把结果与缓冲区一起发送回主线程。

```ts
// md5.worker.ts
/// <reference lib="webworker" />

import { WorkerMessage } from './util/worker-message'
import { WorkerLabelsEnum } from './types/worker-labels.enum'
import SparkMD5 from 'spark-md5'

addEventListener('message', ({ data }: { data: ArrayBuffer }) => {
  const hash = SparkMD5.ArrayBuffer.hash(data)

  postMessage(
    new WorkerMessage(WorkerLabelsEnum.DONE, {
      result: hash,
      chunk: data,
    }),
    [data] // 用于 transfer 的数据, 以避免结构化克隆
  )
})
```

CRC32 的 Worker 使用相同的消息格式，只替换计算摘要的函数。这样上层调度逻辑可以保持一致。

```ts
// crc32.worker.ts
/// <reference lib="webworker" />

import { getCrc, getCrcHex } from '../utils/upload-helper'
import { WorkerMessage } from './util/worker-message'
import { WorkerLabelsEnum } from './types/worker-labels.enum'

addEventListener('message', ({ data }: { data: ArrayBuffer }) => {
  const crc = getCrc(data)
  const hash = getCrcHex(crc)

  postMessage(
    new WorkerMessage(WorkerLabelsEnum.DONE, {
      result: hash,
      chunk: data,
    }),
    [data] // 用于 transfer 的数据, 以避免结构化克隆
  )
})
```

`WorkerMessage` 统一 Worker 返回消息的格式。

```ts
// WorkerMessage.ts
import { WorkerLabelsEnum } from '../types/worker-labels.enum'

export class WorkerMessage<T = any> {
  label: WorkerLabelsEnum
  content?: T

  constructor(label: WorkerLabelsEnum, content?: T) {
    this.label = label
    this.content = content
  }
}
```

`WorkerLabelsEnum` 标识消息类型，包装器据此判断任务是否完成。

```ts
// WorkerLabelsEnum.ts
export enum WorkerLabelsEnum {
  INIT,
  CHUNK,
  DONE,
}
```

`WorkerRep` 描述消息事件中 `data` 的类型，方便在接收端传入泛型。

```ts
// WorkerRep.ts
import { WorkerMessage } from './worker-message'
export interface WorkerRep<T = any> {
  data: WorkerMessage<T>
}
```

### 复用 Worker 并控制任务数量

使用 Worker Pool 来复用 Worker，而不是每次计算哈希都创建新 Worker。同一个池的 `exec` 按批串行调用，执行结束后取消本轮订阅；结果按原始下标保存，任一任务失败会在本批任务结束后使调用失败。

先用 `WorkerWrapper` 包装单个 Worker，通过 Promise 把消息回调转换成任务的完成或失败。

```ts
import { WorkerRep } from './worker-rep'
import { WorkerLabelsEnum } from '../types/worker-labels.enum'

export enum StatusEnum {
  RUNNING = 'running',
  WAITING = 'waiting',
}

export class WorkerWrapper {
  worker: Worker
  status: StatusEnum

  constructor(worker: Worker) {
    this.worker = worker
    this.status = StatusEnum.WAITING
  }

  run<T>(param: ArrayBuffer, params: ArrayBuffer[], index: number) {
    this.status = StatusEnum.RUNNING
    return new Promise<T>((rs, rj) => {
      this.worker.onmessage = ({ data }: WorkerRep<{ result: string; chunk: ArrayBuffer }>) => {
        const { label, content } = data
        if (label === WorkerLabelsEnum.DONE && content) {
          params[index] = content.chunk // 归还分片的所有权
          this.status = StatusEnum.WAITING
          rs(content.result as T)
        }
      }
      this.worker.onerror = (e) => {
        this.status = StatusEnum.WAITING
        rj(e)
      }
      this.worker.postMessage(param, [param]) // 用于 transfer 的数据, 以避免结构化克隆
    })
  }
}
```

再由 `WorkerPool` 管理这些包装器。当运行中的任务数低于上限，就从队列取出任务，交给空闲 Worker；任务结束后更新计数，继续调度。

这里使用 RxJS 的 BehaviorSubject 发布当前运行数量，也可以实现自己的发布订阅机制。

核心是 `subscribe()` 订阅和 `next()` 发布；这里额外通过 `takeUntil` 在任务结束时取消订阅，避免重复调用留下旧回调。

```ts
import { StatusEnum, WorkerWrapper } from './worker-wrapper'
import { BehaviorSubject, Subject, takeUntil } from 'rxjs'

export abstract class WorkerPool {
  pool: WorkerWrapper[] = []
  maxWorkerCount: number
  curRunningCount = new BehaviorSubject(0)
  results: any[] = []

  protected constructor(maxWorkers = navigator.hardwareConcurrency || 4) {
    if (!Number.isInteger(maxWorkers) || maxWorkers <= 0) throw new Error('Worker 数量必须为正整数')
    this.maxWorkerCount = maxWorkers
  }

  exec<T>(params: ArrayBuffer[]) {
    this.results.length = 0
    const workerParams = params.map((param, index) => ({ data: param, index }))

    const finished = new Subject<void>()
    const errors: unknown[] = []
    return new Promise<T[]>((rs, rj) => {
      this.curRunningCount.pipe(takeUntil(finished)).subscribe((count) => {
        if (count < this.maxWorkerCount && workerParams.length !== 0) {
          // 当前能跑的任务数量
          let curTaskCount = this.maxWorkerCount - count
          if (curTaskCount > workerParams.length) {
            curTaskCount = workerParams.length
          }

          // 此时可以用来执行任务的 Worker
          const canUseWorker: WorkerWrapper[] = []
          for (const worker of this.pool) {
            if (worker.status === StatusEnum.WAITING) {
              canUseWorker.push(worker)
              if (canUseWorker.length === curTaskCount) {
                break
              }
            }
          }

          const paramsToRun = workerParams.splice(0, curTaskCount)
          // 更新当前正在跑起来的 worker 数量

          this.curRunningCount.next(this.curRunningCount.value + curTaskCount)
          canUseWorker.forEach((workerApp, index) => {
            const param = paramsToRun[index]
            workerApp
              .run(param.data, params, param.index)
              .then((res) => {
                this.results[param.index] = res
              })
              .catch((e) => {
                errors.push(e)
              })
              .finally(() => {
                this.curRunningCount.next(this.curRunningCount.value - 1)
              })
          })
        }

        if (this.curRunningCount.value === 0 && workerParams.length === 0) {
          finished.next()
          finished.complete()
          if (errors.length > 0) rj(errors[0])
          else rs([...this.results] as T[])
        }
      })
    })
  }
}
```

`WorkerPoolForMd5s` 创建 MD5 Worker，共享前面的调度实现。

```ts
import { WorkerWrapper } from './util/worker-wrapper'
import { WorkerPool } from './util/worker-pool'

export class WorkerPoolForMd5s extends WorkerPool {
  constructor(maxWorkers: number) {
    super(maxWorkers)
    this.pool = Array.from({ length: this.maxWorkerCount }).map(
      () => new WorkerWrapper(new Worker(new URL('./md5.worker.ts', import.meta.url)))
    )
  }
}
```

`WorkerPoolForCrc32s` 则创建 CRC32 Worker，任务分配和结果收集方式相同。

```ts
import { WorkerPool } from './util/worker-pool'
import { WorkerWrapper } from './util/worker-wrapper'

export class WorkerPoolForCrc32s extends WorkerPool {
  constructor(maxWorkers = navigator.hardwareConcurrency || 4) {
    super(maxWorkers)
    this.pool = Array.from({ length: this.maxWorkerCount }).map(
      () => new WorkerWrapper(new Worker(new URL('./crc32.worker.ts', import.meta.url)))
    )
  }
}
```

### 在服务层复用计算池

业务调用通过 `WorkerService` 选择算法，并按需创建对应的池。

```ts
export class WorkerService {
  readonly MAX_WORKERS = 8
  md5SingleWorkerPool: WorkerPoolForMd5s | undefined
  crc32SingleWorkerPool: WorkerPoolForCrc32s | undefined

  // 计算所有分片的 MD5
  getMD5ForFiles(chunks: ArrayBuffer[]): Promise<string[]> {
    if (this.md5SingleWorkerPool === undefined) {
      this.md5SingleWorkerPool = new WorkerPoolForMd5s(this.MAX_WORKERS)
    }
    return this.md5SingleWorkerPool.exec<string>(chunks)
  }

  // 计算所有分片的 CRC32
  getCRC32ForFiles(chunks: ArrayBuffer[]): Promise<string[]> {
    if (this.crc32SingleWorkerPool === undefined) {
      this.crc32SingleWorkerPool = new WorkerPoolForCrc32s(this.MAX_WORKERS)
    }
    return this.crc32SingleWorkerPool.exec<string>(chunks)
  }
}
```

### Worker 的构建与生命周期

部分打包工具需要静态分析 `new Worker(new URL('./crc32.worker.ts', import.meta.url))` 这样的写法，才能识别 Worker 入口。把路径拆成运行时变量后可能无法生成正确的资源地址，需要按所用构建工具的规则配置。

同一个上传服务可以复用 `WorkerPoolForMd5s` 和 `WorkerPoolForCrc32s`，避免每次计算都创建一组 Worker。同一池的批次仍需串行执行，多个文件任务不能同时覆盖共享状态。服务结束使用时，还需要调用 `terminate()` 关闭池中的 Worker，并处理尚未完成的任务。

### 性能实测

硬件情况：Ryzen 9 5900HX + 32 GB DDR4。以下为当时环境下的记录，不代表所有设备的表现。
这组记录使用同一份约 1.8 GB 的文件，比较主线程与不同 Worker 数量计算分片 MD5 的耗时，每种方式执行两次。

```ini
计算 1.8GB 文件分片的 MD5
[主线程中直接算(单线程)]
14585.115966796875 ms
14066.404052734375 ms

8 线程 Web Worker
2174.992919921875 ms
2169.323974609375 ms

12 线程 Web Worker
1825.158935546875 ms
1878.386962890625 ms
```

按这组记录，8 个 Worker 的耗时约为单线程的 1/6.6，12 个 Worker 约为单线程的 1/7.7。增加线程仍有调度成本，适合结合设备性能设置上限。

另外一次记录中，5 GB 文件的标识计算耗时约为 3.5 秒。它属于分片哈希策略下的另一组测试，未完整记录读取耗时等计时边界，不能与上面的 MD5 数据直接比较，也不作为通用性能基准。

## 根据分片摘要生成文件标识

分片摘要计算完成后，还需要一个标识整个文件的值，用于检查是否可以秒传。直接计算标准文件 MD5，需要按原始字节顺序处理整个文件，无法通过简单拼接分片 MD5 得到相同结果。当时另一项测试中，约 1.8 GB 文件的整文件 MD5 计算耗时约 15 秒，这部分不包含分片摘要的计算时间。

这里有两种优化方向。可以使用 WebAssembly 等方式加速原有算法，也可以在上传协议允许的情况下，使用分片摘要构造 Merkle 树，以树根作为文件标识。下面采用后一种方式，具体约定需要由客户端和服务端共同遵守。

### Merkle 树的构造规则

每个叶子节点保存对应分片的哈希，父节点根据两个子节点的哈希继续计算，逐层得到 Merkle 树根。下面的实现遇到单独的末尾节点时，直接沿用它的哈希；客户端和服务端必须采用相同的构造规则。
![Merkle 树根据分片哈希逐层计算根哈希](/m-picture/large-file-upload/merkle-tree.jpg)

图中的 `hA` 到 `hH` 是各个分片的摘要，`hAB` 则由 `hA` 和 `hB` 继续计算得到。分片摘要已经准备好之后，构建树的过程只处理这些较短的摘要，不再读取整份文件，因此额外的计算量较小。整个流程的耗时仍然包括此前读取分片和计算叶子摘要的成本。

最后使用树根哈希作为这套上传协议中的文件标识。它依赖分片大小、叶子哈希算法和树的构造规则，不等于整个文件的标准 MD5；采用 CRC32 叶子时，仍然受叶子碰撞风险影响。

### Merkle 树的实现

下面使用 SparkMD5 计算父节点摘要，并提供序列化与反序列化方法。需要保存整棵树时，可以把序列化结果写入数据库；当前上传流程只使用树根。

```ts
import SparkMD5 from 'spark-md5'

// 定义 Merkle 树节点的接口
interface IMerkleNode {
  h: string
  l: IMerkleNode | null
  r: IMerkleNode | null
}

// 定义 Merkle 树的接口
interface IMerkleTree {
  root: IMerkleNode
  leafs: IMerkleNode[]
  // 你可以根据需要添加其他属性或方法，例如校验、添加和生成树等功能
}

// Merkle 树节点的类实现
class MerkleNode implements IMerkleNode {
  h: string
  l: IMerkleNode | null
  r: IMerkleNode | null

  constructor(hash: string, left: IMerkleNode | null = null, right: IMerkleNode | null = null) {
    this.h = hash
    this.l = left
    this.r = right
  }
}

// Merkle 树的类实现
export class MerkleTree implements IMerkleTree {
  root: IMerkleNode
  leafs: IMerkleNode[]

  constructor(hashList: string[])
  constructor(leafNodes: IMerkleNode[])
  constructor(nodes: string[] | IMerkleNode[]) {
    if (nodes.length === 0) {
      throw new Error('Empty Nodes')
    }
    if (typeof nodes[0] === 'string') {
      this.leafs = nodes.map((node) => new MerkleNode(node as string))
    } else {
      this.leafs = nodes as IMerkleNode[]
    }
    this.root = this.buildTree()
  }

  getRootHash() {
    return this.root.h
  }

  buildTree(): IMerkleNode {
    // 实现构建 Merkle 树的逻辑。根据叶子节点创建父节点，一直到根节点。
    let currentLevelNodes = this.leafs
    while (currentLevelNodes.length > 1) {
      const parentNodes: IMerkleNode[] = []
      for (let i = 0; i < currentLevelNodes.length; i += 2) {
        const left = currentLevelNodes[i]
        const right = i + 1 < currentLevelNodes.length ? currentLevelNodes[i + 1] : null
        // 具体的哈希计算方法
        const parentHash = this.calculateHash(left, right)
        parentNodes.push(new MerkleNode(parentHash, left, right))
      }
      currentLevelNodes = parentNodes
    }

    return currentLevelNodes[0] // 返回根节点
  }

  // 序列化 Merkle 树
  serialize(): string {
    const serializeNode = (node: IMerkleNode | null): any => {
      if (node === null) {
        return null
      }
      return {
        h: node.h,
        l: serializeNode(node.l),
        r: serializeNode(node.r),
      }
    }

    const serializedRoot = serializeNode(this.root)
    return JSON.stringify(serializedRoot)
  }

  // 反序列化 Merkle 树
  static deserialize(serializedTree: string): MerkleTree {
    const parsedData = JSON.parse(serializedTree)

    const deserializeNode = (data: any): IMerkleNode | null => {
      if (data === null) {
        return null
      }
      return new MerkleNode(data.h, deserializeNode(data.l), deserializeNode(data.r))
    }

    const root = deserializeNode(parsedData)
    if (!root) {
      throw new Error('Invalid serialized tree data')
    }

    // 创建一个包含所有叶子节点的数组，这是为了与 MerkleTree 的构造函数兼容
    // 没有保存这些叶子节点的序列化版本，所以这里需要一些额外的逻辑来处理
    // 如果你需要将整个树的所有节点存储为序列化版本，那么可能需要修改这部分逻辑
    const extractLeafNodes = (node: IMerkleNode): IMerkleNode[] => {
      if (node.l === null && node.r === null) {
        return [node]
      }
      return [
        ...(node.l ? extractLeafNodes(node.l) : []),
        ...(node.r ? extractLeafNodes(node.r) : []),
      ]
    }
    const leafNodes = extractLeafNodes(root)

    return new MerkleTree(leafNodes)
  }

  private calculateHash(left: IMerkleNode, right: IMerkleNode | null): string {
    return right ? SparkMD5.hash(left.h + right.h) : left.h
  }
}
```

### 取得树根作为文件标识

```ts
// chunksHash 为所有文件分片的 hash 数组
const merkleTree = new MerkleTree(chunksHash)
const fileHash = merkleTree.getRootHash()
```

## 文件分片的并发上传

### 目标

拿到文件和分片标识后，就可以查询缺失分片并开始上传。分片之间可以并行发送，但一次启动所有请求，容易增加浏览器与服务端的资源压力。

`Promise.all()` 负责汇总任务结果，不负责限制任务启动数量。并发控制需要作用于发起请求的时刻，因此先把上传操作封装成函数，再由 PromisePool 按上限调用。这样队列中的任务可以等待，只有获得名额后才真正发起请求。

### 实现

这里沿用 Worker 池的计数与调度思路，把计算任务换成异步上传函数。

接收一个 `() => Promise<any>` 数组作为任务。池实例按单次任务组使用，任务失败会在本组执行结束后向调用方抛出，避免把错误当作上传成功。

```ts
import { BehaviorSubject, Subject, takeUntil } from 'rxjs'

type AsyncFunction = () => Promise<any>

export class PromisePool {
  private readonly queue: { fn: AsyncFunction; index: number }[] = []
  private readonly maxConcurrentTasks: number
  private results: any[] = []

  curRunningCount = new BehaviorSubject(0)

  constructor(
    functions: AsyncFunction[],
    maxConcurrentTasks: number = navigator.hardwareConcurrency || 8
  ) {
    if (!Number.isInteger(maxConcurrentTasks) || maxConcurrentTasks <= 0) {
      throw new Error('并发数量必须为正整数')
    }
    this.queue = functions.map((fn, index) => ({ fn, index }))
    this.maxConcurrentTasks = maxConcurrentTasks
  }

  exec<T>() {
    const finished = new Subject<void>()
    const errors: unknown[] = []
    return new Promise<T[]>((rs, rj) => {
      this.curRunningCount.pipe(takeUntil(finished)).subscribe((count) => {
        if (count < this.maxConcurrentTasks && this.queue.length !== 0) {
          // 当前需要跑的任务数量
          let curTaskCount = this.maxConcurrentTasks - count
          if (curTaskCount > this.queue.length) {
            curTaskCount = this.queue.length
          }
          // 当前要跑的任务
          const tasks = this.queue.splice(0, curTaskCount)
          this.curRunningCount.next(this.curRunningCount.value + curTaskCount)
          // 执行任务
          tasks.forEach((taskWrap) => {
            const { fn, index } = taskWrap
            Promise.resolve()
              .then(fn)
              .then((result) => {
                this.results[index] = result
              })
              .catch((error) => {
                errors.push(error)
              })
              .finally(() => this.curRunningCount.next(this.curRunningCount.value - 1))
          })
        }

        if (this.curRunningCount.value === 0 && this.queue.length === 0) {
          finished.next()
          finished.complete()
          if (errors.length > 0) rj(errors[0])
          else rs([...this.results] as T[])
        }
      })
    })
  }
}
```

### 使用示例

下面创建十个任务，将并发上限设为 4。运行时最多有四个任务同时执行，每当一个任务结束，再启动队列中的下一个。

```ts
async function testPromisePool() {
  const arr = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
  const asyncFns = arr.map((num) => async () => {
    await new Promise<number>((rs) => {
      console.log('跑起来了: ' + num)
      setTimeout(() => {
        rs(num * 2)
      }, 100)
    })

    return new Promise((rs) => {
      setTimeout(() => {
        rs('结果: ' + num * 10)
      }, 2000)
    })
  })

  const pool = new PromisePool(asyncFns, 4)
  pool.exec().then((res) => {
    console.log(res)
  })
}
```

## 基于实际上传进度的进度计算

上传任务受到并发池控制后，还需要知道每个请求传输了多少数据。Axios 可以通过 `onUploadProgress` 接收上传事件，Angular HttpClient 则可以开启进度报告，再通过 RxJS 管道处理事件。

### 封装 Angular HttpClient 的进度事件

下面在上传进度事件中调用 `cb(event.loaded)`，并在收到最终响应后返回响应体。发送进度与服务端是否已经完成保存是两个阶段，后面会进一步区分。

```ts
// http.service.ts
import {
  HttpClient,
  HttpEvent,
  HttpEventType,
  HttpRequest,
  HttpResponse,
} from '@angular/common/http'
import { filter, lastValueFrom, map, tap } from 'rxjs'

export class HttpService {
  constructor(private http: HttpClient) {}

  private getEventMessage(event: HttpEvent<any>, cb?: (current: any) => void) {
    if (event.type === HttpEventType.UploadProgress) {
      cb && cb(event.loaded)
    }
  }

  postPWithProgress<T>(
    url: string,
    body: any,
    extra: HttpExtraParam = {},
    cb?: (current: number) => void
  ) {
    const urlWithExtra = appendQueryParams(url, extra)
    return lastValueFrom(
      this.http
        .request<T>(
          new HttpRequest('POST', urlWithExtra, body, {
            reportProgress: true,
          })
        )
        .pipe(
          tap((event) => this.getEventMessage(event, cb)),
          filter((event) => event.type === HttpEventType.Response),
          map((event) => (event as HttpResponse<T>).body)
        )
    )
  }
}
```

## 前端上传流程与策略

### 流程

将前面的工具连起来，一次上传可以按以下顺序执行。

1. 读取文件元数据并切片。
2. 计算分片摘要与文件标识。
3. 查询是否可以复用已有文件。
4. 查询缺失分片，构建对应的上传参数。
5. 按并发上限上传这些分片。
6. 请求服务端校验分片，再完成合并。

这个基础流程先展示工具之间的配合。上传会话、失败重试与取消控制会在后面分别讨论。

### 策略

文件按每片 10 MiB 切分，下面记录两种哈希策略的性能取舍。

1. 分片数量为 1 时，直接计算文件的 MD5。
2. 分片数量为 2 ～ 100 时，基于分片 MD5 计算 Merkle 树根，作为文件标识。
3. 分片数量超过 100 时，示例采用分片 CRC32 构建 Merkle 树。这个性能方案存在前面提到的碰撞限制，生产环境需要更强的内容校验，不能仅凭它决定秒传。

### 实时上传进度的思路

为每个待上传分片保存当前请求已发送的字节数，初始值为 0。收到进度事件时，只更新对应下标，再每隔 150 ms 汇总一次，刷新界面。

这样可以合并多个分片频繁触发的进度更新，减少界面刷新次数。断点续传时，还需要加上服务端已确认分片的字节数。

进度达到发送阶段的上限后，仍需展示校验与合并状态。代码中的定时器会在上传任务结束或失败时清理，最终成功则由完成接口确认。

### 整体实现

下面的前端服务组合了这些工具，`UploadApiService`、`HttpExtraParam`、`appendQueryParams` 和哈希工具函数由项目提供。分片查询接口应按 `{ index, chunkHash }` 返回待传分片，避免内容相同的多个分片因哈希相同而覆盖位置。分片大小参数沿用前面的 MiB 单位，接口中的文件大小则统一使用字节。

```ts
interface IMetaData {
  size: number
  lastModified: number
  type: string
}

export class MinioUploaderService {
  // 用于追踪当前的上传阶段
  uploadStatus = new BehaviorSubject<string>('Please select a file.')

  constructor(private uploadApiSvc: UploadApiService, private workerSvc: WorkerService) {}

  async doUpload(file: File, chunkSize: number, cb: (progress: number) => void) {
    // 分片数量不超过 BORDER_COUNT 时用 MD5，否则按示例策略计算 CRC32
    const BORDER_COUNT = 100

    // 文件大小
    const fileSize = file.size
    if (fileSize === 0) throw new Error('请单独处理空文件上传')

    // 文件元数据
    const metadata: IMetaData = {
      size: file.size,
      lastModified: file.lastModified,
      type: file.type,
    }

    // 文件分片
    this.uploadStatus.next('Parsing file ...')
    const chunksBlob = sliceFile(file, chunkSize)
    const chunksBuf = await getArrayBufFromBlobsV2(chunksBlob)

    // 按文件分片数量执行不同 Hash 策略
    let chunksHash: string[] = []
    if (chunksBuf.length === 1) {
      chunksHash = [getMD5FromArrayBuffer(chunksBuf[0])]
    } else if (chunksBuf.length <= BORDER_COUNT) {
      chunksHash = await this.workerSvc.getMD5ForFiles(chunksBuf)
    } else {
      chunksHash = await this.workerSvc.getCRC32ForFiles(chunksBuf)
    }
    const merkleTree = new MerkleTree(chunksHash)
    const fileHash = merkleTree.getRootHash()

    // 检查文件是否已经上传过
    this.uploadStatus.next('Checking file if exist ...')
    const { data: existUrl } = await this.uploadApiSvc.checkFileIfExist(fileHash, fileSize)
    if (existUrl) {
      this.uploadStatus.next('Completed.')
      cb(100)
      return existUrl
    }

    // 查询需要上传的分片
    this.uploadStatus.next('Get the chunks that need to be uploaded ...')
    const { data: _chunksNeedUpload } = await this.uploadApiSvc.getExistChunks(fileHash, chunksHash)

    // 完整的上传参数
    this.uploadStatus.next('Building upload params ...')
    const paramsMap = new Map<number, FormData>()
    chunksBlob.forEach((chunk, index) => {
      const data = new FormData()
      data.append('files', chunk)
      data.set('name', file.name)
      data.set('index', index.toString())
      data.set('fileHash', fileHash)
      data.set('chunkHash', chunksHash[index])
      paramsMap.set(index, data)
    })

    // 获取实际需要上传的分片
    const params = _chunksNeedUpload.map(({ index, chunkHash }) => {
      if (chunksHash[index] !== chunkHash || !paramsMap.has(index)) {
        throw new Error('待上传分片信息不匹配')
      }
      return paramsMap.get(index)!
    })
    this.uploadStatus.next('Uploading ...')

    // 基于实时上传进度的进度
    const total = file.size
    const currentProgressList = params.map(() => 0)
    const pendingBytes = _chunksNeedUpload.reduce(
      (sum, { index }) => sum + chunksBlob[index].size,
      0
    )
    const uploadedBytes = total - pendingBytes
    const intervalId = setInterval(() => {
      const current = uploadedBytes + currentProgressList.reduce((acc, cur) => acc + cur, 0)
      cb(Math.min(99, Math.floor((current / total) * 100)))
    }, 150)

    try {
      await new PromisePool(
        params.map((param, index) => () =>
          this.uploadApiSvc.uploadChunks(param, (current) => {
            const { index: chunkIndex } = _chunksNeedUpload[index]
            currentProgressList[index] = Math.min(current, chunksBlob[chunkIndex].size)
          })
        )
      ).exec()
    } finally {
      clearInterval(intervalId)
    }

    // 获取校验失败的分块并尝试重新上传
    this.uploadStatus.next('Verify uploaded chunks ...')
    const { data: brokenChunksList } = await this.uploadApiSvc.verifyChunks2(fileHash, chunksHash)
    if (brokenChunksList.length !== 0) {
      console.log('brokenChunksList: ', brokenChunksList)
      throw new Error('分片校验失败，需要重试对应分片')
    }

    // 合并分片
    this.uploadStatus.next('Merging chunks ...')
    const { data: url } = await this.uploadApiSvc.mergeChunks(
      fileHash,
      file.name,
      fileSize,
      metadata
    )
    this.uploadStatus.next('Completed.')
    cb(100)
    return url
  }
}
```

## 降低哈希阶段的内存占用

前面的基础实现为了便于组织任务，提前把全部分片读成了 ArrayBuffer。文件越大，这一步占用的内存就越多。Merkle 树根依赖分片大小与构造规则，因此这里保持协议参数不变，只调整读取与计算的调度方式。

下面按 Worker 数量对分片分组。每批读取完成后并行计算，等待这一批结束，再读取下一批。替换前面整体实现中的切片与哈希计算部分后，后续的文件检查和上传流程可以保持不变。

每轮计算前移除上一批缓冲区的引用，让不再被使用的 ArrayBuffer 有机会被回收。清空数组不会强制浏览器立即回收内存，但可以避免整份文件的缓冲区一直被同一个数组持有。

```ts
// 文件分片
this.uploadStatus.next('Parsing file ...')
const chunksBlob = sliceFile(file, chunkSize)
let chunksHash: string[] = []
if (chunksBlob.length === 1) {
  chunksHash = [getMD5FromArrayBuffer(await chunksBlob[0].arrayBuffer())]
} else {
  let chunksBuf: ArrayBuffer[] = []
  // 将文件分片进行分组, 组内任务并行执行, 组外任务串行执行
  const chunksPart = getArrParts<Blob>(chunksBlob, this.workerSvc.MAX_WORKERS)
  const tasks = chunksPart.map((part) => async () => {
    // 移除上一批缓冲区的引用，具体回收时机由垃圾回收器决定
    // 每批读取量约为 MAX_WORKERS × 分片大小，实际峰值还包括计算等额外开销
    chunksBuf.length = 0
    chunksBuf = await getArrayBufFromBlobsV2(part)
    // 按文件分片数量执行不同 Hash 策略
    return chunksBlob.length <= BORDER_COUNT
      ? await this.workerSvc.getMD5ForFiles(chunksBuf)
      : await this.workerSvc.getCRC32ForFiles(chunksBuf)
  })
  for (const task of tasks) {
    const result = await task()
    chunksHash.push(...result)
  }
}
```

`getArrParts` 按指定数量对数组分组，最后一组可以少于指定数量。

```ts
/**
 * 用于将数组分块 [1, 2, 3, 4] => [[1, 2], [3, 4]]
 * @param chunks 原始数组
 * @param size 分 part 大小
 */
function getArrParts<T>(chunks: T[], size: number) {
  if (!Number.isInteger(size) || size <= 0) throw new Error('分组大小必须为正整数')
  const result: T[][] = []
  let tempPart: T[] = []
  chunks.forEach((chunk: T) => {
    tempPart.push(chunk)
    if (tempPart.length === size) {
      result.push(tempPart)
      tempPart = []
    }
  })
  if (tempPart.length !== 0) result.push(tempPart)
  return result
}
```

### 替换哈希实现

读取范围受到控制后，还可以比较不同哈希实现的计算成本。例如将 MD5 Worker 中的 SparkMD5 换成 hash-wasm，消息格式和上层调度方式保持一致。实际收益需要在相同文件、线程数和计时范围下比较。

```ts
// md5.worker.ts
/// <reference lib="webworker" />

import { md5 } from 'hash-wasm'
import { WorkerMessage } from './util/worker-message'
import { WorkerLabelsEnum } from './types/worker-labels.enum'

addEventListener('message', async ({ data }: { data: ArrayBuffer }) => {
  const hash = await md5(new Uint8Array(data))

  postMessage(
    new WorkerMessage(WorkerLabelsEnum.DONE, {
      result: hash,
      chunk: data,
    }),
    [data]
  )
})
```

## 内存与吞吐量一起控制

分批读取降低了哈希阶段的内存峰值，但不代表整个上传过程只占用一批缓冲区。Worker 中的哈希状态、浏览器网络缓冲、FormData 和业务对象也会占用空间。前面的 WorkerWrapper 还会把 ArrayBuffer 转回主线程，如果后续上传直接使用 Blob，这次归还可以省掉，只返回哈希与分片下标，减少缓冲区继续被回调引用的机会。

假设每片 10 MiB，一次读取 8 片，仅这一批的原始字节就约为 80 MiB。并发数应同时受到 CPU、内存和网络条件约束。`navigator.hardwareConcurrency` 适合作为参考，上传请求数量不必与逻辑处理器数量一致，移动设备也不适合直接沿用桌面测试中的线程数。

一种进一步的组织方式是使用有界流水线。先读取少量分片，交给 Worker 计算，再把已计算的分片放入有限长度的上传队列。队列满时停止继续读取，有空位再补充。这样可以重叠读取、计算和上传，又不会因网络较慢而积压整个文件。若秒传必须先拿到完整文件标识，也可以先完成一轮分批哈希，再根据服务端返回的缺失清单读取和上传。

如果需要标准文件 SHA-256，也不能简单改成对整个文件调用一次 `crypto.subtle.digest`。该 API 不接受流式输入，需要先准备完整输入缓冲区。大文件可以使用支持增量更新的哈希实现，逐片读取并按顺序更新摘要；这与独立计算分片摘要、再组合成 Merkle 树是不同的计算方式。[Web Crypto digest 的输入限制](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/digest)

## 让断点续传有稳定的上传会话

基础实现用文件哈希查询已有分片，能够完成续传流程。实际接入时，还需要区分“文件内容”和“这一次上传”。同一份文件可能被不同用户上传到不同目录，同一个用户也可能同时打开两个页面。如果只按文件哈希保存临时分片，任务之间就容易互相覆盖。

可以由服务端在初始化时创建 `uploadId`，把用户、目标位置、文件大小、分片大小、分片数量、哈希算法和协议版本关联到这次会话。客户端保存这个 ID，后续操作都围绕会话进行。

| 阶段       | 请求内容                           | 服务端需要保证的行为                                 |
| ---------- | ---------------------------------- | ---------------------------------------------------- |
| 初始化     | 文件信息、分片规则、目标位置       | 创建或恢复当前用户有权访问的上传会话                 |
| 查询       | `uploadId`                         | 返回服务端已经确认保存的分片下标、大小和校验信息     |
| 上传分片   | `uploadId + index`、分片内容及摘要 | 重复提交相同内容可以返回已有结果，内容冲突则拒绝覆盖 |
| 完成       | `uploadId`、按顺序排列的分片清单   | 校验完整性，合并后记录最终对象信息                   |
| 取消或过期 | `uploadId`                         | 结束会话，按策略清理临时分片                         |

分片下标必须参与身份判断。一个文件连续出现两块完全相同的内容时，它们的哈希相同，但仍然占据两个不同位置。前面使用下标建立 `paramsMap`，就是为了保留这个区别。

恢复上传时，客户端应重新查询服务端，而不是只读取本地保存的“已完成下标”。请求可能已经成功，只是响应没有到达浏览器；本地记录也可能还在，服务端临时分片却已经过期。服务端确认保存的状态才是续传依据。

重新选择文件后，也不能只凭文件名和 `lastModified` 复用会话。这些信息适合快速筛选候选任务，仍需核对大小、摘要与分片规则。普通文件选择得到的 `File` 引用不会自动跨刷新保存，页面恢复通常需要用户重新选择文件。

## 失败后只重传需要重传的分片

前面的并发池会把失败交给调用方，但上传失败不一定意味着整批都要重来。每个分片都可以独立重试，已经确认成功的分片继续保留。

需要先区分失败类型。网络中断、超时，以及服务端明确允许重试的临时错误，可以进行有限重试。参数错误、没有权限和内容冲突，则应先修正问题。`429` 或 `503` 响应带有 `Retry-After` 时，还应按服务端要求等待，避免多个客户端同时不断重试。

### 指数退避与重试上限

下面的工具负责控制次数和等待时间，具体哪些错误可以重试，由调用者通过 `shouldRetry` 决定。`maxAttempts` 包含第一次请求，默认最多执行三次。等待期间也接受取消信号。

```ts
function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('上传已取消', 'AbortError')
}

function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortReason(signal))
      return
    }

    const onAbort = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      reject(abortReason(signal))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

async function withRetry<T>(
  task: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
  shouldRetry: (error: unknown) => boolean,
  maxAttempts = 3,
  baseDelayMs = 300
): Promise<T> {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('尝试次数必须为正整数')
  }
  if (!Number.isFinite(baseDelayMs) || baseDelayMs < 0) {
    throw new Error('等待时间不能为负数')
  }

  for (let attempt = 1; ; attempt += 1) {
    if (signal.aborted) throw abortReason(signal)
    try {
      return await task(signal)
    } catch (error) {
      if (signal.aborted) throw abortReason(signal)
      if (attempt >= maxAttempts || !shouldRetry(error)) throw error

      const delay = Math.min(5000, baseDelayMs * 2 ** (attempt - 1))
      // 加入随机抖动，减少多个请求同时再次发起的情况
      await waitForRetry(delay * (0.5 + Math.random() * 0.5), signal)
    }
  }
}
```

它可以放在前面 PromisePool 的单个任务内部。这样一个分片即使正在重试，也只占用一个并发名额，不会每次重试都往队列里追加新任务。代价是退避期间仍占着名额；如果需要更高吞吐量，可以把等待中的任务放入独立的延迟队列。

调用这个工具时，请求函数必须把 `signal` 继续传给网络层。使用 `fetch` 时传入 `{ signal }`，使用 Axios 时采用对应版本支持的取消接口，使用 Angular HttpClient 时则需要把取消信号接到订阅生命周期上。只给外层 Promise 加一个标记，不会中止已经发送的请求。[AbortController 的取消行为](https://developer.mozilla.org/en-US/docs/Web/API/AbortController/abort)

### 暂停、取消与超时分别处理

暂停上传时，先停止调度新分片，再终止正在进行的请求，保留服务端已经确认的分片。恢复时创建新的 `AbortController`，查询分片状态后继续。已经中止的 signal 不能重新变回未中止状态。

取消则意味着用户放弃这次任务，除了终止前端请求，还应调用服务端接口结束会话。取消请求与上传请求可能同时在网络中，客户端执行 `abort()` 并不代表服务端一定没有收到分片。清理流程需要允许在途请求结束，并避免继续向已取消的会话写入。

超时需要另外设置。并发池等待任务完成，如果某个请求一直没有成功或失败，就会一直占用名额。可以给每次请求单独计时，超时后中止本次请求，再按策略决定是否重试。用户取消应直接结束任务，不能作为超时错误自动重试。

Worker 计算也有相同的生命周期问题。`AbortController` 不会自动停止同步执行中的哈希代码。需要立即停止时，可以终止 Worker，但池必须同时拒绝它对应的 Promise，并重建可用 Worker。任务被中止、页面离开或组件卸载时，进度定时器、消息监听器和 Worker 都需要有对应的清理入口。

## 进度条怎样与实际状态保持一致

前面的 `loaded` 表示请求体发送进度，使用 FormData 时还可能包含 multipart 边界等开销。因此直接把它当成纯文件字节数，只能得到近似的上传进度。更严格的实现可以使用原始 Blob 作为请求体，或者根据可用的 `loaded / total` 比例折算分片进度，同时单独维护服务端确认状态。[XHR 上传进度事件](https://developer.mozilla.org/en-US/docs/Web/API/XMLHttpRequest/upload)

一个分片至少有两类进度。正在发送时记录本次请求已发送的字节数，服务端确认成功后，再把完整分片大小记入已确认字节数。重试时清空该分片上一次尝试的临时进度，不能把两次请求的 `loaded` 累加。

例如总大小为 100 MiB，服务端已确认 60 MiB，当前还有两个分片分别发送了 4 MiB 和 6 MiB。发送进度可以显示为 70%，但已确认进度仍然只有 60%。其中一个请求失败后，发送进度可能回退，这反映的是当前有效尝试的状态。为了让界面稳定，可以同时展示“已完成分片数”和当前阶段，避免通过单调递增的假进度掩盖失败。

上传字节发送完毕后，界面进入“校验中”或“合并中”。只有完成接口确认最终对象可用，才显示任务成功。前面将发送阶段限制在 99%，就是为这个阶段转换留出空间；这里的百分比不表示校验和合并的实际工作量。

## 服务端校验与合并决定最终结果

分片都收到后，仍然需要核对它们是否属于同一个上传会话、下标是否连续、长度是否符合规则，以及实际内容的摘要是否匹配。最后一个分片可以小于固定分片大小，但合并后的总大小必须与预期一致。服务端应根据收到的字节自行验证，客户端上报的摘要只能作为待核对的信息。

Merkle 树方案还需要固定算法和构造规则，包括叶子摘要、父节点的编码方式、奇数节点的处理、分片大小，以及协议版本。单片文件直接使用文件 MD5，多片文件使用树根，这两种标识也要区分。否则更换算法或分片参数后，同一内容可能无法命中原来的缓存，甚至把不同规则产生的值放进同一个命名空间。

### Node 合并与对象存储合并

在 Node 中合并文件不一定会损坏数据。常见问题是按请求完成顺序拼接、按字符串顺序排列下标，或者在写入流尚未结束时就返回成功。比如字符串排序会把 `10` 放在 `2` 前面，合并时应按数值下标读取，并通过流控制写入顺序和背压，避免把整个文件一次性加载到内存中。

如果文件最终保存在 MinIO 或 S3 兼容对象存储中，可以考虑使用其 multipart upload 协议，让对象存储完成分片组装。客户端或业务服务需要保存上传 ID，以及完成请求要求的 part number、ETag 或校验信息，并按接口规则提交分片清单。ETag 的含义取决于存储服务、上传方式等条件，不应一律当作文件 MD5。具体限制需要按目标服务的接口确认。[S3 分段上传机制](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html)

### 完成请求也需要可重复执行

前端发出合并请求后，如果响应丢失，不能仅凭页面报错就判断合并失败。服务端可能已经生成了最终文件。可以将会话状态设计为 `uploading → completing → completed`，对同一会话的重复完成请求返回已有结果，或者返回当前处理中状态。

自建文件合并流程中，可以先写入临时目标，校验完成后再通过存储系统支持的方式发布最终结果。同一会话同时收到两个完成请求时，通过状态条件更新或锁来确保只有一个合并过程实际执行。数据库状态和对象存储写入之间可能出现部分成功，还需要能够查询和恢复，避免最终文件已存在、会话却一直显示处理中。

秒传同样依赖权限校验。知道一个文件哈希，不代表就有权得到已有文件的下载地址。服务端需要确认用户可以访问或引用目标内容，再建立业务记录。上传会话绑定的用户、目录和配额，也不能仅凭客户端参数决定。

## 验证时覆盖失败路径

一次顺利上传只能说明主流程跑通。上线前可以用下面几组情况检查状态与最终文件是否一致。

| 场景                             | 重点检查                                   |
| -------------------------------- | ------------------------------------------ |
| 网络断开后恢复                   | 只重传服务端尚未确认的分片，成功分片不丢失 |
| 请求超时但服务端已经保存         | 重试不会产生重复分片或冲突结果             |
| 重复内容出现在不同分片           | 按下标保留全部位置，最终顺序正确           |
| 暂停、取消和刷新页面             | 队列与资源正确清理，会话状态可以重新查询   |
| 分片缺失、长度错误或摘要不符     | 完成接口拒绝生成可用文件                   |
| 两个页面同时上传或完成           | 会话隔离，重复完成不会重复写入最终结果     |
| 合并成功但响应丢失               | 查询或再次完成能取得同一个最终结果         |
| 更换分片大小或哈希算法           | 不会错误复用另一套规则的分片               |
| 空文件、单片文件和最后一个短分片 | 明确处理边界，最终大小与内容一致           |
| 长时间运行与多轮上传             | Worker、订阅和缓冲区没有持续累积           |

性能测试可以分别记录读取、哈希、排队、发送、校验和合并的耗时，再观察内存峰值与主线程长任务。这样才能分清瓶颈是在计算、网络还是存储服务，避免只增加并发数，却让响应时间和失败率一起上升。

## 总结

这套方案的取舍贯穿整个上传过程。Worker 池用更多并行计算换取时间，分批读取控制内存峰值，Merkle 树减少重复扫描，却需要固定文件标识的生成规则。上传之后，会话状态、分片校验与可重复执行的完成接口，又决定了任务在失败后能否恢复。

因此，调整分片大小和并发数量时，需要同时观察耗时、内存与失败后的恢复成本。能够在目标设备上稳定运行、在中断后确认状态，并最终生成正确文件，才是这套方案需要持续满足的条件。

## 参考资料

[大文件传输优化: 分片上传、断点续传和秒传的前后端实现（附源码）](https://juejin.cn/post/7273429629398515746)
