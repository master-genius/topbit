'use strict';

// Http2Proxy 的 timeout 与 connectTimeout 关系验证
// 连接池的空闲超时取自代理 timeout；若它小于握手等待上限 connectTimeout，
// 连接会在握手中途被当作空闲关掉，因此池会把它抬高为 connectTimeout + 5000。
// timeout = 0 表示不超时，必须原样保留。
//
// 运行：node test/test-http2proxy-timeout.js

const Topbit = require('../src/topbit.js')

const { Http2Proxy } = Topbit.extensions

let pass = 0, fail = 0
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' ' + extra : ''}`)
  cond ? pass++ : fail++
}

// minConnect:0 避免构造期向不存在的后端发起连接；读取后端 Pool 实际生效的空闲超时
function idleTimeouts(proxyOpts, backendCfg = {}) {
  const pxy = new Http2Proxy({
    minConnect: 0,
    ...proxyOpts,
    config: { 'to.test': [{ path: '/', url: 'http://127.0.0.1:1', ...backendCfg }] }
  })
  const t = pxy.hostProxy['to.test']
  return t[Object.keys(t)[0]].map(b => b.h2Pool.connectOptions.timeout)
}

const r = idleTimeouts({})
check('1 默认（30000 ≥ 15000）：不处理', r[0] === 30000, `实际 ${r}`)

const r2 = idleTimeouts({ timeout: 600 })
check('2 timeout 600 < 默认 connectTimeout 15000：抬高为 20000', r2[0] === 20000, `实际 ${r2}`)

const r3 = idleTimeouts({ timeout: 600, connectTimeout: 2000 })
check('3 实例级 connectTimeout 2000：抬高为 7000', r3[0] === 7000, `实际 ${r3}`)

const r4 = idleTimeouts({ timeout: 600 }, { connectTimeout: 3000 })
check('4 后端级 connectTimeout 3000：抬高为 8000', r4[0] === 8000, `实际 ${r4}`)

const r5 = idleTimeouts({ timeout: 0 })
check('5 timeout=0（不超时）：原样保留', r5[0] === 0, `实际 ${r5}`)

const r6 = idleTimeouts({ timeout: 20000 })
check('6 timeout 20000 > connectTimeout 15000：不处理', r6[0] === 20000, `实际 ${r6}`)

const r7 = idleTimeouts({ timeout: 15000 })
check('7 timeout 等于 connectTimeout：不处理', r7[0] === 15000, `实际 ${r7}`)

console.log(`\n通过 ${pass}，失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)
