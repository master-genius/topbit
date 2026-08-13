'use strict';

// 端到端验证 proxy port 匹配行为（Topbit 单例：一进程一实例，场景分进程跑）
// 用法: node test/test-proxy-e2e.js 1234 | 443 | 0

const Topbit = require('../src/topbit.js');
const {Proxy} = Topbit.extensions;
const http = require('node:http');

const mode = process.argv[2] || '1234';

// 后端
const backend = http.createServer((req, res) => res.end('backend-ok'));
backend.listen(39001);

const app = new Topbit({ debug: false });

let pxy;
if (mode === '1234') {
  pxy = new Proxy({ port: 39002, config: { 'x.com': 'http://127.0.0.1:39001' } });
} else if (mode === '443') {
  // 用 port:443 验证双 key 匹配（实际监听 39002，仅测 key 展开与匹配）
  pxy = new Proxy({ port: 443, config: { 'x.com': 'http://127.0.0.1:39001' } });
} else {
  pxy = new Proxy({ port: 0, config: { 'x.com': 'http://127.0.0.1:39001' } });
}
pxy.init(app);

app.run(39002);

function req(host, cb) {
  const r = http.request({
    host: '127.0.0.1',
    port: 39002,
    path: '/',
    headers: { host: host }
  }, res => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => cb(res.statusCode, d));
  });
  r.on('error', e => cb('ERR', e.message));
  r.end();
}

function runCase(t, cb) {
  req(t.host, (code, body) => {
    const pass = t.expect === '' ? body === '' : body.includes(t.expect);
    console.log(`${pass ? 'PASS' : 'FAIL'} [${mode}] ${t.desc}: Host=${t.host} => ${JSON.stringify(body.slice(0, 30))} (期望 ${t.expect === '' ? '空响应' : `含 ${t.expect}`})`);
    cb(pass);
  });
}

setTimeout(() => {
  const cases = mode === '1234'
    ? [
        { host: 'x.com:39002', expect: 'backend-ok', desc: '带端口 Host 应命中转发' },
        { host: 'x.com', expect: '', desc: '裸 Host 应 miss' },
        { host: 'x.com:9999', expect: '', desc: '错误端口应 miss' }
      ]
    : mode === '443'
      ? [
          { host: 'x.com', expect: 'backend-ok', desc: '443：裸 Host 应命中' },
          { host: 'x.com:443', expect: 'backend-ok', desc: '443：带端口 Host 应命中' },
          { host: 'x.com:39002', expect: '', desc: '443：其他端口应 miss' }
        ]
      : [
          { host: 'x.com', expect: 'backend-ok', desc: 'port=0：裸 Host 应命中转发' },
          { host: 'x.com:39002', expect: '', desc: 'port=0：带端口 Host 应 miss' }
        ];

  let i = 0;
  let ok = true;
  const next = () => {
    if (i >= cases.length) {
      backend.close();
      process.exit(ok ? 0 : 1);
      return;
    }
    runCase(cases[i], pass => {
      if (!pass) ok = false;
      i++;
      next();
    });
  };
  next();
}, 300);
