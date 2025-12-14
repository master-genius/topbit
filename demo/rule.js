'use strict'

let Topbit = require('../src/topbit.js')

let {ParamCheck} = Topbit.extensions

let app = new Topbit({
  debug: true
})

let pck = new ParamCheck({
  //支持query、param、body，对应于请求上下文的ctx.query、ctx.param、ctx.body。
  key: 'query',

  //要验证的数据，key值即为属性名称，验证规则可以是string|number|object。
  //string会严格判等，number仅仅数据判等，object是最强大的功能。
  rule: {
    //严格限制say的值必须是hello。
    say: 'hello',
    offset: {
      //如果c.query.offset是undefined，则会赋值为0。
      default: 0,
      //要转换的类型，只能是int、float、boolean
      to: 'int',
      //最小值，>=
      min: 0,
      //最大值，<=
      max: 100
    },
    test: {
      default: false,
      // 转换为布尔类型，若字符串为true则转换为布尔值true，否则转换为布尔值false。
      to: 'boolean'
    }
  }

})

let paramck = new ParamCheck({
  //支持query或param，对应于请求上下文的ctx.query和ctx.param。
  key: 'param',

  //禁止提交的字段
  deny: ['x-key', 'test'],

  //检测到存在禁止提交的属性则自动删除，默认会返回400错误。
  deleteDeny: true,

  //要验证的数据，key值即为属性名称，验证规则可以是string|number|object。
  //string会严格判等，number仅仅数据判等，object是最强大的功能。
  rule: {
    //自定义错误返回的消息，每个属性都可以有自己的错误消息提示。
    name: {
      errorMessage: 'name长度必须在2～8范围内。',

      //obj是c.query或c.param，k是属性名称，method是当前请求方法
      callback: (obj, k, method) => {
        if (obj[k].length < 2 || obj[k].length > 8) {
          return false
        }
        return true
      }
    },

    age: {
      errorMessage: '年龄必须在12～65',
      to: 'int',
      min: 12,
      max: 65
    },
    
    mobile: {
      errorMessage: '手机号不符合要求',
      //利用callback，可以实现完全自主的自定义规则。
      callback: (obj, k, method) => {
        let preg = /^(12|13|15|16|17|18|19)[0-9]{9}$/
        if (!preg.test(obj[k])) {
          return false
        }
        return true
      }
    }
  }

})

let pmbody = new ParamCheck({
  key: 'body',
  rule: {
    username: {
      //必须有这个属性。
      must: true
    },
    passwd: {
      must: true
    },

    mobile: {
      errorMessage: '手机号不符合要求',
      regex: /^(12|13|14|15|16|17|18|19)[0-9]{9}$/,
    },

    detail: {
      errorMessage: 'detail长度0～10',
      min: 0,
      max: 10
    },

    age: {
      to: 'int',
      min: 15,
      max: 95
    }
  }
})

app.use(pck, {method: 'GET'})
  .use(paramck, {method: 'GET'})
  .use(pmbody, {method: ['POST', 'PUT'], name: 'login'})

app.get('/user/:name/:age/:mobile', async c => {
  c.ok({
    query: c.query,
    param: c.param
  })
})

app.post('/login', async c => {
  c.ok(c.body)
}, {name: 'login'})

app.run(1234)
