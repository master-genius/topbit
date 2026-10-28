'use strict';

/**
 * Http2Pool 连接池回归测试
 *
 * 覆盖三个既有用例无法触及的点：
 *   1. GOAWAY 排水：优雅 GOAWAY 期间的存量流必须完整收完，不得静默截断
 *   2. 空闲不 churn：零流量时空闲关闭后不应自动重连
 *   3. waitQueue 不超发：并发洪峰下 aliveStreams 记账不得越过 streamLimit
 *
 * 运行：node test/test-http2pool.js
 */

const assert = require('node:assert')
const http2 = require('node:http2')
const Http2Pool = require('../src/extends/Http2Pool.js')

const sleep = ms => new Promise(rv => setTimeout(rv, ms))

// ---------- 用例1：GOAWAY 期间存量流必须完整 ----------
async function testGoawayDrain() {
  const srv = http2.createServer()

  srv.on('stream', stream => {
    stream.respond({ ':status': 200 })
    stream.write('part1')
    // 响应写到一半时对端发起优雅 GOAWAY，随后才写完剩余部分
    setTimeout(() => stream.session.goaway(0), 60)
    setTimeout(() => stream.end('part2'), 200)
  })

  await new Promise(rv => srv.listen(0, rv))

  const pool = new Http2Pool({ url: `http://127.0.0.1:${srv.address().port}`, maxConnect: 2 })
  pool.createPool(1)
  await sleep(120)

  const stm = await pool.request({ ':path': '/' })

  let body = ''
  let streamError = null
  stm.on('data', d => { body += d })
  stm.on('error', e => { streamError = e })
  await new Promise(rv => stm.on('close', rv))

  assert.strictEqual(streamError, null, 'GOAWAY 排水期间存量流不应报错')
  assert.strictEqual(body, 'part1part2', 'GOAWAY 后存量流被截断（收到：' + JSON.stringify(body) + '）')

  await sleep(50)
  assert.ok(
    pool.sessions.every(w => !w._draining),
    '排水完成的连接不应继续留在池中'
  )

  srv.close()
  console.log('  ✓ GOAWAY 排水：存量流完整收完，无静默截断')
}

// ---------- 用例2：零流量下保持常驻连接且无 churn ----------
async function testIdleKeepsResident() {
  let sessionCount = 0
  const srv = http2.createServer()
  srv.on('session', () => { sessionCount++ })

  await new Promise(rv => srv.listen(0, rv))

  // timeout 压到 200ms 模拟空闲超时；reconnDelay 压到 50ms 放大 churn
  const pool = new Http2Pool({
    url: `http://127.0.0.1:${srv.address().port}`,
    timeout: 200,
    reconnDelay: 50,
    maxConnect: 10
  })
  pool.createPool(3)

  await sleep(200)
  const afterWarmup = sessionCount
  assert.strictEqual(afterWarmup, 3, `预热应建立 3 条连接，实际 ${afterWarmup}`)

  // 静置若干个空闲周期：富余连接被回收，常驻连接靠 ping 保活，全程不应新建连接
  await sleep(1200)

  assert.strictEqual(
    sessionCount, afterWarmup,
    `零流量期间不应新建连接，实际累计 ${sessionCount}（预热 ${afterWarmup}）= 空闲 churn`
  )
  assert.strictEqual(
    pool.sessions.length, pool.minConnect,
    `零流量下应保留 ${pool.minConnect} 条常驻连接，实际 ${pool.sessions.length}`
  )
  assert.ok(pool.ok(), '常驻连接存在时后端应判为可用')

  // 常驻连接可直接服务，无需重新握手
  const stm = await pool.request({ ':path': '/' })
  stm.close()
  assert.strictEqual(sessionCount, afterWarmup, '零流量后的请求应复用常驻连接，不应新建')

  srv.close()
  console.log(`  ✓ 空闲保活：常驻 ${pool.minConnect} 条连接、零 churn，请求直接复用`)
}

// ---------- 用例3：waitQueue 唤醒不超发配额 ----------
async function testNoStreamOverflow() {
  const LIMIT = 2
  const srv = http2.createServer({ settings: { maxConcurrentStreams: LIMIT } })

  srv.on('stream', stream => {
    setTimeout(() => {
      stream.respond({ ':status': 200 })
      stream.end('x')
    }, 120)
  })

  await new Promise(rv => srv.listen(0, rv))

  const pool = new Http2Pool({
    url: `http://127.0.0.1:${srv.address().port}`,
    maxConnect: 1,
    maxAliveStreams: LIMIT,
    queueTimeout: 8000
  })
  pool.createPool(1)
  await sleep(150)

  assert.strictEqual(pool.sessions[0].streamLimit, LIMIT, '应按对端 SETTINGS 收敛 streamLimit')

  // 精确采样：每次配额预占成功后记录当时的并发数
  let peak = 0
  const origAcquire = pool._acquire.bind(pool)
  pool._acquire = w => {
    const r = origAcquire(w)
    if (r) peak = Math.max(peak, w.aliveStreams)
    return r
  }

  const results = await Promise.allSettled(Array.from({ length: 10 }, async () => {
    const stm = await pool.request({ ':path': '/' })
    stm.resume()
    return new Promise(rv => stm.on('close', rv))
  }))

  const ok = results.filter(r => r.status === 'fulfilled').length
  assert.strictEqual(ok, 10, `10 个并发请求应全部完成，实际 ${ok}`)
  assert.ok(peak <= LIMIT, `aliveStreams 记账峰值 ${peak} 超过配额 ${LIMIT}（waitQueue 超发）`)
  assert.strictEqual(pool.sessions[0].aliveStreams, 0, '全部结束后配额应归零（无泄漏）')
  assert.strictEqual(pool.waitQueue.length, 0, '等待队列应清空')

  srv.close()
  console.log(`  ✓ waitQueue 配额：峰值 ${peak} / 上限 ${LIMIT}，无超发无泄漏`)
}


