---
title: '重学 React 状态管理 - Zustand 篇'
date: '2023/07/24'
lastmod: '2023/07/24'
tags: [react, zustand, 状态管理]
draft: false
summary: '用两个计数器拆开 Zustand 的 store 和 React Hook，看看 set 怎么通知订阅者，以及 selector 返回什么值会影响组件更新。'
images: ['/static/images/16350881224248.jpg']
layout: PostLayout
hidePostNavigation: true
---

Zustand 的 `create` 返回一个可以在组件里调用的 Hook，上面还带着 `getState()`、`setState()` 等 store 方法。用 selector 可以让组件只订阅一个计数值；调用 `getState()` 则是读取当前状态。

这两种用法背后是同一个 store。点一下计数按钮，可以顺着这次写入看它怎样发出通知，以及 React 为什么能跳过另一个计数器的更新。

## 用 `create` 写双计数器

示例使用 Zustand v5 和 React 18 或以上。将下面的代码放进安装了 `zustand` 的 React 项目即可。

```jsx
import { create } from 'zustand'

const useCounterStore = create((set) => ({
  count1: 0,
  count2: 0,
  incrementFirst: () => set((state) => ({ count1: state.count1 + 1 })),
  incrementSecond: () => set((state) => ({ count2: state.count2 + 1 })),
}))

const selectFirst = (state) => state.count1
const selectSecond = (state) => state.count2
const selectIncrementFirst = (state) => state.incrementFirst
const selectIncrementSecond = (state) => state.incrementSecond

function Counter({ label, selectCount, selectIncrement }) {
  const count = useCounterStore(selectCount)
  const increment = useCounterStore(selectIncrement)

  return (
    <button type="button" onClick={increment}>
      {label}: {count}
    </button>
  )
}

export default function App() {
  return (
    <>
      <Counter label="count1" selectCount={selectFirst} selectIncrement={selectIncrementFirst} />
      <Counter label="count2" selectCount={selectSecond} selectIncrement={selectIncrementSecond} />
    </>
  )
}
```

