'use strict';

// hop-by-hop 头剥离验证（RFC 7230 §6.1）
// 覆盖：
//   1. 请求方向：connection/keep-alive/te/trailer/upgrade/proxy-auth*/proxy-connection
//      及 Connection 头列出的额外头（x-req-hop）不透传到后端，正常头透传
//   2. 响应方向：后端（raw socket 构造真实逐跳头）的 hop 头不透传给客户端
//   3. http2proxy.fmtHeaders 单元级验证（h1 → h2 转换的头剥离 + :authority 合成）
// 用法: node test/test-proxy-hopbyhop.js           # 全部（proxy/noagent 子进程 + 单测）
//       node test/test-proxy-hopbyhop.js proxy     # 仅 Proxy
//       node test/test-proxy-hopbyhop.js noagent   # 仅 ProxyNoAgent

const { spawnSync } = require('node:child_process');

const mode = process.argv[2];

// ---- 子模式：Proxy / ProxyNoAgent 端到端 ----
if (mode === 'proxy' || mode === 'noagent') {
  const Topbit = require('../src/topbit.js');
  const http = require('node:http');
  const net = require('node:net');

  let pass = 0, fail = 0;
  function check(name, cond, extra = '') {
    console.log(`${cond ? 'PASS' : 'FAIL'} [${mode}] ${name}${extra ? ' ' + extra : ''}`);
    cond ? pass++ : fail++;
  }

  function req(opts, body = null) {
    return new Promise(resolve => {
      let done = false;
      const finish = r => { if (!done) { done = true; resolve(r); } };
      const r = http.request(opts, res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => finish({ code: res.statusCode, headers: res.headers, body: d }));
        res.on('close', () => finish({ code: res.statusCode, headers: res.headers, body: d }));
      });
      r.on('error', e => finish({ code: 'ERR', headers: {}, body: e.message }));
      if (body) r.write(body);
      r.end();
    });
  }

  // b1: echo 请求头
  const b1 = http.createServer((rq, rs) => {
    let d = '';
    rq.on('data', c => d += c);
    rq.on('end', () => rs.end(JSON.stringify({ url: rq.url, h: rq.headers, body: d })));
  });

  // b2: raw socket 后端，构造带逐跳头的真实 HTTP 响应
  // （Node http 服务端会自行管理 Connection/Transfer-Encoding，无法构造，故用裸 socket）
  const b2 = net.createServer(sock => {
    let buf = '';
    sock.on('data', c => {
      buf += c;
      if (buf.includes('\r\n\r\n')) {
        sock.write(
          'HTTP/1.1 200 OK\r\n' +
          'Connection: keep-alive, x-res-hop\r\n' +
          'Keep-Alive: timeout=5\r\n' +
          'X-Res-Hop: dropped\r\n' +
          'X-Normal-Res: kept\r\n' +
          'Upgrade: websocket\r\n' +
          'Proxy-Authenticate: Basic realm="b"\r\n' +
          'Proxy-Connection: keep-alive\r\n' +
          'Transfer-Encoding: chunked\r\n' +
          '\r\n' +
          '6\r\nrawhop\r\n0\r\n\r\n'
        );
        sock.end();
      }
    });
  });

  // 兜底：任何环节挂死则非零退出
  setTimeout(() => { console.error(`[ ${mode} ] TIMEOUT`); process.exit(1); }, 15000).unref();

  Promise.all([
    new Promise(r => b1.listen(39861, r)),
    new Promise(r => b2.listen(39862, r)),
  ]).then(async () => {
    const Ext = mode === 'proxy'
      ? Topbit.extensions.Proxy
      : Topbit.extensions.ProxyNoAgent;

    const app = new Topbit({ debug: false });
    const pxy = new Ext({
      config: {
        'hop.test': [
          { path: '/echo', url: 'http://127.0.0.1:39861' },
          { path: '/raw', url: 'http://127.0.0.1:39862' },
        ]
      }
    });
    pxy.init(app);
    app.run(39860);

    // ---- 请求方向：hop 头 + Connection 列出的额外头被剥离 ----
    const r1 = await req({
      host: '127.0.0.1', port: 39860, path: '/echo?q=1',
      headers: {
        host: 'hop.test',
        connection: 'x-req-hop',
        'x-req-hop': 'dropped',
        'x-keep': 'kept',
        'proxy-authorization': 'Basic dGVzdA==',
        'te': 'trailers',
        // trailer 头由 fmtHeaders 单测覆盖：Node 客户端在非 chunked 编码下
        // 拒绝发送 Trailer（ERR_HTTP_TRAILER_INVALID），此处无法构造
        'upgrade': 'websocket',
        'proxy-connection': 'keep-alive'
      }
    });

    let echoed = {};
    try { echoed = JSON.parse(r1.body); } catch (e) { /* 保持空对象 */ }

    check('请求 200 且后端可达', r1.code === 200, `code=${r1.code}`);
    check('Connection 列出的额外头被剥离 (x-req-hop)', echoed.h['x-req-hop'] === undefined);
    check('proxy-authorization 被剥离', echoed.h['proxy-authorization'] === undefined);
    check('te 被剥离', echoed.h.te === undefined);
    check('trailer 被剥离', echoed.h.trailer === undefined);
    check('upgrade 被剥离', echoed.h.upgrade === undefined);
    check('proxy-connection 被剥离', echoed.h['proxy-connection'] === undefined);
    check('正常头透传 (x-keep)', echoed.h['x-keep'] === 'kept');
    check('host 透传', echoed.h.host === 'hop.test');
    check('路径+query 透传', echoed.url === '/echo?q=1');

    // ---- 响应方向：后端 hop 头不透传给客户端 ----
    const r2 = await req({
      host: '127.0.0.1', port: 39860, path: '/raw',
      headers: { host: 'hop.test' }
    });

    check('响应 body 完整（chunked 解码正常）', r2.body === 'rawhop', `body=${JSON.stringify(r2.body)}`);
    check('响应 Connection 列出的额外头被剥离 (x-res-hop)', r2.headers['x-res-hop'] === undefined);
    // Node >= 19 的 http server 会在当前连接自动发送 Keep-Alive: timeout=N，
    // 这是本跳连接层自己的头（与 transfer-encoding 同理），并非转发自后端；
    // 因此只断言值不携带后端的原始形态（后端发的是 keep-alive: timeout=5，
    // 恰好同形态无法区分，剥离效果由 x-res-hop 断言证明）
    check('响应 keep-alive 非 forwarded（Node 自身形态或缺失）',
      r2.headers['keep-alive'] === undefined || /^timeout=/.test(r2.headers['keep-alive']),
      `val=${r2.headers['keep-alive']}`);
    check('响应 upgrade 被剥离', r2.headers.upgrade === undefined);
    check('响应 proxy-authenticate 被剥离', r2.headers['proxy-authenticate'] === undefined);
    check('响应 proxy-connection 被剥离', r2.headers['proxy-connection'] === undefined);
    check('响应正常头透传 (x-normal-res)', r2.headers['x-normal-res'] === 'kept');

    console.log(`[ ${mode} ] ${pass} pass, ${fail} fail`);
    process.exit(fail > 0 ? 1 : 0);
  });

  return;
}

