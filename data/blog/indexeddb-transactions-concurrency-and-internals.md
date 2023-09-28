---
title: 'IndexedDB 的事务、并发与底层实现'
date: '2023/09/28'
tags: [browser, indexeddb, chromium]
draft: false
summary: 'IndexedDB 支持结构化数据、索引和事务。并发读写由事务范围与模式共同约束，请求成功后还要等待事务提交，版本升级也可能被旧连接阻塞。'
images: ['/static/images/avatar.png']
layout: PostLayout
---

离线草稿要能按 ID 读取，也要能按更新时间查找。多开一个标签页后，还有一个问题：两个页面同时改同一条记录，结果怎么算才对？IndexedDB 把这两件事分别交给索引和事务。先把草稿存起来，再用一个跨标签页的计数例子看事务为什么重要。

## 一条草稿怎么存进去

一个 IndexedDB 数据库里可以有多个对象仓库（object store）。每条记录有一个主键，索引提供另一条查找路径。IndexedDB 可以用结构化序列化保存对象、数组、Blob 等数据，读回来的是一份值的副本。修改读到的对象后，要再用 `put()` 写回。

下面创建 `drafts` 仓库，按 `id` 保存草稿，并为 `updatedAt` 建一个非唯一索引。另建 `counters` 仓库，留给后面的并发例子。

```js
function openDraftsDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('drafts-demo', 1)

    request.onupgradeneeded = () => {
      const db = request.result

      const drafts = db.createObjectStore('drafts', { keyPath: 'id' })
      drafts.createIndex('by-updated-at', 'updatedAt')
      db.createObjectStore('counters')
    }

    request.onblocked = () => {
      console.warn('数据库升级正在等待其他页面关闭旧连接')
    }
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result
      db.onversionchange = () => db.close()
      resolve(db)
    }
  })
}

function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onabort = () => reject(tx.error ?? new Error('事务已中止'))
  })
}

async function saveDraft(db, draft) {
  const tx = db.transaction('drafts', 'readwrite')
  tx.objectStore('drafts').put(draft)
  await transactionDone(tx)
}

async function findDraftsSince(db, timestamp) {
  const tx = db.transaction('drafts', 'readonly')
  const index = tx.objectStore('drafts').index('by-updated-at')
  const request = index.getAll(IDBKeyRange.lowerBound(timestamp))
  await transactionDone(tx)
  return request.result
}

const db = await openDraftsDB()
await saveDraft(db, { id: 'article-1', title: '离线草稿', updatedAt: Date.now() })
console.log(await findDraftsSince(db, 0))
```

