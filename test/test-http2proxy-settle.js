'use strict';

/**
 * Http2Proxy 转发 Promise 的 settle 路径全覆盖测试
 *
 * 背景：转发逻辑是 `await new Promise(async (rv, rj) => {...})`。async executor 的抛出
 * 不会被 new Promise 接管，若某条失败路径既不 rv 也不 rj，外层 await 将永久挂起
 * （表现为请求挂死，而非返回 5xx）。此前靠一处冗余的 rj 兜底，现改为统一的 failsafe，
 * 本测试逐条证明每种失败形态都能 settle 且不挂起。
 *
 *   1. 后端流建立失败（request 抛出 → catch 分支）
 *   2. request 返回空值（catch 未触发但拿不到流 → 兜底分支）
 *   3. 拿到流之后的同步异常（await 之后逃逸 → try/catch 分支）
 *   4. 正常转发（rv 分支）
 *   5. h2 下游客户端以 NO_ERROR 优雅取消：上游流应被销毁，后端不再继续推送
 *      （这条走的是 stm 的 data 分支——request_stream 的 close 钩子只在
 *        rstCode !== NO_ERROR 时关流，优雅取消不触发，只能靠"客户端不可写即销毁"）
 *   6. 响应方向背压：大响应 + 慢读客户端，须完整送达。
 *      drain 监听若被"一次性消费"（例如把按需注册的 once 挪到请求开始处常驻），
 *      第二次背压就会 pause 而无人 resume，表现为传输卡死到超时。
 *
 * 运行：node test/test-http2proxy-settle.js
 */

const http = require('node:http');
const http2 = require('node:http2');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const KEY = path.join(__dirname, '../demo/cert/localhost-privkey.pem');
const CERT = path.join(__dirname, '../demo/cert/localhost-cert.pem');

const mode = process.argv[2] || '';
const BACKEND_PORT = 39151;
const PROXY_PORT = 39152;
const HANG_LIMIT = 4000;   // 超过此时长未响应即判定为挂起

