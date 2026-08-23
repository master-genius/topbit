'use strict';

/**
 * 代理：x-real-host / x-real-proto 与存活检测的启停接口
 *
 * 1) 与 x-real-ip 同族的两个头：让后端知道客户端最初请求的 host 与协议。
 *    后端据此生成绝对 URL、判断是否该发 https 重定向、决定 Secure cookie。
 *    key 可自定义；取值由代理无条件覆盖，不接受客户端传入的同名头。
 *
 * 2) startAliveCheck() / stopAliveCheck()：server.close() 只停止 accept，
 *    存活检测的 setInterval 仍在跑会让老实例无法回收并持续探测后端。
 */

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');

const Topbit = require('../src/topbit.js');
const Proxy = Topbit.extensions.Proxy;
const ProxyNoAgent = Topbit.extensions.ProxyNoAgent;

const KEY  = path.join(__dirname, '../demo/cert/localhost-privkey.pem');
const CERT = path.join(__dirname, '../demo/cert/localhost-cert.pem');

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : '\x1b[31mFAIL\x1b[0m'} ${name}${extra ? '  ' + extra : ''}`);
  cond ? pass++ : fail++;
}

const P = { backend: 45611, plain: 45612, tls: 45613, custom: 45614 };

//回显后端：把收到的请求头原样回吐
const backend = http.createServer((req, res) => {
  res.writeHead(200, {'content-type': 'application/json'});
  res.end(JSON.stringify(req.headers));
});

function get(port, headers = {}, tls = false) {
  return new Promise((resolve, reject) => {
    const mod = tls ? https : http;
    const opt = {host: '127.0.0.1', port, path: '/p/x', headers};
    if (tls) { opt.rejectUnauthorized = false; opt.servername = 'localhost'; }
    const r = mod.request(opt, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch (e) { resolve({__raw: d}); }
      });
    });
    r.on('error', reject);
    r.end();
  });
}

const hostCfg = (h) => ({ [h]: [{ path: '/p', url: `http://127.0.0.1:${P.backend}` }] });

(async () => {
  await new Promise(r => backend.listen(P.backend, '127.0.0.1', r));

  //---------- 明文 ----------
  const app1 = new Topbit({parseBody: false});
  const px1 = new Proxy({ port: P.plain, host: hostCfg(`a.test:${P.plain}`) });
  px1.init(app1);
  app1.run(P.plain);

  //---------- TLS ----------
  const app2 = new Topbit({parseBody: false, https: true, key: KEY, cert: CERT});
  const px2 = new Proxy({ port: P.tls, host: hostCfg(`b.test:${P.tls}`) });
  px2.init(app2);
  app2.run(P.tls);

  //---------- 自定义 key ----------
  const app3 = new Topbit({parseBody: false});
  const px3 = new Proxy({
    port: P.custom,
    realHostHeader: 'X-Gw-Host',
    realProtoHeader: 'X-Gw-Proto',
    host: hostCfg(`c.test:${P.custom}`)
  });
  px3.init(app3);
  app3.run(P.custom);

  await new Promise(r => setTimeout(r, 500));

  //---- 默认 key ----
  let h = await get(P.plain, {host: `a.test:${P.plain}`});
  check('默认写入 x-real-host', h['x-real-host'] === `a.test:${P.plain}`, h['x-real-host']);
  check('明文下 x-real-proto 为 http', h['x-real-proto'] === 'http', h['x-real-proto']);
  check('x-real-ip 仍照常写入', typeof h['x-real-ip'] === 'string', h['x-real-ip']);

  //---- TLS 下 proto 必须是 https ----
  let h2 = await get(P.tls, {host: `b.test:${P.tls}`}, true);
  check('TLS 下 x-real-proto 为 https', h2['x-real-proto'] === 'https', h2['x-real-proto']);
  check('TLS 下 x-real-host 正确', h2['x-real-host'] === `b.test:${P.tls}`, h2['x-real-host']);

  //---- 伪造必须被覆盖 ----
  let h3 = await get(P.plain, {
    host: `a.test:${P.plain}`,
    'x-real-proto': 'https',
    'x-real-host': 'evil.test'
  });
  check('客户端伪造的 x-real-proto 被覆盖', h3['x-real-proto'] === 'http', h3['x-real-proto']);
  check('客户端伪造的 x-real-host 被覆盖',
        h3['x-real-host'] === `a.test:${P.plain}`, h3['x-real-host']);

  //---- 自定义 key ----
  let h4 = await get(P.custom, {host: `c.test:${P.custom}`});
  check('自定义 key 生效（x-gw-host）', h4['x-gw-host'] === `c.test:${P.custom}`, h4['x-gw-host']);
  check('自定义 key 生效（x-gw-proto）', h4['x-gw-proto'] === 'http', h4['x-gw-proto']);
  check('自定义 key 后不再写默认 key', h4['x-real-host'] === undefined,
        String(h4['x-real-host']));

  //---------- 存活检测启停 ----------
  const countTimers = (px) => {
    let n = 0;
    for (const k in px.proxyIntervals) {
      for (const p in px.proxyIntervals[k]) if (px.proxyIntervals[k][p]) n++;
    }
    return n;
  };

  const pxT = new Proxy({
    port: 0,
    host: { 'd.test': [{ path: '/p', url: `http://127.0.0.1:${P.backend}`,
                         aliveCheckPath: '/', aliveCheckInterval: 1 }] }
  });
  const appT = new Topbit({parseBody: false});
  pxT.init(appT);

  check('init() 后存活检测定时器已建立', countTimers(pxT) > 0, `${countTimers(pxT)} 个`);
  check('aliveCheckStopped 初始为 false', pxT.aliveCheckStopped === false);

  pxT.stopAliveCheck();
  check('stopAliveCheck() 后定时器全部清除', countTimers(pxT) === 0);
  check('stopAliveCheck() 后标志位置起', pxT.aliveCheckStopped === true);
  check('stopAliveCheck() 后 retryTimers 已清空', pxT.retryTimers.size === 0);

  pxT.startAliveCheck();
  check('startAliveCheck() 可恢复', countTimers(pxT) > 0 && pxT.aliveCheckStopped === false,
        `${countTimers(pxT)} 个`);

  const n1 = countTimers(pxT);
  pxT.startAliveCheck();
  check('重复 startAliveCheck() 不泄漏定时器', countTimers(pxT) === n1,
        `${n1} → ${countTimers(pxT)}`);

  check('两个方法均返回 this 以便链式调用',
        pxT.stopAliveCheck() === pxT && pxT.startAliveCheck() === pxT);
  pxT.stopAliveCheck();

  //---- ProxyNoAgent 同构 ----
  const pxN = new ProxyNoAgent({
    port: 0,
    host: { 'e.test': [{ path: '/p', url: `http://127.0.0.1:${P.backend}`,
                         aliveCheckPath: '/', aliveCheckInterval: 1 }] }
  });
  pxN.init(new Topbit({parseBody: false}));
  check('ProxyNoAgent 同样具备启停接口',
        typeof pxN.startAliveCheck === 'function' && typeof pxN.stopAliveCheck === 'function');
  pxN.stopAliveCheck();
  check('ProxyNoAgent stopAliveCheck() 生效', countTimers(pxN) === 0);

  //---- 停止之后事件循环不该被存活检测拖住 ----
  px1.stopAliveCheck(); px2.stopAliveCheck(); px3.stopAliveCheck();

  console.log(`\n结果: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
