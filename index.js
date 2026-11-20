/**
 * DSH 宿主半边。
 *
 * 职责只有三件事，全部围绕「Key 不出宿主」：
 *
 *   1. 静态托管 web/（上游 chat-demo 的构建产物），挂在 /plugins/dsh-chat-demo/web/。
 *   2. 反向代理 /plugins/dsh-chat-demo/api/* → https://api.deepseek.com/*，
 *      每次请求现取 Key 并注入鉴权头，浏览器永远拿不到明文。
 *   3. 历史导入的收件口：/plugins/dsh-chat-demo/import（扩展或手工提交），
 *      落到内存暂存（5 分钟 TTL），由面板取走后送进 iframe。
 *
 * 路由前缀的选择是**被迫的窄**：client-modules 已经用 kind:'prefix' 占了 '/plugins'
 * 来发每个插件的 client.js，而它按最长前缀优先匹配（webserver/src/index.ts L542-556）。
 * 如果这里注册 '/plugins/dsh-chat-demo'，就会把本插件自己的 client.js 抢走、变成 404。
 * 所以只注册 web/ api/ import 三个更窄的路径。
 */

import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { dirname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID, timingSafeEqual } from 'node:crypto'

/** 本插件所有路由的共同前缀 */
const BASE = '/plugins/dsh-chat-demo'

const WEB_PREFIX = `${BASE}/web`
const API_PREFIX = `${BASE}/api`
const IMPORT_PATH = `${BASE}/import`
const IMPORT_PENDING_PATH = `${BASE}/import/pending`
const IMPORT_TOKEN_PATH = `${BASE}/import/token`
const STATUS_PATH = `${BASE}/status`
const KEY_PATH = `${BASE}/key`

/** 暂存保留时长：只在内存里活着，5 分钟或取走即失效 */
const STAGING_TTL_MS = 5 * 60 * 1000
/** 单次导入载荷上限：官方导出几 MB 量级，留足余量但拒绝明显的滥用 */
const STAGING_MAX_BYTES = 64 * 1024 * 1024

const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.ico', 'image/x-icon'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.ttf', 'font/ttf'],
  ['.otf', 'font/otf'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.wasm', 'application/wasm'],
])

/** 扩展名 → MIME；未知扩展名回退二进制流 */
const mimeOf = (path) => {
  const dot = path.lastIndexOf('.')
  return dot < 0 ? 'application/octet-stream' : MIME.get(path.slice(dot).toLowerCase()) ?? 'application/octet-stream'
}

const hasExtension = (path) => {
  const name = path.slice(path.lastIndexOf('/') + 1)
  return name.includes('.')
}

/** 响应写一个 JSON 体；所有控制面接口共用 */
const sendJson = (res, status, body, extraHeaders = {}) => {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(text)),
    'cache-control': 'no-store',
    ...extraHeaders,
  })
  res.end(text)
}

const sendText = (res, status, text, headers = {}) => {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': String(Buffer.byteLength(text)),
    'cache-control': 'no-store',
    ...headers,
  })
  res.end(text)
}

/**
 * 读请求体，带上限；超限即停止接收并让调用方回 413。
 *
 * 注意不能在这里 `req.destroy()`：那会把 socket 一起掐掉，客户端看到的是连接重置，
 * 而不是我们准备好的 413。所以只停止累积，由调用方写完响应。
 */
const readBody = (req, limit) =>
  new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let tooLarge = false
    req.on('data', (chunk) => {
      if (tooLarge) {
        return
      }
      size += chunk.length
      if (size > limit) {
        tooLarge = true
        chunks.length = 0
        reject(Object.assign(new Error('payload too large'), { code: 'TOO_LARGE' }))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!tooLarge) {
        resolve(Buffer.concat(chunks))
      }
    })
    req.on('error', reject)
  })

/**
 * 判定请求是否来自本机页面。
 *
 * 反 DNS rebinding：Host 必须是环回地址（与 packages/client/connection/src/api-request-trust.ts 同一套判据）。
 * 同源校验：带 Origin 的请求，其 origin 必须与 Host 一致 —— 浏览器跨站 POST 一定带 Origin。
 */
