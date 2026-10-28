'use strict';

/**
 * 代理：不自动注入 x-real-* 请求头，与存活检测的启停接口
 *
 * 1) 代理不再自动写入 x-real-host / x-real-proto，addIP 默认关闭时也不写 x-real-ip；
 *    客户端带来的同名头原样透传。需要时由用户在后端配置的 headers 里自定义，
 *    或开启 addIP 写入客户端 IP。（三种代理的完整矩阵见 test-proxy-auto-headers.js）
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
  const px1 = new Proxy({ port: P.plain, config: hostCfg(`a.test:${P.plain}`) });
  px1.init(app1);
  app1.run(P.plain);

  //---------- TLS ----------
  const app2 = new Topbit({parseBody: false, https: true, key: KEY, cert: CERT});
  const px2 = new Proxy({ port: P.tls, config: hostCfg(`b.test:${P.tls}`) });
  px2.init(app2);
  app2.run(P.tls);

  //---------- addIP:true ----------
  const app3 = new Topbit({parseBody: false});
  const px3 = new Proxy({
    port: P.custom,
    addIP: true,
    config: hostCfg(`c.test:${P.custom}`)
  });
  px3.init(app3);
  app3.run(P.custom);

  await new Promise(r => setTimeout(r, 500));

  //---- 默认：不再自动注入 ----
  let h = await get(P.plain, {host: `a.test:${P.plain}`});
  check('默认不注入 x-real-host', h['x-real-host'] === undefined, String(h['x-real-host']));
  check('默认不注入 x-real-proto', h['x-real-proto'] === undefined, String(h['x-real-proto']));
  check('默认不写 x-real-ip（addIP 关闭）', h['x-real-ip'] === undefined, String(h['x-real-ip']));

  //---- TLS 下同样不注入 ----
  let h2 = await get(P.tls, {host: `b.test:${P.tls}`}, true);
  check('TLS 下不注入 x-real-proto', h2['x-real-proto'] === undefined, String(h2['x-real-proto']));
  check('TLS 下不注入 x-real-host', h2['x-real-host'] === undefined, String(h2['x-real-host']));

  //---- 客户端带来的头原样透传，不屏蔽 ----
  let h3 = await get(P.plain, {
    host: `a.test:${P.plain}`,
    'x-real-proto': 'https',
    'x-real-host': 'evil.test'
  });
  check('客户端的 x-real-proto 原样透传', h3['x-real-proto'] === 'https', h3['x-real-proto']);
  check('客户端的 x-real-host 原样透传', h3['x-real-host'] === 'evil.test', h3['x-real-host']);

  //---- addIP:true 才写入 x-real-ip ----
  let h4 = await get(P.custom, {host: `c.test:${P.custom}`});
  check('addIP:true 写入 x-real-ip',
        typeof h4['x-real-ip'] === 'string' && h4['x-real-ip'].includes('127.0.0.1'), h4['x-real-ip']);
  check('addIP:true 也不注入 x-real-host', h4['x-real-host'] === undefined, String(h4['x-real-host']));

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
    config: { 'd.test': [{ path: '/p', url: `http://127.0.0.1:${P.backend}`,
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
    config: { 'e.test': [{ path: '/p', url: `http://127.0.0.1:${P.backend}`,
                         aliveCheckPath: '/', aliveCheckInterval: 1 }] }
  });
  pxN.init(new Topbit({parseBody: false}));
  check('ProxyNoAgent 同样具备启停接口',
        typeof pxN.startAliveCheck === 'function' && typeof pxN.stopAliveCheck === 'function');
  pxN.stopAliveCheck();
  check('ProxyNoAgent stopAliveCheck() 生效', countTimers(pxN) === 0);

  //---- 三扩展的配置选项统一为 config ----
  {
    const cfg = { 'z.test': [{ path: '/p', url: `http://127.0.0.1:${P.backend}` }] };

    for (const [name, Cls] of [['Proxy', Proxy], ['ProxyNoAgent', ProxyNoAgent],
                               ['Http2Proxy', Topbit.extensions.Http2Proxy]]) {
      const px = new Cls({ port: 0, config: JSON.parse(JSON.stringify(cfg)) });
      check(`${name} 接受 config 选项`,
            Object.keys(px.pathTable).includes('/p/*'),
            JSON.stringify(Object.keys(px.pathTable)));
      if (typeof px.stopAliveCheck === 'function') px.stopAliveCheck();
    }
  }

  //---- 停止之后事件循环不该被存活检测拖住 ----
  px1.stopAliveCheck(); px2.stopAliveCheck(); px3.stopAliveCheck();

  console.log(`\n结果: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
