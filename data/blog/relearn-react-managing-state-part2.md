---
title: '重学 React 状态管理 - Jotai 篇'
date: '2023/07/16'
lastmod: '2023/07/16'
tags: [react, jotai, 状态管理]
draft: false
summary: '从派生 atom 里的两次 get 看 Jotai 怎么记录依赖，再用购物车说明基础数据、派生值和写操作怎么组织。'
images: ['/static/images/16350881224248.jpg']
layout: PostLayout
hidePostNavigation: true
---

在 Jotai 里，合计可以直接写成一个派生 atom：用 `get` 读两个计数，再把它们加起来。这两次读取也建立了依赖。之后任意一个计数变化，Jotai 就能找到需要重算的合计。

两个计数器加一行合计，已经能看出独立订阅和派生计算是怎么配合的。换到购物车，问题会变成哪些值要单独保存、哪些可以算出来，以及 atom 多了该怎么分组。

## 用两个 atom 写双计数器

先让两个计数器各读一个基础 atom，再加一个会随两者更新的合计。示例使用 Jotai v2，可以放进独立 React 项目的 `App.jsx`。

```jsx
import { Provider, atom, useAtom, useAtomValue } from 'jotai'

const firstCountAtom = atom(0)
const secondCountAtom = atom(0)
const totalAtom = atom((get) => get(firstCountAtom) + get(secondCountAtom))

function Counter({ label, countAtom }) {
  const [count, setCount] = useAtom(countAtom)
  return (
    <button type="button" onClick={() => setCount((previous) => previous + 1)}>
      {label}: {count}
    </button>
  )
}

function Total() {
  const total = useAtomValue(totalAtom)
  return <p>合计 {total}</p>
}

export default function App() {
  return (
    <Provider>
      <Counter label="count1" countAtom={firstCountAtom} />
      <Counter label="count2" countAtom={secondCountAtom} />
      <Total />
    </Provider>
  )
}
```

