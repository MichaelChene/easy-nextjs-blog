---
title: '小而美的Nice Modal'
date: '2024/05/29'
tags: ['React', '状态管理']
draft: false
summary: '同一个 Ant Design 弹窗被多个页面调用时，开关、参数和回调容易散落在各个入口。Nice Modal 用注册表和 Context 集中管理渲染，再用 Promise 返回结果。后记记录了弹窗界面如何随参数变化刷新，以及嵌套 Provider 下的调用归属。'
images: ['/static/images/avatar.png']
layout: PostLayout
---

用户列表里原本有一个「编辑」按钮，点开 Ant Design 的弹窗，改完名字就刷新当前行。后来详情页也加了「编辑」按钮。编辑表单可以共用，但详情页还得接上自己的开关状态、初始数据和保存回调。看起来只是多了一个入口，弹窗的管理逻辑却又接了一遍。

对这两个页面来说，真正需要的是把当前用户交给弹窗，等编辑结束后拿回结果。Nice Modal 把这段调用变成了 `await show(...)`。这个 Promise 从哪来，弹窗又是在哪里渲染的？先看原本由页面负责的那几件事。

## 传统 Ant Design 弹窗，麻烦出在哪

用 Ant Design 的受控 `<Modal>` 时，列表通过 `open` 决定弹窗是否显示，同时管理当前用户和输入框里的草稿。下面是列表组件里的相关片段，`user` 是当前行的数据，`onUserSaved` 用来更新列表。（[Ant Design 5.17.4 的 Modal 类型](https://raw.githubusercontent.com/ant-design/ant-design/5.17.4/components/modal/interface.ts)）

```tsx
const [open, setOpen] = useState(false)
const [editingUserId, setEditingUserId] = useState<number | null>(null)
const [name, setName] = useState('')

function startEdit(userId: number, currentName: string) {
  setEditingUserId(userId)
  setName(currentName)
  setOpen(true)
}

return (
  <>
    <button type="button" onClick={() => startEdit(user.id, user.name)}>
      编辑
    </button>
    <Modal
      open={open}
      onOk={() => {
        if (editingUserId === null) return
        onUserSaved({ userId: editingUserId, name })
        setOpen(false)
      }}
      onCancel={() => setOpen(false)}
    >
      <Input value={name} onChange={(event) => setName(event.target.value)} />
    </Modal>
  </>
)
```

只有一个入口时，开关、草稿和保存回调放在同一个组件里，读起来很直接。多个入口可以共用一个 `EditUserModal`，把草稿收进去。剩下的是谁来渲染它、谁接收结果。每个入口各自挂一份，开关和回调就分散到各处。把弹窗提到共同的父组件，则要把打开的方法传给各个入口，还要让保存结果回到发起调用的页面。

eBay 的 `@ebay/nice-modal-react` 把这部分协调交给了 Provider 和弹窗组件。弹窗仍然可以用 Ant Design 实现，发起调用的页面在 `await NiceModal.show(...)` 后处理自己的保存结果。（[eBay Nice Modal 仓库](https://github.com/eBay/nice-modal-react/tree/1.2.13)）

## 弹窗放在别处，调用留在原地

应用顶层放一个 `NiceModal.Provider` 后，列表、详情页和工具栏都可以用 `show(组件或 ID, 参数)` 打开编辑弹窗。调用方给出组件引用或注册过的 ID，Provider 根据状态把弹窗渲染出来。顺着这次调用看，Nice Modal 需要维护三份数据。

| 数据           | 作用                                                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 组件注册表     | 按 `modalId` 找到要渲染的组件和注册时的 props。传组件引用时，库可为它生成 ID 并注册。                                                      |
| Provider 状态  | 以 `modalId` 为键，记录 `args`、`visible`、`delayVisible` 和 `keepMounted` 等信息。默认通过 `useReducer` 管理，再通过 Context 提供给子树。 |
| Promise 回调表 | 按 ID 保存 `show()` 和 `hide()` 各自的 Promise 及其回调。它们放在模块里，和触发界面更新的状态分开。                                        |

以注册表驱动的渲染为例，`show` 派发动作创建状态条目，Provider 下的 `NiceModalPlaceholder` 按状态里的 ID 找到已注册的组件，用 ID 作为 React 的 key 进行渲染。`NiceModal.create` 返回的高阶组件会将运行时 `args` 传给业务组件，并通过内部 Context 提供当前 ID。业务组件用 `useModal()` 就能拿到 `visible`、`hide` 和 `resolve` 等控制方法。（[弹窗包装与渲染源码](https://github.com/eBay/nice-modal-react/blob/1.2.13/src/index.tsx#L359-L479)）

```text
调用方 show(组件或 ID, args)
  → reducer 写入 Provider 的弹窗条目
  → Placeholder 按 ID 查注册表
  → create 包装的组件接收 args
  → 弹窗内部 useModal() 读取状态并控制交互
```

首次打开还多一步。若组件尚未挂载，`show` 先写入 `delayVisible`，让组件挂载时保持隐藏。包装组件在 effect 里再次触发显示，随后 UI 库才收到打开状态，有机会播放进入动画。（[显示状态的 reducer 源码](https://github.com/eBay/nice-modal-react/blob/1.2.13/src/index.tsx#L109-L136)）

按需挂载能推迟业务组件的渲染和 effect。模块何时下载和解析，取决于组件是怎么导入和拆包的。想把这部分成本也推迟，可以把弹窗组件放进按需加载的模块。

## 用 Promise 接交互结果，用动画回调收尾

普通弹窗通常用 `onOk` 把数据传回父组件。Nice Modal 可以让调用方留在原来的业务函数里 `await show()`，弹窗内决定何时交付结果。这里有三个时间点，分清它们就知道取消、关闭动画和卸载应该各归谁管。

- `resolve(data)` 或 `reject(error)` 结算的是 `show()` 返回的 Promise。取消可以约定返回 `null`，也可以显式 `reject()`，后者需要调用方处理拒绝。
- `hide()` 把 `visible` 改成 `false`，返回的是等待关闭完成的另一份 Promise。这份实现会在调用 `hide()` 时清掉 `show()` 的回调引用。如果业务还在等结果，要先结算，再关闭。仅调用 `hide()` 或 `remove()`，原来的 `await show()` 可能一直等下去。（[关闭与移除源码](https://github.com/eBay/nice-modal-react/blob/1.2.13/src/index.tsx#L244-L273)）
- 退出动画结束后，由 Ant Design 的 `afterClose`、MUI 对应的退出回调或适配器调用 `resolveHide()`，再按需 `remove()`。开启 `keepMounted` 时，适配器可以跳过移除，保留组件及其本地状态。（[弹窗关闭适配器源码](https://github.com/eBay/nice-modal-react/blob/1.2.13/src/index.tsx#L534-L607)）

下面还是编辑用户名的例子。调用方把用户 ID 和当前名称一起传入，确认后用日志展示收到的结果。点击取消、遮罩或关闭按钮，或者按 Esc，都会走 `onCancel`，返回 `null`。

```tsx
import { useState } from 'react'
import { Input, Modal } from 'antd'
import NiceModal, { useModal } from '@ebay/nice-modal-react'

type EditResult = { userId: number; name: string }

const MyEditModal = NiceModal.create(
  ({ userId, currentName }: { userId: number; currentName: string }) => {
    const modal = useModal()
    const [name, setName] = useState(currentName)

    function closeWith(result: EditResult | null) {
      modal.resolve(result)
      void modal.hide()
    }

    return (
      <Modal
        title={`编辑用户 ${userId}`}
        open={modal.visible}
        onOk={() => closeWith({ userId, name })}
        onCancel={() => closeWith(null)}
        afterClose={() => {
          modal.resolveHide()
          if (!modal.keepMounted) modal.remove()
        }}
      >
        <Input value={name} onChange={(event) => setName(event.target.value)} />
      </Modal>
    )
  }
)

NiceModal.register('edit-user', MyEditModal)

async function editUser() {
  const result = await NiceModal.show<EditResult | null>('edit-user', {
    userId: 1,
    currentName: '小林',
  })
  if (result !== null) console.log('用户编辑后的数据:', result)
}

export default function App() {
  return (
    <NiceModal.Provider>
      <button type="button" onClick={() => void editUser()}>
        编辑用户
      </button>
    </NiceModal.Provider>
  )
}
```

同一个 ID 对应同一份弹窗状态。如果第一次 `show()` 还在等待结果，再次用同一个 ID 调用 `show()` 会更新入参，并复用还在回调表里的 Promise。需要同时开启两次独立编辑时，要为两个实例分配不同的 ID。（[弹窗打开与 Promise 复用源码](https://github.com/eBay/nice-modal-react/blob/1.2.13/src/index.tsx#L218-L242)）

## 项目里遇到的两个问题

前面的编辑弹窗打开时传一次数据，整个页面共用一层 Provider。弹窗在打开期间也可能需要显示变化中的数据，页面大了也可能需要几块各自管理弹窗的区域。

eBay 的开源版长期没有发布新版本。为了继续支持业务中的弹窗需求，我们在公司内部 fork 了一份 Nice Modal，作为私有 npm 库持续维护，并陆续加入了不少新功能。（[eBay Nice Modal 发布记录](https://github.com/eBay/nice-modal-react/releases)）

### update 问题

父组件直接在 JSX 里渲染弹窗时，父组件重新渲染就可以把新的 props 传给弹窗。通过 `NiceModal.show()` 打开时，弹窗由 Provider 下的 Placeholder 渲染，参数来自那次 `show()` 写入的 `args`。调用方自己的状态变了，弹窗里显示的数据还可能停在打开时的那一份。

开源版没有单独的 `update` 接口。再调用一次 `show()` 可以传入新值，但它会替换整份入参，也会重新处理可见性。独立的更新入口可以把界面刷新和打开动作分开，保留用户正在进行的操作。（[开源版公开 API](https://github.com/eBay/nice-modal-react/blob/1.2.13/src/index.tsx#L621-L640)、[弹窗状态更新源码](https://github.com/eBay/nice-modal-react/blob/1.2.13/src/index.tsx#L109-L136)）

在我们的项目里，用户可以在同一个主页上展示链接和推荐商品。编辑主页时，用户可以在商品选择器里搜索，再用「快速添加」连续选入多件商品。

当时的问题是，添加成功后，已添加商品的 ID 列表变了，弹窗里的商品却没有显示 `Added`。私有 npm 库里的 `update` 让界面按新的参数刷新。用户马上能看到哪些商品已经加到主页，也能留在原来的搜索结果里继续选。

商品项的 `Added` 可以在每次渲染时直接从 `productPreferenceIds` 推导，搜索词则留在组件自己的状态里。这样一来，新参数会刷新商品标记，用户刚输入的搜索词也会保留。如果用 `useState(props)` 把参数当作初始值，后来传入的新参数不会自动改写这份本地状态。（[React 的状态初始化](https://18.react.dev/reference/react/useState#avoiding-recreating-the-initial-state)）

这里有个容易漏掉的时序。用户关闭商品选择器又重新打开，旧请求才返回。前后两次打开用了同一个 `modalId`，只按 ID 更新就可能把旧结果写进新弹窗。可以在每次打开时分配一个 `sessionId`，发请求时捕获这次打开的 ID，等请求回来后原样带进 `update`。

reducer 核对会话后才浅合并 `args`，保留弹窗的可见状态。空补丁直接返回原状态。`productPreferenceIds` 是一个数组，浅合并会整项替换它，所以调用方传入的是本次会话的最新完整列表。

```ts
case 'nice-modal/update': {
  const { modalId, sessionId, args } = action.payload
  const current = state[modalId]

  if (current?.sessionId !== sessionId || Object.keys(args).length === 0) {
    return state
  }

  return {
    ...state,
    [modalId]: { ...current, args: { ...current.args, ...args } },
  }
}
```

`useModal()` 把动作交给当前 Provider 的 `dispatch`。依赖里包含 `dispatch`，受控 Provider 更换派发函数后，新渲染拿到的句柄会使用新的函数。异步结果使用发起请求时捕获的会话 ID。（[React 的 useCallback 依赖规则](https://18.react.dev/reference/react/useCallback)）

```ts
const updateCallback = useCallback(
  (sessionId: number, args: Record<string, unknown>) => {
    dispatch({ type: 'nice-modal/update', payload: { modalId: mid, sessionId, args } })
  },
  [mid, dispatch]
)
```

### 嵌套 Provider 问题

如果页面里有一个需要独立管理弹窗的区域，可以在外层 `NiceModal.Provider` 里再套一层。默认情况下，两层 Provider 各有自己的状态。React 组件读取 Context 时，会找到 React 树中离它最近的一层。（[React Context 文档](https://18.react.dev/reference/react/useContext)）

开源版的静态 `NiceModal.show()` 则通过模块里保存的 `dispatch` 引用派发动作。当两层 Provider 共用同一份 Nice Modal 模块时，后渲染的那一层可能把这个引用改成自己的。于是外层按钮发出的调用也可能送到内层。就算内层已经卸载，模块里留下的引用也可能仍指向它。（[Provider 派发源码](https://github.com/eBay/nice-modal-react/blob/1.2.13/src/index.tsx#L449-L479)）

同一个主页编辑器还提供预览，让用户看到访客打开主页时的效果。编辑器在外层，预览放在内层的 iframe 里，两边各放一层 Provider 来管理自己的弹窗状态。两层 Provider 仍在同一棵 React 树中，并且共用一份 Nice Modal 模块。预览打开后，编辑器的调用可能跑到预览里。关闭预览后，编辑器自己的弹窗有时也打不开。私有 npm 库解决的是这两个入口的调用归属，让编辑器和预览各自打开自己的弹窗。

把 `dispatch` 交给 Context，可以先解决动作发给哪一层的问题。Promise 回调也要跟着 Provider 分开存放，否则两层同时打开同一个 ID 时，仍可能拿到同一个 Promise。再往里一层，同一个 Provider 下的关闭回调也只属于它开始时对应的那次会话。

以下用退出后移除弹窗的流程举例。每个 Provider 持有自己的会话表，表内的 `sessionId` 逐次递增。短时间内多次调用 `show()`，如果弹窗仍处于同一次交互，就复用本次结果。如果已经进入关闭阶段，调用方先等待关闭完成，再发起下一次打开。这样可以等退出动画收尾，也给旧请求和迟到的回调留下一个可核对的标识。

#### 让 action 和渲染都带上会话 ID

需要把 `sessionId` 加到弹窗条目和 action 的类型里。打开新会话时，先建立一个隐藏的条目，等对应组件挂载后派发 `ready`，再把它显示出来。这样可以用当前会话的状态完成两阶段显示，省去模块级挂载标记。

```ts
type ModalArgs = Record<string, unknown>
type SessionRef = { modalId: string; sessionId: number }

type ModalEntry = {
  sessionId: number
  args?: ModalArgs
  visible: boolean
  delayVisible: boolean
}

type NiceModalAction =
  | { type: 'nice-modal/show'; payload: SessionRef & { args?: ModalArgs } }
  | { type: 'nice-modal/update'; payload: SessionRef & { args: ModalArgs } }
  | { type: 'nice-modal/ready' | 'nice-modal/hide' | 'nice-modal/remove'; payload: SessionRef }
```

下面是 reducer 中和显示有关的分支。`ready`、`hide` 和 `remove` 都先核对会话。收到旧会话的动作时，返回原状态；当前会话的 `hide` 同时清除 `visible` 和 `delayVisible`，避免关闭以后再被迟到的 `ready` 显示出来。

```ts
const { modalId, sessionId } = action.payload
const current = state[modalId]

if (action.type !== 'nice-modal/show' && current?.sessionId !== sessionId) {
  return state
}

switch (action.type) {
  case 'nice-modal/show': {
    const entry: ModalEntry =
      current?.sessionId === sessionId
        ? { ...current, args: action.payload.args }
        : { sessionId, args: action.payload.args, visible: false, delayVisible: true }
    return { ...state, [modalId]: entry }
  }
  case 'nice-modal/ready': {
    if (!current?.delayVisible) return state
    return { ...state, [modalId]: { ...current, visible: true, delayVisible: false } }
  }
  case 'nice-modal/hide': {
    if (!current) return state
    return { ...state, [modalId]: { ...current, visible: false, delayVisible: false } }
  }
  case 'nice-modal/remove': {
    const next = { ...state }
    delete next[modalId]
    return next
  }
  // 参数更新使用前一节的分支
  default:
    return state
}
```

Placeholder 用 `modalId` 和 `sessionId` 组成 React 的 key，把同一 ID 的两次打开渲染成两个有独立生命周期的实例。包装组件挂载时用自己的会话 ID 派发 `ready`。如果关闭发生在首次显示之前，适配器可以直接完成关闭流程，无需等待一次不会发生的退出动画。（[React 的状态保留与重置](https://18.react.dev/learn/preserving-and-resetting-state)）

#### 让 Promise 从同一次会话里取出和结算

Provider 用惰性初始化创建自己的 `runtime`，再把它和当前 `dispatch` 放进 Context。普通重渲染会继续使用同一张会话表。下面的 `scope` 是 `useModal()` 从最近的 Provider 读到的值。（[React 的 useContext](https://18.react.dev/reference/react/useContext)、[React 的 useState](https://18.react.dev/reference/react/useState)）

```ts
type PendingResult = {
  promise: Promise<unknown>
  resolve: (value?: unknown) => void
}

function createPendingResult(): PendingResult {
  let resolve!: PendingResult['resolve']
  const promise = new Promise<unknown>((onResolve) => {
    resolve = onResolve
  })
  return { promise, resolve }
}

type ModalSession = {
  sessionId: number
  result: PendingResult
  close?: PendingResult
}

function createModalRuntime() {
  return { nextSessionId: 0, sessions: new Map<string, ModalSession>() }
}

type ModalScope = {
  dispatch: Dispatch<NiceModalAction>
  runtime: ReturnType<typeof createModalRuntime>
}
```

打开时登记当前会话。关闭时先在会话里记录关闭 Promise，再结算交互结果。动画回调捕获的是发起关闭时的 `ref`，只有它仍对应当前会话，才会移除条目并结算关闭 Promise。

```ts
function showInScope(scope: ModalScope, modalId: string, args?: ModalArgs) {
  const { dispatch, runtime } = scope
  let session = runtime.sessions.get(modalId)

  if (session?.close) {
    return Promise.reject(new Error('请在当前弹窗关闭后再打开'))
  }
  if (!session) {
    session = { sessionId: ++runtime.nextSessionId, result: createPendingResult() }
    runtime.sessions.set(modalId, session)
  }

  dispatch({
    type: 'nice-modal/show',
    payload: { modalId, sessionId: session.sessionId, args },
  })
  return session.result.promise
}

function hideInScope(scope: ModalScope, ref: SessionRef, result: unknown = null) {
  const session = scope.runtime.sessions.get(ref.modalId)
  if (!session || session.sessionId !== ref.sessionId) return Promise.resolve()
  if (session.close) return session.close.promise

  const close = createPendingResult()
  session.close = close
  session.result.resolve(result)
  scope.dispatch({ type: 'nice-modal/hide', payload: ref })
  return close.promise
}

function finishClose(scope: ModalScope, ref: SessionRef) {
  const session = scope.runtime.sessions.get(ref.modalId)
  if (!session?.close || session.sessionId !== ref.sessionId) return

  scope.dispatch({ type: 'nice-modal/remove', payload: ref })
  scope.runtime.sessions.delete(ref.modalId)
  session.close.resolve()
}
```

接回 UI 时，确认和取消都把渲染时拿到的 `ref` 传给 `hideInScope()`。异步确认也用发出请求时捕获的 `ref`。退出动画结束后，再把那次关闭的 `ref` 交给 `finishClose()`。销毁 Provider 时，剩余会话也要按业务约定结算，直接清表会让等待结果的调用一直挂起。

这样，编辑器和预览各自在自己的 Provider 内处理交互。同一层里，旧会话的更新、异步确认和关闭回调也都只能作用于原来那次打开。需要动态注册、注销或覆盖弹窗组件时，注册表也可以跟着 Provider 划分作用域。

## 小结

| 维度     | 组件本地管理                       | Nice Modal                                             |
| -------- | ---------------------------------- | ------------------------------------------------------ |
| 状态归属 | 由拥有弹窗的页面或组件管理         | Provider 管渲染状态，注册表和 Promise 回调另有存放位置 |
| 组件引用 | 调用方通常在自己的 JSX 中渲染弹窗  | 通过注册 ID 或组件引用调用，由 Placeholder 渲染        |
| 数据交互 | 通过 props 回调传出结果            | 通过 `show()` 的 Promise 返回结果                      |
| 渲染开销 | 可以自行做条件渲染、卸载和代码拆分 | 支持按需挂载和退出后移除，模块加载时机仍由导入方式决定 |

Nice Modal 好用的地方，是把跨入口调用的编辑、选择或确认流程变成可以 `await` 的操作。一个页面自己控制的小弹窗，继续用本地状态往往更直观。需要让弹窗一直开着时，要考虑数据变化如何反映到界面上。页面里有多个 Provider 时，还要明确每次交互由哪一层处理。