// ---------- 用例4：空闲回收后仍应判为可用（否则被负载均衡器饿死） ----------
async function testOkAfterIdleReclaim() {
  const srv = http2.createServer()
  await new Promise(rv => srv.listen(0, rv))

  const port = srv.address().port
  // minConnect:0 关闭常驻，强制把池放空，用于验证 ok() 的兜底语义
  const pool = new Http2Pool({
    url: `http://127.0.0.1:${port}`,
    timeout: 200,
    minConnect: 0,
    maxConnect: 5
  })
  pool.createPool(2)
  await sleep(150)
  assert.ok(pool.ok(), '有存活连接时应判为可用')

  // 静置到空闲回收，池被清空
  await sleep(800)
  assert.strictEqual(pool.sessions.length, 0, '空闲连接应被回收')
  assert.ok(
    pool.ok(),
    '空闲回收后池为空，但仍可按需建连，必须判为可用；否则负载均衡器会永久剔除该后端'
  )

  // 该后端仍应能被 balancer 选中
  const Balancer = require('../src/lib/balancer.js')
  const bl = new Balancer({ identityFn: c => c.ip })
  const idle = { url: 'http://idle', weight: 1, h2Pool: pool }
  const busy = { url: 'http://busy', weight: 1, h2Pool: { ok: () => true } }
  const picked = new Set()
  for (let i = 0; i < 60; i++) picked.add(bl.select({ ip: `10.0.0.${i}` }, [idle, busy], { stepIndex: 0 }).url)
  assert.ok(picked.has('http://idle'), '空闲后端应仍可被负载均衡器选中')

  // 后端真的挂掉时才应判为不可用
  srv.close()
  await new Promise(rv => setTimeout(rv, 50))
  const dead = new Http2Pool({ url: `http://127.0.0.1:${port}`, minConnect: 0, maxConnect: 2 })
  dead.createPool(1)
  await sleep(300)
  assert.strictEqual(dead.ok(), false, '建连失败的后端应判为不可用')

  console.log('  ✓ ok() 语义：空闲空池仍可用、建连失败才不可用')
}

// ---------- 用例5：冷启动（SETTINGS 未到达）不得超发 ----------
async function testColdStartNoOverflow() {
  const LIMIT = 2
  const srv = http2.createServer({ settings: { maxConcurrentStreams: LIMIT } })
  srv.on('stream', stream => {
    setTimeout(() => { stream.respond({ ':status': 200 }); stream.end('x') }, 100)
  })
  await new Promise(rv => srv.listen(0, rv))

  const pool = new Http2Pool({
    url: `http://127.0.0.1:${srv.address().port}`,
    maxConnect: 1,
    maxAliveStreams: 100,   // 本地配置远大于对端声明
    queueTimeout: 8000
  })
  pool.createPool(1)

  // 关键：不等待 remoteSettings，连接刚建立就打并发
  // （'connect' 先于 'remoteSettings' 触发，此刻若按本地配置放行即超发）
  let peak = 0
  const origAcquire = pool._acquire.bind(pool)
  pool._acquire = w => {
    const r = origAcquire(w)
    if (r) peak = Math.max(peak, w.aliveStreams)
    return r
  }

  const results = await Promise.allSettled(Array.from({ length: 10 }, async () => {
    const stm = await pool.request({ ':path': '/' })
    stm.resume()
    return new Promise(rv => stm.on('close', rv))
  }))

  const ok = results.filter(r => r.status === 'fulfilled').length
  assert.strictEqual(ok, 10, `冷启动并发请求应全部完成，实际 ${ok}`)
  assert.ok(peak <= LIMIT, `冷启动期间并发峰值 ${peak} 超过对端声明的 ${LIMIT}`)

  srv.close()
  console.log(`  ✓ 冷启动配额：峰值 ${peak} / 对端声明 ${LIMIT}，SETTINGS 到达前不超发`)
}


