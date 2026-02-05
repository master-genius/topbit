'use strict'

const crypto = require('node:crypto')

/**
 * 确定性负载均衡器
 * 支持基于用户 ID 的哈希分发
 */
class ConsistentBalancer {
  constructor(options = {}) {
    // 定义如何从请求上下文 c 中提取唯一标识
    // 默认尝试提取 header 中的 user-id，或者使用 IP
    this.identityFn = options.identityFn || ((c) => {
      return c.user ? c.user.id : c.ip
    })
    
    this.hashAlgorithm = options.hashAlgorithm || 'sha256'
  }

  /**
   * 负载均衡选择算法
   * @param {Object} c 请求上下文
   * @param {Array} prlist 备选后端列表
   * @param {Object} pxybalance 状态表
   */
  select(c, prlist, pxybalance) {
    if (!prlist || prlist.length === 0) return null

    if (prlist.length === 1) return prlist[0]

    // 1. 提取标识符
    const identity = this.identityFn(c)

    if (!identity) {
      // 如果没有标识符，退回到随机/轮询（或者直接用原逻辑）
      return this.fallback(prlist, pxybalance)
    }

    // 2. 过滤健康的后端 (基于你原有的 checkAlive 逻辑)
    // 注意：pr.h2Pool.ok() 是判断连接池是否正常的关键
    const aliveBackends = prlist.filter(pr => pr.h2Pool && pr.h2Pool.ok())

    const targets = aliveBackends.length > 0 ? aliveBackends : prlist

    // 3. 确定性哈希计算 (Rendezvous Hashing)
    let maxWeight = -1
    let selected = targets[0]

    for (let pr of targets) {
      // 计算 Hash(identity + server_url)
      let hash = crypto.createHash(this.hashAlgorithm)
                  .update(identity + pr.url)
                  .digest()
                  .readUInt32BE(0)

      // 结合权重计算分值 (HRW Hashing 变体)
      // 使用公式：Score = Hash * (Weight^(1/n)) 或者简单乘法
      let score = hash * (pr.weight || 1)

      if (score > maxWeight) {
        maxWeight = score
        selected = pr
      }
    }

    return selected
  }

  // 兜底逻辑
  fallback(prlist, pxybalance) {
    if (pxybalance.stepIndex >= prlist.length) pxybalance.stepIndex = 0
    return prlist[pxybalance.stepIndex++]
  }
}

module.exports = ConsistentBalancer
