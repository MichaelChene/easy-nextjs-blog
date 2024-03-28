---
title: '从力扣基本计算器到编译原理'
date: '2024/03/28'
tags: ['V8', '算法']
draft: false
summary: '用括号栈、有限状态机和 AST 实现力扣的基本计算器，处理一元负号、运算符优先级和整数除法。再对照 V8 的字节码、分层编译与反优化，我们来看看 JavaScript 源码如何开始执行。'
images: ['/m-picture/calculator-to-compilers/compiler-front-end.jpg']
layout: PostLayout
---

把 `2 + 3 * 4` 交给计算器，答案是 14。可如果扫描到 `2 + 3` 就把它算成 5，最后只能得到 20。再加一对括号，`(2 + 3) * 4` 又确实应该得到 20。同一组数字与符号，怎么组合，决定了怎么算。

力扣的基本计算器要求我们自己解释这串字符，不能交给 `eval()`。先看 `2 + 3 * 4` 怎么一步步变成 14。

1. 词法分析读出 `[2, '+', 3, '*', 4]`。每个数字或符号都是一个 token。
2. 语法分析按优先级把 token 组装成抽象语法树（AST）。加法是根节点，乘法是它的右子树。
3. 求值从叶子开始，先算出 `3 * 4`，再把结果加到 `2` 上。

```text
    +
   / \
  2   *
     / \
    3   4
```

这棵树把「先算谁」写进了结构里。接下来给计算器加上括号和一元负号，看看它们分别在哪一步处理。

## 三道题，共用一个表达式解析器

