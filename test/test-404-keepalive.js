'use strict';

// 404 分支的连接收尾行为。
// 404 不进入中间件链，maxBody 无从生效，若请求体未消费完 Node 会把它整个排空，
// 攻击者用不存在的路径即可让服务端白吞任意流量，因此必须断开；但无请求体的 404
// 不应打断 keep-alive——否则一次 404 之后的同连接请求会全部失败。
// 用法: node test/test-404-keepalive.js

const net = require('node:net');
const tls = require('node:tls');
const Topbit = require('../src/topbit.js');

const CERT = __dirname + '/../demo/cert/';
const P_H1 = 49401;
const P_ALPN = 49402;

let failed = 0;
const ok = (d, c, e) => { if (!c) { failed++; console.log(`FAIL ${d}${e ? '  ' + e : ''}`); } else console.log(`PASS ${d}`); };

function mk(port, opts) {
  const app = new Topbit(Object.assign({ parseBody: false, debug: false }, opts));
  app.get('/ok/:i', async c => { c.data = 'OK' + c.param.i; });
  app.post('/ok/:i', async c => { c.data = 'POK' + c.param.i; });
  app.run(port);
  return app;
}
mk(P_H1, {});
mk(P_ALPN, { https: true, http2: true, allowHTTP1: true,
  key: CERT + 'localhost-privkey.pem', cert: CERT + 'localhost-cert.pem' });

// 在一条连接上按顺序发多个请求，返回收到的状态行
function seq(port, payloads, useTls) {
  return new Promise(resolve => {
    const sock = useTls
      ? tls.connect({ port, host: '127.0.0.1', rejectUnauthorized: false, ALPNProtocols: ['http/1.1'] })
      : net.connect(port, '127.0.0.1');
    let buf = '';
    const onReady = () => sock.write(payloads.join(''));
    sock.on(useTls ? 'secureConnect' : 'connect', onReady);
    sock.on('data', d => buf += d);
    sock.on('close', () => resolve(buf.split(/(?=HTTP\/1\.1 )/).filter(x => x).map(p => p.split('\r\n')[0].replace('HTTP/1.1 ', ''))));
    sock.on('error', () => resolve(['ERR']));
    setTimeout(() => sock.destroy(), 800);
  });
}

const G = p => `GET ${p} HTTP/1.1\r\nHost: x\r\n\r\n`;
const P = (p, body) => `POST ${p} HTTP/1.1\r\nHost: x\r\nContent-Length: ${body.length}\r\n\r\n${body}`;

// 发送声明 mb 兆但持续写入的请求体，统计服务端实际收下多少
function flood(port, path, mb, useTls) {
  return new Promise(resolve => {
    const total = mb * 1048576, chunk = Buffer.alloc(65536, 0x78);
    let sent = 0, closed = false;
    const sock = useTls
      ? tls.connect({ port, host: '127.0.0.1', rejectUnauthorized: false, ALPNProtocols: ['http/1.1'] })
      : net.connect(port, '127.0.0.1');
    sock.on(useTls ? 'secureConnect' : 'connect', () => {
      sock.write(`POST ${path} HTTP/1.1\r\nHost: x\r\nContent-Length: ${total}\r\n\r\n`);
      const pump = () => {
        while (sent < total && !closed) {
          if (!sock.write(chunk)) { sock.once('drain', pump); sent += chunk.length; return; }
          sent += chunk.length;
        }
      };
      pump();
    });
    sock.on('data', () => {});
    sock.on('close', () => { closed = true; resolve(sent / 1048576); });
    sock.on('error', () => { closed = true; });
    setTimeout(() => { closed = true; sock.destroy(); }, 2000);
  });
}

setTimeout(async () => {
  // ---- 无请求体的 404 不打断 keep-alive ----
  {
    const r = await seq(P_H1, [G('/ok/1'), G('/nope'), G('/ok/2'), G('/ok/3')]);
    ok('GET 404 后同一连接的后续请求仍然成功',
       r.length === 4 && r[0] === '200 OK' && r[1] === '404 Not Found' && r[2] === '200 OK' && r[3] === '200 OK',
       `收到 ${r.length} 个: ${r.join(' | ')}`);
  }
  {
    const r = await seq(P_H1, [G('/nope/a'), G('/nope/b'), G('/ok/9')]);
    ok('连续多个 404 不累积断连', r.length === 3 && r[2] === '200 OK', `${r.join(' | ')}`);
  }

  // ---- 带请求体的 404 断开连接 ----
  {
    const r = await seq(P_H1, [P('/nope', 'hello'), G('/ok/1')]);
    ok('带 body 的 404 之后连接被断开', r.length === 1 && r[0] === '404 Not Found', `${r.join(' | ')}`);
  }

  // ---- 大请求体不被吞下 ----
  // 以客户端能写出多少字节作为判据：连接被及时关闭时，只有 socket 缓冲里的那部分
  // 能写出去（实测约 3.6MB），远小于声明的 20MB；被完整接收时则能写满 20MB。
  {
    const got = await flood(P_H1, '/nope', 20);
    ok('声明 20MB 的 POST 打到 404 时连接被及时关闭', got < 10, `客户端写出 ${got.toFixed(1)} MB`);
  }
  {
    const got = await flood(P_H1, '/ok/1', 20);
    ok('对照：打到已注册路径时请求体被完整接收', got > 15, `客户端写出 ${got.toFixed(1)} MB`);
  }

  // ---- ALPN 兼容模式（httpc）同样成立 ----
  {
    const r = await seq(P_ALPN, [G('/ok/1'), G('/nope'), G('/ok/2')], true);
    ok('ALPN 兼容模式：GET 404 不打断 keep-alive',
       r.length === 3 && r[2] === '200 OK', `收到 ${r.length} 个: ${r.join(' | ')}`);
  }
  {
    // ALPN 兼容路径下小请求体在 end 回调前就已被解析消费完（req.complete 为 true），
    // 不存在排空风险，因此连接正常保留——判据是「有没有未消费的请求体」，
    // 而不是「有没有请求体」，这里两种模式表现不同但都正确。
    const r = await seq(P_ALPN, [P('/nope', 'hello'), G('/ok/1')], true);
    ok('ALPN 兼容模式：小 body 已消费完则不断连',
       r.length === 2 && r[1] === '200 OK', `${r.join(' | ')}`);
  }
  {
    const got = await flood(P_ALPN, '/nope', 20, true);
    ok('ALPN 兼容模式：大 body 打 404 时连接被及时关闭', got < 10, `客户端写出 ${got.toFixed(1)} MB`);
  }
  {
    const got = await flood(P_ALPN, '/ok/1', 20, true);
    ok('ALPN 兼容模式对照：已注册路径请求体完整接收', got > 15, `客户端写出 ${got.toFixed(1)} MB`);
  }

  console.log(`\ntest-404-keepalive: ${failed === 0 ? '全部通过' : failed + ' 项失败'}`);
  process.exit(failed === 0 ? 0 : 1);
}, 500);
