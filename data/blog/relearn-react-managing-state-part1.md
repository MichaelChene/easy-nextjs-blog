---
title: '重学 React 状态管理 - Context 篇'
date: '2023/06/21'
lastmod: '2023/07/07'
tags: [react, redux, context]
draft: false
summary: '只改了一个计数，为什么另一个组件也重新渲染？从双计数器看 Context 怎么传值、怎么传播更新，以及什么时候适合拆分 Context。'
images: ['/static/images/16350881224248.jpg']
layout: PostLayout
hidePostNavigation: true
---

只点了第一个计数器的按钮，控制台却打印了 `Count2 render`。第二个计数值没变，组件也用了 `memo`，这次渲染是怎么来的？

要解释这条日志，得弄清两个问题：组件从哪个 Provider 取值，以及 React 比较的是整个 `value` 还是组件用到的字段。把这两点分清，再看稳定对象引用、拆分 Context 各能解决什么问题。

## 从组件状态到共享状态

主题可以保存在上层组件的 `useState` 或 `useReducer` 里，由 Context 把当前值传给子树。用户切换主题时，状态更新发生在持有它的组件中，读取主题的组件随后拿到新的值。

### 心智模型

- 在**不可变状态模型**下，每次渲染看到的是当次的状态快照。更新对象时创建新对象，未改变的部分可以保留原引用。例如用 `setSettings(prev => ({ ...prev, theme: 'dark' }))` 更新主题，React 可以通过引用变化识别这次更新。
- 在**可变状态模型**下，对象可以原地修改，由代理、显式订阅等机制通知读者。接入 React 时，外部 store 仍需要提供可比较的快照，React 才能判断哪次读取看到了新数据。

把一个对象放进 Context 后直接改它的属性，Provider 的 `value` 引用依然相同，React 不会因此发出 Context 更新。消费者如果随后因为别的原因重新渲染，才可能读到修改后的字段，这会让不同组件的更新时机变得难以预测。

### 状态管理库要解决的问题

最基本的是在合适的范围内读写状态。规模再大一些，才需要考虑按字段订阅、订阅清理、并发渲染下的快照一致性，或者把数据持久化到浏览器。持久化和内存占用取决于应用如何保存数据、维护缓存和清理订阅，跟采用哪种传值方式是两回事。

## Context 如何查找数据

以主题为例。页面大部分区域可以共用一个主题，局部仍能覆盖它。

`createContext(defaultValue)` 创建一个 Context。在组件里调用 `useContext` 时，React 沿组件树向上找最近的同一个 Context 的 Provider。内层 Provider 可以覆盖外层的值，覆盖范围是它自己的子树。没有匹配的 Provider 时，组件才会拿到 `defaultValue`。如果最近的 Provider 显式传了 `undefined`，读到的就是 `undefined`。

```jsx
import { createContext, useContext } from 'react'

const ThemeContext = createContext('light')

function ThemeLabel({ name }) {
  const theme = useContext(ThemeContext)
  return (
    <p>
      {name}：{theme}
    </p>
  )
}

export default function App() {
  return (
    <>
      <ThemeLabel name="默认主题" />
      <ThemeContext.Provider value="dark">
        <ThemeLabel name="外层主题" />
        <ThemeContext.Provider value="light">
          <ThemeLabel name="内层主题" />
        </ThemeContext.Provider>
        <ThemeLabel name="外层的另一个子组件" />
      </ThemeContext.Provider>
    </>
  )
}
```

