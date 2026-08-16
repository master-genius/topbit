'use strict';

// 端到端验证：resource 静态资源扩展全功能
// 覆盖：200/404/ETag/304/缓存命中与记账/gzip/超限流式/路径穿越/MIME 表实例隔离/extName

const Topbit = require('../src/topbit.js');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'topbit-static-'));
const BIG = Buffer.alloc(60000, 7); // 60KB，超过 maxFileSize(30KB) → 流式

fs.writeFileSync(path.join(ROOT, 'index.html'), `<html>${'x'.repeat(2000)}</html>`);
fs.writeFileSync(path.join(ROOT, 'data.json'), '{"a":1}');
fs.writeFileSync(path.join(ROOT, 'img.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8]));
fs.writeFileSync(path.join(ROOT, 'big.bin'), BIG);

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' ' + extra : ''}`);
  cond ? pass++ : fail++;
}

// ---------- MIME 表实例隔离与 extName 单元断言 ----------
const { Resource } = Topbit.extensions;
const r1 = new Resource({ staticPath: ROOT });
const r2 = new Resource({ staticPath: ROOT });
r1.addType({ '.myext': 'application/x-my' });
check('addType 不污染其他实例', r2.filetype('.myext') === 'application/octet-stream');
check('大写 key 可用', r1.filetype('.CSS') === 'text/css; charset=utf-8');
check('extName 长扩展名完整返回', r1.extName('/a/note.markdown') === '.markdown');
check('extName 目录名带点不干扰', r1.extName('/srv/app.2024/public/file') === '');

// ---------- e2e ----------
const st = new Resource({
  staticPath: ROOT,
  routePath: '/static/*',
  routeGroup: '_static_test',
  maxFileSize: 30000,   // big.bin 超限 → 流式
  cacheControl: 'max-age=600'
});
const app = new Topbit({ debug: false });
st.init(app);
app.run(39890, '127.0.0.1');

function req(p, headers = {}) {
  return new Promise(resolve => {
    const r = http.request({ host: '127.0.0.1', port: 39890, path: p, headers }, res => {
      const bufs = [];
      res.on('data', c => bufs.push(c));
      res.on('end', () => resolve({ code: res.statusCode, headers: res.headers, body: Buffer.concat(bufs) }));
    });
    r.on('error', e => resolve({ code: 'ERR', headers: {}, body: Buffer.from(e.message) }));
    r.end();
  });
}

setTimeout(async () => {
  // html：200 + content-type + gzip（>1KB 文本）+ etag + cache-control
  let r = await req('/static/index.html');
  check('html 状态 200', r.code === 200);
  check('html content-type', r.headers['content-type'] === 'text/html; charset=utf-8');
  check('html gzip 压缩', r.headers['content-encoding'] === 'gzip');
  check('html etag 存在', typeof r.headers.etag === 'string');
  check('html cache-control', r.headers['cache-control'] === 'max-age=600');
  let gunzipped = zlib.gunzipSync(r.body).toString();
  check('html gunzip 后内容完整', gunzipped.startsWith('<html>') && gunzipped.endsWith('</html>'));
  check('html content-length 为 gzip 长度', +r.headers['content-length'] === r.body.length);
  const etag = r.headers.etag;

  // 缓存命中 + 304
  r = await req('/static/index.html', { 'if-none-match': etag });
  check('If-None-Match → 304', r.code === 304, `实际 ${r.code}`);
  check('304 带回 etag', r.headers.etag === etag);
  check('304 无 body', r.body.length === 0);

  // json 小文件（≤1KB 不压缩）
  r = await req('/static/data.json');
  check('json content-type', r.headers['content-type'] === 'application/json; charset=utf-8');
  check('json 小文件不压缩', r.headers['content-encoding'] === undefined);
  check('json 内容正确', r.body.toString() === '{"a":1}');

  // 二进制 png
  r = await req('/static/img.png');
  check('png content-type', r.headers['content-type'] === 'image/png');
  check('png 内容完整', r.body.equals(fs.readFileSync(path.join(ROOT, 'img.png'))));

  // 超限文件流式
  r = await req('/static/big.bin');
  check('超限文件 content-length 为原始大小', +r.headers['content-length'] === BIG.length);
  check('超限文件不压缩', r.headers['content-encoding'] === undefined);
  check('超限文件内容完整', r.body.equals(BIG));

  // 404
  r = await req('/static/noexist.js');
  check('不存在文件 404', r.code === 404);

  // 路径穿越拦截
  r = await req('/static/..%2F..%2Fetc%2Fpasswd');
  check('路径穿越（编码形式）拦截', r.code === 404, `实际 ${r.code}`);
  r = await req('/static/../topbit-secret');
  check('路径穿越（明文形式）不泄露', r.code !== 200 || !r.body.length);

  // 缓存记账
  check('缓存条目数 = 3', st.cache.size === 3, `实际 ${st.cache.size}`);
  check('缓存总大小记账一致', st.size === [...st.cache.values()].reduce((s, e) => s + e.data.length, 0));
  st.clearCache();
  check('clearCache 清空', st.cache.size === 0 && st.size === 0);

  fs.rmSync(ROOT, { recursive: true, force: true });
  console.log(`\n结果: ${pass} pass, ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}, 400);
