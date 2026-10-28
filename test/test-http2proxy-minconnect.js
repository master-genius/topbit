'use strict';

// Http2Proxy minConnect 选项端到端验证（h1 下游 → h2c 上游）
// 覆盖：
//   1. 全局 minConnect:0     → 启动期零连接，首个请求才建连，空闲回收后不补连
//   2. 后端级 minConnect:-3  → <=0 同样生效，且可覆盖实例默认
//   3. 不传 minConnect       → 保持原行为（启动预热）
//   4. 非法 minConnect       → 报错并回退默认，不误报「未知选项」
//
// 运行：node test/test-http2proxy-minconnect.js

const Topbit = require('../src/topbit.js')
const http = require('node:http')
const http2 = require('node:http2')

const { Http2Proxy } = Topbit.extensions

let pass = 0, fail = 0
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' ' + extra : ''}`)
  cond ? pass++ : fail++
}

const sleep = ms => new Promise(rv => setTimeout(rv, ms))

// 统计连接数的 h2c 后端：total 为累计，active 为当前存活
function startBackend(port) {
  const st = { total: 0, active: 0 }
  const srv = http2.createServer()

  srv.on('connection', sock => {
    st.total++
    st.active++
    sock.on('close', () => st.active--)
    sock.on('error', () => {})
  })

  srv.on('stream', stream => {
    stream.on('error', () => {})
    stream.respond({ ':status': 200 })
    stream.end('ok')
  })

  return new Promise(rv => srv.listen(port, '127.0.0.1', () => rv({ srv, st })))
}

// 每次请求用独立连接（agent:false），避免 h1 下游 keep-alive 干扰
function request(port, host) {
  return new Promise(resolve => {
    const r = http.request({ host: '127.0.0.1', port, path: '/', headers: { host }, agent: false }, res => {
      let d = ''
      res.on('data', c => d += c)
      res.on('end', () => resolve({ code: res.statusCode, body: d }))
    })
    r.on('error', e => resolve({ code: 'ERR', body: e.message }))
    r.end()
  })
}

// 起一套 后端 + 代理 + 应用；proxyOpts 为 Http2Proxy 构造参数里除 config 外的部分
async function setup(bport, aport, proxyOpts, backendCfg) {
  const { srv, st } = await startBackend(bport)

  const pxy = new Http2Proxy({
    // 空闲回收时长取自实例 timeout，调小以便测试
    timeout: 600,
    config: {
      'mc.test': [{ path: '/', url: `http://127.0.0.1:${bport}`, ...backendCfg }]
    },
    ...proxyOpts
  })

  const app = new Topbit({ debug: false })
  pxy.init(app)
  app.run(aport, '127.0.0.1')

  return { srv, st, pxy, aport }
}

// 捕获 console.error，用于断言告警内容
function captureErrors() {
  const msgs = []
  const orig = console.error
  console.error = (...a) => { msgs.push(a.join(' ')) }
  return { msgs, restore: () => { console.error = orig } }
}

;(async () => {
  // ---------- 1. 全局 minConnect:0 ----------
  {
    const cap = captureErrors()
    const s = await setup(39901, 39900, { minConnect: 0 }, {})
    await sleep(900)  // 超过「未知选项」告警的 500ms 延迟
    cap.restore()

    check('1.1 启动期零连接', s.st.total === 0, `累计 ${s.st.total}`)
    check('1.2 minConnect 不触发「未知选项」', !cap.msgs.some(m => m.includes('未知选项')),
          cap.msgs.join('|').slice(0, 80))

    const r = await request(39900, 'mc.test')
    check('1.3 首个请求成功', r.code === 200 && r.body === 'ok', `实际 ${r.code} ${r.body.slice(0, 40)}`)
    check('1.4 首个请求才建连', s.st.total === 1, `累计 ${s.st.total}`)

    await sleep(1800)  // 超过空闲回收时长
    check('1.5 空闲回收后连接归零', s.st.active === 0, `存活 ${s.st.active}`)
    check('1.6 回收后不补连', s.st.total === 1, `累计 ${s.st.total}`)

    const r2 = await request(39900, 'mc.test')
    check('1.7 回收后再次请求成功', r2.code === 200, `实际 ${r2.code}`)
    check('1.8 再次请求按需重建', s.st.total === 2, `累计 ${s.st.total}`)

    s.srv.close()
  }

  // ---------- 2. 后端级 minConnect:-3（<=0 等价于 0） ----------
  {
    const s = await setup(39903, 39902, {}, { minConnect: -3 })
    await sleep(900)
    check('2.1 后端级 -3：启动期零连接', s.st.total === 0, `累计 ${s.st.total}`)

    const r = await request(39902, 'mc.test')
    check('2.2 后端级 -3：首个请求成功', r.code === 200, `实际 ${r.code}`)
    check('2.3 后端级 -3：按需建连', s.st.total === 1, `累计 ${s.st.total}`)

    s.srv.close()
  }

  // ---------- 2b. 后端级覆盖实例级：实例 0，后端 3 → 后端走预热 ----------
  {
    const s = await setup(39905, 39904, { minConnect: 0 }, { minConnect: 3 })
    await sleep(900)
    check('2b 后端级 3 覆盖实例级 0：启动预热', s.st.total >= 2, `累计 ${s.st.total}`)
    s.srv.close()
  }

  // ---------- 3. 不传 minConnect：原行为（预热） ----------
  {
    const s = await setup(39907, 39906, {}, {})
    await sleep(900)
    check('3.1 默认：启动期预热建连', s.st.total >= 2, `累计 ${s.st.total}`)

    const r = await request(39906, 'mc.test')
    check('3.2 默认：请求成功', r.code === 200, `实际 ${r.code}`)

    s.srv.close()
  }

  // ---------- 4. 非法值 ----------
  {
    const cap = captureErrors()
    const s = await setup(39909, 39908, { minConnect: 'abc' }, { minConnect: NaN })
    await sleep(900)
    cap.restore()

    check('4.1 实例级非法值报错', cap.msgs.some(m => m.includes('minConnect 必须是数字: abc')),
          cap.msgs.join('|').slice(0, 80))
    check('4.2 后端级非法值报错', cap.msgs.some(m => /minConnect 必须是数字: NaN/.test(m)),
          cap.msgs.join('|').slice(0, 80))
    check('4.3 非法值回退默认（预热）', s.st.total >= 2, `累计 ${s.st.total}`)
    check('4.4 非法值不误报「未知选项」', !cap.msgs.some(m => m.includes('未知选项')))

    s.srv.close()
  }

  console.log(`\n通过 ${pass}，失败 ${fail}`)
  process.exit(fail > 0 ? 1 : 0)
})().catch(err => {
  console.error('测试异常：', err)
  process.exit(1)
})
