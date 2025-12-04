'use strict'

class Api {
  constructor() {

  }

  async get(ctx) {
    ctx.ok([
      ctx.method, ctx.path, ctx.routepath, ctx.param
    ])
  }
}

module.exports = Api