if (mode) {
  const Topbit = require('../src/topbit.js');
  const { Http2Proxy } = Topbit.extensions;

  // abort 场景：后端持续推送大响应，用于观察客户端取消后上游是否被及时切断
  let backendPushed = 0;
  let backendStopped = false;

  const BIG_SIZE = 8 * 1024 * 1024;

  const backend = http2.createServer();
  backend.on('stream', stream => {
    if (mode === 'backpressure') {
      stream.respond({ ':status': 200 });
      const chunk = Buffer.alloc(64 * 1024, 'b');
      let sent = 0;
      const pump = () => {
        while (sent < BIG_SIZE) {
          sent += chunk.length;
          if (stream.write(chunk) === false) { stream.once('drain', pump); return; }
        }
        stream.end();
      };
      pump();
      return;
    }

    if (mode !== 'abort') {
      stream.respond({ ':status': 200 });
      stream.end('backend-ok');
      return;
    }

    stream.respond({ ':status': 200 });
    const chunk = Buffer.alloc(16 * 1024, 'a');
    const push = () => {
      if (backendStopped || stream.destroyed || stream.closed) { backendStopped = true; return; }
      backendPushed += chunk.length;
      stream.write(chunk);
      setTimeout(push, 10);
    };
    stream.on('close', () => { backendStopped = true; });
    push();
  });
  backend.listen(BACKEND_PORT);

  // abort 场景需要纯 h2 下游（ServerHttp2Stream），其余场景用 h1 下游即可
  const app = mode === 'abort'
    ? new Topbit({ debug: false, http2: true, key: KEY, cert: CERT })
    : new Topbit({ debug: false });
  const pxy = new Http2Proxy({
    config: { 'x.com': [{ url: `http://127.0.0.1:${BACKEND_PORT}` }] }
  });
  pxy.init(app);
  app.run(PROXY_PORT);

  // 拿到后端对象，按场景替换其连接池的 request 行为
  const backendObj = pxy.hostProxy['x.com'][Object.keys(pxy.hostProxy['x.com'])[0]][0];

  const stubs = {
    // 建流失败：走 .catch(err => failsafe(err))
    'reject': () => { backendObj.h2Pool.request = async () => { throw new Error('stub: connect failed') }; },
    // 建流「成功」但拿到空值：catch 不触发，只能靠 !stm 兜底分支
    'empty':  () => { backendObj.h2Pool.request = async () => null; },
    // 拿到流之后的同步异常：await 之后逃逸，只能靠整体 try/catch
    'throw':  () => { backendObj.h2Pool.request = async () => ({ destroyed: false }); },
    // 正常路径
    'ok':     () => {},
    // 客户端提前断开
    'abort':  () => {},
    // 响应方向背压
    'backpressure': () => {}
  };

  stubs[mode]();

  if (mode === 'backpressure') {
    setTimeout(() => {
      const started = Date.now();
      let received = 0;

      const hangTimer = setTimeout(() => {
        console.log(`  ✗ [backpressure] 15s 内只收到 ${received}/${BIG_SIZE} 字节 = 传输卡死`);
        process.exit(1);
      }, 15000);

      const r = http.request({
        host: '127.0.0.1', port: PROXY_PORT, path: '/', headers: { host: 'x.com' }
      }, res => {
        // 慢读：周期性暂停，制造多轮下游背压
        res.on('data', d => {
          received += d.length;
          res.pause();
          setTimeout(() => res.resume(), 4);
        });

        res.on('end', () => {
          clearTimeout(hangTimer);
          const ok = received === BIG_SIZE;
          console.log(`  ${ok ? '✓' : '✗'} [backpressure] ${Date.now() - started}ms 收到 `
            + `${received}/${BIG_SIZE} 字节`);
          backend.close();
          process.exit(ok ? 0 : 1);
        });
      });

      r.on('error', e => {
        clearTimeout(hangTimer);
        console.log(`  ✗ [backpressure] 传输出错 ${e.code || e.message}（已收 ${received} 字节）`);
        process.exit(1);
      });

      r.end();
    }, 500);
    return;
  }

  if (mode === 'abort') {
    setTimeout(() => {
      const client = http2.connect(`https://127.0.0.1:${PROXY_PORT}`, { rejectUnauthorized: false });

      client.on('error', e => {
        console.log(`  ✗ [abort] h2 客户端连接失败：${e.message}`);
        process.exit(1);
      });

      const req = client.request({ ':method': 'GET', ':path': '/', ':authority': 'x.com' });

      req.on('response', () => {
        // 收到响应头后以 NO_ERROR 优雅取消（不是 RST/断连）
        req.close(http2.constants.NGHTTP2_NO_ERROR);

        const pushedAtAbort = backendPushed;
        setTimeout(() => {
          const pushedAfter = backendPushed - pushedAtAbort;
          const ok = backendStopped && pushedAfter <= 64 * 1024;
          console.log(`  ${ok ? '✓' : '✗'} [abort] NO_ERROR 取消后后端`
            + `${backendStopped ? '已停止推送' : '仍在推送'}，其后又推了 ${pushedAfter} 字节`);
          backend.close();
          process.exit(ok ? 0 : 1);
        }, 700);
      });

      req.on('error', () => {});
      req.resume();
      req.end();
    }, 500);
    return;
  }

  setTimeout(() => {
    const started = Date.now();
    let answered = false;

    const hangTimer = setTimeout(() => {
      if (answered) return;
      console.log(`  ✗ [${mode}] ${HANG_LIMIT}ms 内无响应 = Promise 未 settle，请求挂起`);
      process.exit(1);
    }, HANG_LIMIT);

    const r = http.request({
      host: '127.0.0.1', port: PROXY_PORT, path: '/', headers: { host: 'x.com' }
    }, res => {
      answered = true;
      clearTimeout(hangTimer);
      res.resume();
      res.on('end', () => {
        const cost = Date.now() - started;
        // 失败场景一律映射为 5xx（不含 504：这些都不是超时），正常场景 200
        const ok = mode === 'ok'
          ? res.statusCode === 200
          : (res.statusCode >= 500 && res.statusCode < 600 && res.statusCode !== 504);

        console.log(`  ${ok ? '✓' : '✗'} [${mode}] ${cost}ms 内返回 ${res.statusCode}`
          + (mode === 'ok' ? '（期望 200）' : '（期望 5xx，非挂起）'));

        backend.close();
        process.exit(ok ? 0 : 1);
      });
    });

    r.on('error', e => {
      answered = true;
      clearTimeout(hangTimer);
      console.log(`  ✗ [${mode}] 连接错误 ${e.code || e.message}`);
      process.exit(1);
    });

    r.end();
  }, 500);

  return;
}

console.log('Http2Proxy 转发 Promise settle 路径测试');

let fail = 0;
const modes = ['reject', 'empty', 'throw', 'ok', 'backpressure'];

// abort 场景依赖 demo/cert（仅测试用途）
if (fs.existsSync(KEY) && fs.existsSync(CERT)) modes.push('abort');
else console.log('  - [abort] SKIP：demo/cert/ 证书缺失');

for (const m of modes) {
  const r = spawnSync(process.execPath, [__filename, m], { timeout: 30000, stdio: 'inherit' });
  if (r.status !== 0) fail++;
}

console.log(fail === 0 ? '全部通过' : `${fail} 个场景失败`);
process.exit(fail > 0 ? 1 : 0);
