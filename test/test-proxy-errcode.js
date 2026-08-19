'use strict';

/**
 * 代理错误码语义 + balancer 契约回归测试
 *
 *   1. 后端不可达（ECONNREFUSED）→ 502 Bad Gateway
 *   2. 后端不响应（ETIMEOUT）    → 504 Gateway Timeout
 *   3. balancer 返回 undefined   → 503（而非解引用 undefined 抛 TypeError → 500）
 *
 * Topbit 是单例（一进程一实例），故每个场景各起一个子进程。
 * 运行：node test/test-proxy-errcode.js
 */

const http = require('node:http');
const { spawnSync } = require('node:child_process');

const mode = process.argv[2] || '';

const PROXY_PORT = 39120;
const DEAD_PORT  = 39121;   // 无人监听
const HANG_PORT  = 39122;   // 只接受连接、永不响应

// ---------------- 子进程：各场景 ----------------
if (mode) {
  const Topbit = require('../src/topbit.js');
  const { Proxy } = Topbit.extensions;

  let hangServer = null;
  let pxy = null;

  if (mode === 'unreach') {
    pxy = new Proxy({
      config: { 'x.com': [{ url: `http://127.0.0.1:${DEAD_PORT}`, aliveCheckInterval: 7200 }] }
    });
  } else if (mode === 'timeout') {
    hangServer = http.createServer(() => { /* 永不响应 */ });
    hangServer.listen(HANG_PORT);
    pxy = new Proxy({
      // 后端级 timeout：不影响 this.timeout，因而不会连带压低框架的 socket 超时
      config: { 'x.com': [{ url: `http://127.0.0.1:${HANG_PORT}`, timeout: 700, aliveCheckInterval: 7200 }] }
    });
  } else if (mode === 'balancer') {
    pxy = new Proxy({
      // 契约违例的第三方 balancer：既不返回后端也不返回 null
      balancer: { select: () => undefined },
      config: { 'x.com': [{ url: `http://127.0.0.1:${DEAD_PORT}`, aliveCheckInterval: 7200 }] }
    });
  }

  const app = new Topbit({ debug: false });
  pxy.init(app);
  app.run(PROXY_PORT);

  setTimeout(() => {
    const r = http.request({
      host: '127.0.0.1', port: PROXY_PORT, path: '/', headers: { host: 'x.com' }
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        const expect = { unreach: 502, timeout: 504, balancer: 503 }[mode];
        const ok = res.statusCode === expect;
        console.log(`  ${ok ? '✓' : '✗'} [${mode}] 期望 ${expect}，实际 ${res.statusCode}`);
        if (!ok) console.log('    body:', body.slice(0, 120).replace(/\s+/g, ' '));
        hangServer && hangServer.close();
        process.exit(ok ? 0 : 1);
      });
    });

    r.on('error', e => {
      console.log(`  ✗ [${mode}] 请求出错：${e.message}`);
      process.exit(1);
    });

    r.end();
  }, 300);

  return;
}

// ---------------- 父进程：调度 ----------------
console.log('代理错误码语义回归测试');

let fail = 0;
for (const m of ['unreach', 'timeout', 'balancer']) {
  const r = spawnSync(process.execPath, [__filename, m], { timeout: 30000, stdio: 'inherit' });
  if (r.status !== 0) fail++;
}

console.log(fail === 0 ? '全部通过' : `${fail} 个场景失败`);
process.exit(fail > 0 ? 1 : 0);
