'use strict';

// http2proxy 的分组名已与 proxy/proxyNoAgent 统一为 topbit_proxy（应用层不需要
// 关心上游走 http1 还是 http2），本测试固化：
//   1) @topbit_proxy 分组中间件能接管 http2proxy 的未命中请求；
//   2) routepath 跨 host 降级在 http2proxy 上同样生效；
//   3) 应用自有业务路由不被吞。
// 用法: node test/test-h2proxy-group-fallback.js

const assert = require('node:assert');
const http = require('node:http');
const http2 = require('node:http2');
const Topbit = require('../src/topbit.js');
const { Http2Proxy } = Topbit.extensions;

const PORT = 39401;
const BK_A = 39411;   // a.com 的 /api
const BK_B = 39412;   // b.com 的 /

function h2echo(port, tag) {
  const serv = http2.createServer();
  serv.on('stream', (stream, headers) => {
    stream.on('error', () => {});
    stream.respond({ ':status': 200, 'content-type': 'text/plain' });
    stream.end(`${tag}:${headers[':path']}`);
  });
  serv.listen(port);
  return serv;
}

h2echo(BK_A, 'A_API');
h2echo(BK_B, 'B_ROOT');

const app = new Topbit({ parseBody: false });

const pxy = new Http2Proxy({
  port: PORT,
  config: {
    'a.com': [{ path: '/api', url: `http://127.0.0.1:${BK_A}` }],
    'b.com': [{ path: '/',    url: `http://127.0.0.1:${BK_B}` }]
  }
});
pxy.init(app);

// 统一后的分组名：不再是 @topbit_h2_proxy
app.use(async (c, next) => c.status(404).html('MISS-404'), '@topbit_proxy');

app.get('/admin/:id', async c => c.text(`biz-admin:${c.param.id}`));

app.run(PORT);

// 结构断言：降级映射在 http2proxy 上同样建好
const K = h => `${h}:${PORT}`;
assert.strictEqual(pxy.pathFallback[K('b.com')]['/api/*'], '/*',
  'http2proxy 也应预计算出 b.com 的 /api/* → /*');
assert.strictEqual(pxy.pathFallback[K('a.com')], undefined,
  'a.com 没声明 /，无降级项');
console.log('PASS http2proxy 的 pathFallback 预计算正确');

function req(host, path, cb) {
  http.get({ host: '127.0.0.1', port: PORT, path, headers: { host } }, res => {
    let d = '';
    res.on('data', x => d += x);
    res.on('end', () => cb(res.statusCode, d));
  }).on('error', e => cb('ERR', e.message));
}

const cases = [
  ['a.com', '/api/x',   200, 'A_API:/api/x',   'a.com 直接命中 /api'],
  ['b.com', '/',        200, 'B_ROOT:/',       'b.com 直接命中 /'],
  ['b.com', '/api/x',   200, 'B_ROOT:/api/x',  'b.com 的 /api 降级到 /'],
  ['a.com', '/',        404, 'MISS-404',       'a.com 无 / 可降 → @topbit_proxy 分组接管'],
  ['b.com', '/admin/7', 200, 'biz-admin:7',    '业务路由不被吞']
];

setTimeout(() => {
  let i = 0, failed = 0;

  const next = () => {
    if (i >= cases.length) {
      console.log(`\ntest-h2proxy-group-fallback: ${failed === 0 ? '全部通过' : failed + ' 个用例失败'}`);
      process.exit(failed === 0 ? 0 : 1);
    }

    const [host, path, code, body, desc] = cases[i++];

    req(`${host}:${PORT}`, path, (sc, d) => {
      const ok = sc === code && d === body;
      if (!ok) failed++;
      console.log(`${ok ? 'PASS' : 'FAIL'} ${desc}`);
      if (!ok) console.log(`     期望 ${code} ${JSON.stringify(body)}，实际 ${sc} ${JSON.stringify(d)}`);
      next();
    });
  };

  next();
}, 500);
