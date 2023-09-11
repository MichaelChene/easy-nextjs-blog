---
title: '当两个标签页同时写入 LocalStorage'
date: '2023/09/11'
tags: [browser, localstorage, web storage]
draft: false
summary: 'localStorage 适合保存少量偏好数据。同步调用会占用主线程，跨标签页的读改写也可能丢失更新，storage 事件和后台落盘各有自己的时机。'
images: ['/static/images/avatar.png']
layout: PostLayout
---

把主题写进 `localStorage`，刷新后就能读回来。用它保存这么一个值很顺手，拿它做跨标签页的计数器却容易出错：两个页面各加一次，结果可能只加了一次。要理解这个差别，可以先看一次 `setItem()` 承诺了什么，再看两个页面同时做几步操作时会发生什么。

## 基本特性与常用操作

网页通过 `window.localStorage` 取得一个 `Storage` 对象。键和值都是字符串，找不到某个键时，`getItem()` 返回 `null`。保存对象需要自己序列化，读取时也要处理旧格式或解析失败。

```js
const themeKey = 'preferences:theme'

localStorage.setItem(themeKey, 'dark')
const theme = localStorage.getItem(themeKey) ?? 'light'
localStorage.removeItem(themeKey)
```

| 特性     | 实际行为                                                                                         |
| -------- | ------------------------------------------------------------------------------------------------ |
| 作用域   | 普通同源页面可以访问同一片存储。源由协议、主机和端口决定，嵌入式第三方场景还可能按顶层站点分区。 |
| 生命周期 | 重载页面和关闭普通标签页后通常仍在。用户清理数据、隐私策略或浏览器回收都可能让数据消失。         |
| 配额     | Web Storage 的额度只有几 MiB 量级，写满时会抛出 `QuotaExceededError`。使用时要能接受保存失败。   |
| 执行环境 | API 在 Window 上同步执行，Web Worker 中没有 `localStorage`。                                     |

