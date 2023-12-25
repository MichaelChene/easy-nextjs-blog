---
title: '前缀字典树 JS中GC问题优化（FinalizationRegistry）'
date: '2023/12/25'
tags: ['算法']
draft: false
summary: '前缀字典树能按参数组合复用计算结果，缓存的生命周期还要看引用关系。对象参数交给 WeakMap，基本类型需要主动清理。结合 React 16 的 ReactCache.js，看看资源缓存如何共享请求、通过 LRU 淘汰条目，以及 FinalizationRegistry 能帮上什么忙。'
images: ['/static/images/avatar.png']
layout: PostLayout
---

## 2630. 记忆函数 II

> https://leetcode.cn/problems/memoize-ii/description/

解法：双 Map / 字典

记忆函数的基本思路是把参数组合与计算结果关联起来。再次收到相同参数时，直接返回缓存。实现功能之后，还需要考虑缓存占用的空间会怎样增长。

双 Map 的一种做法是先给对象分配 ID，再把参数 ID 拼成组合键。对象到 ID 的映射可以交给 `WeakMap`，但存放“组合键 → 结果”的普通 `Map` 不会因此同步删除条目。对象已经没有其他用途，组合字符串和结果却仍可能留在缓存中。JavaScript 也没有提供同步查询某个对象是否已经被回收的接口。

前缀字典树把每个参数作为路径的一层，沿路径就能找到结果。对象参数使用 `WeakMap`，可以避免缓存通过键强引用该对象。字符串、数字等参数通常放入 `Map`，相关分支仍然需要容量限制、过期策略或显式清空。

