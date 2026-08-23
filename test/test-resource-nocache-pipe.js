'use strict';

/**
 * 静态资源：缓存进不去时不再全量累积
 *
 * 二进制分支为了填缓存会 pipe 的同时把全部 chunk 收进数组再 Buffer.concat。
 * 缓存满时那份数据读完即弃，等于每个请求白白分配两倍文件大小，且每次都来一遍。
 * 修复后在读取之前先问 canCache()，进不去就纯流式发送。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const Topbit = require('../src/topbit.js');
const Resource = Topbit.extensions.Resource;

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : '\x1b[31mFAIL\x1b[0m'} ${name}${extra ? '  ' + extra : ''}`);
  cond ? pass++ : fail++;
}

const PORT = 45602;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'res-np-'));

const SIZE = 512 * 1024;
fs.writeFileSync(path.join(dir, 'a.png'), Buffer.alloc(SIZE, 3));
fs.writeFileSync(path.join(dir, 'b.png'), Buffer.alloc(SIZE, 4));

function req(p) {
  return new Promise((resolve, reject) => {
    const r = http.request({host: '127.0.0.1', port: PORT, path: p}, res => {
      let n = 0, first = -1, ok = true;
      res.on('data', c => {
        if (first < 0) first = c[0];
        for (const v of c) if (v !== first) ok = false;
        n += c.length;
      });
      res.on('end', () => resolve({status: res.statusCode, len: n, byte: first, uniform: ok}));
    });
    r.on('error', reject);
    r.end();
  });
}

//注意 maxCacheSize 有 10MB 下限（resource.js:257），无法靠配置调小。
//为避免写十几 MB 的测试文件，第一个文件正常入缓存后直接把 size 顶到上限，
//模拟"缓存已满"——本测试要验的正是 canCache() 这道闸门，不是缓存怎么满的。
const app = new Topbit({parseBody: false});
const res = new Resource({
  staticPath: dir, routePath: '/s/*',
  maxFileSize: 10_000_000
});
res.init(app);
app.run(PORT);

//探针：记录 pipeData（会全量累积的那条路径）被调用了几次
let piped = 0;
const origPipeData = res.pipeData.bind(res);
res.pipeData = function (...a) { piped++; return origPipeData(...a); };

(async () => {
  await new Promise(r => setTimeout(r, 400));

  //第一个文件：缓存是空的，应当走累积路径并进缓存
  let r1 = await req('/s/a.png');
  check('文件 a 内容完整', r1.len === SIZE && r1.byte === 3 && r1.uniform,
        `${r1.len} 字节 byte=${r1.byte}`);

  //缓存写入发生在读流 end 之后，客户端看到 end 时可能尚未落库，让一个 tick
  await new Promise(r => setTimeout(r, 100));
  check('文件 a 进入缓存', res.cache.has('/a.png'), `缓存条目 ${res.cache.size}`);
  check('文件 a 走累积路径（为填缓存）', piped === 1, `pipeData 调用 ${piped} 次`);

  //把已用量顶到上限，模拟缓存满
  res.size = res.maxCacheSize;
  check('缓存已满', !res.canCache(), `size=${res.size} max=${res.maxCacheSize}`);

  //第二个文件：缓存已满，不该再走累积路径，但内容必须完整
  const before = piped;
  let r2 = await req('/s/b.png');
  check('文件 b 内容完整', r2.len === SIZE && r2.byte === 4 && r2.uniform,
        `${r2.len} 字节 byte=${r2.byte}`);
  check('文件 b 未进入缓存', !res.cache.has('/b.png'));
  check('缓存满时不再走累积路径（核心修复）', piped === before,
        `pipeData 调用次数 ${before} → ${piped}`);

  //重复请求同样不累积
  const before2 = piped;
  for (let i = 0; i < 5; i++) {
    let r = await req('/s/b.png');
    if (r.len !== SIZE || r.byte !== 4) { check('重复请求内容完整', false, JSON.stringify(r)); break; }
  }
  check('重复请求内容始终完整', true);
  check('重复请求全程不累积', piped === before2, `pipeData 调用次数 ${before2} → ${piped}`);

  //缓存命中的文件仍正常
  let r3 = await req('/s/a.png');
  check('缓存命中的文件仍正确', r3.len === SIZE && r3.byte === 3 && r3.uniform);

  console.log(`\n结果: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
