'use strict';

/**
 * ProxyNoAgent 连接复用语义回归测试
 *
 * Node.js >= 19 起 http.globalAgent 默认 keepAlive:true，
 * 因此 ProxyNoAgent 默认复用连接；keepAlive:false 时须显式退化为一请求一连接。
 *
 * 运行：node test/test-proxy-keepalive.js
 */

const http = require('node:http');
const { spawnSync } = require('node:child_process');

const mode = process.argv[2] || '';
const BACKEND_PORT = 39131;
const PROXY_PORT = 39132;
const N = 5;

if (mode) {
  const Topbit = require('../src/topbit.js');
  const { ProxyNoAgent } = Topbit.extensions;

  let conns = 0;
  const backend = http.createServer((req, res) => res.end('ok'));
  backend.on('connection', () => { conns++; });
  backend.listen(BACKEND_PORT);

  const app = new Topbit({ debug: false });
  const pxy = new ProxyNoAgent({
    config: { 'x.com': [{ url: `http://127.0.0.1:${BACKEND_PORT}`, aliveCheckInterval: 7200 }] },
    keepAlive: mode === 'reuse'
  });
  pxy.init(app);
  app.run(PROXY_PORT);

  const one = () => new Promise(rv => {
    const r = http.request({
      host: '127.0.0.1', port: PROXY_PORT, path: '/', headers: { host: 'x.com' }
    }, res => { res.resume(); res.on('end', rv); });
    r.on('error', rv);
    r.end();
  });

  setTimeout(async () => {
    for (let i = 0; i < N; i++) await one();

    // 复用模式：N 次请求应共用少量连接；关闭复用：每请求一条
    const ok = mode === 'reuse' ? (conns < N) : (conns === N);
    console.log(`  ${ok ? '✓' : '✗'} [keepAlive=${mode === 'reuse'}] ${N} 次请求 → 后端连接数 ${conns}`
      + `（期望 ${mode === 'reuse' ? `< ${N}` : `= ${N}`}）`);

    backend.close();
    process.exit(ok ? 0 : 1);
  }, 300);

  return;
}

console.log('ProxyNoAgent 连接复用语义回归测试');

let fail = 0;
for (const m of ['reuse', 'noreuse']) {
  const r = spawnSync(process.execPath, [__filename, m], { timeout: 30000, stdio: 'inherit' });
  if (r.status !== 0) fail++;
}

console.log(fail === 0 ? '全部通过' : `${fail} 个场景失败`);
process.exit(fail > 0 ? 1 : 0);
