---
title: '重学 React 状态管理 - Redux 篇'
date: '2023/07/22'
lastmod: '2023/07/22'
tags: [react, redux, redux toolkit, state management]
draft: false
summary: '顺着一次 dispatch 看 Redux 怎么保存状态、通知订阅者，再用 Redux Toolkit 写同样的双计数器，看看哪些配置可以交给工具处理。'
images: ['/static/images/16350881224248.jpg']
layout: PostLayout
hidePostNavigation: true
---

手写 Redux store 时，`state = reducer(state, action)` 算出并保存下一份状态。接下来，store 会通知订阅者。到了 React 这一层，`useSelector` 还要比较前后两次选出的值，才能决定组件需不需要更新。

从这行代码出发，可以把一次 `dispatch` 的前后串起来。等 action、reducer 和订阅是怎么配合的都清楚了，就容易看懂 Redux Toolkit 把哪些配置收进了 `configureStore`。

## 一次 `dispatch` 发生了什么

Redux store 的三个核心方法是 `getState`、`dispatch` 和 `subscribe`。一个普通的同步 action 会经过以下步骤。

1. store 创建时先发出内部初始化 action，根 reducer 返回初始状态。
2. 调用 `dispatch(action)` 后，根 reducer 根据当前状态和 action 算出下一份状态。store 保存结果。
3. store 按本次通知使用的订阅列表调用监听器。监听器通过 `getState()` 读取当前状态，订阅时返回的函数可以取消订阅。
4. React Redux 收到通知后读取快照。对 `useSelector` 而言，选择结果是否相等，决定这次订阅更新是否需要组件重新渲染。

