'use strict';

/**
 * 代理层请求体大小限制回归测试
 *
 * 代理是 pre 中间件，抢在框架读体中间件之前就把请求流转走，
 * 因此框架的 maxBody 检查对被代理的请求完全不生效，限额改由代理自己执行。
 * 取值三级优先级：ctx.box.proxyMaxBody > 后端配置 maxBody > 代理实例 maxBody。
 *
 *   1. content-length 预检：超限直接 413，后端一个字节都收不到
 *   2. chunked 流式累计：无 content-length 时边转发边判定，超限 413
 *   3. 前置中间件设置 ctx.box.proxyMaxBody 后应放行（最高优先级）
 *   4. 后端级 maxBody 覆盖代理实例配置
 *   5. 未超限的请求正常转发
 *   6. ProxyNoAgent / Http2Proxy 同样生效（三个实现各自独立执行限额）
 *
 * 运行：node test/test-proxy-maxbody.js
 */

const http = require('node:http');
const http2 = require('node:http2');
const { spawnSync } = require('node:child_process');

const mode = process.argv[2] || '';
const BACKEND_PORT = 39141;
const PROXY_PORT = 39142;
const LIMIT = 4096;

if (mode) {
  const Topbit = require('../src/topbit.js');

  // 三个代理实现各自独立执行限额，逐一覆盖
  const ProxyClass = mode === 'noagent' ? Topbit.extensions.ProxyNoAgent
                   : mode === 'h2'      ? Topbit.extensions.Http2Proxy
                   : Topbit.extensions.Proxy;

  let backendBytes = 0;
  let backend;

  if (mode === 'h2') {
    // Http2Proxy 的上游必须是 h2
    backend = http2.createServer();
    backend.on('stream', stream => {
      stream.on('data', d => { backendBytes += d.length; });
      stream.on('end', () => {
        stream.respond({ ':status': 200 });
        stream.end('backend-ok');
      });
    });
  } else {
    backend = http.createServer((req, res) => {
      req.on('data', d => { backendBytes += d.length; });
      req.on('end', () => res.end('backend-ok'));
    });
  }

  backend.listen(BACKEND_PORT);

  const app = new Topbit({ debug: false });
  // backend 场景：后端级 maxBody 放宽到 1MB，用于验证它覆盖实例级的 LIMIT
  const backendCfg = { url: `http://127.0.0.1:${BACKEND_PORT}`, aliveCheckInterval: 7200 };
  if (mode === 'backend') backendCfg.maxBody = 1024 * 1024;

  const pxy = new ProxyClass({
    maxBody: LIMIT,
    config: { 'x.com': [backendCfg] }
  });
  // 动态场景：前置中间件按业务在 ctx.box 上放宽本次请求的限额。
  // 代理中间件不会调用 next()，因此要先于它执行，必须在 pxy.init(app) 之前注册。
  if (mode === 'dynamic') {
    app.use(async (c, next) => {
      if (c.headers['x-big-upload'] === 'yes') c.box.proxyMaxBody = 10 * 1024 * 1024;
      return await next(c);
    }, { pre: true });
  }

  pxy.init(app);

  const cases = {
    // 声明 content-length 且超限
    'cl':      { size: 200 * 1024, chunked: false, expect: 413, backend: 0 },
    // 不声明 content-length（chunked）
    'chunked': { size: 200 * 1024, chunked: true,  expect: 413 },
    // ctx.box.proxyMaxBody 放宽后应放行（优先级最高）
    'dynamic': { size: 200 * 1024, chunked: false, expect: 200, header: { 'x-big-upload': 'yes' } },
    // 后端级 maxBody 覆盖实例级配置
    'backend': { size: 200 * 1024, chunked: false, expect: 200 },
    // 未超限
    'pass':    { size: 1024,       chunked: false, expect: 200, backend: 1024 },
    // 另外两个实现同样应拦截
    'noagent': { size: 200 * 1024, chunked: false, expect: 413, backend: 0 },
    'h2':      { size: 200 * 1024, chunked: false, expect: 413, backend: 0 }
  };

  const t = cases[mode];

  setTimeout(() => {
    const body = Buffer.alloc(t.size, 'a');
    const headers = Object.assign({ host: 'x.com' }, t.header || {});
    if (!t.chunked) headers['content-length'] = body.length;

    const r = http.request({
      host: '127.0.0.1', port: PROXY_PORT, path: '/', method: 'POST', headers
    }, res => {
      res.resume();
      res.on('end', () => {
        let ok = res.statusCode === t.expect;
        let detail = `状态码 ${res.statusCode}（期望 ${t.expect}）`;

        if (ok && t.backend !== undefined) {
          ok = backendBytes === t.backend;
          detail += `，后端收到 ${backendBytes} 字节（期望 ${t.backend}）`;
        }

        console.log(`  ${ok ? '✓' : '✗'} [${mode}] ${detail}`);
        backend.close();
        process.exit(ok ? 0 : 1);
      });
    });

    r.on('error', e => {
      // 超限时代理会主动断开，客户端可能先收到 ECONNRESET
      console.log(`  ✗ [${mode}] 请求出错：${e.code || e.message}`);
      process.exit(1);
    });

    r.end(body);
  }, 300);

  app.run(PROXY_PORT);
  return;
}

console.log('代理请求体限额回归测试');

let fail = 0;
for (const m of ['cl', 'chunked', 'dynamic', 'backend', 'pass', 'noagent', 'h2']) {
  const r = spawnSync(process.execPath, [__filename, m], { timeout: 30000, stdio: 'inherit' });
  if (r.status !== 0) fail++;
}

console.log(fail === 0 ? '全部通过' : `${fail} 个场景失败`);
process.exit(fail > 0 ? 1 : 0);
