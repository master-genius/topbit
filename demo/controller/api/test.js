'use strict'

class Test {
  constructor() {

  }

  async get(ctx) {
    ctx.ok([
      ctx.method, ctx.path, ctx.routepath, ctx.param
    ])
  }

  __mid() {
    return [
      {
        middleware: async (ctx, next) => {
          console.log(`test ${ctx.method} start`)
          await next(ctx)
          console.log(`test ${ctx.method} end`)
        }
      }
    ]
  }
}

module.exports = Test