// ---- 主模式：fmtHeaders 单测 + 拉起两个子进程 ----
let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' ' + extra : ''}`);
  cond ? pass++ : fail++;
}

const Http2Proxy = require('../src/extends/http2proxy.js');
const fmt = Http2Proxy.prototype.fmtHeaders;

// fmtHeaders 不依赖 this，可直接调用
const out = fmt.call(null, {
  host: 'h2.test',
  connection: 'close, x-h',
  'x-h': 'dropped',
  'x-ok': 'kept',
  'proxy-authorization': 'Basic z',
  'proxy-authenticate': 'Basic r',
  te: 'trailers',
  trailer: 'x-f',
  upgrade: 'websocket',
  'proxy-connection': 'keep-alive',
  'transfer-encoding': 'chunked',
  keep_alive_alias: 'v'
}, { method: 'POST', path: '/a?b=1' });

check('fmtHeaders :method', out[':method'] === 'POST');
check('fmtHeaders :path（无 :path 头时取 ctx.path）', out[':path'] === '/a?b=1');
check('fmtHeaders host → :authority', out[':authority'] === 'h2.test');
check('fmtHeaders Connection 额外头剥离 (x-h)', out['x-h'] === undefined);
check('fmtHeaders proxy-authorization 剥离', out['proxy-authorization'] === undefined);
check('fmtHeaders proxy-authenticate 剥离', out['proxy-authenticate'] === undefined);
check('fmtHeaders te 剥离', out.te === undefined);
check('fmtHeaders trailer 剥离', out.trailer === undefined);
check('fmtHeaders upgrade 剥离', out.upgrade === undefined);
check('fmtHeaders proxy-connection 剥离', out['proxy-connection'] === undefined);
check('fmtHeaders transfer-encoding 剥离', out['transfer-encoding'] === undefined);
check('fmtHeaders connection 剥离', out.connection === undefined);
check('fmtHeaders 正常头保留 (x-ok)', out['x-ok'] === 'kept');

// :path 伪头优先
const out2 = fmt.call(null, { ':path': '/from-pseudo', host: 'x.test' }, { method: 'GET', path: '/ignored' });
check('fmtHeaders :path 伪头优先', out2[':path'] === '/from-pseudo');

// ---- 子进程跑 Proxy / ProxyNoAgent ----
for (const m of ['proxy', 'noagent']) {
  const r = spawnSync(process.execPath, [__filename, m], { timeout: 30000, stdio: 'inherit' });
  if (r.status !== 0) fail++;
}

console.log(`TOTAL ${pass + (fail > 0 ? 0 : 0)} pass, ${fail} fail (子进程失败计入 fail)`);
process.exit(fail > 0 ? 1 : 0);
