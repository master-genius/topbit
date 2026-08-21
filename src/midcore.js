'use strict';

class MidCore {

  constructor(options = {}) {
    this.debug = true;
    if (options.debug !== undefined) {
      this.debug = options.debug;
    }

    this.errorHandle = options.errorHandle;
    
    if (typeof this.errorHandle !== 'function') {
      this.errorHandle = (err, errname) => {
        this.debug && console.error(errname, err);
      };
    }

    this.globalKey = `_GLOBAL_0129_${Math.random().toString(16).substring(2).substring(0,6)}_`;

    this.midGroup = Object.create(null);

    this.midGroup[ this.globalKey ] = [
      //纯转发，调用后无操作，因此不需要async：直接把回调的promise透传给调用方，
      //省掉一层promise与一次async帧挂起。路由回调被强制为async，不会同步抛异常。
      (ctx) => {
        if (typeof ctx.requestCall === 'function') {
          return ctx.requestCall(ctx);
        }
      }
    ];

    this.stackCache = [];
  }

  /**
   * @param {function} midcall 回调函数
   * @param {array|object|string} 选项
   */
  addCache(midcall, options = {}) {
    this.stackCache.push({
      callback: midcall,
      options: options
    });
  };

  /**
   * @param {object} groupTable 路由分组表
   */
  addFromCache() {
    let m = null;
    while((m = this.stackCache.pop()) !== undefined) {
      this.add(m.callback, m.options);
    }
  };

  //如果某一分组添加时，已经有全局中间件，需要先把全局中间件添加到此分组。
  initGroup(group, fromGroup='') {
    this.midGroup[group] = [];
    let mids = this.midGroup[this.globalKey];
    
    /* if (fromGroup && group !== fromGroup && this.midGroup[fromGroup])
      mids = this.midGroup[fromGroup]; */

    for(let i=0; i < mids.length; i++) {
      this.midGroup[group].push(mids[i]);
    }
  };

  /**
   * @param {async function} midcall 接受参数(ctx, next)。
   * @param {string|Array|object} options 选项。
   * options如果是字符串则表示针对分组添加中间件，如果是数组或正则表达式则表示匹配规则。
   * 如果你想针对某一分组添加中间件，同时还要设置匹配规则，则可以使用以下形式：
   * {
   *   pathname  : string | Array,
   *   group : string
   * }
   */
  add(midcall, options = {}) {
    if (typeof midcall === 'object') {
      if (midcall.mid && typeof midcall.mid === 'function') {
        
        midcall = midcall.mid();

      } else if (midcall.middleware
            && typeof midcall.middleware === 'function'
            && midcall.middleware.constructor.name === 'AsyncFunction')
      {
        midcall = midcall.middleware.bind(midcall);
      }

    }

    if (typeof midcall !== 'function' || midcall.constructor.name !== 'AsyncFunction') {
      throw new Error('callback and middleware function must use async');
    }
    
    let pathname = null;
    let group = null;
    let method = null;
    //let from_group = '';
    if (typeof options === 'string') {
      if (options[0] === '@') {
        options = { group: options.substring(1) }
      } else {
        options = [options]
      }
    }

    if (Array.isArray(options)) {
      pathname = options;
    } if (options && typeof options === 'object') {
      if (options.name !== undefined) {
        if (typeof options.name === 'string' && options.name.trim()) {
          pathname = [options.name.trim()];
        } else if (Array.isArray(options.name) && options.name.length > 0) {
          pathname = options.name;
        }
      }

      if (options.group !== undefined && typeof options.group === 'string') {
        group = options.group;
      }

      /* if (options.from && typeof options.from === 'string') {
        from_group = options.from;
      } */

      if (options.method !== undefined) {
        if (typeof options.method === 'string' && options.method.length > 0) {
          method = [options.method];
        } else if (Array.isArray(options.method) && options.method.length > 0) {
          method = options.method;
        }
        //请求方法如果传递了小写，都转换为大写。
        method && method.forEach((m, index) => {
          method[index] = m.toUpperCase();
        });
      }
    }

    let self = this;
    /**
     * 包装层只负责绑定nextcall与做method/name过滤，调用midcall之后不再有任何操作，
     * 因此不需要声明为async——直接返回midcall的promise即可，语义与async包装完全等价
     * （调用方一律是await）。这样每层中间件省掉一个promise与一次async帧挂起/恢复。
     *
     * 安全性依据：add()与router.addPath都强制回调必须是AsyncFunction，而async函数
     * （包括bind之后的）永不同步抛异常，只返回rejected promise，所以去掉async包装
     * 不会让异常绕过Middleware.run的try/catch。
     *
     * 需要在await之后继续处理的中间件（如addFinal的fr）仍然必须是async，不在此列。
     */
    let makeRealMid = (prev_mid, grp) => {
      let nextcall = self.midGroup[grp][prev_mid];

      if (!method && !pathname) {
        return (ctx) => midcall(ctx, nextcall);
      }

      let methodTable = null;
      method && (methodTable = {}) && method.forEach(a => { methodTable[a] = true; });

      let nameTable = null;
      pathname && (nameTable = {}) && pathname.forEach(a => { nameTable[a] = true; });

      if (methodTable && !nameTable) {
        return (ctx) => {
          if (!methodTable[ctx.method]) {
            return nextcall(ctx);
          }
  
          return midcall(ctx, nextcall);
        }
      }

      if (!methodTable && nameTable) {
        return (ctx) => {
          if (!nameTable[ctx.name]) {
            return nextcall(ctx);
          }

          return midcall(ctx, nextcall);
        }
      }

      return (ctx) => {
        if (!methodTable[ctx.method] || !nameTable[ctx.name]) {
          return nextcall(ctx);
        }

        return midcall(ctx, nextcall);
      };
    };

    let last = 0;
    if (group) {
      if (!this.midGroup[group]) {
        this.initGroup(group);
        //this.initGroup(group, from_group);
      }
      last = this.midGroup[group].length - 1;
      this.midGroup[group].push(makeRealMid(last, group));
    } else {
      //全局添加中间件
      for (let k in this.midGroup) {
        last = this.midGroup[k].length - 1;
        this.midGroup[k].push(makeRealMid(last, k));
      }
    }
    return this;
  }

  exec(ctx, group='') {
    if (!group || this.midGroup[group] === undefined) {
      group = this.globalKey;
    }

    let last = this.midGroup[group].length - 1;
    return this.midGroup[group][last](ctx);
  }

}

module.exports = MidCore;
