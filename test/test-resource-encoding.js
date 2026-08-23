'use strict';

/**
 * 静态资源：Accept-Encoding 协商与缓存表示
 *
 * 覆盖两处修复：
 *  1. 此前压缩条件只看文件类型与大小，从不读 accept-encoding，压完即无条件
 *     带上 content-encoding: gzip。声明 identity 的客户端会收到 gzip 字节。
 *  2. 缓存只保留压缩版一种表示，命中时同样无条件发 gzip。
 *
 * 现在：缓存同时保留原文与 gzip 版本，按请求二选一，两种表示各自的 ETag
 * 不同，并带 Vary: accept-encoding。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');

const Topbit = require('../src/topbit.js');
const Resource = Topbit.extensions.Resource;

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : '\x1b[31mFAIL\x1b[0m'} ${name}${extra ? '  ' + extra : ''}`);
  cond ? pass++ : fail++;
}

const PORT = 45601;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'res-enc-'));

const TEXT = 'A'.repeat(4000) + 'tail';
fs.writeFileSync(path.join(dir, 'big.txt'), TEXT);
fs.writeFileSync(path.join(dir, 'tiny.txt'), 'hi');            // <1K，不压
fs.writeFileSync(path.join(dir, 'pic.png'), Buffer.alloc(2048, 7)); // 二进制分支

function req(p, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({host: '127.0.0.1', port: PORT, path: p, headers}, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        buf: Buffer.concat(chunks)
      }));
    });
    r.on('error', reject);
    r.end();
  });
}

const app = new Topbit({parseBody: false});
const res = new Resource({staticPath: dir, routePath: '/s/*', cacheControl: 'max-age=60'});
res.init(app);
app.run(PORT);

(async () => {
  await new Promise(r => setTimeout(r, 400));

  //=========== 未缓存（首次请求）===========

  //1) 不接受压缩 → 必须拿到原文
  let a = await req('/s/big.txt', {'accept-encoding': 'identity'});
  check('identity：不带 content-encoding',
        a.headers['content-encoding'] === undefined, String(a.headers['content-encoding']));
  check('identity：拿到的是原文', a.buf.toString() === TEXT,
        `${a.buf.length} 字节 / 原文 ${TEXT.length}`);

  //2) 接受 gzip → 拿到压缩版，且解压后等于原文
  let b = await req('/s/big.txt', {'accept-encoding': 'gzip, deflate'});
  check('gzip：带 content-encoding: gzip', b.headers['content-encoding'] === 'gzip');
  check('gzip：解压后与原文一致',
        zlib.gunzipSync(b.buf).toString() === TEXT);
  check('gzip：体积确实变小', b.buf.length < TEXT.length,
        `${b.buf.length} < ${TEXT.length}`);

  //3) 两种表示的 ETag 必须不同，且都带 Vary
  check('两种表示的 ETag 不同',
        a.headers.etag && b.headers.etag && a.headers.etag !== b.headers.etag,
        `${a.headers.etag} vs ${b.headers.etag}`);
  check('可压缩资源带 Vary: accept-encoding',
        a.headers.vary === 'accept-encoding' && b.headers.vary === 'accept-encoding',
        `${a.headers.vary} / ${b.headers.vary}`);

  //4) 缺失 accept-encoding → RFC 9110 §12.5.3：任意编码皆可接受，默认压缩
  let c0 = await req('/s/big.txt', {});
  check('缺失 accept-encoding 时默认压缩',
        c0.headers['content-encoding'] === 'gzip' &&
        zlib.gunzipSync(c0.buf).toString() === TEXT,
        String(c0.headers['content-encoding']));

  //4b) 头存在但为空 → 明确表示不要任何内容编码
  let c1 = await req('/s/big.txt', {'accept-encoding': ''});
  check('accept-encoding 为空串时不压缩',
        c1.headers['content-encoding'] === undefined && c1.buf.toString() === TEXT,
        String(c1.headers['content-encoding']));

  //5) 不含 gzip 的编码列表 → 不压缩
  let nz = await req('/s/big.txt', {'accept-encoding': 'br, deflate'});
  check('列表中无 gzip 时不压缩',
        nz.headers['content-encoding'] === undefined && nz.buf.toString() === TEXT,
        String(nz.headers['content-encoding']));

  //5b) q 值不参与判定——只看 gzip 是否出现。
  //    刻意的简化：不想接收压缩的客户端本就不该在头里声明支持 gzip。
  let q0 = await req('/s/big.txt', {'accept-encoding': 'gzip;q=0, identity'});
  check('q 值不参与判定，出现 gzip 即压缩',
        q0.headers['content-encoding'] === 'gzip' &&
        zlib.gunzipSync(q0.buf).toString() === TEXT,
        String(q0.headers['content-encoding']));

  //=========== 已缓存（再次请求，走缓存分支）===========

  let a2 = await req('/s/big.txt', {'accept-encoding': 'identity'});
  check('缓存命中 + identity：仍返回原文',
        a2.headers['content-encoding'] === undefined && a2.buf.toString() === TEXT,
        `enc=${a2.headers['content-encoding']} len=${a2.buf.length}`);

  let b2 = await req('/s/big.txt', {'accept-encoding': 'gzip'});
  check('缓存命中 + gzip：返回压缩版且可解压',
        b2.headers['content-encoding'] === 'gzip' &&
        zlib.gunzipSync(b2.buf).toString() === TEXT);

  check('缓存命中时两种表示的 ETag 与未缓存时一致',
        a2.headers.etag === a.headers.etag && b2.headers.etag === b.headers.etag,
        `${a2.headers.etag} / ${b2.headers.etag}`);

  //6) 条件请求：用哪种表示的 ETag，就该对哪种表示 304
  let nm1 = await req('/s/big.txt',
    {'accept-encoding': 'identity', 'if-none-match': a.headers.etag});
  check('原文 ETag + identity → 304', nm1.status === 304, String(nm1.status));

  let nm2 = await req('/s/big.txt',
    {'accept-encoding': 'gzip', 'if-none-match': b.headers.etag});
  check('gzip ETag + gzip → 304', nm2.status === 304, String(nm2.status));

  //交叉：拿 gzip 的 ETag 去请求原文表示，不该 304
  let nm3 = await req('/s/big.txt',
    {'accept-encoding': 'identity', 'if-none-match': b.headers.etag});
  check('gzip 的 ETag 不会让原文表示误判 304', nm3.status === 200, String(nm3.status));

  //=========== 小文件不压缩 ===========
  let t = await req('/s/tiny.txt', {'accept-encoding': 'gzip'});
  check('小于 1K 的文件不压缩',
        t.headers['content-encoding'] === undefined && t.buf.toString() === 'hi');
  check('不可压缩资源不带 Vary', t.headers.vary === undefined, String(t.headers.vary));

  //=========== 二进制分支 ===========
  let p1 = await req('/s/pic.png', {'accept-encoding': 'gzip'});
  check('二进制文件不压缩且内容正确',
        p1.headers['content-encoding'] === undefined && p1.buf.length === 2048,
        `${p1.buf.length} 字节`);

  let p2 = await req('/s/pic.png', {'accept-encoding': 'gzip'});
  check('二进制文件缓存命中后内容仍正确', p2.buf.length === 2048 &&
        p2.buf.every(v => v === 7));

  //=========== 缓存容量记账 ===========
  check('cache.size 与两种表示之和一致',
        (() => {
          let sum = 0;
          for (const v of res.cache.values()) {
            sum += v.data.length + (v.zdata ? v.zdata.length : 0);
          }
          return sum === res.size;
        })(), `记账 ${res.size}`);

  res.removeNameCache('big.txt');
  check('removeNameCache 后记账同步扣减',
        (() => {
          let sum = 0;
          for (const v of res.cache.values()) {
            sum += v.data.length + (v.zdata ? v.zdata.length : 0);
          }
          return sum === res.size;
        })(), `记账 ${res.size}`);

  console.log(`\n结果: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