const isLocalTrusted = (req, expectedOrigin) => {
  const host = req.headers.host
  if (typeof host !== 'string') {
    return false
  }
  const hostname = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]
  const loopback =
    hostname === 'localhost' ||
    hostname === '[::1]' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
  if (!loopback) {
    return false
  }
  const origin = req.headers.origin
  if (origin === undefined) {
    // 扩展的 service worker 请求不带 Origin；仍然要求 Host 是环回，已经挡住了网页。
    return true
  }
  return origin === expectedOrigin
}

/** 常量时间比较，避免 token 被逐字节试探 */
const tokenMatches = (given, expected) => {
  if (typeof given !== 'string') {
    return false
  }
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

const errorMessage = (error) => (error instanceof Error ? error.message : String(error))

export const name = 'dsh-chat-demo'

/** webServer 用于注册路由；credentials 用于现取 Key（两者都缺席时插件无法工作） */
export const inject = ['webServer']

/**
 * 配置项。全部显式校验，默认值只在 `resolveConfig` 里出现一次。
 * @typedef {object} Config
 * @property {string} [upstreamOrigin] 上游 API 根，默认 https://api.deepseek.com
 * @property {string} [apiKeyRef] 凭据引用名，默认 DEEPSEEK_API_KEY
 */

/**
 * 把用户配置收敛成内部使用的完整配置。
 * @param {Config | undefined} config 加载器传入的条目配置
 * @returns {{upstreamOrigin: string, apiKeyRef: string}} 校验后的配置
 */
const resolveConfig = (config) => {
  const upstreamOrigin = config?.upstreamOrigin ?? 'https://api.deepseek.com'
  let parsed
  try {
    parsed = new URL(upstreamOrigin)
  } catch {
    throw new Error(`dsh-chat-demo: upstreamOrigin 不是合法 URL：${upstreamOrigin}`)
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`dsh-chat-demo: upstreamOrigin 只支持 http/https，收到 ${parsed.protocol}`)
  }
  return { upstreamOrigin: parsed.origin, apiKeyRef: config?.apiKeyRef ?? 'DEEPSEEK_API_KEY' }
}

/**
 * 解析出可用的上游 Key。
 *
 * 优先级：① 宿主凭据服务（它自己已经叠加了环境变量与 .env）② 本次运行中
 * 用户一次性输入的 Key（仅宿主内存）。全部失败返回 undefined —— 调用方必须把
 * 「未配置」当成一个要显示出来的状态，不允许静默失败。
 *
 * @param {object} deps 依赖
 * @param {object | undefined} deps.credentials 凭据服务（可能未加载）
 * @param {string} deps.apiKeyRef 凭据引用名
 * @param {() => string | undefined} deps.memoryKey 取宿主内存里的临时 Key
 * @returns {Promise<{value: string, source: string} | undefined>} 命中即返回值与来源
 */
const resolveApiKey = async ({ credentials, apiKeyRef, memoryKey }) => {
  if (credentials !== undefined && typeof credentials.resolve === 'function') {
    const resolved = await credentials.resolve(apiKeyRef)
    if (resolved !== undefined && typeof resolved.value === 'string' && resolved.value !== '') {
      return { value: resolved.value, source: `credential:${resolved.source}` }
    }
  }
  const fromMemory = memoryKey()
  return fromMemory === undefined || fromMemory === '' ? undefined : { value: fromMemory, source: 'memory' }
}

/**
 * 判断某个上游路径该用哪种鉴权头。
 *
 * 上游 chat-demo 对 Anthropic 兼容端点用 x-api-key，对 /models 用 Bearer
 * （见上游 src/services/api/client.ts 的 anthropicHeaders / verifyApiKey）。
 * @param {string} rest 去掉代理前缀后的上游路径
 * @returns {'x-api-key' | 'authorization'} 该路径使用的鉴权头
 */