| 题目                                                                                                      | 输入范围                                                     |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| [224. 基本计算器](https://leetcode.com/problems/basic-calculator/)                                        | 整数、加减、空格和括号，允许 `-1`、`-(2 + 3)` 这样的一元负号 |
| [227. 基本计算器 II](https://leetcode.cn/problems/basic-calculator-ii/)                                   | 非负整数字面量、空格和四则运算，整数除法向零截断             |
| [面试题 16.26. 计算器](https://leetcode.cn/problems/calculator-lcci/?envId=stack&envType=problem-list-v2) | 非负整数字面量、空格和四则运算，同样使用整数除法             |

三道题的语法可以合进同一个 `calculate`。实现还允许乘除与括号混用，以及在二元运算符后使用一个一元负号，例如 `7 / -3`。题目保证输入有效，这里也会检查括号、操作数和运算符的位置，把拼错的表达式拦下来。一元正号、连续的一元负号、小数和隐式乘法都超出这套语法的范围。

下面三个 TypeScript 代码块按顺序放在同一个文件里，就是完整的计算器。先从读取输入开始。

## 词法分析：用栈把括号配成组

`123` 应该是一个数字 token，`-123` 则拆成 `-` 和 `123`。同一个减号也会出现在 `5-123` 里，词法分析先保留符号，等语法分析根据前后关系判断它的角色。

这里的 `tokenize` 还顺手给括号分组。一般的扫描器可以发出平铺的左右括号 token，由解析器负责配对。这份实现把分组并入扫描，每遇到一个左括号就压入新的 token 数组，匹配到右括号时再把它放回外层。于是 `12 + (3 * 4)` 会变成 `[12, '+', [3, '*', 4]]`，内层数组在外层看来就是一个操作数。

扫描连续数字只需要有限状态，匹配任意深度的括号还需要栈来记住当前在哪一层。栈底是整条表达式的数组，因此读到右括号时，栈里只有一层就说明它没有匹配的左括号。

```ts
type BinaryOperator = '+' | '-' | '*' | '/'
type Token = number | BinaryOperator | Tokens
type Tokens = Token[]

function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= '0' && char <= '9'
}

function tokenize(s: string): Tokens {
  const tokens: Tokens = []
  const stack: Tokens[] = [tokens]
  for (let i = 0; i < s.length; i++) {
    const char = s[i]
    const current = stack[stack.length - 1]
    if (/\s/.test(char)) continue

    if (isDigit(char)) {
      const start = i
      while (isDigit(s[i + 1])) i++
      const value = Number(s.slice(start, i + 1))
      if (!Number.isSafeInteger(value)) throw new RangeError('整数超出安全范围')
      current.push(value)
    } else if (char === '+' || char === '-' || char === '*' || char === '/') {
      current.push(char)
    } else if (char === '(') {
      stack.push([])
    } else if (char === ')') {
      if (stack.length === 1) throw new SyntaxError(`多余的右括号，位置 ${i}`)
      stack.pop()
      stack[stack.length - 1].push(current)
    } else {
      throw new SyntaxError(`无法识别字符 ${char}，位置 ${i}`)
    }
  }

  if (stack.length !== 1) throw new SyntaxError('缺少右括号')
  return tokens
}
```

## 语法分析：用状态机读 token，按优先级构树

有了 token 还不能开始算。比如 `1 2` 能扫出两个合法的整数，但第一个数后面应该接运算符。再看 `-`，它在 `-3` 里表示取负，在 `5-3` 里表示减法。解析器在每层括号里维护三个状态，用当前期待和下一枚 token 来判断该怎么读。

| 当前期待           | 数字或括号组                       | `-`                          | `+`、`*`、`/`                  | 输入结束 |
| ------------------ | ---------------------------------- | ---------------------------- | ------------------------------ | -------- |
| 操作数             | 接收，接下来等二元运算符           | 记为一元负号，继续等操作数   | 报错                           | 报错     |
| 一元负号后的操作数 | 构建一元表达式，接下来等二元运算符 | 报错                         | 报错                           | 报错     |
| 二元运算符         | 报错                               | 记为二元减法，接下来等操作数 | 记为二元运算符，接下来等操作数 | 完成     |

收到操作数时，如果有待处理的一元负号，解析器先为它构建 `UnaryExpression`，再决定怎么与已有的左表达式合并。这个节点记录了负号作用在哪个表达式上，真正取负要等到求值阶段。AST 节点借用了 Babel 常见的命名，包括 `NumericLiteral`、`UnaryExpression`、`BinaryExpression` 和 `ParenthesizedExpression`。这里显式保留括号节点，让外层解析器在处理优先级时把整个括号组视为一个操作数。也可以在 AST Explorer 里输入相同表达式，切换解析器观察括号的表示方式。 [Babel Parser 文档](https://babeljs.io/docs/babel-parser) · [AST Explorer](https://astexplorer.net/)

以 `2 + 3 * 4` 为例，读完 `2 + 3` 时，当前树的根是加法。后续的乘法优先级更高，所以把 `3` 和 `4` 组合成新的右子树，而根仍然是加法。继续读 `/ 2` 时，已有的整个乘法子树成为除法的左侧，得到 `2 + ((3 * 4) / 2)`。同级运算总是用已有子树作为左操作数，因此 `8 / 4 / 2` 得到 `(8 / 4) / 2`。如果根是括号节点，例如 `(2 + 3) * 4`，乘法就直接把整个括号组接到左侧。

这个接到右子树的规则依赖当前只有两档二元优先级，且同档都是左结合。若要加入右结合的幂运算，或继续增加优先级层次，优先级爬升或 Pratt 解析器能直接表达这些规则，扩展起来更清楚。

```ts
type Expression =
  | { type: 'NumericLiteral'; value: number }
  | { type: 'UnaryExpression'; operator: '-'; argument: Expression }
  | { type: 'BinaryExpression'; operator: BinaryOperator; left: Expression; right: Expression }
  | { type: 'ParenthesizedExpression'; expression: Expression }

type State = 'operand' | 'unary' | 'binary'
type TokenType = 'number' | 'group' | 'minus' | 'operator'

const transform: Record<State, Partial<Record<TokenType, State>>> = {
  operand: { number: 'binary', group: 'binary', minus: 'unary' },
  unary: { number: 'binary', group: 'binary' },
  binary: { minus: 'operand', operator: 'operand' },
}

function getTokenType(token: Token): TokenType {
  if (typeof token === 'number') return 'number'
  if (Array.isArray(token)) return 'group'
  return token === '-' ? 'minus' : 'operator'
}

interface ParseFrame {
  tokens: Tokens
  index: number
  state: State
  negate: boolean
  left?: Expression
  operator?: BinaryOperator
}

function createFrame(tokens: Tokens): ParseFrame {
  return { tokens, index: 0, state: 'operand', negate: false }
}

function appendOperand(frame: ParseFrame, operand: Expression): void {
  const right: Expression = frame.negate
    ? { type: 'UnaryExpression', operator: '-', argument: operand }
    : operand
  frame.negate = false

  const { left, operator } = frame
  if (left === undefined || operator === undefined) {
    frame.left = right
  } else if (
    left.type === 'BinaryExpression' &&
    (left.operator === '+' || left.operator === '-') &&
    (operator === '*' || operator === '/')
  ) {
    left.right = { type: 'BinaryExpression', operator, left: left.right, right }
  } else {
    frame.left = { type: 'BinaryExpression', operator, left, right }
  }
  frame.operator = undefined
}

function buildExpression(tokens: Tokens): Expression {
  const stack = [createFrame(tokens)]
  while (true) {
    const frame = stack[stack.length - 1]
    if (frame.index === frame.tokens.length) {
      if (frame.state !== 'binary' || frame.left === undefined) {
        throw new SyntaxError('表达式为空或缺少操作数')
      }

      stack.pop()
      if (!stack.length) return frame.left
      appendOperand(stack[stack.length - 1], {
        type: 'ParenthesizedExpression',
        expression: frame.left,
      })
      continue
    }

    const token = frame.tokens[frame.index++]
    const next = transform[frame.state][getTokenType(token)]
    if (next === undefined) throw new SyntaxError('此处不应出现该 token')

    frame.state = next
    if (typeof token === 'number') {
      appendOperand(frame, { type: 'NumericLiteral', value: token })
    } else if (Array.isArray(token)) {
      stack.push(createFrame(token))
    } else if (next === 'unary') {
      frame.negate = true
    } else {
      frame.operator = token
    }
  }
}
```

状态表只管当前层，括号栈负责跨层。比如 `-(2 + 3)`，外层记住待处理的负号，内层先建好加法树。出栈时，外层再把整个括号表达式放进一元负号节点。这样既能区分一元和二元减号，也能拒绝 `1 2`、`()`、`1 +` 和 `+1`。

## 求值：从叶子往上算

树建好以后，求值阶段就不用再判断优先级了。数字节点直接产生值，括号节点把求值交给内部表达式，一元负号等一个值，二元运算等两个值。这样开头那棵树会先得到 `3 * 4` 的 12，再算 `2 + 12`。数值栈中后弹出的是左值，顺序颠倒会把减法和除法算错。

实现使用显式栈做后序遍历。很深的括号和很长的左结合表达式都可能产生很深的树，直接递归求值容易先碰到 JavaScript 的调用栈上限。解析也使用显式栈，避免把括号深度转成函数调用深度。

```ts
function applyBinary(operator: BinaryOperator, left: number, right: number): number {
  switch (operator) {
    case '+':
      return left + right
    case '-':
      return left - right
    case '*':
      return left * right
    case '/':
      if (right === 0) throw new RangeError('除数不能为 0')
      return Math.trunc(left / right)
  }
}

function evaluate(ast: Expression): number {
  const work: { node: Expression; expanded: boolean }[] = [{ node: ast, expanded: false }]
  const values: number[] = []

  while (work.length) {
    const { node, expanded } = work.pop()!
    switch (node.type) {
      case 'NumericLiteral':
        values.push(node.value)
        break
      case 'ParenthesizedExpression':
        work.push({ node: node.expression, expanded: false })
        break
      case 'UnaryExpression':
        if (expanded) {
          values.push(-values.pop()!)
        } else {
          work.push({ node, expanded: true }, { node: node.argument, expanded: false })
        }
        break
      case 'BinaryExpression':
        if (expanded) {
          const right = values.pop()!
          const left = values.pop()!
          const result = applyBinary(node.operator, left, right)
          if (!Number.isSafeInteger(result)) throw new RangeError('结果超出安全整数范围')
          values.push(result)
        } else {
          work.push(
            { node, expanded: true },
            { node: node.right, expanded: false },
            { node: node.left, expanded: false }
          )
        }
        break
    }
  }

  const result = values[0]
  return result === 0 ? 0 : result
}

function calculate(s: string): number {
  return evaluate(buildExpression(tokenize(s)))
}
```

整数除法只保留商的整数部分，`(-7) / 3` 得到 `-2`，用 `Math.floor` 会算成 `-3`。这也是计算器与 JavaScript 本身的区别之一：对两个 `Number` 使用 `/` 时，JavaScript 保留小数部分，非零值除以零还可能得到无穷大。这里把除零和超出安全整数范围当作求值错误。 [ECMAScript 2024 的 Number 除法](https://tc39.es/ecma262/2024/multipage/ecmascript-data-types-and-values.html#sec-numeric-types-number-divide)

### 验证与开销

下面几组输入分别覆盖了括号、一元负号、结合性和截断方向。遇到括号不配对、未知字符或操作数缺失时抛出 `SyntaxError`，除零和安全整数越界抛出 `RangeError`。

| 输入                  | 结果          | 检查点                                     |
| --------------------- | ------------- | ------------------------------------------ |
| `(1+(4+5+2)-3)+(6+8)` | `23`          | 多层括号和返回外层后的运算                 |
| `-(2 + 3) * 4`        | `-20`         | 一元负号应用于整个括号组                   |
| `2 + 3 * 5 / 2`       | `9`           | 加法右侧先乘后除                           |
| `2 + 3 * (5 / 2)`     | `8`           | 括号内先做整数除法，结果比上一行少 1       |
| `8 / 4 / 2`           | `1`           | 连续除法按左结合求值                       |
| `7 / -3`              | `-2`          | 负商向零截断                               |
| `1a2`、`1 +`、`2)`    | `SyntaxError` | 分别拒绝未知字符、缺失操作数和多余的右括号 |
| `1 / (2 - 2)`         | `RangeError`  | 除数求值后为零                             |

本地还跑了长度为 300,000 的深层括号输入、长度为 299,999 的连续加法，以及 1,000 个用 `BigInt` 核对结果的生成表达式。这些用例分别检查了深层解析、左深树求值和整数运算的结果。

设输入长度为 `n`，扫描、构树、求值的总时间是 `O(n)`，额外空间是 `O(n)`。我当时的力扣提交记录是通过测试，运行用时只超过约 16% 的提交。记录只留下了平台相对排名，具体题号、毫秒数、运行环境和计时边界都没有留下来。这个数字无法区分扫描、构树和求值各自的耗时，也无法与这里的实现直接比较。

如果题目只要一个数，边扫描边归约就能省去 token 数组和 AST 节点。只有加减和括号时，还可以用栈保存外层的累计结果和符号。保留 AST 的好处是，结合顺序可以单独检查，同一棵树也可以交给不同的程序去打印、求值或生成指令。

## V8 怎样把源码变成可执行程序

V8 选择先把语法树编译成字节码。字节码可以直接交给 Ignition 解释执行，也能作为其他编译层的输入。理解这条执行路径，可以先看它和计算器共有的前端步骤。

![编译前端示意图，源码经过词法、语法和语义分析后进入代码生成或解释执行](/m-picture/calculator-to-compilers/compiler-front-end.jpg)

```text
JavaScript 源码
  ↓ Scanner 做词法分析
Token 流
  ↓ Parser 做语法分析
AST（解析过程中检查早期错误，记录和分析作用域）
  ↓ 字节码生成器遍历 AST
Ignition 字节码
  ├─→ Ignition 解释执行，积累运行反馈
  └─→ Sparkplug 可直接从字节码生成基线机器码

字节码 + 运行反馈
  ↓ Maglev 或 TurboFan 可据此做推测性优化
优化机器码（由 CPU 执行）
  ↓ 假设失效并触发反优化
恢复执行状态，从对应的字节码位置继续
```

### 解析：从字符到 AST

在计算器里，`tokenize` 先切出数字和符号，`buildExpression` 再判断它们怎么组合。V8 的 Scanner 和 Parser 也有类似的分工：Scanner 从字符流识别标识符、字面量和运算符等 token，Parser 按 JavaScript 的语法识别表达式、函数声明和其他结构，并构建 AST。比如 `(2 + 3) * 4` 的括号已经改变了树的结合方式，AST 可以直接用子树表达这个关系。空格和注释通常也无需保留成节点，有语法意义的换行则需要在解析时处理。 [V8 Scanner](https://v8.dev/blog/scanner) · [ECMAScript 2024 的词法文法](https://tc39.es/ecma262/2024/multipage/ecmascript-language-lexical-grammar.html)

JavaScript 还需要回答计算器里没有的问题。例如两个同名的 `let` 声明出现在同一个块里，会触发早期错误。遇到一次变量访问，引擎还要确定它对应哪个作用域里的绑定。这些工作和解析、编译前端密切相关。V8 也可以先预解析暂时用不到的函数体，到需要时再生成其完整的 AST 和字节码，以减少启动阶段的工作。 [V8 惰性解析与变量分配](https://v8.dev/blog/preparser) · [ECMAScript 2024 的块级早期错误](https://tc39.es/ecma262/2024/multipage/ecmascript-language-statements-and-declarations.html#sec-block-static-semantics-early-errors)

### 生成字节码：同一棵树，换一种访问方式

前面的 `evaluate` 遇到数字就取值，遇到二元表达式就处理左右两棵子树。要增加打印或代码生成，可以复用这些节点，再给每种节点定义另一套处理逻辑。这就是访问者模式在 AST 上的用途：把对节点做什么和节点本身的数据结构分开。计算器用 `switch` 体现了按节点类型分派的思路。V8 的字节码生成器则有不同的节点访问方法，例如 `VisitBinaryOperation` 会按运算符继续分派，把算术和短路逻辑交给不同路径。 [V8 12.4.254 的字节码生成器源码](https://github.com/v8/v8/blob/12.4.254/src/interpreter/bytecode-generator.cc#L6362)

Ignition 的字节码生成器把 AST 转成较紧凑的指令序列，Ignition 解释器再逐条分派。这样，同一份字节码可以交给解释器，也能作为后续编译层的输入。常量折叠和死代码消除是编译中常见的优化，能在哪一步做，要看当时掌握了哪些信息以及是否能保住 JavaScript 的语义。生成本地机器码时，还要针对目标 CPU 做指令选择和寄存器分配。 [V8 的 Ignition 设计](https://v8.dev/blog/ignition-interpreter) · [Sparkplug 如何从字节码生成机器码](https://v8.dev/blog/sparkplug)

### 解释执行：看一条加法怎样跑起来

用一个累加函数就能看到字节码在做什么。

```js
function sum(arr) {
  let total = 0
  for (let i = 0; i < arr.length; i++) {
    total += arr[i]
  }
  return total
}
```

把函数保存到 `sum.js`，加上一行 `sum([1, 2, 3])`，再运行下面的命令。

```bash
node --print-bytecode --print-bytecode-filter=sum sum.js
```

在 Node.js 22.23.2（V8 `12.4.254.21-node.56`）中，`total += arr[i]` 对应的指令里可以看到 `Ldar r1`、`GetKeyedProperty` 和 `Add r0, [3]`。它们先把下标加载到累加器，再读取数组元素，最后用累加器里的元素值和 `r0` 里的 `total` 做加法。计算器用数值栈暂存左右操作数，Ignition 用的是虚拟寄存器和累加器。 [V8 的 Ignition 寄存器模型](https://v8.dev/blog/ignition-interpreter)

`Add r0, [3]` 里的 `[3]` 还是一个反馈槽索引。随着函数执行，引擎会积累加法所见的值、数组访问所见的对象形状等运行反馈。同一段代码跑得越多，引擎就越有机会判断是否值得花时间生成更专门的机器码。 [Maglev 的运行反馈与表示选择](https://v8.dev/blog/maglev#representation-selection)

### 即时编译：热点代码为什么值得多编译一次

ECMAScript 定义了 JavaScript 的语义，具体怎样执行由引擎决定。V8 用 Ignition 让代码较快开始执行，再用即时编译（JIT）减少热点代码反复执行的成本。这里的「热点」既可能是反复调用的函数，也可能是函数中持续运行的循环。

![V8 的 Ignition 和 TurboFan 执行路径，含字节码、类型反馈和反优化](/m-picture/calculator-to-compilers/v8-ignition-turbofan.jpg)

图中画的是 Chrome 59 搭载的 V8 5.9 所启用的两层管线，Ignition 负责解释，TurboFan 负责优化编译。后来 Chrome 91 引入 Sparkplug，快速把字节码翻译成本地机器码，省去解释器逐条分派的开销。Chrome 117 又引入 Maglev，放在 Sparkplug 和 TurboFan 之间，以较低的编译成本做推测性优化。TurboFan 可以花更多编译时间追求峰值性能。函数能走到哪一层，取决于热度、运行反馈和引擎配置。 [V8 5.9 的两层管线](https://v8.dev/blog/launching-ignition-and-turbofan) · [Sparkplug](https://v8.dev/blog/sparkplug) · [Maglev](https://v8.dev/blog/maglev)

回到 `sum`。如果调用时一直传入紧凑的小整数数组，优化编译器就可能为数组元素加载和加法生成更专门的机器码，并在运行时检查相关假设。这里的收益来自省去一些通用路径上的工作。编译耗时、启动延迟和稳态吞吐仍要分别衡量，单凭生成了机器码也无法推断它和某段 C++ 代码谁快。 [V8 的数组元素种类](https://v8.dev/blog/elements-kinds) · [Maglev 的推测性优化](https://v8.dev/blog/maglev#known-node-information)

### 反优化：假设失效后从哪里继续

假设 `sum` 已经按小整数数组优化，下一次却收到 `[1, '2', 3]`。这次的结果应该是字符串 `'123'`：加到 `'2'` 时，`+` 开始执行字符串拼接。传入对象数组也可能打破数组元素种类的假设。具体会不会触发反优化，取决于引擎先前生成的代码和正在检查的条件。 [ECMAScript 2024 的加法语义](https://tc39.es/ecma262/2024/multipage/ecmascript-language-expressions.html#sec-addition-operator-plus)

如果优化代码上的检查失败并触发反优化，V8 会利用编译时留下的元数据，把机器寄存器或栈里的值还原成未优化执行所需的帧和寄存器值，再从对应的字节码位置继续。这样已经完成的操作无需从函数开头再做一遍。把参数写成 TypeScript 的 `number[]` 可以在开发阶段检查调用方，但类型标注在生成 JavaScript 时会擦除。V8 做推测时仍然依据实际运行中看到的值。 [Maglev 的反优化](https://v8.dev/blog/maglev#deoptimization) · [TypeScript 的类型擦除](https://www.typescriptlang.org/docs/handbook/2/basic-types.html#erased-types)

## 总结

做这道题时，如果只关心结果，边扫描边归约更省空间。把 AST 留下来，则能看清为什么 `2 + 3 * 4` 先算乘法，也能把同一棵树交给求值器或代码生成器。V8 把解析后的结构进一步变成字节码，让程序能较早开始执行。至于一段代码值不值得继续编译、能对实际输入做多强的假设，要等它跑起来以后才能判断。