第一个按钮调用 `incrementFirst` 后，第二个计数器的数字和动作函数引用都保持相同，因此它不会因这次 store 更新而重新渲染。如果把组件里的读取改成无参数的 `useCounterStore()`，组件订阅的就是整个状态对象。再次点击第一个按钮，两个组件的选择结果都会由于根状态引用变化而改变。（[Zustand React 实现](https://github.com/pmndrs/zustand/blob/main/src/react.ts)）

## 从 `setState` 到 React

写入和读取是两条相连的链路。第一张图展示 vanilla store 如何保存状态和管理监听器，第二张图展示 React 如何处理通知。点击第一个按钮后，store 发出通知，React 重新读取各个订阅选出的快照，再根据比较结果决定要不要更新组件。

![Zustand 状态容器与 React 订阅结构](/m-picture/relearn-react-managing-state/zustand-v4-store-and-react-subscriptions.jpg)

![Zustand 从状态变化到快照比较的流程](/m-picture/relearn-react-managing-state/zustand-state-update-flow.jpg)

## 用简化实现理解订阅

下面把图里的两层拆成代码。先看 store 怎样用一个 `Set` 管理监听器，再看 Hook 怎样读取和比较选择结果。

```ts
import { useCallback, useRef, useSyncExternalStore } from 'react'

type Subscribe = (listener: () => void) => () => void

type GetState<T> = () => T

type SetState<T> = (partial: T | Partial<T> | ((state: T) => T | Partial<T>)) => void

type StoreApi<T> = {
  setState: SetState<T>
  getState: GetState<T>
  subscribe: Subscribe
}

type StateCreator<T> = (setState: SetState<T>) => T

type EqualityFn<T> = (a: T, b: T) => boolean

// 默认比较函数（使用 Object.is）
const defaultEqualityFn = <T>(a: T, b: T) => Object.is(a, b)

/**
 * -----------------------------
 * createStore
 * -----------------------------
 * 创建一个最小的状态容器（类似 Zustand 内核）
 * 内部保存 state、listeners（订阅者），并提供 setState/getState/subscribe
 */
const createStore = <T>(createState: StateCreator<T>): StoreApi<T> => {
  // 订阅回调函数集合（每个 listener 都会收到状态变化通知）
  const listeners = new Set<(state: T) => void>()
  let state: T // store 内部状态

  /**
   * setState：修改状态并触发订阅者
   */
  const setState: SetState<T> = (partial) => {
    // 允许 (state) => newState 或 { partial } 或 newState
    const nextState = typeof partial === 'function' ? (partial as (s: T) => T)(state) : partial

    // 若没有变化，不触发更新
    if (Object.is(nextState, state)) return

    // 合并（若是对象则 shallow merge，否则直接替换）
    state =
      typeof nextState !== 'object' || nextState === null
        ? (nextState as T)
        : Object.assign({}, state, nextState)

    // 通知所有订阅者：状态变化了
    listeners.forEach((listener) => listener(state))
  }

  /**
   * getState：返回当前状态
   */
  const getState = () => state

  /**
   * subscribe：订阅状态变化
   * listener 通知 React 检查快照是否变化
   */
  const subscribe: Subscribe = (listener) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  // 初始化 state
  state = createState(setState)

  return { setState, getState, subscribe }
}

/**
 * -----------------------------
 * useStore
 * -----------------------------
 * 使用 React 18 的 useSyncExternalStore 实现：
 * - 订阅 store
 * - 选择 state slice
 * - 使用 equalityFn 比较选择结果，避免不必要的重新渲染
 */
function useStore<State, Slice>(
  api: StoreApi<State>,
  selector: (state: State) => Slice = api.getState as any,
  equalityFn: EqualityFn<Slice> = defaultEqualityFn
) {
  /**
   * ref 保存：
   * - 上一次的选择结果
   * - 最新 selector
   * - 最新 equalityFn
   *
   * 为什么用 ref？
   * getSnapshot 保持稳定的引用，通过 ref 读取最新的 selector 和 equalityFn。
   */
  const lastSliceRef = useRef<Slice>(undefined)
  const selectorRef = useRef(selector)
  const equalityFnRef = useRef(equalityFn)

  selectorRef.current = selector
  equalityFnRef.current = equalityFn

  /**
   * getSnapshot：
   * useSyncExternalStore 会在渲染时调用此函数
   *
   * 这里做了三件事：
   * 1. 通过 selector 取出 state slice
   * 2. 与上一次做比较
   * 3. 若不同 → 更新 sliceRef
   */
  const getSnapshot = useCallback(() => {
    const state = api.getState()
    const slice = selectorRef.current(state)
    const lastSlice = lastSliceRef.current

    // 第一次渲染或 slice 发生变化
    if (lastSlice === undefined || !equalityFnRef.current(lastSlice, slice)) {
      lastSliceRef.current = slice
      return slice
    }

    // 没变 → 返回旧值，避免触发组件刷新
    return lastSlice
  }, [api])

  /**
   * useSyncExternalStore：
   * - 订阅 subscribe
   * - 收到 store 通知后，调用 getSnapshot 检查快照是否变化
   */
  const slice = useSyncExternalStore(api.subscribe, getSnapshot, getSnapshot)

  return slice
}

/**
 * -----------------------------
 * create
 * -----------------------------
 * 对外暴露更多 Zustand 风格：
 * const useStore = create(...)
 * useStore(selector) → 获取某个状态片段
 * useStore.setState(...) → 修改
 */
export const create = <T>(createState: StateCreator<T>) => {
  const api = createStore(createState)

  /**
   * useBoundStore：
   * selector 不传则返回整个 state
   */
  const useBoundStore = <Slice = T>(
    selector?: (state: T) => Slice,
    equalityFn?: EqualityFn<Slice>
  ) => useStore<T, Slice>(api, selector ?? ((s) => s as any), equalityFn)

  // 把 API 添加到 Hook 上，实现：useStore.getState() / useStore.setState()
  Object.assign(useBoundStore, api)

  return useBoundStore as typeof useBoundStore & StoreApi<T>
}
```

## 浅合并与嵌套对象

vanilla store 提供 `getState`、`getInitialState`、`setState` 和 `subscribe`。对于前例，更新函数返回部分状态，store 默认将其与旧状态做一层浅合并，保存新的根对象，然后用新旧状态通知监听器。React 侧读取 selector 生成的快照，再判断它是否变化。普通的订阅通知并不会因为组件只选了一个字段而自动按字段分发。（[Zustand vanilla store 源码](https://github.com/pmndrs/zustand/blob/main/src/vanilla.ts)）

浅合并只处理顶层。如果 store 里还有 `filters` 对象，更新搜索词要为它创建新对象，保留其他过滤条件。

```js
set((state) => ({
  filters: { ...state.filters, keyword },
}))
```

直接修改原对象后继续返回同一引用，会让按引用比较的订阅读不到预期变化。`setState(nextState, true)` 则会替换整个状态，放在状态对象里的动作也需要随新状态一起提供。

如果嵌套更新很多，可以使用 Zustand 的 Immer 中间件。未变化的分支可以复用原引用。（[Zustand 文档](https://github.com/pmndrs/zustand)）

## v5 中 selector 的返回值要稳定

Zustand v5 的常规 `create` 路径使用 React 的 `useSyncExternalStore`。如果 selector 每次都新建数组或对象，即使底层数据保持不变，连续读到的快照也可能不同，导致反复更新。读取多个字段时，可以分别选择，或用 `useShallow` 复用浅比较相同的结果。

```jsx
import { useShallow } from 'zustand/react/shallow'

function Summary() {
  const [count1, count2] = useCounterStore(useShallow((state) => [state.count1, state.count2]))
  return <p>合计 {count1 + count2}</p>
}
```

浅比较只检查结果的第一层。结果里每次都新建的嵌套对象仍会被判为不同。复杂且昂贵的派生计算需要单独按输入缓存，`useShallow` 仍会运行 selector。如果确实需要自定义相等函数，可以用 `zustand/traditional` 中的 `createWithEqualityFn` 或 `useStoreWithEqualityFn`。这条路径用的是 `useSyncExternalStoreWithSelector`，并需要安装它所在的 `use-sync-external-store` 包。（[Zustand v5 迁移指南](https://zustand.docs.pmnd.rs/migrations/migrating-to-v5)、[traditional 实现](https://github.com/pmndrs/zustand/blob/main/src/traditional.ts)）

带 selector 缓存和相等函数的订阅实现还可以在底层快照未变时复用上次的选择结果。这个优化属于带缓存的实现路径，前面手写的 `getSelection` 展示了它如何工作。

## 什么时候需要多个 store 实例

上面的 `create` 在模块加载时创建一个 store，同一模块里的消费者共享它。如果页面上有两个编辑器，每个编辑器都需要按自己的初始数据创建状态，可以用 `zustand/vanilla` 的 `createStore` 为每个编辑器创建实例，用 Context 传实例，再用 `useStore(store, selector)` 读取。Provider 可以通过惰性 `useState` 在挂载期间保留同一个 store。服务端渲染时，同样需要让不同请求拥有独立的用户状态，并让客户端从与服务端一致的初始状态水合。（[Zustand 的 Next.js 指南](https://zustand.docs.pmnd.rs/guides/nextjs)）

回到双计数器，Redux 用 action 和 reducer 描述更新，Jotai 用 atom 和依赖关系描述订阅，Zustand 则把动作与状态放在同一个轻量的 store 里。三者都能实现按需渲染，实际差异在于应用需要怎样组织写入、派生数据和调试流程。
