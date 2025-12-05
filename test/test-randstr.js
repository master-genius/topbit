// benchmark.js
const generateSalt = require('../src/randstring.js');
const { performance } = require('perf_hooks');

const ITERATIONS = 1000000; // 100万次
const SALT_LENGTH = 16;      // 生成 8 位

console.log('========================================');
console.log(`性能测试开始`);
console.log(`目标: 生成 ${ITERATIONS.toLocaleString()} 次, 长度 ${SALT_LENGTH}`);
console.log('========================================');

// 1. 预热 (Warm-up)
// 让 V8 引擎的 JIT (Just-In-Time) 编译器介入，把热点代码编译成机器码
// 这样测出来的才是服务器稳定运行时的真实性能
for(let i = 0; i < 10000; i++) {
  generateSalt(SALT_LENGTH);
}
console.log('预热完成，开始计时...');

// 2. 正式测试
const startTime = performance.now();

for (let i = 0; i < ITERATIONS; i++) {
  generateSalt(SALT_LENGTH);
}

const endTime = performance.now();

// 3. 计算结果
const totalTimeMs = endTime - startTime;
const qps = Math.floor(ITERATIONS / (totalTimeMs / 1000));

// 4. 验证一次输出 (确保功能正常)
const sample = generateSalt(SALT_LENGTH);

console.log('\n测试结果:');
console.log(`----------------------------------------`);
console.log(`总耗时   : ${totalTimeMs.toFixed(2)} ms`);
console.log(`平均耗时 : ${(totalTimeMs / ITERATIONS).toFixed(6)} ms/次`);
console.log(`QPS      : ${qps.toLocaleString()} 次/秒`);
console.log(`----------------------------------------`);
console.log(`生成的样例: ${sample}`);
console.log('========================================');