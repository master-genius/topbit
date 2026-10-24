'use strict'

process.chdir(__dirname)

const Topbit = require('topbit')
const {Cors, Resource, ToFile} = Topbit.extensions
const npargv = Topbit.npargv

const fs = require('node:fs')

let args = npargv({
  '--port': {
    name: 'port',
    type: 'number',
    default: 3003,
    min: 1,
    max: 65535,
    description: 'Port to listen on'
  },

  '--debug': {
    name: 'debug',
    type: 'boolean',
    default: false,
    description: 'Enable debug logging'
  },

  '--worker': {
    name: 'worker',
    default: 2,
  },

  '--host': {
    name: 'host',
    default: '0.0.0.0'
  },

  '--keyfile': {
    name: 'keyfile',
    type: 'string',
    default: ''
  },

  '--keyenv': {
    name: 'keyenv',
    type: 'string',
    default: 'MEDIA_SERVER_KEY'
  },

  '--no-auth': {
    name: 'noAuth',
    type: 'boolean',
    default: false
  },

  '--storage-dir': {
    name: 'storage_dir',
    type: 'string',
    default: './storage'
  }
})

const app = new Topbit({
  debug: args.debug,
  useLimit: true,
  maxConn: 3600,
  maxIPRequest: 100,
  unitTime: 60,
})

let auth_key = args.keyfile ? fs.readFileSync(args.keyfile, 'utf8').trim() : ''

if (args.keyenv && process.env[args.keyenv]) {
  auth_key = process.env[args.keyenv] || ''
}

let auth = async (ctx, next) => {
  if (!auth_key && args.noAuth) {
    return await next(ctx)
  }

  let token = ctx.headers.authorization || ''
  if (token !== auth_key) {
    return ctx.status(401).to('Unauthorized')
  }

  await next(ctx)
}


let storage_dir = args.storage_dir
let storage_image_dir = `${storage_dir}/image`

if (app.isMaster) {
  if (!fs.existsSync(args.storage_dir)) {
    fs.mkdirSync(args.storage_dir, { recursive: true })
  }

  if (!fs.existsSync(storage_image_dir)) {
    fs.mkdirSync(storage_image_dir, { recursive: true })
  }
}

if (app.isWorker) {
  //为Cors提供的路由
  app.options('/*', async ctx => {})

  app.pre(new Cors({
    allow: '*',
    allowHeaders: 'authorization, content-type'
  })).use(new ToFile)

  app.middleware([auth]).group('文件上传', route => {
    route.post('/image', async ctx => {
      let file = ctx.getFile('file') || ctx.getFile('image')
      if (!file) {
        return ctx.status(400).to('No file uploaded')
      }

      ctx.to({
        path: `/image/${await file.toFile(storage_image_dir)}`
      })
    })
  })

  ;(new Resource({
    staticPath: storage_dir,
    //静态资源服务，若是不支持/iamge则直接会到此处
    routePath: '/*',
    cacheControl: 'public, max-age=86400'
  })).init(app)

  app.get('/*', async ctx => {})
}

app.daemon(args.port, args.host, args.worker)
