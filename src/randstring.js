'use strict'
const crypto = require('crypto')

let saltArr = [
  'a','b','c','d','e','f','g',
  'h','i','j','k','l','m','n',
  'o','p','q','r','s','t','u',
  'v','w','x','y','z','1','2',
  '3','4','5','6','7','8','9'
]

function secureShuffle(arr) {
  const newArr = [...arr]

  // Fisher-Yates 洗牌算法
  for (let i = newArr.length - 1; i > 0; i--) {
    // 这里只在启动时运行一次，所以用性能较慢但绝对安全的 crypto
    const j = crypto.randomInt(0, i + 1)
    ;[newArr[i], newArr[j]] = [newArr[j], newArr[i]]
  }

  return newArr
}

const fastSecretChars = secureShuffle(saltArr)
const charsLen = fastSecretChars.length

module.exports = (length = 8, sarr = null) => {
  let saltstr = ''
  
  // 如果用户传了自定义数组，为了兼容性不得不降级处理 (性能稍慢，逻辑不变)
  if (sarr) {
    const customLen = sarr.length

    for (let i = 0; i < length; i++) {
      saltstr += sarr[(Math.random() * customLen) | 0]
    }
    
    return saltstr
  }

  for (let i = 0; i < length; i++) {
    saltstr += fastSecretChars[(Math.random() * charsLen) | 0]
  }

  return saltstr
}