点击 `count1` 时，第一个计数器和合计的订阅值都变了。第二个计数器的订阅值保持原样，它仍可能因为父组件渲染等其他原因执行。把两个计数器都渲染两组，并为每组放置各自的 Provider，还可以观察到两棵子树的值互不影响。（[atom 文档](https://github.com/pmndrs/jotai/blob/main/docs/core/atom.mdx)、[useAtom 文档](https://github.com/pmndrs/jotai/blob/main/docs/core/use-atom.mdx)）

## atom 的定义、值和依赖

`atom(0)` 创建的是一个配置对象。store 按配置对象的引用保存和查找对应的状态，因此同一个 atom 配置可以在不同 store 里有不同的值。共享的 atom 通常定义在模块顶层。确实需要每个组件实例拥有自己的 atom 时，可以用 `useMemo` 或惰性 `useState` 稳定它的引用。

读取 `totalAtom` 时，Jotai 执行它的读函数，记录这次 `get` 访问了哪些 atom。在已挂载的依赖关系中，基础 atom 更新后，可以沿反向依赖找到需要重算的派生 atom。重算以后，如果派生值保持相等，其订阅组件不会因这次值更新而重新渲染。

依赖会随读函数的执行而变化。例如 `atom(get => get(showFirstAtom) ? get(firstCountAtom) : get(secondCountAtom))` 总会依赖 `showFirstAtom`，而两个计数器中只依赖当前分支读取的那个。写函数里的 `get` 则只用于此次写入时读取数据，不会建立读函数那样的依赖关系。（[Jotai store 实现](https://github.com/pmndrs/jotai/blob/main/src/vanilla/internals.ts)）

## 从依赖图到订阅通知

前面用 `totalAtom` 看到了派生依赖。下面用一个手写 store 展开这条链路，图中的字段名对应它的实现，`S` 表示 atom 状态，`M` 表示挂载信息。（[Jotai 简单实现](https://github.com/L-Qun/state-management-collection/blob/main/packages/jotai/package.json)）

![Jotai atom 的读取、写入和订阅流程](/m-picture/relearn-react-managing-state/jotai-atom-dependency-flow.jpg)

- `readAtom` 读取 atom，依赖记录保存在 atom 状态中。
- 建立订阅时，挂载信息会记录有哪些监听器，以及哪些 atom 依赖当前 atom。
- 写入 atom 时，store 可以沿反向依赖重算受影响的派生值，再通知相关监听器。
- React 组件通过 Provider 对应的 store 读取和订阅。只需要触发写入的组件可以使用 `useSetAtom`。

```text
┌──────────────────────────────────────────────────────────────────────┐
│                          createStore 内部结构                         │
└──────────────────────────────────────────────────────────────────────┘

                               ┌───────────────────┐
                               │   atomStateMap    │
                               │ WeakMap<Atom, S>  │
                               │   { v, d }        │
                               └───────────────────┘
                                         ▲
                          read(getter)   │   write(setter)
                                         │
                                ┌────────┴────────┐
                                │                 │
                                ▼                 ▼
                      ┌────────────────┐   ┌──────────────────┐
                      │  readAtomState │   │  writeAtomState  │
                      └────────────────┘   └──────────────────┘
                                │                 │
                                │    recompute    │
                                ▼                 ▼
                       ┌────────────────────────────┐
                       │         pendingMap         │
                       │ Map<Atom, prevState>       │
                       └────────────────────────────┘
                                │
                                │   flushPending()
                                ▼
                     ┌──────────────────────────┐
                     │  调用 mounted.l 中的 listeners │
                     │    → 触发组件重渲染            │
                     └──────────────────────────┘



──────────────────────────────── 订 阅 与 依 赖 ─────────────────────────────────

                      (组件订阅)
                           │
                     sub(atom, listener)
                           │
                           ▼
                   ┌──────────────────┐
                   │   mountedMap     │
                   │ WeakMap<Atom, M> │
                   │   l: Set<fn>,    │ ← 放 listener
                   │   t: Set<Atom>   │ ← dependents: 谁依赖我
                   │ }                │
                   └──────────────────┘
                           ▲
                           │
                     mountAtom()
                           │（读取 atomState.d）
                           ▼
          ┌───────────────────────────────────────────────────┐
          │   atomState.d = Map<dependencyAtom, depState>     │
          │   每次 readAtomState 会重建 atom 的依赖图           │
          └───────────────────────────────────────────────────┘


────────────────────────────── 读 的 完整链路 ───────────────────────────────

              readAtom(atom)
                    │
                    ▼
             readAtomState(atom)
                    │
           构造 getter() 递归 get 其他 atom
                    │
                    ▼
             atomState.d 更新依赖图
                    │
              setAtomValue() 写入 atomStateMap
                    │
                    ▼
          pendingMap.set(atom, prevState)


────────────────────────────── 写 的 完整链路 ───────────────────────────────

              writeAtom(atom, newValue)
                    │
                    ▼
             writeAtomState()
                    │
            setAtomValue() 写入 atomStateMap
                    │
     状态改变？ → 是 → recomputeDependents(atom)
                    │
                    ▼
          让所有依赖该 atom 的派生 atom 重新 read
                    │
                    ▼
               pendingMap 记录变更
                    │
                    ▼
              flushPending()
                    │
                    ▼
       mounted.l.forEach(listener) → 组件渲染


────────────────────────────── 三 个 Map 的 职 责 ───────────────────────────────

atomStateMap
  → 存 **每个 atom 的当前值 v** 和 **依赖 d**

mountedMap
  → 存 **订阅它的组件 listener（l）**
  → 存 **依赖这个 atom 的其他 atom（t）**

pendingMap
  → 写（setAtomValue）时记录“哪个 atom 变了”
  → flush 时逐个触发 listener


────────────────────────────── 记 忆 法 ───────────────────────────────

atomStateMap：存“值”和“我依赖谁”
mountedMap：存“谁依赖我”和“谁订阅我”
pendingMap：存“谁最近变了，等 flush 通知组件”


```

## 并发渲染中的快照一致性

前面的实验观察的是哪些组件收到更新。并发渲染还涉及快照一致性。同一次提交里，组件是否读到了同一版本的状态？如果两个消费者读到了不同版本，就会出现状态撕裂。Jotai 的 `useAtomValue` 通过 React 的 reducer 和 store 订阅更新读取结果。使用 `useSyncExternalStore` 的外部 store 则有另一条路径。React 会在非阻塞 Transition 提交前重新读取快照，发现快照已经改变时回退到阻塞更新。具体表现要结合库版本和更新路径来看。（[Jotai 的 useAtomValue 实现](https://github.com/pmndrs/jotai/blob/main/src/react/useAtomValue.ts)、[React 的快照一致性说明](https://react.dev/reference/react/useSyncExternalStore#caveats)）

## atom 多了怎么组织

回到双计数器，两个基础 atom 的依赖关系一眼就能看清。购物车、筛选和表单都放进来后，需要先确定谁负责保存数据、谁负责派生、谁可以写入。

- 让每个 atom 聚焦一个职责。独立变化的数据可以放到不同的 atom 中，以缩小订阅范围。
- 将关系密切的 atom 放在同一个业务模块中，便于查看依赖。
- 用派生 atom 表达计算关系，复杂逻辑可以由多个 atom 组合完成。
- 只需要写入的组件可以调用 `useSetAtom`，避免订阅自己用不到的值。

### 按业务领域拆分

- 按购物车、筛选、表单等业务领域拆分。
- 将 atom 分为三层：base（数据）、derived（计算）、action（行为）
- 使用 `atomFamily` 或工厂函数减少重复创建
- 把计算逻辑放到派生 atom 中，避免组件层拼状态
- 通过自定义 Hook 或业务模块封装 atom，避免直接暴露细节

把每个 atom 当作依赖图上的节点，命名和分组就能反映它与其他 atom 的关系。

### 用购物车串起三种 atom

以购物车为例，数量是基础状态，总件数可以派生，加入商品则是一个动作。同一条写入规则放在写 atom 中后，商品列表和商品详情页就能复用同一个入口。

```jsx
import { atom, useAtomValue, useSetAtom } from 'jotai'

const quantitiesAtom = atom({})
const totalItemsAtom = atom((get) =>
  Object.values(get(quantitiesAtom)).reduce((total, quantity) => total + quantity, 0)
)

const addItemAtom = atom(null, (_get, set, productId) => {
  set(quantitiesAtom, (previous) => ({
    ...previous,
    [productId]: (previous[productId] ?? 0) + 1,
  }))
})

export function useCartItemCount() {
  return useAtomValue(totalItemsAtom)
}

export function useAddCartItem() {
  return useSetAtom(addItemAtom)
}
```

只调用 `useAddCartItem` 的按钮不会订阅购物车的值。合计由数量推导，数量修改后无需再同步更新第二份数据。内部可以调整 atom 的组织方式，调用方继续使用原来的 Hook。

### 什么时候需要按 ID 创建 atom

如果列表里每行都有独立的编辑状态，组件卸载后也需要在同一个 store 中保留这份状态，可以用 `atomFamily` 按稳定的业务 ID 复用 atom。若编辑状态只在一行的挂载期间使用，行组件自己的 `useState` 已经足够。

`atomFamily` 会缓存参数和 atom 的映射。临时 ID 会持续增长时，应在业务确认条目永久移除后清理缓存，例如调用 `family.remove(id)`。只卸载组件不会清除这个映射。新代码可以使用独立的 `jotai-family` 包，Jotai 文档已将 `jotai/utils` 中的 family 入口标为弃用。（[atomFamily 文档](https://github.com/pmndrs/jotai/blob/main/docs/utilities/family.mdx)）

## 怎么验证拆分有效

用 React DevTools 录制分别点击两个计数器的操作，看变化是否落在对应计数器和合计上。再换成购物车的真实交互，观察修改一行时，其他行是否因共用一个大对象而重新渲染。拆分的依据是哪些数据独立变化、有哪些读者，以及状态需要存活多久。