如果希望对象回收后连带删除涉及它的组合键，可以了解一下 [FinalizationRegistry](https://es6.ruanyifeng.com/#docs/set-map#FinalizationRegistry)。注册对象时记录对象 ID，再维护“对象 ID → 相关组合键”的反向索引，清理回调就有机会删除对应的缓存条目。不过回调的执行时间没有保证，具体限制后面再讨论。

这些问题在 React 16 的资源缓存中也有对应的取舍。下面结合 React v16.6.0 的 [ReactCache.js](https://github.com/facebook/react/blob/v16.6.0/packages/react-cache/src/ReactCache.js) 和 [LRU.js](https://github.com/facebook/react/blob/v16.6.0/packages/react-cache/src/LRU.js)，看看它如何保存异步结果、复用请求，以及主动移除强引用。它采用的是双层 `Map` 和 LRU，没有使用前缀字典树或 `FinalizationRegistry`。参数树部分先讨论通用记忆函数，再与这套资源缓存对照。

## 先看把所有参数放进 WeakMap 的写法

为了统一树节点，有时会先把基本类型包装成对象，再把所有参数放进 `WeakMap`。

```js
class DictNode {
  res = undefined
  save = false
  children = new WeakMap() // 对象参数是弱键，包装对象的生命周期还受 cache 影响
  setResult = (res) => ((this.res = res), (this.save = true), res)
}
function wrapArg(arg) {
  if ((typeof arg === 'object' && arg !== null) || typeof arg === 'function') {
    return arg // 可直接作为 WeakMap key
  } else {
    if (!wrapArg.cache.has(arg)) {
      wrapArg.cache.set(arg, Object.freeze({ val: arg }))
    }
    return wrapArg.cache.get(arg)
  }
}
wrapArg.cache = new Map()

function memoize(fn) {
  const root = new DictNode()
  return function (...args) {
    let node = root
    for (let arg of args) {
      const wrapped = wrapArg(arg)
      if (!node.children.has(wrapped)) {
        node.children.set(wrapped, new DictNode())
      }
      node = node.children.get(wrapped)
    }
    if (node.save) return node.res
    return node.setResult(fn(...args))
  }
}
```

这段代码能复用计算结果，但要沿着引用链检查它的内存行为。对象和函数直接作为弱键，没有被 `wrapArg.cache` 保存。基本类型却需要一个稳定的包装对象，否则同一个数字每次得到不同的对象，就无法命中缓存。

稳定性由 `wrapArg.cache` 保证，也正是它让包装对象一直存活。

```text
wrapArg.cache（普通 Map）
  └─ 42 → 包装对象 { val: 42 }
              ↑
       同时作为 children 的弱键
```

只要这个全局 `Map` 仍然可达，包装对象就有强引用。`WeakMap` 不会让一个仍被其他位置持有的对象自动消失。连续传入大量不同的字符串时，包装表依然会增长，而且会在不同的 `memoize` 实例之间共享。

直接清空包装表也有代价。旧树中的基本类型路径会失去稳定的查找键，后续调用会创建新的包装对象，原有结果便无法正常复用。既然基本类型最终需要普通 `Map` 维护身份，就可以直接让树节点同时支持两种分支。

## 用 WeakMap 和 Map 组成参数树

例如依次调用 `calculate(user, 'zh-CN')` 和 `calculate(user, 'en-US')`，两次调用共享第一个参数节点，再分别走向语言参数的分支。

```text
root
  └─ WeakMap[user]
       └─ Map
           ├─ 'zh-CN' → 中文计算结果
           └─ 'en-US' → 英文计算结果
```

这棵树按参数位置匹配。同一对象引用、相同参数顺序和相同参数个数才会走到同一个结果节点。两个内容相同的新对象仍然是不同的键，`fn(1)` 与 `fn(1, undefined)` 也会停在不同层级。参数较多时，无需先把它们序列化成字符串，也就避开了循环引用和序列化碰撞的问题。

下面是一份独立的教学实现，保留参数树、结果状态和错误复用，并提供显式清空入口。它适用于结果只由参数决定的函数，不把调用者的 `this` 纳入缓存键。

```js
function createNode() {
  return {
    status: 'empty',
    value: undefined,
    objects: null,
    primitives: null,
  }
}

function memoizeByArgs(fn) {
  let root = createNode()

  function cached(...args) {
    let node = root

    for (const arg of args) {
      const isObject = (typeof arg === 'object' && arg !== null) || typeof arg === 'function'
      const field = isObject ? 'objects' : 'primitives'

      if (node[field] === null) {
        node[field] = isObject ? new WeakMap() : new Map()
      }

      const children = node[field]
      let child = children.get(arg)
      if (child === undefined) {
        child = createNode()
        children.set(arg, child)
      }
      node = child
    }

    if (node.status === 'value') return node.value
    if (node.status === 'error') throw node.value

    try {
      const value = Reflect.apply(fn, undefined, args)
      node.value = value
      node.status = 'value'
      return value
    } catch (error) {
      node.value = error
      node.status = 'error'
      throw error
    }
  }

  cached.clear = () => {
    root = createNode()
  }

  return cached
}
```

单独保存 `status` 很有必要。函数返回 `undefined`、`null` 或 `false` 都是有效结果，不能用结果的真假判断是否命中。没有参数时，结果保存在根节点，因此零参数函数也能缓存。

```js
let calls = 0
const getLabel = memoizeByArgs((user, locale) => {
  calls += 1
  return `${user.name}:${locale}`
})

const user = { name: 'Michael' }
getLabel(user, 'zh-CN')
getLabel(user, 'zh-CN') // 命中，calls 仍为 1
getLabel({ name: 'Michael' }, 'zh-CN') // 新对象，calls 变为 2

getLabel.clear()
getLabel(user, 'zh-CN') // 清空后重新计算
```

这里的 `Map` 使用 SameValueZero 比较键，`NaN` 可以命中自身，`0` 与 `-0` 会命中同一分支。如果函数依靠 `Object.is` 区分正负零，就需要额外编码键。对象的属性发生变化也不会改变引用，因此可变对象可能命中过时结果。使用不可变参数或在数据变化时清空缓存，是调用方需要约定的规则。

### 弱键能释放哪一段路径

上面的 `user` 不再被外部使用后，树不会仅仅因为 `WeakMap` 的键而阻止它回收。挂在这个弱键下的语言分支和结果，如果也没有其他强引用，就有机会一起被回收。结果反过来引用 `user`，也不会单凭这条弱映射形成永久保活，`WeakMap` 的键值关系由垃圾回收器特殊处理。[WeakMap 的引用语义](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/WeakMap)

不过，树上弱键之前的普通 `Map` 节点不会随之自动修剪。把参数顺序换成 `calculate(locale, user)`，即使 `user` 对应分支消失，根节点下的 `locale` 条目也仍可能存在。全是基本类型的参数路径，更是完全没有弱键可以依赖。参数树减少了对象被缓存意外保活的机会，整个缓存仍然需要明确的生命周期。

## React 16 的 ReactCache.js 缓存了什么

前面的记忆函数接受多个参数，缓存一次函数调用的结果。React 16 的 `react-cache` 则以资源为单位，管理异步读取。`unstable_createResource(fetch, hashInput)` 返回一个带有 `read` 和 `preload` 的资源对象，每次读取接受一个 `input`。需要多个条件时，可以把它们放进输入对象，再定义稳定的缓存键。

这里阅读的是 React v16.6.0 中实验性的 `react-cache` 包。它与 React 核心配合，用于探索 Suspense 的数据读取方式，不是 React 16 的稳定数据请求 API。

### 两层 Map 分别负责什么

模块级的 `entries` 先按资源隔离缓存，再按输入键查找条目。外层和内层都是普通 `Map`，内层保存的值是 LRU 节点，节点再持有资源的状态和结果。

```text
entries
  ├─ UserResource
  │    ├─ userId = 1 → LRU 条目 → result
  │    └─ userId = 2 → LRU 条目 → result
  └─ ImageResource
       └─ imageUrl → LRU 条目 → result

同一个全局 LRU 连接上述所有资源条目
```

外层使用资源对象作键，所以两个资源即使用了相同的输入键，也不会混淆结果。内层的键由 `hashInput(input)` 得到，未提供哈希函数时直接使用输入。默认路径在开发环境会检查输入类型，对象输入应提供自己的哈希函数。

例如按用户 ID 查用户，可以把 `input.id` 作为键，但如果租户也影响查询结果，就必须把租户一起纳入键。下面的写法同时保留两个字段的边界，传给加载函数的仍然是完整输入。

```js
import { unstable_createResource } from 'react-cache'

const UserResource = unstable_createResource(
  ({ tenantId, userId }) =>
    fetch(`/api/tenants/${encodeURIComponent(tenantId)}/users/${encodeURIComponent(userId)}`).then(
      (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response.json()
      }
    ),
  // 此处约定 tenantId 和 userId 都是字符串
  ({ tenantId, userId }) => JSON.stringify([tenantId, userId])
)

function UserName({ tenantId, userId }) {
  const user = UserResource.read({ tenantId, userId })
  return <span>{user.name}</span>
}
```

资源定义在模块级，多个组件读取时才能共享它。每次渲染都创建新资源，会得到新的外层 `Map` 键，已有缓存也就无法复用。相反，如果两个不同请求被哈希为同一个键，就会错误地共享数据。缓存键的完整性直接影响正确性。

### accessResult 先保存正在进行的请求

第一次调用 `resource.read(input)` 时，源码先检查渲染环境，再计算键，进入 `accessResult`。它先找到或建立当前资源的内层 `Map`，接着查找该键对应的 LRU 条目。

未命中时，调用 `fetch(input)` 得到 thenable，为其注册成功和失败回调，再创建结果对象。结果初始为 `Pending`，`value` 指向这个 thenable。随后用 `lru.add` 创建条目，绑定删除回调，并把条目放进内层 `Map`。命中时则调用 `lru.access(entry)`，更新访问顺序并取出结果。

这里保存的是可变的结果对象。异步操作成功后，回调把它改为 `Resolved` 并写入成功值。失败后则改为 `Rejected`，保存失败原因。回调只在当前状态仍为 `Pending` 时执行状态转换，已经进入终态的结果不会被后续通知覆盖。这段流程以普通 Promise 一类异步调用回调的 thenable 为阅读前提。

正在等待的请求也会立即进入缓存，因此第一个组件还没有拿到数据时，第二个组件就能命中同一条目。复用不仅发生在请求完成之后，也发生在请求仍然进行的时候。

### read 为什么会抛出 Promise

`accessResult` 负责找结果，`read` 再根据状态决定如何继续渲染。

| 资源状态   | 保存的内容          | `read` 的行为                                    |
| ---------- | ------------------- | ------------------------------------------------ |
| `Pending`  | 正在等待的 thenable | 抛出 thenable，让 React 的 Suspense 机制处理等待 |
| `Resolved` | 异步操作的成功值    | 直接返回数据                                     |
| `Rejected` | 异步操作的失败原因  | 抛出错误，交给错误边界等机制处理                 |

因此，组件中的 `read` 看起来像同步读取，但内部可以通过抛出 thenable 暂停当前渲染路径。请求完成后，React 有机会重试渲染。重试时仍然读取同一个资源和键，就会找到已经变成 `Resolved` 的结果，返回数据。请求失败时则抛出保存的错误。

同一个结果对象从等待状态变为终态，正好把首次渲染和重试渲染连在一起。如果没有缓存，重试时每次都创建新请求，就可能始终读到另一个尚未完成的 Promise。

### preload 与渲染环境检查

`preload(input)` 复用相同的查找和加载流程，但不根据结果状态抛出 thenable 或保存的错误。它可以在渲染过程中提前发起其他资源的请求，让后面的 `read` 有机会直接命中。

不过，React 16.6.0 这份实现的 `read` 和 `preload` 都会先调用 `readContext(CacheContext)`。内部通过 `ReactCurrentOwner.currentDispatcher` 获取 dispatcher，缺少 dispatcher 时抛错，提示只能在组件渲染期间调用。这里的 Context 尚未实际承载缓存数据，读取它主要用于约束调用环境。不能直接把这份 `preload` 放进普通事件处理函数中使用。

此外，`preload` 不主动抛出缓存状态，不代表它会吞掉所有异常。`fetch(input)` 如果同步抛错，异常仍然沿当前调用栈向外传播。资源已缓存的异步失败也没有自动重试机制，后续 `read` 会继续抛出错误，直到条目被淘汰后重新加载。

这套缓存保存在模块级，不随单个组件卸载立即清空，也不会随着服务端数据变化自动刷新。它的空间管理主要交给 LRU，数据刷新还需要独立的业务策略。[React 16.6.0 ReactCache.js 源码](https://github.com/facebook/react/blob/v16.6.0/packages/react-cache/src/ReactCache.js)

## LRU 怎样限制强引用缓存

这些 `Map` 会强引用条目，释放空间依靠配套的 `LRU.js`。LRU 按最近访问顺序组织缓存，优先删除最久没有被使用的条目。

底层是循环双向链表。`first` 指向最近使用的节点，`first.previous` 就是最久未使用的节点。每个节点既保存结果，也保存前后指针和删除回调。内层 `Map` 负责快速定位节点，双向链表负责在定位后快速调整顺序。

```text
first
  ↓
  C ⇄ B ⇄ A
  ↑       ↓
  └───────┘

访问 A 后
  A ⇄ C ⇄ B
  ↑       ↓
  └───────┘

需要淘汰时，从尾部的 B 开始
```

新增节点放在头部。访问已有节点时，把它从原位置摘下，再接到头部。这两种操作只需要修改有限的指针，不必遍历所有键。清理时从尾部逐个删除，直到条目数回到目标值。

删除也必须同时处理两份结构。链表摘掉节点后调用 `onDelete`，对应的 `deleteEntry(resource, key)` 会删除内层 `Map` 的索引。如果该资源已经没有条目，再删除外层 `entries` 中的资源项。只删链表会让 `Map` 继续持有缓存，只删 `Map` 则会在链表中留下无法正常访问的条目。

React v16.6.0 的实现默认全局限制为 500 个条目，多个资源共享这个额度，而且限制按条目数量计算，不按字节数计算。500 张大图与 500 个小对象的内存开销可能相差很大，不能直接把这个数字当作内存预算。

### 清理并非每次新增后立即发生

React v16.6.0 的 `scheduleCleanUp` 在超出限制且尚未安排清理时，调用 Scheduler 的 `scheduleCallback(cleanUp)`。清理通过调度执行，缓存数量可能暂时超过上限，`cleanUpIsScheduled` 标记用于避免重复安排同一轮清理。

具体到这个版本，`add` 只负责插入节点和递增计数，检查是否安排清理由 `access` 和 `setLimit` 触发。如果一直新增条目而没有命中访问，也没有调整限制，单靠 `add` 不会安排清理。因此这份实现中的 500 是清理目标，不能理解为每次写入都强制执行的硬上限。实现自己的缓存时，应在写入路径上明确检查容量，并决定同步淘汰还是调度清理。

另外，淘汰仍处于 `Pending` 状态的条目，不等于取消网络请求。这里没有随淘汰执行的 `AbortController` 逻辑，后续读取如果再次未命中，还可能发起另一轮请求。条目从索引移除后，其结果对象也可能暂时被 Promise 回调持有，最终释放仍取决于所有引用何时消失。[LRU.js 源码](https://github.com/facebook/react/blob/v16.6.0/packages/react-cache/src/LRU.js)

## FinalizationRegistry 能补上什么

参数树通过弱键避免持有对象，LRU 主动删除不再保留的缓存。对于前面“双 Map + 参数 ID”的设计，`FinalizationRegistry` 提供了另一个辅助入口，可以在对象被回收后尝试清理关联的组合键。

下面只演示反向索引的关联方式。一个 ID 可以参与多组参数，清理时需要删除所有相关结果。

```js
const objectIds = new WeakMap()
const results = new Map()
const keysById = new Map()
let nextId = 0

const registry = new FinalizationRegistry((id) => {
  const keys = keysById.get(id)
  if (keys !== undefined) {
    for (const key of keys) results.delete(key)
    keysById.delete(id)
  }
})

function getObjectId(object) {
  let id = objectIds.get(object)
  if (id === undefined) {
    id = ++nextId
    objectIds.set(object, id)
    registry.register(object, id)
  }
  return id
}

function saveResult(key, objectArgs, value) {
  results.set(key, value)
  for (const object of objectArgs) {
    const id = getObjectId(object)
    let keys = keysById.get(id)
    if (keys === undefined) {
      keys = new Set()
      keysById.set(id, keys)
    }
    keys.add(key)
  }
}
```

`key` 应由完整参数组合稳定生成，且不能让不同组合碰撞。这里用单调递增的 ID 避免复用旧 ID。注册时保存的是数字 ID，反向索引保存的是组合键字符串，都没有直接强引用注册对象。

实际使用还要补上主动淘汰时的反向索引清理。例如一个组合关联了对象 A 和 B，A 回收后删除了结果，B 的索引集合中仍可能残留这个组合键。它不会让已删除的结果重新出现，但元数据也需要控制增长。缓存结果若又强引用了参数对象，则 `results → value → object` 仍可让对象存活，清理回调也就无从触发。把对象藏进注册信息或闭包，同样可能意外延长它的生命。

更关键的是，回调可能很晚执行，也可能始终不执行。不能依赖它维护准确的缓存大小、及时释放外部资源或完成业务逻辑。即使加入了注册机制，容量限制和显式清理仍然有必要。`FinalizationRegistry` 适合作为补充清理手段，使用前应确认维护反向索引的成本确实值得。[FinalizationRegistry 的清理约束](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/FinalizationRegistry)

## 给缓存一个明确的退出条件

选择缓存结构时，可以先确定结果需要存活多久。组件实例内的计算，可以随实例释放。请求内的共享计算，可以随请求结束。长期运行的模块级缓存，则需要为条目设置容量、失效条件和清空入口。

| 场景                          | 可以优先考虑的策略                                    |
| ----------------------------- | ----------------------------------------------------- |
| 结果跟随对象存活              | 对象键使用 `WeakMap`，避免额外强引用                  |
| 多个参数决定结果              | 参数树，分别处理对象与基本类型                        |
| 大量字符串、ID 等基本类型输入 | LRU、TTL 或明确的请求作用域                           |
| 数据可能更新                  | 主动失效或版本键，避免一直返回旧值                    |
| 对象 ID 组合需要关联清理      | 容量管理加反向索引，必要时辅以 `FinalizationRegistry` |

检查内存时，重点是缓存仍然能到达哪些对象。`WeakMap` 可以解除一类保活关系，LRU 可以主动丢弃旧条目，请求作用域可以在任务结束后放下整棵树。这些机制共同决定了缓存的实际寿命。命中率之外，把退出条件设计清楚，记忆函数才不会在长时间运行后变成不断增长的存储容器。
