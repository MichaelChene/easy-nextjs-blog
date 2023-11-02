---
title: 'Fuse.js 模糊查询算法'
date: '2023/11/02'
tags: ['算法']
draft: false
summary: 'Fuse.js 的 BitapSearch 实现，包含模式串掩码、搜索区间和位运算匹配过程，以及 Levenshtein 编辑距离的动态规划实现。'
images: ['/static/images/avatar.png']
layout: PostLayout
---

## 核心算法 Bitap

Bitap 算法是 fuse.js 中用于实现模糊搜索的核心算法之一，其主要思路是利用位运算来计算模式串和目标串之间的相似度。具体来说，Bitap 算法首先将模式串转换为二进制掩码，并利用位运算来计算模式串和目标串之间的相似度，然后采用一些启发式策略来提高算法的准确性和效率。

在 fuse.js 中，Bitap 算法的实现主要在`BitapSearch`类中。接下来我将尝试解析一下这个类。

### 构造函数初始化

在构造函数中，会根据配置参数计算并设置一些内部变量，如模式串的二进制掩码、距离阈值等。

```js
export default class BitapSearch{
  constructor(pattern, {location, threhold, //...其它config参数略}){
    this.pattern = isCaseSensitive ? pattern : pattern.toLowerCase()
    this.chunks = []
    const addChunk = (pattern, startIndex) => {
      this.chunks.push({
        pattern,
        alphabet: createPatternAlphabet(pattern),
        startIndex
      })
    }
    const len = this.pattern.length

    if (len > MAX_BITS) {//MAX_BITS = 32
      let i = 0
      const remainder = len % MAX_BITS
      const end = len - remainder

      while (i < end) {
        addChunk(this.pattern.substr(i, MAX_BITS), i)
        i += MAX_BITS
      }

      if (remainder) {
        const startIndex = len - MAX_BITS
        addChunk(this.pattern.substr(startIndex), startIndex)
      }
    } else {
      addChunk(this.pattern, 0)
    }
  }
}
```

`createPatternAlphabet` 函数的作用是生成一个对象 `mask`，它的键是模式字符串中的字符，值是一个二进制数，表示该字符在模式字符串中的位置。这个字典用于后续的位运算匹配算法中，用于计算某个字符在目标字符串中出现的位置。

```js
export default function createPatternAlphabet(pattern) {
  let mask = {}

  for (let i = 0, len = pattern.length; i < len; i += 1) {
    const char = pattern.charAt(i)
    mask[char] = (mask[char] || 0) | (1 << (len - i - 1))
  }

  return mask
}
```

`| `表示按位或运算，可以理解为二进制中的`||`，只要某一二进制位有一个是 1，就是 1，如果都是 0，则是 0。
`<<` 表示左移运算。`1 << (len - i - 1)`表示将数字 1 左移`len-i-1`位。比如 `len=4`，`i=2` ，将 1 左移 `(4-2-1)` 位，即左移 1 位，结果为 `00000010`，也就是十进制数 2。

以模式字符串"hello"为例，则 mask 对象可能如下所示：

```js
{
  "h": 16, // 二进制00010000，表示 "h" 在模式字符串的第一个位置
  "e": 8,  // 00001000，第二个位置
  "l": 3,  // 00000011，第三和第四个位置
  "o": 1   // 00000001，第五个位置
}
```

### 类暴露的 searchIn 方法

#### 参数和工具函数

`searchIn`方法中，调用了`search`函数。可以看到，`search`函数接收了`text`目标字符串，以及`pattern`模式串和`opions`参数，用于在目标字符串中搜索模式串。

```js
const { isMatch, score, indices } = search(text, pattern, alphabet, {
  location: location + startIndex,
  distance,
  threshold,
  findAllMatches,
  minMatchCharLength,
  includeMatches,
  ignoreLocation,
})
```