// ---------- 用例6：冷启动不产生连接扇出 ----------
async function testColdStartNoFanout() {
  let sessions = 0
  const srv = http2.createServer({ settings: { maxConcurrentStreams: 10 } })
  srv.on('session', () => { sessions++ })
  srv.on('stream', stream => {
    setTimeout(() => { stream.respond({ ':status': 200 }); stream.end('x') }, 80)
  })
  await new Promise(rv => srv.listen(0, rv))

  const pool = new Http2Pool({
    url: `http://127.0.0.1:${srv.address().port}`,
    maxConnect: 10,
    maxAliveStreams: 100,
    queueTimeout: 8000
  })
  pool.createPool(1)

  // 不等握手完成就打并发：每个请求都会发现"暂无可用配额"
  const results = await Promise.allSettled(Array.from({ length: 10 }, async () => {
    const stm = await pool.request({ ':path': '/' })
    stm.resume()
    return new Promise(rv => stm.on('close', rv))
  }))

  const ok = results.filter(r => r.status === 'fulfilled').length
  assert.strictEqual(ok, 10, `冷启动并发请求应全部完成，实际 ${ok}`)
  assert.ok(sessions <= 2, `冷启动 10 并发只应复用握手中的连接，实际建立了 ${sessions} 条`)

  srv.close()
  console.log(`  ✓ 冷启动扇出：10 并发 → ${sessions} 条连接（对端配额充足时不扩容）`)
}

// 取一个当前无人监听的端口
async function freePort() {
  const s = http2.createServer()
  await new Promise(rv => s.listen(0, '127.0.0.1', rv))
  const port = s.address().port
  await new Promise(rv => s.close(rv))
  return port
}

function simpleGet(pool) {
  return pool.request({ ':path': '/' }).then(stm => new Promise((rv, rj) => {
    stm.on('error', rj)
    stm.on('close', rv)
    stm.resume()
  }))
}

// ---------- 用例7：minConnect<=0 的失败窗口：窗口内不可用，窗口后放行，恢复后自愈 ----------
async function testZeroMinConnectFailWindow() {
  for (const mc of [0, -1]) {
    const port = await freePort()
    const pool = new Http2Pool({
      url: `http://127.0.0.1:${port}`,
      minConnect: mc,
      failWindow: 400,
      timeout: 200
    })

    // 不调用 createPool：池一直为空，直到有请求才建连（lazy 语义）
    await sleep(100)
    assert.strictEqual(pool.sessions.length, 0, `minConnect=${mc} 时不应自行建连`)
    assert.ok(pool.ok(), '从未失败过，空池应判为可用')

    // 对死端口发请求：建连失败，并且不得有后台重连
    await simpleGet(pool).then(
      () => assert.fail('死端口不应请求成功'),
      () => {}
    )
    await sleep(50)
    assert.strictEqual(pool.ok(), false, `minConnect=${mc}：失败窗口内应判为不可用`)

    await sleep(500)
    assert.strictEqual(pool.sessions.length, 0, `minConnect=${mc}：失败后不得后台重连`)
    assert.ok(pool.ok(), `minConnect=${mc}：窗口过后应放行探测`)

    // 后端恢复：放行的那个请求应当成功，并复位失败标记
    const srv = http2.createServer()
    srv.on('stream', stream => { stream.respond({ ':status': 200 }); stream.end('x') })
    await new Promise(rv => srv.listen(port, '127.0.0.1', rv))
    await simpleGet(pool)
    assert.strictEqual(pool._lastFailedAt, 0, '连上之后应清零失败时间')
    assert.ok(pool.ok(), '恢复后应判为可用')

    // 空闲回收后池空且不补连
    await sleep(800)
    assert.strictEqual(pool.sessions.length, 0, '空闲连接应被回收且不补连')

    srv.close()
  }
  console.log('  ✓ minConnect<=0：无预建、失败窗口内不可用、窗口后放行并自愈')
}

// ---------- 用例8（回归）：minConnect>0 的 ok() 不受失败窗口影响 ----------
async function testPositiveMinConnectUnchanged() {
  const port = await freePort()
  const pool = new Http2Pool({
    url: `http://127.0.0.1:${port}`,
    minConnect: 2,
    failWindow: 200,
    reconnDelay: 60000,
    maxConnect: 2
  })
  pool.createPool(1)
  await sleep(100)
  assert.strictEqual(pool.ok(), false, '建连失败后应判为不可用')

  await sleep(500)  // 远超 failWindow
  assert.strictEqual(
    pool.ok(), false,
    'minConnect>0 时失败标记不得按时间自动失效，只能由成功建连复位'
  )
  console.log('  ✓ 回归：minConnect>0 时失败标记不受 failWindow 影响')
}

;(async () => {
  console.log('Http2Pool 回归测试')
  await testGoawayDrain()
  await testIdleKeepsResident()
  await testNoStreamOverflow()
  await testOkAfterIdleReclaim()
  await testColdStartNoOverflow()
  await testColdStartNoFanout()
  await testZeroMinConnectFailWindow()
  await testPositiveMinConnectUnchanged()
  console.log('全部通过')
  process.exit(0)
})().catch(err => {
  console.error('测试失败：', err.message)
  process.exit(1)
})
