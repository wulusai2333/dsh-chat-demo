/**
 * 宿主半边的独立验证台。
 *
 * 为什么不用真 DSH：测试不该要求一个正在运行的宿主进程，更不该去重启它。
 * 所以这里用**真实 node:http** 起一个假宿主，把 index.js 的 apply() 接到一个符合
 * WebServer 契约的最小实现上，再按 webserver/src/index.ts L542-556 的
 * 「精确表优先、其次最长前缀」规则派发。被测的是插件自己的代码，不是这份夹具。
 */

import { createServer } from 'node:http'
import { gzipSync } from 'node:zlib'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

/**
 * 造一个足以让 apply() 跑起来的假上下文。
 * @param {{credentials?: object | (() => object | undefined), origin?: string}} options 依赖注入
 * @returns {{ctx: object, dispatcher: Function, dispose: Function, routes: object}} 假上下文与派发函数
 */
export const createHost = (options = {}) => {
  const exact = new Map()
  const prefixes = new Map()
  const disposers = []
  const routes = { exact, prefixes }

  const ctx = {
    // apply() 用 ctx.effect(fn, label) 把路由注册挂成可撤销的副作用。
    effect(callback) {
      const dispose = callback()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => dispose?.()
    },
    get(name) {
      if (name !== 'credentials') return undefined
      // 函数形式用来模拟「凭据服务在 apply 之后才激活」：真宿主里
      // ctx.get 默认 strict，提供方 fiber 未 ACTIVE 时返回 undefined。
      return typeof options.credentials === 'function' ? options.credentials() : options.credentials
    },
    logger: { info() {}, warn() {}, error() {} },
    webServer: {
      register(route) {
        const table = route.kind === 'exact' ? exact : prefixes
        if (table.has(route.path)) throw new Error(`duplicate ${route.kind} route "${route.path}"`)
        table.set(route.path, route)
        return () => table.delete(route.path)
      },
      getOrigin() {
        return options.origin ?? 'http://127.0.0.1:0'
      },
    },
  }

  /** 与 WebServer#match 同规则：精确命中优先，否则最长前缀胜出。 */
  const match = (pathname) => {
    const hit = exact.get(pathname)
    if (hit !== undefined) return hit
    let best
    for (const [prefix, route] of prefixes) {
      if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue
      if (best === undefined || prefix.length > best.path.length) best = route
    }
    return best
  }

  apply(ctx, options.config)

  return {
    ctx,
    routes,
    match,
    dispose() {
      for (const dispose of disposers) dispose()
    },
  }
}

/**
 * 起一个真实 HTTP 服务，用被测插件注册的处理器应答。
 * @param {object} host createHost 的返回值
 * @param {number} port 监听端口（0 = 随机空闲端口）
 * @returns {Promise<{base: string, close: Function}>} 服务地址与关闭函数
 */
export const serve = async (host, port = 0) => {
  const server = createServer((req, res) => {
    const url = req.url ?? '/'
    const pathname = url.includes('?') ? url.slice(0, url.indexOf('?')) : url
    const route = host.match(pathname)
    if (route === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('no route')
      return
    }
    Promise.resolve(route.handler(req, res)).catch((error) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'text/plain' })
        res.end(String(error))
      } else {
        res.destroy()
      }
    })
  })
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
  const { port: bound } = server.address()
  return {
    base: `http://127.0.0.1:${bound}`,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.()
      server.close(() => resolve())
    }),
  }
}

/**
 * 造一个假上游，记录收到的请求头，用于断言代理行为。
 * @returns {Promise<{base: string, seen: object[], close: Function}>} 上游地址与观测记录
 */
export const fakeUpstream = async () => {
  const seen = []
  const server = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: { ...req.headers } })
    const pathname = req.url ?? ''

    // SSE：分两段慢慢发，验证宿主是逐块下转而不是缓冲。
    if (pathname.includes('/messages')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: {"type":"chunk","n":1}\n\n')
      setTimeout(() => {
        res.write('data: {"type":"chunk","n":2}\n\n')
        res.end()
      }, 30)
      return
    }

    // 错误体里故意回显 Key，验证宿主的擦除逻辑。
    if (pathname.includes('/boom')) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: `bad key: ${req.headers['x-api-key'] ?? req.headers.authorization}` } }))
      return
    }

    // 二进制：响应体里恰好含有 Key 的字节序列，验证宿主不会去「洗」它。
    if (pathname.includes('/binary')) {
      const bytes = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe]),
        Buffer.from(req.headers['x-api-key'] ?? '', 'utf8'),
        Buffer.from([0x00, 0x01, 0x02]),
      ])
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(bytes.length) })
      res.end(bytes)
      return
    }

    // 压缩响应：验证宿主明确要求 identity，不会拿到无法按 utf8 处理的 gzip 体。
    if (pathname.includes('/gzip')) {
      const accepted = req.headers['accept-encoding'] ?? ''
      const body = JSON.stringify({ accepted })
      // 只有客户端说接受 gzip 时才压缩 —— 宿主说 identity，所以这里应当返回明文。
      if (accepted.includes('gzip')) {
        const packed = gzipSync(Buffer.from(body, 'utf8'))
        res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' })
        res.end(packed)
        return
      }
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) })
      res.end(body)
      return
    }

    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, path: pathname }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    base: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.()
      server.close(() => resolve())
    }),
  }
}

/** 临时目录，用于放一个假的 web/ 根（避免依赖真实构建产物存在）。 */
export const makeWebRoot = () => mkdtempSync(join(tmpdir(), 'dsh-chat-demo-test-'))

/** 删除临时目录。 */
export const dropDir = (dir) => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // 清理失败不影响断言结果。
  }
}