Redux 核心会在 dispatch 后通知监听器，即使 reducer 返回了原引用。通知监听器和触发组件渲染是两个步骤。订阅列表在通知期间可以被修改，Redux 用快照隔离进行中的遍历。（[Redux createStore 源码](https://github.com/reduxjs/redux/blob/master/src/createStore.ts)、[React Redux Hooks](https://redux.js.org/react-redux/api/hooks)）

### `combineReducers` 和 middleware 在哪里

`combineReducers` 把多个 slice reducer 组合起来。根 reducer 会把同一个 action 和各自的旧子状态交给每个 slice reducer。没有相关处理逻辑的 slice 返回旧引用。如果所有子状态和键集合都保持原样，组合后的根状态也可以复用旧引用。

middleware 包装的是 `dispatch`。例如日志中间件可以在 `next(action)` 前后读状态，thunk 中间件可以接收函数，让函数通过 `dispatch` 和 `getState` 协调异步流程。真正进入 reducer 的普通 action 仍通过同步计算得到下一份状态。请求、计时器等副作用放在 thunk、中间件或应用的其他位置，reducer 保持可重复执行。（[combineReducers 源码](https://github.com/reduxjs/redux/blob/master/src/combineReducers.ts)、[applyMiddleware 源码](https://github.com/reduxjs/redux/blob/master/src/applyMiddleware.ts)）

## 用简化版 store 串起这些步骤

下面的示意图和实现把 store、reducer 与 middleware 放到同一条链路上。可以沿着最后几次 `dispatch` 回看 action 如何进入对应的 reducer。

![Redux 数据流示意图](/m-picture/relearn-react-managing-state/redux-data-flow.gif)

```js
// 闭包与发布订阅模式

function createStore(reducer, enhancer) {
  if (enhancer && typeof enhancer === 'function') {
    const newCreateStore = enhancer(createStore)
    return newCreateStore(reducer)
  }

  let state
  let listeners = []

  function getState() {
    return state
  }

  function subscribe(listener) {
    listeners.push(listener)
  }

  function dispatch(action) {
    state = reducer(state, action)
    for (let i = 0; i < listeners.length; i++) {
      const listener = listeners[i]
      listener()
    }
  }

  dispatch({ type: '@@redux/INIT' })

  return {
    getState,
    subscribe,
    dispatch,
  }
}

function combineReducers(reducers) {
  return function (state = {}, action) {
    const nextState = {}
    for (let key in reducers) {
      nextState[key] = reducers[key](state[key], action)
    }
    return nextState
  }
}

const compose = (...funcs) => {
  if (!funcs.length) return (v) => v
  if (funcs.length === 1) return funcs[0]
  return funcs.reduce((pre, curr) => (...args) => pre(curr(...args)))
}

// function logger(state) {
//   const { getState } = state
//   // next = dispatch
//   return next => action => {
//     console.log('dispatching', action)
//     const result = next(action)
//     console.log('next state', getState())
//     return result
//   }
// }
function applyMiddleware(...middlewares) {
  return function (createStore) {
    return function (reducer) {
      const store = createStore(reducer)
      let dispatch = store.dispatch
      const middlewareAPI = {
        getState: store.getState,
        dispatch: (...args) => dispatch(...args),
      }
      const chain = middlewares.map((middleware) => middleware(middlewareAPI))
      dispatch = compose(...chain)(store.dispatch)
      return {
        ...store,
        dispatch,
      }
    }
  }
}

// ------------- 测试 -------------
function counterReducer(
  state = {
    count: 0,
  },
  action
) {
  switch (action.type) {
    case 'add':
      return {
        ...state,
        count: state.count + 1,
      }
    case 'minus':
      return {
        ...state,
        count: state.count - 1,
      }
    default:
      return state
  }
}

function colorReducer(
  state = {
    car: 'red',
  },
  action
) {
  switch (action.type) {
    case 'change_car_color':
      return {
        ...state,
        car: action.color,
      }
    default:
      return state
  }
}

function logger(state) {
  const { getState } = state
  // next = dispatch
  return (next) => (action) => {
    console.log('dispatching', action)
    const result = next(action)
    console.log('next state', getState())
    return result
  }
}

const store = createStore(
  combineReducers({
    counter: counterReducer,
    color: colorReducer,
  }),
  applyMiddleware(logger)
)
store.subscribe(() => {
  console.log(store.getState())
})

store.dispatch({ type: 'add' })
store.dispatch({ type: 'add' })
store.dispatch({ type: 'minus' })
store.dispatch({ type: 'change_car_color', color: 'blue' })

console.log(store.getState())
```

## 用 Redux Toolkit 配置 store

自己组装完 reducer 和 middleware 后，再看 `configureStore` 就容易了。它把组合 reducer、配置 thunk 和接入 DevTools 等工作集中到一个入口。

### `configureStore` 提供哪些默认配置

| 功能点           | `createStore`（旧方式）                   | `configureStore`（推荐方式）                           |
| ---------------- | ----------------------------------------- | ------------------------------------------------------ |
| 语法简洁         | ❌ 手动组合 reducer、middleware、DevTools | ✅ 一行搞定所有                                        |
| DevTools 支持    | ❌ 需手动配置                             | ✅ 默认开启                                            |
| 内置 thunk       | ❌ 需显式引入 middleware                  | ✅ 默认集成                                            |
| TypeScript 支持  | ❌ 类型需手动推导                         | ✅ 自动推导 dispatch、state 类型                       |
| Immer 支持       | 需自行编写不可变更新或接入 Immer          | 使用 `createSlice` 或 `createReducer` 时可直接修改草稿 |
| createSlice 支持 | ❌ action/reducer 手动分离                | ✅ 一步生成 reducer + action                           |
| 安全性检查       | ❌ 容易误用（如 dispatch 非对象）         | ✅ 自动发出警告                                        |

### 同一个 store 的两种配置

#### 使用 `createStore`

```ts
import { createStore, applyMiddleware, combineReducers } from 'redux'
import thunk from 'redux-thunk'

const rootReducer = combineReducers({
  counter: counterReducer,
  user: userReducer,
})

const store = createStore(rootReducer, applyMiddleware(thunk))
```

---

#### 使用 `configureStore`

```ts
import { configureStore } from '@reduxjs/toolkit'

const store = configureStore({
  reducer: {
    counter: counterReducer,
    user: userReducer,
  },
})
```

自动推导类型：

```ts
export type RootState = ReturnType<typeof store.getState>
export type AppDispatch = typeof store.dispatch
```

---

### Redux 文档如何建议配置 store

> **Redux Toolkit is the standard way to write Redux logic.**  
> All new Redux code should use Redux Toolkit.  
> — [Redux 官方文档](https://redux.js.org/introduction/why-rtk-is-recommended)

---

### 默认配置带来的变化

使用 `configureStore` 的好处总结如下：

- 更少的样板代码
- 更强的类型支持
- 更现代化的状态管理
- 更安全的默认配置（中间件、DevTools）
- 更强大的开发体验（配合 `createSlice`）

### 按业务组织 slice

将复杂、容易出错的 Redux 配置流程抽象成“少数核心 API + 内部约定”，提升可维护性和开发效率

- 抽象样板逻辑  
  自动封装 action/reducer 创建流程，让你专注于业务逻辑
- 集中式切片模型（slice）  
  状态 + reducer + actions 合并为一个文件，类似 dva 的 model
- 通过 Immer 实现不可变更新  
  可以对 Immer 草稿写 `state.count++`，最终生成不可变的新状态。
- 约定优于配置  
  默认集成 DevTools 和 thunk 中间件，store 类型可自动推导。
- TypeScript 类型支持  
  常见的状态和 action 类型可以从 store 或 slice 推导。
- 强烈鼓励模块组织结构  
  按业务模块组织切片，提升可维护性与解耦性

## 用 Redux Toolkit 写双计数器

一个 slice 把某个业务领域的初始状态和更新规则放在一起。把上面的配置用到双计数器上，可以同时看到 slice 怎么写、组件怎么发出 action。这个例子可放进安装了 `@reduxjs/toolkit` 和 `react-redux` 的独立 React 项目。这里在客户端模块里创建一个应用级 store。

```jsx
import { configureStore, createSlice } from '@reduxjs/toolkit'
import { Provider, useDispatch, useSelector } from 'react-redux'

const countersSlice = createSlice({
  name: 'counters',
  initialState: { count1: 0, count2: 0 },
  reducers: {
    incrementFirst(state) {
      state.count1 += 1
    },
    incrementSecond(state) {
      state.count2 += 1
    },
  },
})

const store = configureStore({
  reducer: { counters: countersSlice.reducer },
})

const { incrementFirst, incrementSecond } = countersSlice.actions
const selectFirst = (state) => state.counters.count1
const selectSecond = (state) => state.counters.count2

function Counter({ label, selectCount, increment }) {
  const count = useSelector(selectCount)
  const dispatch = useDispatch()

  return (
    <button type="button" onClick={() => dispatch(increment())}>
      {label}: {count}
    </button>
  )
}

export default function App() {
  return (
    <Provider store={store}>
      <Counter label="count1" selectCount={selectFirst} increment={incrementFirst} />
      <Counter label="count2" selectCount={selectSecond} increment={incrementSecond} />
    </Provider>
  )
}
```

`configureStore` 组合 reducer，并预设常用 middleware 和 DevTools 集成。`createSlice` 生成 reducer 和 action creator，点击第一个按钮后，DevTools 可以看到 `counters/incrementFirst` 以及变更前后的状态。这里的 `state.count1 += 1` 写在 Immer draft 上。Immer 会生成新的状态并保留未修改部分的引用。在其他地方读取 store 时，应把读到的状态当作不可变快照。（[configureStore](https://redux.js.org/toolkit/api/configureStore)、[createSlice](https://redux.js.org/toolkit/api/createSlice)）

## selector 如何决定更新范围

Provider 用 Context 传递 store 和订阅相关信息。点击 `count1` 后，`selectFirst` 返回新数字，`selectSecond` 仍返回旧数字。虽然 store 已发生更新，第二个计数器的选择结果通过了 `useSelector` 默认的严格相等比较，所以它不会被这次订阅更新带着渲染。

如果 selector 每次都返回 `{ count: state.counters.count2 }`，相同数字也会被包进不同的对象，默认比较就会判为变化。读取多个字段时可以分别调用 `useSelector`，也可以对小对象使用 `shallowEqual`。计算开销明显时，可用 `createSelector` 缓存派生结果。selector 可能被执行多次，应保持纯函数。（[React Redux 的相等比较](https://redux.js.org/react-redux/api/hooks#equality-comparisons-and-updates)）

依赖 props 的 selector 还要处理记录消失的情况。例如 `state.todos.entities[id]?.title` 可以处理列表删除某项时，子组件仍拿着旧 ID 的短暂窗口。这个问题源于父组件传下来的 props 与外部 store 通知的先后顺序。（[stale props 与 zombie children](https://redux.js.org/react-redux/api/hooks#stale-props-and-zombie-children)）

## 状态结构如何影响更新

selector 能否复用旧结果，也和 reducer 保留了哪些引用有关。状态结构复杂时，可以从三个地方入手。

1. 用 Immer 更新修改路径，保留其他分支的引用
2. 使用 normalized state（扁平化），将 state 扁平化管理，避免嵌套结构重复更新
3. 局部 reducer + combineReducers 拆分更新

## 把业务流程放到哪里

如果同一个事件会影响多个领域，可以让相关 slice 在 `extraReducers` 中响应同一个 action。例如结账成功后，购物车清空，订单列表记录新订单。Redux DevTools 中的一条事件就能对应完整的业务变化。只服务单个输入框的临时草稿留在组件里，跨页面共享或需要按 action 追踪的状态再进入 store。
