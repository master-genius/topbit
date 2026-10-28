'use strict';

// Proxy / ProxyNoAgent 存活检测的定时器策略验证
// 约定：
//   1. aliveCheckInterval 默认 0：不显式设置就不检测，不创建定时器，后端收不到探测请求
//   2. 显式设置 > 0 才检测该后端；全局最多一个定时器，只覆盖这些后端
//   3. 同一后端被多个 host key 共享（:80 / :443 别名）时只检测一次
//   4. stopAliveCheck() / startAliveCheck() 可反复调用，不泄漏定时器
//   5. debug: true 时输出是否启动定时器，以及检测 / 跳过了哪些后端
//
// 运行：node test/test-proxy-alive-check.js

const http = require('node:http')

const Topbit = require('../src/topbit.js')
const { Proxy, ProxyNoAgent } = Topbit.extensions

let pass = 0, fail = 0
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' ' + extra : ''}`)
  cond ? pass++ : fail++
}

const sleep = ms => new Promise(rv => setTimeout(rv, ms))

// 不起真实服务，只验证 init() 里的存活检测逻辑
const mockApp = { config: { timeout: 0 }, router: { map: () => {} }, use: () => {} }

// 端口取在系统临时端口范围（32768+）之外
const BACKEND_PORT = 28920

// 记录收到的探测请求
let probes = []
const backend = http.createServer((rq, rs) => {
  probes.push({ method: rq.method, url: rq.url, ua: rq.headers['user-agent'] })
  rs.end('ok')
})

// 捕获 console.log
function captureLog(fn) {
  const lines = []
  const orig = console.log
  console.log = (...a) => { lines.push(a.join(' ')) }
  try { fn() } finally { console.log = orig }
  return lines
}

;(async () => {
  await new Promise(rv => backend.listen(BACKEND_PORT, '127.0.0.1', rv))
  const url = `http://127.0.0.1:${BACKEND_PORT}`

  for (const [name, Cls] of [['Proxy', Proxy], ['ProxyNoAgent', ProxyNoAgent]]) {
    // ---- 1. 默认不检测 ----
    probes = []
    const pDef = new Cls({ config: { 'a.test': [{ path: '/', url }] } })
    pDef.init(mockApp)
    check(`${name} 默认不创建定时器`, pDef.aliveTimer === null, String(pDef.aliveTimer))
    check(`${name} 默认没有被检测的后端`, pDef.aliveTargets.length === 0, String(pDef.aliveTargets.length))
    await sleep(2500)
    check(`${name} 默认：后端收不到探测请求`, probes.length === 0, `收到 ${probes.length} 次`)
    pDef.stopAliveCheck()

    // ---- 2. 显式开启 ----
    probes = []
    const pOn = new Cls({ config: { 'a.test': [{ path: '/', url, aliveCheckInterval: 1 }] } })
    pOn.init(mockApp)
    check(`${name} 显式设置 > 0 创建定时器`, !!pOn.aliveTimer)
    await sleep(2500)
    check(`${name} 显式开启：后端收到探测请求`, probes.length >= 1, `收到 ${probes.length} 次`)
    check(`${name} 探测请求带存活检测标识`, probes.length > 0 && /AliveCheck/.test(probes[0].ua), String(probes[0] && probes[0].ua))
    pOn.stopAliveCheck()

    // ---- 3. 混合配置：只收集 > 0 的后端，全局一个定时器 ----
    const pMix = new Cls({
      config: {
        'a.test': [
          { path: '/', url: 'http://127.0.0.1:28921', aliveCheckInterval: 3 },
          { path: '/', url: 'http://127.0.0.1:28922' }                       // 默认 0，跳过
        ],
        'b.test': [
          { path: '/api', url: 'http://127.0.0.1:28923', aliveCheckInterval: 5,
            aliveCheckMethod: 'HEAD', aliveCheckPath: '/ping' }
        ],
        'c.test': [
          { path: '/', url: 'http://127.0.0.1:28924', aliveCheckInterval: 0 } // 显式 0，跳过
        ]
      }
    })
    pMix.init(mockApp)
    const urls = pMix.aliveTargets.map(t => t.url).sort()
    check(`${name} 混合配置只检测 > 0 的后端`,
          JSON.stringify(urls) === JSON.stringify(['http://127.0.0.1:28921', 'http://127.0.0.1:28923']),
          JSON.stringify(urls))
    check(`${name} 混合配置全局只有一个定时器`, !!pMix.aliveTimer)

    // ---- 4. 别名去重 ----
    const pAlias = new Cls({ port: 443, config: { 'x.com': [{ path: '/', url, aliveCheckInterval: 2 }] } })
    pAlias.init(mockApp)
    check(`${name} 双 key 别名下同一后端只检测一次`,
          Object.keys(pAlias.hostProxy).length === 2 && pAlias.aliveTargets.length === 1,
          `key ${Object.keys(pAlias.hostProxy)} / 检测 ${pAlias.aliveTargets.length}`)
    pAlias.stopAliveCheck()

    // ---- 5. 启停 ----
    const t1 = pMix.aliveTimer
    pMix.stopAliveCheck()
    check(`${name} stopAliveCheck() 清除定时器与目标`,
          pMix.aliveTimer === null && pMix.aliveTargets.length === 0 && pMix.aliveCheckStopped === true)
    check(`${name} stopAliveCheck() 返回 this 以便链式调用`, pMix.stopAliveCheck() === pMix)

    pMix.startAliveCheck()
    const t2 = pMix.aliveTimer
    check(`${name} startAliveCheck() 可恢复`, !!t2 && pMix.aliveTargets.length === 2 && pMix.aliveCheckStopped === false)
    pMix.startAliveCheck()
    check(`${name} 重复 startAliveCheck() 不泄漏旧定时器`, t2._destroyed === true && !!pMix.aliveTimer && pMix.aliveTimer !== t2)
    check(`${name} 旧句柄在 stop 后已销毁`, t1._destroyed === true)
    pMix.stopAliveCheck()

    // ---- 6. debug 输出 ----
    const mixCfg = () => ({
      config: {
        'a.test': [
          { path: '/', url: 'http://127.0.0.1:28921', aliveCheckInterval: 3 },
          { path: '/', url: 'http://127.0.0.1:28922' }
        ],
        'b.test': [
          { path: '/api', url: 'http://127.0.0.1:28923', aliveCheckInterval: 5,
            aliveCheckMethod: 'HEAD', aliveCheckPath: '/ping' }
        ]
      }
    })

    let pxy
    let lines = captureLog(() => { pxy = new Cls({ debug: true, ...mixCfg() }); pxy.init(mockApp) })
    const out = lines.join('\n')
    check(`${name} debug：输出已启动与数量`, out.includes(`[${name}] 存活检测：已启动，1 个定时器，检测 2 个后端`), lines[0])
    check(`${name} debug：列出检测的后端（含间隔 / 方法 / 路径）`,
          /检测\s+a\.test\s+\S+\s+http:\/\/127\.0\.0\.1:28921\s+每 3s\s+GET \//.test(out)
          && /检测\s+b\.test\s+\S+\s+http:\/\/127\.0\.0\.1:28923\s+每 5s\s+HEAD \/ping/.test(out), out)
    check(`${name} debug：列出被跳过的后端`, /跳过\s+a\.test\s+\S+\s+http:\/\/127\.0\.0\.1:28922\s+aliveCheckInterval=0/.test(out))
    pxy.stopAliveCheck()

    lines = captureLog(() => {
      pxy = new Cls({ debug: true, config: { 'a.test': [{ path: '/', url: 'http://127.0.0.1:28922' }] } })
      pxy.init(mockApp)
    })
    check(`${name} debug：没有可检测后端时输出未启动`,
          lines[0] === `[${name}] 存活检测：未启动（没有 aliveCheckInterval > 0 的后端）`
          && lines.some(l => /跳过\s+a\.test/.test(l)), lines.join(' | '))
    pxy.stopAliveCheck()

    lines = captureLog(() => { pxy = new Cls(mixCfg()); pxy.init(mockApp) })
    check(`${name} 未开启 debug 时不输出`, lines.length === 0, lines.join(' | '))
    pxy.stopAliveCheck()
  }

  backend.close()
  console.log(`\n通过 ${pass}，失败 ${fail}`)
  process.exit(fail > 0 ? 1 : 0)
})().catch(err => {
  process.stderr.write(`测试异常：${err && err.stack}\n`)
  process.exit(1)
})