代码可以在支持顶层 `await` 的模块或 DevTools 控制台里运行。知道 ID 时，直接用对象仓库的 `get(id)`。要找某个时间之后更新的草稿，可以在只读事务里通过 `by-updated-at` 索引，把时间交给 `IDBKeyRange.lowerBound(timestamp)`。数据量大时，可以用游标分段读。（[IndexedDB 规范中的对象仓库与索引](https://w3c.github.io/IndexedDB/#object-store)）

`put()` 返回的是 `IDBRequest`，保存动作真正完成要看事务的 `complete` 事件。同一事务里的某个请求已经触发 `success`，后续操作仍可能导致整个事务回滚。要显示「保存成功」，等事务完成再更新界面更准确。

## 「线程安全」具体保证什么

主页面、其他标签页和 Web Worker 可以在同一存储区下连接同一个数据库。异步 API 让调用方可以继续处理其他任务。跨连接的数据一致性由事务约束决定。

### 异步访问模型

`indexedDB.open()`、`get()`、`put()` 等方法先返回请求对象，再通过事件交付结果。示例用 Promise 包装这些事件，便于把几次操作串起来。原生请求本身仍是 `IDBRequest`。

调用方提交请求后可以继续执行脚本，浏览器在满足事务调度条件时处理请求。同一个事务中的请求有确定的执行顺序，来自不同事务的请求则需要结合各自的范围和模式判断。

### 原子性事务

所有对象仓库的读写都在事务中进行。假设一次保存需要同时更新草稿和本地操作记录，可以把两个仓库一起放进事务范围。中途失败导致事务中止时，两边的写入一起回滚。

原子性保护的是这一次事务。把操作拆进两个事务后，第一个事务已经提交的结果，会留在数据库里，即使第二个事务随后失败。划分事务时，要把业务上需要一起成功的读写放在一起。

### 锁机制和事务隔离

调用 `db.transaction(['drafts', 'counters'], 'readwrite')` 时，两个仓库组成事务范围。浏览器判断两个事务会不会冲突时，看的是范围是否重叠以及事务模式。只写同一个仓库里的两个不同主键，范围仍然重叠。

| 事务模式        | 调度规则                                                                             |
| --------------- | ------------------------------------------------------------------------------------ |
| `readonly`      | 多个只读事务可以并行，即使访问同一个仓库。更早创建且尚未结束的重叠写事务会让它等待。 |
| `readwrite`     | 要等更早创建且范围重叠的事务结束。范围不重叠时有机会并行，具体实现仍可限制并发。     |
| `versionchange` | 用于升级数据库结构，由带新版本号的 `open()` 触发。旧连接关闭后才能升级。             |

写事务提交后，改动会一起生效。事务中止时，已执行的写入会回滚。这是 API 提供的原子性。至于浏览器内部怎样分配锁、任务在哪条序列上运行，属于实现细节。（[IndexedDB 规范中的事务调度](https://w3c.github.io/IndexedDB/#transaction-scheduling)）

### 跨线程访问与数据竞争

页面主线程与 Web Worker 可以分别打开连接。只要访问的是同一存储区中的同一个数据库，浏览器后端就会统一协调这些连接的事务。每个上下文持有自己的连接和请求对象，结果事件也回到发起操作的上下文。

这样的协调能让多个连接安全地使用事务。应用仍要检查自己的读改写是否完整地放进了事务范围。例如，如果先开一个只读事务取出计数，等它结束，再开一个写事务存入新值，两个页面仍然可能读到同一个旧值。把这两步放进同一个 `readwrite` 事务，才把竞争窗口关在事务里面。

```js
function incrementVisits(db) {
  const tx = db.transaction('counters', 'readwrite')
  const done = transactionDone(tx)
  const store = tx.objectStore('counters')
  const read = store.get('visits')
  let next

  read.onsuccess = () => {
    next = (read.result ?? 0) + 1
    store.put(next, 'visits')
  }

  return done.then(() => next)
}

const results = await Promise.all([incrementVisits(db), incrementVisits(db)])
console.log(results)
```

新建数据库时，这段代码会得到 `[1, 2]`。另一个标签页同时调用同一函数，更新也会按重叠写事务的规则排队。即使事务保护了这次累加，业务仍可能因为重复点击或网络重试而提交同一个操作两次。如果一个操作只能生效一次，可以把操作 ID 的去重检查也放进同一个事务。

### 为什么事务里不适合等网络

事务有活跃窗口。创建事务时，以及浏览器分发该事务请求事件时，可以继续排入请求。若中途等待一个无关的网络请求，期间没有待处理的 IndexedDB 请求，浏览器可能已经提交了事务。回来再调用 `put()`，就可能收到 `TransactionInactiveError`。

上例把下一次写入放在 `get()` 的成功回调里。遇到网络数据，先等请求结束，再开一个短事务，把实际需要一起提交的本地操作放进去。若数据太多需要分批，先明确业务允许前几批成功、后几批失败这一状态。（[IndexedDB 事务生命周期](https://w3c.github.io/IndexedDB/)）

| 并发场景                 | 可能发生什么                                     | 怎么处理                               |
| ------------------------ | ------------------------------------------------ | -------------------------------------- |
| 多个连接同时写同一仓库   | 重叠事务排队，创建得再多也不会加快提交           | 把同一次业务操作涉及的读写放进一个事务 |
| 大事务长时间占用同一仓库 | 后续请求等待，页面或 Worker 感受到的保存延迟变长 | 缩小事务范围，按允许独立提交的边界分批 |
| 多个页面高频写入         | 小请求积压，排队时间上升                         | 合并短时间内的重复写入，按实际负载测量 |

## 版本升级为什么会卡住

假设版本 2 要给草稿增加一个分类索引。新版标签页执行 `indexedDB.open('drafts-demo', 2)` 时，旧连接先收到 `versionchange`。旧页面还开着连接的话，新请求就可能收到 `blocked`，等待连接关闭，升级回调才会运行。

前面的例子用 `db.onversionchange = () => db.close()` 释放连接。实际应用还可以提示这个标签页需要刷新。做迁移时，按 `event.oldVersion` 分别处理创建仓库和添加索引，让全新安装与旧版本升级都能走完各自的路径。（[IndexedDB 打开连接算法](https://w3c.github.io/IndexedDB/)）

## 在 Chromium 里，V8 负责哪一段

回到 `indexedDB.open()`。网页或 Worker 里的脚本由 V8 执行，`indexedDB` 是宿主通过 Blink 的 Web IDL 绑定提供的 API。Blink 的 `IDBFactory` 包装打开请求，后端接受请求后再负责连接、事务调度和持久化。

```text
Window 或 Worker 中的 JavaScript
    ↓ V8 执行，Blink 暴露 IDBFactory / IDBRequest 等接口
Blink IndexedDB 模块
    ↓ Mojo IPC
Chromium 浏览器进程的 IndexedDB 后端
    ↓ 连接调度、事务、锁
底层存储
    ↑ 结果经 IPC 返回
调用方上下文收到 success / error 等事件
```

在渲染器里，`IDBDatabase` 表示连接，`IDBTransaction` 表示事务，`IDBObjectStore` 用来发出对仓库的请求，`IDBRequest` 把异步结果送回原来的执行上下文。这个上下文可能是页面主线程，也可能是发起请求的 Worker。Chromium 后端源码里可以看到不同存储后端的锁请求构造。网页代码只需依赖标准规定的事务范围和执行顺序，无需假设一定有一把对象仓库锁或固定的线程拓扑。（[Blink 的 IDBFactory](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/modules/indexeddb/idb_factory.cc)、[Chromium 的后端锁调度](https://chromium.googlesource.com/chromium/src/+/b99028df8f9316671381530844e2de51df3e1517/content/browser/indexed_db/instance/database.cc)）

| 层级           | 执行位置与职责                                                            |
| -------------- | ------------------------------------------------------------------------- |
| V8             | 在发起调用的页面或 Worker 中执行 JavaScript，也在对应上下文里执行事件回调 |
| Blink          | 通过绑定提供 Web API，包装请求、连接和事务，通过 IPC 发送操作             |
| IndexedDB 后端 | 在浏览器进程中管理连接和事务，根据仓库范围与底层后端协调锁                |
| 存储层         | 执行底层数据读写。任务序列和 I/O 分工会随 Chromium 实现演进               |

阅读旧版 Chromium 时，还可能见到 `IndexedDBDispatcherHost`，它处理历史版本中的 IndexedDB IPC 消息。追踪当前代码时，可以从 Blink 的 `IDBFactory` 沿 Mojo 接口找到浏览器侧的 `BucketContext`。（[历史版本的 IndexedDBDispatcherHost](https://chromium.googlesource.com/chromium/src/+/627e7f73d47910f4255031de55075e2a04b222f6/content/browser/indexed_db/indexed_db_dispatcher_host.cc)、[浏览器侧 BucketContext](https://chromium.googlesource.com/chromium/src/+/ac05faa48fee50a11df1e2da2f3ae24f3e9c37eb/content/browser/indexed_db/instance/bucket_context.h)）

## IndexedDB 的执行流程详解

把上面的职责放到一次调用里，就能跟踪请求从 JavaScript 进入浏览器后端，再返回结果的过程。以打开数据库为起点，后续的读写也沿着类似路径执行。

### 步骤 1：JavaScript 调用触发

```js
const request = indexedDB.open('my-db', 1)
```

V8 在当前上下文执行这行脚本。`indexedDB` 由浏览器宿主通过 Blink 的绑定暴露，`open()` 的参数经过接口绑定层处理，调用进入 Blink 的 `IDBFactory` 实现。脚本随即得到一个 `IDBOpenDBRequest`，可以注册成功、失败和升级处理函数。

这里的数字 1 是期望的数据库版本。浏览器还要比较已有版本，才能决定直接建立连接，还是先执行升级流程。

### 步骤 2：进入 Blink 接口层

Blink 为 JavaScript 保留请求及其关联上下文，并管理连接和事务的前端状态。后面调用读写方法时，会用到这些接口对象。

| 接口             | 负责的操作                         |
| ---------------- | ---------------------------------- |
| `IDBFactory`     | 打开、删除数据库等入口             |
| `IDBDatabase`    | 表示数据库连接，创建事务或关闭连接 |
| `IDBTransaction` | 维护事务的模式、范围和生命周期     |
| `IDBObjectStore` | 在事务内读写仓库记录、访问索引     |
| `IDBRequest`     | 承载请求结果或错误，并分发事件     |

比如 `tx.objectStore('drafts').put(draft)` 会先关联当前事务，再准备要传输的键和值。无法结构化序列化的内容可能在这一阶段抛出异常，因此数据准备也要考虑调用方线程上的开销。

### 步骤 3：调度与线程隔离

Blink 通过 Mojo 把请求发送给浏览器进程中的 IndexedDB 后端。打开请求涉及数据库名和版本，后端还需要协调旧连接、升级事务以及等待中的请求。

普通读写则按事务范围和模式进入调度。重叠的写事务需要依序取得访问权，只读事务可以在规则允许时一起运行。历史版本的 `IndexedDBDispatcherHost` 承担过 IPC 分发职责，当前实现可以继续沿 `BucketContext`、数据库和事务对象追踪任务流向。

前端 JavaScript 无需等待这段后台处理完成，事务顺序由后端协调。浏览器可以让存储工作离开页面主线程，序列化结果和执行事件处理函数时仍会回到调用方。

### 步骤 4：持久化与底层数据库

获得执行条件后，后端处理记录和索引，并把事务交给对应的存储实现。以 LevelDB 路径为例，元信息、对象记录和索引映射会编码成键值记录，大值和 Blob 还可能涉及独立文件。后面的存储结构表会进一步展开这些记录。

底层成功完成一次请求后，浏览器可以交付该请求的结果。写事务还要等其余操作和提交过程结束，才能最终报告 `complete`。应用看到的事务完成与设备突然断电时的数据耐久性也有区别，实际持久化强度还受浏览器和事务耐久性设置影响。

### 步骤 5：事件结果回传给 JavaScript

后端把结果或错误通过 IPC 送回 Blink。Blink 更新对应请求的状态，在原调用上下文排入事件，再由 V8 执行 `onsuccess`、`onerror` 等处理函数。Worker 发出的请求回到相应 Worker，页面发出的请求回到页面。

对于首次创建数据库或版本升级，`upgradeneeded` 会先给脚本修改结构的机会。升级成功提交后，打开请求才最终成功。后续记录操作也要区分请求事件与事务事件，才能判断何时可以读取结果，何时可以向用户确认保存完成。

这五个步骤把 API 调用、后台调度和回调时机连在了一起。具体类名会随 Chromium 版本调整，Web API 的请求和事务语义则由规范约束。（[Blink 的 IDBFactory 实现](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/modules/indexeddb/idb_factory.cc)、[IndexedDB 规范](https://w3c.github.io/IndexedDB/)）

## 存储结构与底层数据库

### LevelDB 中的记录

Chromium 长期使用 LevelDB 和独立文件存储 IndexedDB 数据。以 LevelDB 路径为例，数据库和对象仓库的元信息、记录、索引映射都有各自的内部编码。网页主键与用户值是不同层次的数据。值的序列化按 IndexedDB 的结构化序列化语义处理，后端锁由调度层维护，通常不对应独立的磁盘键值记录。

| 记录类型     | LevelDB 键的组成示意                                   | 保存的内容                       |
| ------------ | ------------------------------------------------------ | -------------------------------- |
| 元信息       | 数据库标识、元信息类型等                               | 数据库版本、仓库名称、主键路径等 |
| 对象仓库记录 | 数据库标识、仓库标识、保留的记录标识、编码后的主键     | 记录版本和序列化后的值           |
| 索引记录     | 数据库标识、仓库标识、索引标识、编码后的索引键和主键等 | 用于定位原记录的主键等信息       |

这里省略了编码细节。LevelDB 的排序依赖 Chromium 的比较逻辑，业务对象走的是结构化序列化。一个后端目录也不必只对应一个 JavaScript 层的命名数据库。（[Chromium LevelDB 编码设计](https://chromium.googlesource.com/chromium/src/+show/882a7c5b519cb21c62a0fffcf36a5cc0a078b903/content/browser/indexed_db/leveldb_coding_scheme.md)）

### LevelDB 和 SQLite 的演进

Chromium 已开始引入 SQLite 后端。Chrome 145 的发布说明先列出无痕模式等内存场景，Chromium 团队随后公开了更广范围的更换计划。磁盘目录、编码和锁实现都可能随版本变化，业务应通过 IndexedDB API 读写，调试可以使用 DevTools 的 **Application → IndexedDB**。（[Chrome 的 LevelDB 存储说明](https://developer.chrome.com/docs/chromium/indexeddb-storage-improvements)、[Chrome 145 发布说明](https://developer.chrome.com/release-notes/145)、[Chromium 团队的 SQLite 后端公告](https://groups.google.com/a/chromium.org/g/blink-dev/c/jS0khnC5IWA)）

## V8 与线程安全如何配合

V8 在各自的执行上下文里运行脚本，Blink 关联 API 对象、请求和事件，浏览器后端统一协调连接和事务。把并发一致性落实到应用时，可以沿着下面几层检查。

| 机制         | 提供的能力                         | 应用需要处理的部分                 |
| ------------ | ---------------------------------- | ---------------------------------- |
| 异步请求     | 调用方可以继续执行，结果经事件交付 | 在结果返回后再使用数据             |
| 原子事务     | 一组写入一起提交或回滚             | 将需要一起成功的操作放进同一事务   |
| 范围与锁调度 | 协调重叠事务，维护隔离性           | 缩小事务范围，避免无关等待         |
| 后端存储     | 组织记录、索引和持久化             | 处理配额、存储清理和连接失效等情况 |

回到草稿功能，索引解决「怎么找到记录」，事务解决「哪些操作必须一起成功」。先画出要查询的字段，再拆出最小的原子操作，通常就能决定仓库、索引和事务该怎么划分。
