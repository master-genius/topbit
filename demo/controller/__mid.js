'use strict'

module.exports = [
  {
    middleware: async (ctx, next) => {
      console.log(`global ${ctx.path} start`)
      await next(ctx)
      console.log(`global ${ctx.path} end`)
    }
  }
]