页面访问存储受到浏览器策略限制时，连读取 `window.localStorage` 本身都可能抛出 `SecurityError`。如果只是主题偏好，可以让页面退回默认主题，用户仍然可以使用页面。（[HTML Web Storage 规范](https://html.spec.whatwg.org/multipage/webstorage.html)、[Chrome 存储分区说明](https://privacysandbox.google.com/cookies/storage-partitioning)）

## 同步调用与后台落盘

下面这行把序列化和存储写在了一起。数据越大，在主线程上执行的工作就越多。

```js
localStorage.setItem('drafts', JSON.stringify(drafts))
```

执行顺序是先跑完 `JSON.stringify()`，再同步调用 `setItem()`。输入框每打一字就重写整份草稿列表，会把这两段工作一起放进输入事件。读取已有数据时也一样，`getItem()` 和 `JSON.parse()` 都在当前调用栈中完成。可以先合并高频更新，再用 DevTools 的 Performance 面板确认耗时究竟来自序列化、存储调用，还是同一事件里的其他代码。

### LocalStorage 的底层实现

以 Chromium 为例，V8 执行网页脚本，Blink 提供 `Storage` 的接口和缓存，渲染器通过 Mojo 向浏览器的 DOM Storage 后端提交操作。后端负责组织存储区和持久化。网页看到的是同步接口，缓存、进程通信以及后台提交是浏览器内部的工作。

```text
页面调用 setItem()
    ↓ V8 执行脚本，Blink 处理 Storage 调用
渲染器侧存储区缓存
    ↓ Mojo
浏览器 DOM Storage 后端
    ↓
浏览器配置目录中的持久化存储
```

### 数据存储路径与文件格式

在使用 LevelDB 的 Linux Chromium 配置中，默认用户资料下可能看到这样的目录。

```text
~/.config/chromium/Default/Local Storage/leveldb/
```

存储键可以作为底层记录的一部分，多个源的数据也可以放在同一份数据库里。网页端字符串可以按 UTF-16 代码单元理解，Chromium 的历史实现则区分过 Latin-1 和 UTF-16 两种存储编码。比如你保存 JSON 时，那只是你选用的字符串格式。底层目录、编码和后端由浏览器版本与配置决定。调试时，用 DevTools 的 **Application → Local Storage** 就能直接查看网页读到的键值。（[Blink 存储区缓存](https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/modules/storage/cached_storage_area.cc)、[Chromium DOM Storage 后端](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/components/services/storage/dom_storage/local_storage_impl.cc)、[Chromium 历史版本的记录与编码](https://chromium.googlesource.com/chromium/src/+/dd8d5985e4b1dc04142c94984d0654f4a3339298/components/services/storage/dom_storage/local_storage_impl.cc)）

浏览器可以调度缓存提交和后台落盘，网页仍要为每次同步调用付出主线程时间。Web Storage 也没有规定一个可依赖的「每秒写入次数」。比起猜浏览器何时限频，更有效的是减少重复写入。

## 多标签页和窗口的同步机制

一个标签页改了值，共享同一存储区的其他文档可以收到 `storage` 事件。发起写入的页面应直接更新自己的界面。另一个页面收到事件后，可以用 `event.key` 判断修改范围，再读最新值。调用 `clear()` 时，事件的 `key` 为 `null`。

```js
function syncTheme() {
  const theme = localStorage.getItem('preferences:theme') ?? 'light'
  document.documentElement.dataset.theme = theme
}

window.addEventListener('storage', (event) => {
  if (event.storageArea !== localStorage) return
  if (event.key === 'preferences:theme' || event.key === null) syncTheme()
})

function setTheme(theme) {
  localStorage.setItem('preferences:theme', theme)
  syncTheme()
}
```

## 线程安全与锁机制

Chromium 按存储键管理存储区域，具体版本中能看到 `StorageAreaImpl`、`LocalStorageImpl` 等后端对象。多进程间的 IPC、缓存更新与后台提交保证浏览器能够管理共享存储。应用需要的跨步骤一致性，还要回到几次 JavaScript 调用之间判断。

改主题时，最后成功写入的偏好值往往就够用了。累加计数则不同。假设两个标签页都做 `getItem()` → 加一 → `setItem()`，它们可能先后读到同一个旧值，再分别写入同一个新值。事件能告诉另一个页面发生过写入，无法把三步变成一个原子操作。

| 时刻 | 标签页 A | 标签页 B  |
| ---- | -------- | --------- |
| 读取 | 读到 10  | 读到 10   |
| 计算 | 算出 11  | 算出 11   |
| 写入 | 写入 11  | 也写入 11 |

HTML 规范建议应用按**没有跨页面锁**来设计。只要最终结果依赖「我读的旧值在写入前不能变」，就需要事务或额外的协调机制。比如累计本地操作次数，可以把读和写放进同一个 IndexedDB 写事务。（[HTML 规范关于共享状态的说明](https://html.spec.whatwg.org/multipage/webstorage.html#introduction)）

## 过期、清理和敏感数据

`localStorage` 没有按键设置有效期的 API。需要缓存时，可以把过期时间和数据一起保存。读取侧对旧格式、过期或不可访问的记录用同一个默认值处理。

```js
localStorage.setItem(
  'preferences:cached-language',
  JSON.stringify({ value: 'zh-CN', expiresAt: Date.now() + 60_000 })
)

function readCachedValue(key) {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return null

    const entry = JSON.parse(raw)
    return Number.isFinite(entry?.expiresAt) && Date.now() < entry.expiresAt ? entry.value : null
  } catch {
    return null
  }
}

const language = readCachedValue('preferences:cached-language') ?? 'en'
```

这个例子只会忽略过期值。清理可以由写入方定期处理，避免读取方拿着一份旧记录去删除刚被另一个页面更新的值。删除键的作用是让网页无法再通过该键读取数据。浏览器的日志、备份和底层文件如何清理，不属于 `removeItem()` 的保证。

### 安全性分析

同源脚本能读写 `localStorage`。如果页面发生 XSS，攻击脚本也能在这个源里运行。浏览器端的 API 没有 `HttpOnly` 这一层保护。主题、语言和界面布局适合保存在这里。会话凭据如果由服务端通过 `HttpOnly` Cookie 管理，可以避免脚本直接读取 Cookie 值，但页面仍需防范 XSS。（[HTML Web Storage 安全性说明](https://html.spec.whatwg.org/multipage/webstorage.html)、[RFC 6265 的 HttpOnly 属性](https://www.rfc-editor.org/rfc/rfc6265#section-4.1.2.6)）

| 问题                 | 使用时的影响                                                              |
| -------------------- | ------------------------------------------------------------------------- |
| XSS 与同源脚本访问   | 能在当前源中执行的脚本可以读写这些数据                                    |
| 缺少 `HttpOnly` 属性 | 无法为某个键关闭 JavaScript 访问                                          |
| 没有内建过期时间     | 需要由应用判断有效期并安排清理                                            |
| 删除后的底层清理     | 删除键后无法再通过 API 读取，磁盘文件、日志和备份的处理由浏览器与系统负责 |

## 性能问题与限制

| 限制           | 对应用的影响                                               |
| -------------- | ---------------------------------------------------------- |
| 同步调用       | 频繁读写和大数据序列化会占用页面主线程                     |
| 字符串键值     | 对象要自行转换，读取时要处理格式变更与解析错误             |
| 配额和访问策略 | 写入可能失败，读取存储对象本身也可能受策略限制             |
| 缺少事务与索引 | 多键更新和读改写需要额外设计，查询通常依赖应用自己组织数据 |

## 按数据的用途选存储

| 存储             | 范围和生命周期                                           | 调用方式和容量                                           | 适合保存                           |
| ---------------- | -------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------- |
| `localStorage`   | 同一存储区内共享，重载后通常仍在                         | 同步，几 MiB 量级                                        | 少量、低频更新的偏好               |
| `sessionStorage` | 按源和顶层浏览上下文隔离，通常随标签页会话结束而清理     | 同步，几 MiB 量级                                        | 单个标签页里的临时步骤             |
| IndexedDB        | 按存储区隔离，数据通常跨会话保留，也可能随配额政策被回收 | 异步，配额通常更大，支持索引和事务                       | 大量结构化数据、离线草稿和并发更新 |
| Cookie           | 按域名、路径等属性匹配，可设置到期时间                   | `document.cookie` 是同步接口，单条 Cookie 通常只有几 KiB | 随请求发送给服务端的少量会话数据   |

可以先问一个实际的问题：这份数据丢了，页面还能不能正常工作？对于能回退默认值的小偏好，`localStorage` 的简单最有价值。需要查找大量记录、同时写多条数据，或者让读改写成为一次完整操作时，IndexedDB 的事务更合适。

## 最佳实践

`localStorage` 的优势是 API 简单、浏览器支持广，保存少量偏好时容易接入。让这些特点发挥作用，可以把读写频率和失败处理一起考虑。

- 主题、语言等轻量偏好用独立键保存，并为读取失败准备默认值。
- 合并输入过程中的高频写入，避免每次都序列化整份大对象。
- 为缓存记录有效期，同时安排清理，避免过期记录一直占用配额。
- 保存敏感数据前检查同源脚本的访问范围，会话凭据结合服务端 Cookie 机制设计。
- 需要索引查询或原子更新时，用 IndexedDB 的对象仓库和事务表达数据关系。