const authSchemeOf = (rest) => (rest === 'models' || rest.startsWith('v1/tools') ? 'authorization' : 'x-api-key')

/**
 * 注册本插件的全部路由。
 * @param {object} ctx Cordis 上下文
 * @param {Config | undefined} config 条目配置
 * @returns {void}
 */
export function apply(ctx, config) {
  const { upstreamOrigin, apiKeyRef } = resolveConfig(config)
  const webRoot = join(dirname(fileURLToPath(import.meta.url)), 'web')

  /**
   * 现取凭据服务，**不要**在 apply 时缓存。
   *
   * `ctx.get(name)` 默认 `strict`：提供方的 fiber 必须已经 ACTIVE，否则返回 undefined。
   * 插件的 invoke 只有 `webServer`，本行条目在 profile 里又排在 `credentials` 之后激活，
   * 于是 apply 那一刻 `credentials` 常常还没起来 —— 缓存下来就是**永久** undefined，
   * 表现为 /status 永远是 `{"key":"missing"}`，即使 ~/.dsh/.credentials.yaml 里
   * DEEPSEEK_API_KEY 明明有值。官方 llm-deepseek 也是每次操作现取
   * （dsh-llm-deepseek/src/credential.ts:16、:32）。
   */
  const credentialsOf = () => ctx.get('credentials')

  /** 一次性输入的 Key：只活在宿主进程内存里，进程结束即消失，不落盘。 */
  let memoryKey
  /** 导入暂存：内存里一条，5 分钟或取走即失效。 */
  let staged
  /** 一次性导入 token；每次成功使用后轮换。 */
  let importToken = randomUUID()

  const origin = () => ctx.webServer.getOrigin()
  const keyOf = () => resolveApiKey({ credentials: credentialsOf(), apiKeyRef, memoryKey: () => memoryKey })

  const note = (message) => ctx.logger.info(`dsh-chat-demo: ${message}`)

  // ── 静态资源 ────────────────────────────────────────────────────────────

  /**
   * 把 URL 路径映射到 webRoot 下的文件；越界一律返回 undefined。
   * 只做路径规范化后比较前缀，不做字符串包含判断（那会被 `..%2f` 之类的变形骗过）。
   */
  const resolveStatic = (relative) => {
    const decoded = decodeURIComponent(relative)
    if (decoded.includes('\0') || decoded.includes('\\')) {
      return undefined
    }
    const candidate = normalize(join(webRoot, decoded))
    if (candidate !== webRoot && !candidate.startsWith(webRoot + sep)) {
      return undefined
    }
    return candidate
  }

  const serveStatic = async (req, res) => {
    /* node:http 的 url 一定有值；这里只是为了满足类型收窄 */
    const url = req.url ?? '/'
    const queryAt = url.indexOf('?')
    const pathname = queryAt < 0 ? url : url.slice(0, queryAt)

    let relative = pathname.slice(WEB_PREFIX.length)
    if (relative === '' || relative === '/') {
      relative = '/index.html'
    }

    let target
    try {
      target = resolveStatic(relative.replace(/^\/+/, ''))
    } catch {
      // 非法的百分号转义：当作不存在，交给 SPA 回退判断。
      target = undefined
    }

    let info = target === undefined ? undefined : await stat(target).catch(() => undefined)

    // SPA 回退：只有「无扩展名」的未命中才回 index.html。
    // 有扩展名的 404 必须是 404，否则缺 chunk 会被静默换成 HTML，前端报语法错误。
    if ((info === undefined || !info.isFile()) && !hasExtension(pathname)) {
      target = join(webRoot, 'index.html')
      info = await stat(target).catch(() => undefined)
    }

    if (info === undefined || !info.isFile() || target === undefined) {
      sendText(res, 404, 'not found')
      return
    }

    // index.html 不缓存（产物更新后要立即生效）；带指纹的 static/ 长缓存。
    const immutable = relative.startsWith('/static/')
    res.writeHead(200, {
      'content-type': mimeOf(target),
      'content-length': String(info.size),
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      'x-content-type-options': 'nosniff',
    })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    // 文件可能在 stat 与读取之间被删（重新构建 web/ 时）。readStream 的 error 若不接，
    // 会变成未捕获异常把宿主进程带下去 —— 一个静态请求不该有这种能力。
    const stream = createReadStream(target)
    stream.on('error', () => {
      if (!res.headersSent) {
        sendText(res, 404, 'not found')
      } else {
        res.destroy()
      }
    })
    res.on('close', () => stream.destroy())
    stream.pipe(res)
  }

  // ── 反向代理 ────────────────────────────────────────────────────────────

  /**
   * 把上游响应体里出现的 Key 抹掉。
   *
   * 上游正常不会回显 Key，但错误体是它自己拼的字符串，不能假设。
   * 只处理**文本**响应：二进制（图片、音频、zip）按字节原样透传，
   * 对它做 toString('utf8') 会破坏内容。SSE 是边收边发，无法也不应在宿主里解析改写。
   */
  const scrub = (buffer, secret, contentType) => {
    if (secret === undefined || secret === '') {
      return buffer
    }
    // 只有文本类响应才可能「回显 Key」，也只有它们能被安全地改写。
    const textual =
      contentType.includes('json') || contentType.includes('text/') || contentType.includes('xml')
    if (!textual) {
      return buffer
    }
    const body = buffer.toString('utf8')
    if (!body.includes(secret)) {
      return buffer
    }
    return Buffer.from(body.split(secret).join('[redacted]'), 'utf8')
  }

  const proxy = async (req, res) => {
    const url = req.url ?? '/'
    const queryAt = url.indexOf('?')
    const pathname = queryAt < 0 ? url : url.slice(0, queryAt)
    const search = queryAt < 0 ? '' : url.slice(queryAt)

    let rest = pathname.slice(API_PREFIX.length).replace(/^\/+/, '')
    if (rest === '') {
      sendJson(res, 400, { error: { message: 'dsh-chat-demo: empty proxy path' } })
      return
    }
    // 只允许接到上游根下的普通路径，不能借 `..` 逃到别的 host 或协议。
    if (rest.includes('..') || rest.includes('\0')) {
      sendJson(res, 400, { error: { message: 'dsh-chat-demo: invalid proxy path' } })
      return
    }

    const resolved = await keyOf()
    if (resolved === undefined) {
      // 显式失败：前端据此显示「宿主未配置可用 Key」，不做任何降级猜测。
      sendJson(res, 503, {
        error: {
          message:
            'dsh-chat-demo: 宿主未配置可用 Key。请在 DSH 中配置 DEEPSEEK_API_KEY，或在面板中一次性填入。',
          code: 'host-key-missing',
        },
      })
      return
    }

    const target = new URL(`${upstreamOrigin}/${rest}${search}`)
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest

    const headers = {}
    // 透传必要头；鉴权头一律丢弃，用宿主 Key 重新生成，浏览器传来的任何凭据都无效。
    for (const key of ['content-type', 'accept', 'anthropic-beta', 'anthropic-version', 'user-agent']) {
      const value = req.headers[key]
      if (value !== undefined) {
        headers[key] = value
      }
    }
    headers[authSchemeOf(rest)] = authSchemeOf(rest) === 'x-api-key' ? resolved.value : `Bearer ${resolved.value}`
    // 让上游按身份返回体积：身份是宿主的，不是浏览器的。
    delete headers['user-agent']

    // **不转发 accept-encoding**：非流式响应要在宿主里缓冲并擦除可能回显的 Key，
    // 而压缩体是二进制、按 utf8 处理会直接损坏。明确要求上游不压缩，
    // 握手时 Node 也就不必替我们解压、不会出现「改写后 content-length 与实体不符」。
    // SSE 路径不需要这条（浏览器自带的 EventSource/fetch 自己管），
    // 但我们统一走同一套头，避免两条路行为不一致。
    headers['accept-encoding'] = 'identity'

    if (req.headers['content-length'] !== undefined) {
      headers['content-length'] = req.headers['content-length']
    }

    const upstream = send(target, { method: req.method, headers }, (up) => {
      const status = up.statusCode ?? 502
      const contentType = up.headers['content-type'] ?? ''
      const isEventStream = contentType.includes('text/event-stream')

      const outHeaders = { 'cache-control': 'no-store' }
      if (contentType !== '') {
        outHeaders['content-type'] = contentType
      }
      if (isEventStream) {
        // SSE：逐块下转，禁止任何缓冲与压缩（一旦被缓冲，流式就变成一次性吐出）。
        outHeaders['x-accel-buffering'] = 'no'
        outHeaders.connection = 'keep-alive'
        res.writeHead(status, outHeaders)
        res.flushHeaders()
        up.pipe(res)
        up.on('error', () => res.destroy())
        return
      }

      // 非流式：先缓冲，抹掉可能回显的 Key 再发（错误体是上游自己拼的）。
      const chunks = []
      up.on('data', (chunk) => chunks.push(chunk))
      up.on('end', () => {
        const body = scrub(Buffer.concat(chunks), resolved.value, contentType)
        // 用实际字节数覆盖上游的 content-length：洗过 Key 之后长度可能变化。
        res.writeHead(status, { ...outHeaders, 'content-length': String(body.length) })
        res.end(body)
      })
      up.on('error', () => {
        if (!res.headersSent) {
          sendJson(res, 502, { error: { message: 'dsh-chat-demo: upstream stream failed' } })
        } else {
          res.destroy()
        }
      })
    })

    upstream.on('error', (error) => {
      if (!res.headersSent) {
        sendJson(res, 502, { error: { message: `dsh-chat-demo: upstream unreachable (${errorMessage(error)})` } })
      } else {
        res.destroy()
      }
    })

    // 浏览器断开（Esc 中断、关面板）就断开上游，不留悬挂连接。
    res.on('close', () => {
      if (!res.writableEnded) {
        upstream.destroy()
      }
    })

    // 请求体原样上送。multipart 与 JSON 都只是字节流，不解析、不重组。
    req.pipe(upstream)
  }

  // ── 控制面 ──────────────────────────────────────────────────────────────

  const statusHandler = async (_req, res) => {
    const resolved = await keyOf()
    sendJson(res, 200, {
      key: resolved === undefined ? 'missing' : 'ok',
      // 只暴露来源类别，不含值；面板用它告诉用户「Key 从哪来」。
      source: resolved === undefined ? null : resolved.source,
    })
  }

  const keyHandler = async (req, res) => {
    if (!isLocalTrusted(req, origin())) {
      sendJson(res, 403, { error: { message: 'dsh-chat-demo: untrusted origin' } })
      return
    }
    let payload
    try {
      payload = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8'))
    } catch (error) {
      sendJson(res, 400, { error: { message: `dsh-chat-demo: bad body (${errorMessage(error)})` } })
      return
    }
    const value = typeof payload?.key === 'string' ? payload.key.trim() : ''
    if (value === '') {
      sendJson(res, 400, { error: { message: 'dsh-chat-demo: empty key' } })
      return
    }
    // 只进内存：不写 localStorage（浏览器侧不碰）、不写任何文件。
    memoryKey = value
    note('one-time key accepted into host memory (not persisted)')
    const resolved = await keyOf()
    sendJson(res, 200, { key: resolved === undefined ? 'missing' : 'ok', source: resolved?.source ?? null })
  }

  const tokenHandler = (_req, res) => {
    // token 本身就是面板要展示给用户去扩展里填的东西，同源可读是设计的一部分；
    // 真正的跨站防线是上面的 Origin/Host 校验。
    sendJson(res, 200, { token: importToken })
  }

  const pendingHandler = (_req, res) => {
    if (staged === undefined) {
      sendJson(res, 200, { pending: null })
      return
    }
    if (Date.now() - staged.at > STAGING_TTL_MS) {
      staged = undefined
      sendJson(res, 200, { pending: null })
      return
    }
    const { payload, source, name, at } = staged
    // 取走即失效：同一份载荷不会被导入两次（幂等台账是第二道保险）。
    staged = undefined
    sendJson(res, 200, { pending: { payload, source, name, at } })
  }

  const importHandler = async (req, res) => {
    if (!isLocalTrusted(req, origin())) {
      sendJson(res, 403, { error: { message: 'dsh-chat-demo: untrusted origin' } })
      return
    }
    const given = req.headers['x-import-token']
    if (!tokenMatches(Array.isArray(given) ? given[0] : given, importToken)) {
      sendJson(res, 401, { error: { message: 'dsh-chat-demo: bad import token' } })
      return
    }
    let body
    try {
      body = await readBody(req, STAGING_MAX_BYTES)
    } catch (error) {
      const tooLarge = error?.code === 'TOO_LARGE'
      sendJson(res, tooLarge ? 413 : 400, {
        error: { message: `dsh-chat-demo: ${tooLarge ? 'payload too large' : errorMessage(error)}` },
      })
      return
    }
    if (body.length === 0) {
      sendJson(res, 400, { error: { message: 'dsh-chat-demo: empty payload' } })
      return
    }
    let parsed
    try {
      parsed = JSON.parse(body.toString('utf8'))
    } catch (error) {
      sendJson(res, 400, { error: { message: `dsh-chat-demo: body is not JSON (${errorMessage(error)})` } })
      return
    }

    // 载荷只留在内存，5 分钟内被面板取走或自行过期。
    staged = {
      at: Date.now(),
      source: typeof parsed?.source === 'string' ? parsed.source : 'extension',
      name: typeof parsed?.name === 'string' ? parsed.name : 'archive.zip',
      payload: parsed?.payload ?? parsed,
    }
    // token 用过即换：一条泄漏的 token 不能反复投递。
    importToken = randomUUID()
    note('import payload staged in memory (5 min TTL)')
    sendJson(res, 202, { staged: true })
  }

  // ── 路由注册 ────────────────────────────────────────────────────────────

  // 注册是副作用，必须挂在 effect 里：插件卸载或重载时路由随之摘掉，
  // 否则重复加载会撞上 webserver 的 duplicate route 断言。
  ctx.effect(() => {
    const disposers = [
      ctx.webServer.register({ kind: 'prefix', path: WEB_PREFIX, handler: serveStatic }),
      ctx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler: proxy }),
      ctx.webServer.register({ kind: 'exact', path: IMPORT_PATH, handler: importHandler }),
      ctx.webServer.register({ kind: 'exact', path: IMPORT_PENDING_PATH, handler: pendingHandler }),
      ctx.webServer.register({ kind: 'exact', path: IMPORT_TOKEN_PATH, handler: tokenHandler }),
      ctx.webServer.register({ kind: 'exact', path: STATUS_PATH, handler: statusHandler }),
      ctx.webServer.register({ kind: 'exact', path: KEY_PATH, handler: keyHandler }),
    ]
    return () => {
      for (const dispose of disposers) {
        dispose()
      }
    }
  }, 'dsh-chat-demo: routes')

  // 启动探测一次，让「宿主未配置 Key」尽早暴露成可关闭的提示，而不是等用户发出第一条消息才 503。
  void keyOf().then(
    (resolved) => {
      if (resolved === undefined) {
        ctx.logger.warn(
          `dsh-chat-demo: 宿主未配置可用 Key（${apiKeyRef}）。面板打开后会显示提示，填入后可临时使用。`,
        )
      } else {
        note(`upstream key resolved from ${resolved.source}`)
      }
      note(`panel: ${BASE}/web/  ·  proxy: ${API_PREFIX}/`)
    },
    (error) => ctx.logger.warn(`dsh-chat-demo: key probe failed: ${errorMessage(error)}`),
  )
}