fuse.js 提供了[这些参数](https://github.com/krisk/Fuse/blob/04295e51ef9305824852241affce5e2dc00299f8/src/core/config.js)的默认值，比如其中的`FuzzyOptions`：

```js
export const FuzzyOptions = {
  location: 0,
  threshold: 0.6,
  distance: 100,
}
```

我们重点关注 `threshold` 参数，它表示匹配的阈值，取值范围为 `[0, 1]`。如果匹配的得分小于阈值，则表示匹配失败。在进行模式匹配时，`Fuse.js` 会根据模式串的长度，以及 `threshold` 参数，计算出一个可以接受的最大编辑距离，即 `distance` 参数。如果两个字符串的编辑距离超过了这个值，就认为它们不匹配。

具体来说，对于一个长度为 `m` 的模式串，计算出的最大编辑距离 `d` 约为 `m * (1 - threshold)`。例如，如果 `threshold` 为 `0.6`，模式串的长度为 `4`，则 `d = 4 * (1 - 0.6) = 1.6`，向下取整后得到 `1`。也就是说，对于一个长度为 `4` 的模式串，最多允许编辑距离为 `1`。

`computeScore` 根据传入的参数计算出当前匹配的得分，分数越低表示匹配程度越高。

```js
export default function computeScore(
  pattern,
  {
    errors = 0,
    currentLocation = 0,
    expectedLocation = 0,
    distance = Config.distance,
    ignoreLocation = Config.ignoreLocation,
  } = {}
) {
  const accuracy = errors / pattern.length

  if (ignoreLocation) {
    return accuracy
  }

  const proximity = Math.abs(expectedLocation - currentLocation)

  if (!distance) {
    // Dodge divide by zero error.
    return proximity ? 1.0 : accuracy
  }

  return accuracy + proximity / distance
}
```

`accuracy = 错误数/模式长度`，表示当前匹配的质量。`proximity = 期望位置 - 当前匹配位置`的绝对值，表示它们之间的距离。如果 `distance` 为 0，避开被除数为 0 的错误，判断二者之间距离，返回阙值 1 或者 匹配质量的分数。否则，根据错误数和期望位置和实际位置之间的距离，计算出匹配得分 `score = accuracy + proximity / distance`。

我们得到了匹配得分，现在让我们回到 search 函数。

#### 第一次循环

`while` 循环在每次迭代中执行以下操作：在 `text` 中搜索 `pattern`，并调用`computeScore`计算每个匹配的得分。该循环用来优化搜索算法，不断比较模式与文本中的字符串，直到找到最佳匹配为止。

```js
let index

// Get all exact matches, here for speed up
while ((index = text.indexOf(pattern, bestLocation)) > -1) {
  let score = computeScore(pattern, {
    currentLocation: index,
    expectedLocation,
    distance,
    ignoreLocation,
  })

  currentThreshold = Math.min(score, currentThreshold)
  bestLocation = index + patternLen

  if (computeMatches) {
    let i = 0
    while (i < patternLen) {
      matchMask[index + i] = 1
      i += 1
    }
  }
}
```

`currentThreshold`表示当前的阈值，用于控制什么样的匹配可以被接受。它初始化为最大值，然后每次迭代都会被更新为当前最优匹配的得分，以保证后续的匹配得分不会超过当前最优解。同时，如果`computeMatches` 为`true`，则在 `matchMask` 数组中标记匹配，以便后续统计匹配数。

#### 第二次循环

每次开始搜索前，重置几个变量如`bestLocation`、`binMax`，计算掩码`mask`的值，掩码的长度等于搜索模式的长度 `patternLen`。

```js
bestLocation = -1

let lastBitArr = []
let finalScore = 1
let binMax = patternLen + textLen

const mask = 1 << (patternLen - 1)
```

用一个 for 循环遍历给定的搜索模式中的每个字符，计算出搜索模式的每个字符对应的掩码值，这个掩码用来进行位运算匹配。

```js
for (let i = 0; i < patternLen; i += 1) {
  //...不急不急，后面一步步来分解。
}
```

##### 第一步，二分查找算法更新区间端点

我们先看这个循环体内的一个 while 循环。一个熟悉的二分查找算法，还有一个老朋友`computeScore`函数：计算当前二分区间中间位置的得分。简直就像是即将迷路的旅人见到了自己熟悉的物事。胜利在望了啊同志们！

```js
let binMin = 0
let binMid = binMax
while (binMin < binMid) {
  const score = computeScore(pattern, {
    errors: i,
    currentLocation: expectedLocation + binMid,
    expectedLocation,
    distance,
    ignoreLocation,
  })

  if (score <= currentThreshold) {
    binMin = binMid
  } else {
    binMax = binMid
  }

  binMid = Math.floor((binMax - binMin) / 2 + binMin)
}
```

在这个循环中，每次计算二分区间中间位置的得分，然后根据当前得分和阈值来更新区间端点。这样，循环会不断缩小搜索范围，直到找到最佳匹配或者搜索范围缩小到为空为止。再用这个值赋值给`binMax`作为下一次二分搜索中的右端点：

```js
// Use the result from this iteration as the maximum for the next.
binMax = binMid
```

##### 计算区间两端的值

计算出左端点 `start` 和右端点 `finish`：

```js
let start = Math.max(1, expectedLocation - binMid + 1)
let finish = findAllMatches ? textLen : Math.min(expectedLocation + binMid, textLen) + patternLen

// Initialize the bit array
let bitArr = Array(finish + 2)

bitArr[finish + 1] = (1 << i) - 1
```

左端点 `start` 的值是 `max(expectedLocation - binMid + 1, 1)`，这样可以保证搜索区间的左端点不会小于 1。右端点 `finish` 的值取决于变量 `findAllMatches` 和文本长度 `textLen`。如果 `findAllMatches` 为 `true`，需要搜索整个文本，则将右端点 `finish` 设置为文本长度 `textLen`。否则，将右端点 `finish` 设置为 `min(expectedLocation + binMid, textLen) + patternLen`，以便搜索可能包含匹配项的区间。

初始化二进制数组 `bitArr`，长度为 `finish + 2`。数组中的每个元素代表一位二进制数中的一位。在 `bitArr` 数组中，右端点 `finish + 1` 的元素被设置为一个二进制数，`(1 << i) - 1` 确保其后 `i` 位均为 1，其余位为 0。在后面的算法中，用来存储搜索模式和文本之间的匹配信息。

##### 遍历区间

从右往左遍历文本中的每个字符。这个循环体的代码很长，没关系，继续分解便是。

```js
for (let j = finish; j >= start; j -= 1) {
  let currentLocation = j - 1
  let charMatch = patternAlphabet[text.charAt(currentLocation)]

  if (computeMatches) {
    // Speed up: quick bool to int conversion (i.e, `charMatch ? 1 : 0`)
    matchMask[currentLocation] = +!!charMatch
  }

  // First pass: exact match
  bitArr[j] = ((bitArr[j + 1] << 1) | 1) & charMatch

  // Subsequent passes: fuzzy match
  if (i) {
    bitArr[j] |= ((lastBitArr[j + 1] | lastBitArr[j]) << 1) | 1 | lastBitArr[j + 1]
  }

  if (bitArr[j] & mask) {
    finalScore = computeScore(pattern, {
      errors: i,
      currentLocation,
      expectedLocation,
      distance,
      ignoreLocation,
    })

    // This match will almost certainly be better than any existing match.
    // But check anyway.
    if (finalScore <= currentThreshold) {
      // Indeed it is
      currentThreshold = finalScore
      bestLocation = currentLocation

      // Already passed `loc`, downhill from here on in.
      if (bestLocation <= expectedLocation) {
        break
      }

      // When passing `bestLocation`, don't exceed our current distance from `expectedLocation`.
      start = Math.max(1, 2 * expectedLocation - bestLocation)
    }
  }
}
```

先看第一段：

```js
let currentLocation = j - 1
let charMatch = patternAlphabet[text.charAt(currentLocation)]

if (computeMatches) {
  // Speed up: quick bool to int conversion (i.e, `charMatch ? 1 : 0`)
  matchMask[currentLocation] = +!!charMatch
}

// First pass: exact match
bitArr[j] = ((bitArr[j + 1] << 1) | 1) & charMatch
```

这里根据该字符是否与模式串中的对应字符匹配，更新 `bitArr` 数组相应位置的值。
`patternAlphabet[text.charAt(currentLocation)]` 用于获取当前位置的字符在模式串中最右边出现的位置。如果该字符不在模式串中，则返回 `undefined`。然后，将这个位置记录在 `charMatch` 变量中，以便在后面的匹配过程中使用。

`(bitArr[j + 1] << 1 | 1)` 将右侧位置的匹配状态左移一位，将最后一位设为 1，保证右侧位置的比特位都是 1。再用 `& charMatch` 和当前位置对应的字符是否匹配的比特位进行与运算。如果匹配，那么与运算的结果就是 1，否则是 0。这个过程实际上是在构建比特矩阵，用于后续的模糊匹配。

这里需要注意的是，由于 `bitArr` 数组的长度比文本串和模式串的长度都要长 2，因此 `bitArr[finish + 1]` 和 `bitArr[finish + 2]` 的值都为 0。

```js
// Subsequent passes: fuzzy match
if (i) {
  bitArr[j] |= ((lastBitArr[j + 1] | lastBitArr[j]) << 1) | 1 | lastBitArr[j + 1]
}
```

这段代码实现了模糊匹配的逻辑。`lastBitArr` 初始化为空数组，在后面的代码中，会看到被赋值为上一次循环的 `bitArr`。
在第一次匹配只考虑完全匹配，`bitArr[j]` 只需要用到 `bitArr[j+1]`。但是在后续的匹配需要考虑字符不匹配的情况，那么就需要用到 `lastBitArr` 数组，它存储了上一次匹配的结果。具体来说，对于当前位置 `j`，我们把左侧、上侧和左上侧三个位置（这仨位置可以想象成看似矩阵实际是二维数组的左、左上、上，比如最长公共子序列那个算法）的匹配结果进行或运算，并左移一位。然后再和 1 或上一个特定的值（`lastBitArr[j+1]`），最终得到 `bitArr[j]` 的值。这样就可以考虑字符不匹配的情况，实现模糊匹配的功能。
接下来，判断当前位置的匹配结果是否满足阈值要求，如果满足，则更新最优匹配位置。

```js
if (bitArr[j] & mask) {
  finalScore = computeScore(pattern, { //...一些参数，这里省略  })

  // This match will almost certainly be better than any existing match.
  // But check anyway.
  if (finalScore <= currentThreshold) {
    // Indeed it is
    currentThreshold = finalScore
    bestLocation = currentLocation

    // Already passed `loc`, downhill from here on in.
    if (bestLocation <= expectedLocation) {
      break
    }

    // When passing `bestLocation`, don't exceed our current distance from `expectedLocation`.
    start = Math.max(1, 2 * expectedLocation - bestLocation)
  }
}
```

如果 `bitArr[j] & mask` 的结果为真，则说明当前位置匹配成功，接下来计算当前位置的得分 `finalScore`。如果 `finalScore` 小或等于当前阈值 `currentThreshold`，说明当前匹配结果更优，更新阈值和最优匹配位置 `bestLocation`。

如果最优匹配位置 `bestLocation` 小于等于期望位置 `expectedLocation`，说明已经找到了期望位置的最优匹配，跳出循环；否则更新搜索起点 `start`，保证在向左搜索时不超过当前距离期望位置的距离。

判断当前错误距离是否已经超出了之前最好的匹配结果，如果已经超出，则终止后续匹配，因为后续匹配的结果不可能更优。

```js
// No hope for a (better) match at greater error levels.
const score = computeScore(pattern, {
  errors: i + 1,
  currentLocation: expectedLocation,
  expectedLocation,
  distance,
  ignoreLocation,
})

if (score > currentThreshold) {
  break
}

lastBitArr = bitArr
```

最后，真的最后了 👇🏻：

```js
const result = {
  isMatch: bestLocation >= 0,
  // Count exact matches (those with a score of 0) to be "almost" exact
  score: Math.max(0.001, finalScore),
}

if (computeMatches) {
  const indices = convertMaskToIndices(matchMask, minMatchCharLength)
  if (!indices.length) {
    result.isMatch = false
  } else if (includeMatches) {
    result.indices = indices
  }
}
```

`convertMaskToIndices()`函数将匹配掩码转换为匹配的索引数组。以上，我们得到了 search 的结果。

接下来，回到`searchIn`函数，我们会看到对`result`结果的一些其它处理。这里不再赘述。

## 基于动态规划算法的 Levenshtein 算法

动态规划（Dynamic Programming）常用于处理具有有重叠子问题和最优子结构性质的问题，它将原问题分解成一系列子问题，通过求解子问题的最优解来推算出原问题的最优解。动态规划算法两个关键步骤：设计状态转移方程，用来表示状态之间的关系；确定边界，设置循环结束条件。
一个经典的动态规划算法例子，使用动态规划算法实现斐波那契数列：

```js
function fibonacci(n) {
  if (n === 0 || n === 1) return n

  const dp = new Array(n + 1).fill(0)
  dp[0] = 0
  dp[1] = 1

  for (let i = 2; i <= n; i++) {
    dp[i] = dp[i - 1] + dp[i - 2]
  }

  return dp[n]
}
```

Levenshtein 算法是一种用于计算两个字符串之间的编辑距离的算法，即需要将一个字符串转换为另一个字符串所需的最少编辑次数。编辑操作可以是插入、删除或替换字符。

```js
function levenshteinDistance(str1, str2) {
  const m = str1.length
  const n = str2.length
  const dp = []

  for (let i = 0; i <= m; i++) {
    dp[i] = [i]
  }

  for (let j = 1; j <= n; j++) {
    dp[0][j] = j
  }

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = str1[i - 1] === str2[j - 1] ? 0 : 1
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1, //删除
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      )
    }
  }

  return dp[m][n]
}
```

让我们照着下图来分析如何求出 dp[i][j]

```js
|   |   |     s |   i   |   t   |   t   |   i   |   n   |   g   |
|   | 0 | 1     | 2     | 3     | 4     | 5     | 6     | 7     |
| k | 1 | 1     | 2     | 3     | 4     | 5     | 6     | 7     |
| i | 2 | 2     | 1     | 2     | 3     | 4     | 5     | 6     |
| t | 3 | 3     | 2     | 1     | 2     | 3     | 4     | 5     |
| t | 4 | 4     | 3     | 2     | 1     | 2     | 3     | 4     |
| e | 5 | 5     | 4     | 3     | 2     | 2     | 3     | 4     |
| n | 6 | 6     | 5     | 4     | 3     | 3     | 2     | 3     |
```

假设我们要将字符串 `str1` 转换为字符串 `str2`，并且我们已经定义了一个二维数组 `dp`，其中 `dp[i][j]` 表示将字符串 `str1` 的前 `i` 个字符转换为字符串 `str2` 的前 `j` 个字符所需的最少编辑次数。为了求出 `dp[i][j]`，我们可以考虑将字符串 `str1` 的前 `i` 个字符转换为字符串 `str2` 的前 `j` 个字符时，最后一步进行了什么操作。可能的操作有三种：

删除字符串 `str1` 中的第 `i` 个字符，然后将剩余的字符转换为字符串 `str2` 的前 `j` 个字符。这种情况下，`dp[i][j]` 就等于 `dp[i-1][j] + 1`，其中 `dp[i-1][j]` 表示将字符串 `str1` 的前 `i-1` 个字符转换为字符串 `str2` 的前 `j` 个字符所需的最少编辑次数，再加上删除字符的操作次数 `1`。

在字符串 `str1` 的第 `i` 个位置插入字符 `str2[j]`，然后将剩余的字符转换为字符串 `str2` 的前 `j` 个字符。这种情况下，`dp[i][j]` 就等于 `dp[i][j-1] + 1`，其中 `dp[i][j-1]` 表示将字符串 `str1` 的前 `i` 个字符转换为字符串 `str2` 的前 `j-1` 个字符所需的最少编辑次数，再加上插入字符的操作次数 `1`。

将字符串 `str1` 中的第 `i` 个字符替换为字符 `str2[j]`，然后将剩余的字符转换为字符串 `str2` 的前 `j` 个字符。这种情况下，`dp[i][j]` 就等于 `dp[i-1][j-1] + cost`，其中 `dp[i-1][j-1]` 表示将字符串 `str1` 的前 `i-1` 个字符转换为字符串 `str2` 的前 `j-1` 个字符所需的最少编辑次数，再加上替换字符的操作次数 `cost`（如果 `str1[i]` 和 `str2[j]` 相同，那么 `cost` 就为 `0`，否则 `cost` 就为 `1`）。

上述三种操作中所需的最少编辑次数取最小值，便可作为将字符串 `str1` 的前 `i` 个字符转换为字符串 `str2` 的前 `j` 个字符所需的最少编辑次数。
