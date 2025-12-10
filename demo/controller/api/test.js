'use strict'

class Test {
  constructor() {

  }

  async get(ctx) {
    ctx.ok([
      ctx.method, ctx.path, ctx.routepath, ctx.param
    ])
  }

  async post(ctx) {
    ctx.ok(ctx.body)
  }

  async list(ctx) {
    ctx.ok(ctx.query)
  }

  __mid() {
    return [
      {
        middleware: async (ctx, next) => {
          console.log(`test ${ctx.method} start`)
          await next(ctx)
          console.log(`test ${ctx.method} end`)
        }
      },

      {
        middleware: async (ctx, next) => {
          console.log('use for get list method')
          await next(ctx)
          console.log('end for get list method')
        },

        handler: [
          'get', 'list'
        ]
      },

      {
        middleware: async (ctx, next) => {
          console.log('use for get method', (new Date).toLocaleString())
          await next(ctx)
          console.log('end for get method', (new Date).toLocaleString())
        },

        handler: [
          'get'
        ]
      },

      {
        middleware: async (ctx, next) => {
          console.log(' -- use for post method', (new Date).toLocaleString())
          ctx.body.tag = Math.random()
          await next(ctx)
          console.log(' -- end for post method', (new Date).toLocaleString())
        },

        handler: [
          'post'
        ]
      },
    ]
  }
}

module.exports = Test