四行依次显示 `light`、`dark`、`light`、`dark`。查找从调用 `useContext` 的组件上方开始，所以在一个组件里读取 Context，再在它返回的 JSX 里添加 Provider，后者只对其后代生效。本文使用 React 17、18 都支持的 `<ThemeContext.Provider>` 语法。React 19 起也可以直接写 `<ThemeContext value="dark">`。（[createContext 文档](https://zh-hans.react.dev/reference/react/createContext)、[useContext 文档](https://zh-hans.react.dev/reference/react/useContext)）

## Context 为什么会引起额外渲染

主题例子说明了组件会读到哪个 Provider。接下来把主题换成两个会变化的计数值，看看这两个消费者何时会收到更新。React 用 `Object.is` 比较同一个 Provider 上的旧 `value` 和新 `value`。只要比较结果不同，读取该 Provider 的消费者就会收到 Context 更新。React 记录的依赖是整个 Context，解构 `count2` 只影响组件拿到值以后怎么用它。

下面用两个计数器复现这个行为。`Count2` 特意用了 `memo`，用于排除相同 props 下由父组件渲染引起的干扰。代码可以放进 React 项目的 `App.jsx`。如果项目使用经典 JSX 转换，请在导入列表里加上默认导入 `React`。

```jsx
import { createContext, memo, useContext, useState } from 'react'

const CounterContext = createContext(null)

function Count1() {
  const { count1, setCount1 } = useContext(CounterContext)
  console.log('Count1 render')

  return (
    <button type="button" onClick={() => setCount1((previous) => previous + 1)}>
      count1: {count1}
    </button>
  )
}

const Count2 = memo(function Count2() {
  const { count2, setCount2 } = useContext(CounterContext)
  console.log('Count2 render')
  return (
    <button type="button" onClick={() => setCount2((previous) => previous + 1)}>
      count2: {count2}
    </button>
  )
})

function StateProvider({ children }) {
  const [count1, setCount1] = useState(0)
  const [count2, setCount2] = useState(0)

  return (
    <CounterContext.Provider value={{ count1, count2, setCount1, setCount2 }}>
      {children}
    </CounterContext.Provider>
  )
}

export default function App() {
  return (
    <StateProvider>
      <Count1 />
      <Count2 />
    </StateProvider>
  )
}
```

![点击 count1 后，两个消费者都打印了渲染日志](/m-picture/relearn-react-managing-state-part1/context-consumer-rerender.gif)

点击按钮后，`count1` 和 Provider 的 `value` 都变了，两个消费者都会执行渲染逻辑。`Count2` 仍然显示 0。类似地，即使所有字段的内容都没变，只要 Provider 在别的更新中重新创建了 `value` 对象，`Object.is` 也会得到 `false`。

控制台日志记录的是组件函数被调用的次数，开发模式下 Strict Mode 还可能额外调用它。要判断这次更新有没有性能影响，可以在 React DevTools 的 Profiler 里录制同一次点击，检查提交中涉及哪些组件，以及渲染花了多少时间。（[React Profiler 文档](https://react.dev/reference/react/Profiler)）

## 源码实现

为什么主题能在内层覆盖后恢复，双计数器的更新又能穿过 `memo`？沿着 React 18.2.0 的渲染过程，可以把两种行为串起来。函数名和字段属于 Reconciler 内部实现，其他版本的组织方式可能不同。

### 创建 Context 与进入 Provider

`createContext(defaultValue)` 创建 Context 对象，初始化 `_currentValue` 和 `_currentValue2`，并设置 Provider、Consumer。两个值槽用于区分主渲染器和次渲染器。

渲染进入一个 Provider 时，`pushProvider` 把此前的值压栈，再写入当前 Provider 的 `value`。离开这个 Provider 时，`popProvider` 恢复之前的值。回到主题示例，进入内层 Provider 后读到 `light`，渲染完内层子树后恢复成 `dark`，所以后面的兄弟组件依然读到外层主题。（[ReactContext.js](https://github.com/facebook/react/blob/v18.2.0/packages/react/src/ReactContext.js)、[ReactFiberNewContext.old.js](https://github.com/facebook/react/blob/v18.2.0/packages/react-reconciler/src/ReactFiberNewContext.old.js#L80)）

### 读取 Context 并记录依赖

函数组件调用 `useContext` 时，Reconciler 通过 `readContext` 取出当前渲染器可见的值，并把读取过的 Context 及当时读到的值记到当前 Fiber 的依赖列表里。列表从 `dependencies.firstContext` 开始，组件可以在同一次渲染中读取多个 Context。

这段记录的粒度就是 Context 本身。组件之后执行 `const { count2 } = value`，并不会给依赖列表补上一条 `count2` 的字段订阅。（[React 18.2.0 的 readContext 实现](https://github.com/facebook/react/blob/v18.2.0/packages/react-reconciler/src/ReactFiberNewContext.old.js#L610)）

### 传播变更并标记更新

在 React 18.2.0 的即时传播路径上，`updateContextProvider` 用 `Object.is` 比较前后的 `value`。发生变化时，`propagateContextChange` 查找子树中依赖这个 Context 的 Fiber，把本次渲染的 lane 合并到匹配组件的更新标记中，并在父路径上标记 `childLanes`。同一个 Context 的内层 Provider 会覆盖外层值，因此传到它的那一路更新会在这里停下，只要它自己的值没有变化，它的消费者就不会因外层值变化而收到 Context 更新。

`lanes` 表示当前 Fiber 的待处理更新，`childLanes` 表示后代的待处理更新。在双计数器例子中加一层中间组件，就能看到这两个标记如何把更新传到消费者。

```text
CounterContext.Provider     value 变了，开始传播
└─ 中间组件                 childLanes：后代有更新
   ├─ Count1                lanes：依赖 CounterContext
   └─ Count2（memo）        lanes：依赖 CounterContext
```

中间组件即使自己的 props 没变，React 也能继续向下处理标记过的消费者。同样，Provider 的 `value` 相同只代表没有这次 Context 值更新，子树里的 props、state 或其他 Context 依然可能有工作要做。（[Provider 的 beginWork 处理](https://github.com/facebook/react/blob/v18.2.0/packages/react-reconciler/src/ReactFiberBeginWork.old.js#L3032)、[Context 的传播实现](https://github.com/facebook/react/blob/v18.2.0/packages/react-reconciler/src/ReactFiberNewContext.old.js#L222)）

## 如何减少额外渲染

依赖粒度既然是整个 Context，可以先检查 `value` 是否真的变了，再决定要不要缩小订阅范围。

### 稳定 Provider 的 value

如果重渲染来自 Provider 得到了一个内容相同的新对象，可以把前例的 `value` 用 `useMemo` 稳定下来，并把 `useMemo` 加入 React 的导入列表。

```jsx
const value = useMemo(() => ({ count1, count2, setCount1, setCount2 }), [
  count1,
  count2,
  setCount1,
  setCount2,
])

return <CounterContext.Provider value={value}>{children}</CounterContext.Provider>
```

Provider 因其他状态重新渲染时，依赖项没变就可以复用原来的对象。点击 `count1` 时，依赖项发生变化，两个消费者仍会收到 Context 更新。如果重新创建的函数也是 `value` 的字段，可以用 `useCallback` 稳定它，并列出它读取的依赖。例子里的 `setCount1` 和 `setCount2` 由 React 提供，引用保持稳定。（[官方的对象与函数优化示例](https://zh-hans.react.dev/reference/react/useContext#optimizing-re-renders-when-passing-objects-and-functions)）

### 拆分更新频率不同的 Context

如果 `count1` 确实变了，复用整个对象就不合适了。两个计数值独立更新时，可以让 `Count1` 和 `Count2` 分别读取 `Count1Context` 和 `Count2Context`。下面替换前例的 `StateProvider`，沿用两个计数器原本的读写逻辑。

```jsx
const Count1Context = createContext(null)
const Count2Context = createContext(null)

function StateProvider({ children }) {
  const [count1, setCount1] = useState(0)
  const [count2, setCount2] = useState(0)
  const value1 = useMemo(() => ({ count1, setCount1 }), [count1, setCount1])
  const value2 = useMemo(() => ({ count2, setCount2 }), [count2, setCount2])

  return (
    <Count1Context.Provider value={value1}>
      <Count2Context.Provider value={value2}>{children}</Count2Context.Provider>
    </Count1Context.Provider>
  )
}
```

点击 `count1` 时，`value2` 的依赖项都没变，`Count2` 就不会收到 Context 更新。实际项目里可以在业务功能自己的 Provider 组件里组合这些 Context，也可以把 Provider 下移到实际使用它的子树。

有时按「读状态」和「发操作」来拆更自然。例如任务列表读取 `TasksContext`，新增按钮只从 `TasksDispatchContext` 读取 `useReducer` 返回的 `dispatch`。任务列表更新时，`dispatch` 的引用保持稳定，新增按钮不会因为订阅了它而收到这次 Context 更新。（[使用 Reducer 和 Context 拓展你的应用](https://zh-hans.react.dev/learn/scaling-up-with-reducer-and-context)）

### 让渲染开销较大的组件只接收 props

如果暂时保留一个大 Context，可以让外层组件读取 Context，再把内层组件真正需要的数据通过 props 传下去。

```jsx
const Count2View = memo(function Count2View({ count2 }) {
  return <span>count2: {count2}</span>
})

function Count2() {
  const { count2, setCount2 } = useContext(CounterContext)
  return (
    <button type="button" onClick={() => setCount2((previous) => previous + 1)}>
      <Count2View count2={count2} />
    </button>
  )
}
```

点击 `count1` 后，`Count2` 仍会执行，但传给 `Count2View` 的数字没变，视图组件可以跳过这次渲染。缓存 JSX 也可以帮助跳过由父级渲染引起的工作。只要组件本身订阅的 Context 发生变化，缓存 JSX 或给这个组件加 `memo` 都挡不住这次 Context 更新。（[memo 文档](https://react.dev/reference/react/memo#updating-a-memoized-component-using-a-context)）

### 用 selector 按字段订阅

React 的公开 `useContext` API 接收一个 Context 参数。社区讨论过给原生 Context 增加 selector，目前可以通过 `use-context-selector` 体验这种写法。Provider 可以沿用双计数器例子的写法。用库里的 `createContext` 创建 Context 后，把两个计数器都改成用 `useContextSelector` 读取所需的字段。（[Context selectors RFC](https://github.com/reactjs/rfcs/pull/119)、[use-context-selector 文档](https://github.com/dai-shi/use-context-selector)）

```jsx
import { createContext, useContextSelector } from 'use-context-selector'

const CounterContext = createContext(null)

function Count2() {
  const count2 = useContextSelector(CounterContext, (value) => value.count2)
  const setCount2 = useContextSelector(CounterContext, (value) => value.setCount2)

  return (
    <button type="button" onClick={() => setCount2((previous) => previous + 1)}>
      count2: {count2}
    </button>
  )
}
```

Provider 更新时，这个订阅关心的是 selector 的返回值。返回 `value.count2` 这样一个数字，比较结果很直观。如果写成 `value => ({ count2: value.count2 })`，每次调用都会创建新对象，字段相同也会被判为变化。需要少量字段时，可以分别选择它们。selector 显式选了哪些字段，订阅就关心哪些字段，即使某个渲染分支暂时没用到其中一个。

selector 缩小的是订阅触发更新的范围。父组件自身重新渲染，依然可能带着消费者一起渲染。库文档的例子会把 `children` 在 Provider 外创建，或通过 `memo` 稳定相关组件，避免把两种更新混在一起观察。（[use-context-selector 的使用限制](https://github.com/dai-shi/use-context-selector#limitations)）

## 手写一个按字段订阅的外部 store

组件已经能通过 selector 只读取自己需要的字段。再往前一步，可以把频繁变化的状态放到外部 store 中，让 Provider 稳定地传递 store 实例。`useSyncExternalStore` 则负责订阅和读取快照。React Redux 也用 Context 传递 store 和订阅相关的数据，组件通过 `useSelector` 选择状态。下面的双计数器示例使用 React 18 起提供的 `useSyncExternalStore`。（[React Redux 如何访问 store](https://redux.js.org/react-redux/using-react-redux/accessing-store)、[useSyncExternalStore 文档](https://react.dev/reference/react/useSyncExternalStore)）

```jsx
import { createContext, useCallback, useContext, useState, useSyncExternalStore } from 'react'

const CounterStoreContext = createContext(null)

function createCounterStore(initialState) {
  let state = initialState
  const listeners = new Set()

  return {
    getState: () => state,
    getInitialState: () => initialState,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    increment(name) {
      state = { ...state, [name]: state[name] + 1 }
      listeners.forEach((listener) => listener())
    },
  }
}

function CounterProvider({ children }) {
  const [store] = useState(() => createCounterStore({ count1: 0, count2: 0 }))
  return <CounterStoreContext.Provider value={store}>{children}</CounterStoreContext.Provider>
}

function Counter({ name }) {
  const store = useContext(CounterStoreContext)
  const getSnapshot = useCallback(() => store.getState()[name], [store, name])
  const getServerSnapshot = useCallback(() => store.getInitialState()[name], [store, name])
  const count = useSyncExternalStore(store.subscribe, getSnapshot, getServerSnapshot)

  return (
    <button type="button" onClick={() => store.increment(name)}>
      {name}: {count}
    </button>
  )
}

export default function App() {
  return (
    <CounterProvider>
      <Counter name="count1" />
      <Counter name="count2" />
    </CounterProvider>
  )
}
```

每个 `CounterProvider` 各自创建一个 store。同一次挂载期间，Provider 的 `value` 始终指向这个实例。点击 `count1` 时，store 先保存新状态，再通知两个订阅者。React 重新读取快照时发现只有 `count1` 的数字变了，所以只有订阅它的组件需要因为本次 store 更新而重新渲染。这里还是通知了所有订阅者，依靠快照比较省掉的是后续的渲染。

- **快照要可复用。** 状态没变时，多次调用 `getSnapshot` 应返回同一个值。示例直接返回数字，所以天然满足这个条件。如果需要返回多个字段，可以保留未变化对象的引用，或者使用 `use-sync-external-store` 包提供的 `with-selector` 入口，传入 selector 和可选的相等函数。直接在 `getSnapshot` 里每次拼一个新对象，可能导致 React 反复尝试更新。（[快照缓存要求](https://react.dev/reference/react/useSyncExternalStore#im-getting-an-error-the-result-of-getsnapshot-should-be-cached)、[with-selector 实现](https://github.com/facebook/react/blob/v18.2.0/packages/use-sync-external-store/src/useSyncExternalStoreWithSelector.js)）
- **服务端渲染和客户端水合的初始数据要一致。** `getServerSnapshot` 在服务端渲染和客户端水合时都要能读到同一份初始数据。这里的两个计数都从 0 开始。如果初始数据来自服务端请求，需要把它随页面传到客户端，并用它初始化客户端的 store。（[useSyncExternalStore 的服务端渲染说明](https://react.dev/reference/react/useSyncExternalStore#adding-support-for-server-rendering)）

对于依赖 props 的 selector，还要考虑更新顺序。例如子组件用 `props.id` 查一条待办，用户删除这条待办时，store 里的记录可能已经消失，而父组件还没来得及移除子组件。读取时处理记录不存在的情况，比假定 selector 每次都能按 id 取到数据更稳妥。这个边界在 React Redux 文档里称为 stale props 和 zombie children。（[React Redux 的订阅顺序说明](https://redux.js.org/react-redux/api/hooks#stale-props-and-zombie-children)）

## 总结

主题、语言、当前页面的操作入口，通常用 Context 就能传得很清楚。遇到更新问题时，先用 Profiler 看一次具体交互。如果相同内容反复创建了新对象，可以稳定 `value`。两份状态各自变化，可以拆 Context。如果同一份状态更新频繁、消费者又只读取其中一小部分，才值得引入 selector 或外部 store。

### 延伸阅读

- [使用 Context 深层传递参数](https://zh-hans.react.dev/learn/passing-data-deeply-with-context)
- [2023 再谈前端状态管理](https://mp.weixin.qq.com/s/F6UAmEP9VXEHNZz7VWwxbA)
- [掘金小册：深入浅出 React 状态管理库](https://juejin.cn/book/7311970169411567626)
- [从 0 实现 use-context-selector](https://juejin.cn/post/7197972831795380279)
