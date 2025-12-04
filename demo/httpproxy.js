'use strict'

let Topbit = require('../src/topbit.js')

let {Proxy} = Topbit.extensions

let app = new Topbit({
  debug: true,
  globalLog: true,
  loadInfoFile: '--mem',
})

if (app.isWorker) {
  let pxy = new Proxy({
    config: {
      'x.com': [
        {
          url: 'http://localhost:3001',
          weight: 10,
          path : '/',
          reconnDelay: 200,
          max: 2,
          headers: {
            'x-test-key': `${Date.now()}-${Math.random()}`
          },
          connectTimeout: 2000
        },

        {
          url: 'http://localhost:3002',
          weight: 4,
          path : '/',
          max: 2,
          reconnDelay: 100,
          headers: {
            'x-test-key2': `${Date.now()}-${Math.random()}`
          }
        }
      ]
    },
    debug: true
  })

  pxy.init(app)
}

app.daemon(1234, 2)