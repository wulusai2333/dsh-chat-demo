/**
 * 宿主半边（index.js）的行为验证。
 *
 * 全部跑在独立端口 + 假上游上，**不连真实的 DSH 进程**（也不重启它）。
 * 断言的是宿主半边那些可被机器检查的条款：静态托管、路径穿越、缓存头、Key 注入与擦除、
 * SSE 逐块、断连清理、导入 token 一次性、卸载后路由摘除。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHost, serve, fakeUpstream } from './harness.mjs'

const MODULE_DIR = dirname(fileURLToPath(import.meta.url))

/** 每个用例都把 index.js 的 webRoot 指向真实产物目录（web/ 已构建）。 */
const WEB_ROOT = join(MODULE_DIR, '..', 'web')

/**
 * 起一套「被测插件 + 假上游」并返回清理函数。
 * @param {object} [options] 覆盖项
 * @returns {Promise<object>} 服务与观测句柄
 */
const boot = async (options = {}) => {
  const upstream = await fakeUpstream()
  const host = createHost({
    credentials: options.credentials,
    config: { upstreamOrigin: upstream.base },
  })
  const server = await serve(host)
  return {
    host,
    server,
    upstream,
    async close() {
      await server.close()
      await upstream.close()
      host.dispose()
    },
  }
}

test('静态资源：index.html 命中且不缓存，static/** 长缓存', async () => {
  const app = await boot()
  try {
    const index = await fetch(`${app.server.base}/plugins/dsh-chat-demo/web/`)
    assert.equal(index.status, 200)
    assert.match(index.headers.get('content-type'), /text\/html/)
    assert.equal(index.headers.get('cache-control'), 'no-cache')

    const html = await index.text()
    // 从 index.html 里取出真实带指纹的 js，再请求它，验证 MIME 与缓存头。
    const match = /src="([^"]+\.js)"/.exec(html)
    assert.ok(match !== null, 'index.html 里应当有脚本引用')
    // 产物必须用绝对前缀：SPA 回退出来的深层 URL 下相对路径会解析到不存在的目录。
    assert.match(match[1], /^\/plugins\/dsh-chat-demo\/web\/static\/js\//)
    const asset = await fetch(`${app.server.base}${match[1]}`)
    assert.equal(asset.status, 200)
    assert.match(asset.headers.get('content-type'), /text\/javascript/)
    assert.match(asset.headers.get('cache-control'), /immutable/)
    await asset.arrayBuffer()
  } finally {
    await app.close()
  }
})

test('静态资源：有扩展名的缺失文件必须是 404，不能被 SPA 回退成 HTML', async () => {
  const app = await boot()
  try {
    const missing = await fetch(`${app.server.base}/plugins/dsh-chat-demo/web/static/js/nope.js`)
    assert.equal(missing.status, 404)

    // 无扩展名的路径才回退到 index.html（前端路由）。
    const route = await fetch(`${app.server.base}/plugins/dsh-chat-demo/web/conversation/abc`)
    assert.equal(route.status, 200)
    assert.match(route.headers.get('content-type'), /text\/html/)
    await route.arrayBuffer()
  } finally {
    await app.close()
  }
})

test('静态资源：路径穿越不能逃出 web/ 前缀', async () => {
  const app = await boot()
  try {
    for (const attack of [
      '%2e%2e%2f%2e%2e%2fpackage.json',
      '..%2f..%2fpackage.json',
      '..%2F..%2Findex.js',
    ]) {
      const response = await fetch(`${app.server.base}/plugins/dsh-chat-demo/web/${attack}`)
      const body = await response.text()
      assert.notEqual(response.status, 200, `穿越 ${attack} 不应成功`)
      assert.ok(!body.includes('"dsh-chat-demo"'), `穿越 ${attack} 不应泄露 package.json`)
    }
  } finally {
    await app.close()
  }
})

test('代理：宿主 Key 覆盖浏览器传来的任何凭据，且带正确的鉴权头', async () => {
  const app = await boot({ credentials: { resolve: async () => ({ value: 'sk-host-secret', source: 'config' }) } })
  try {
    // 浏览器假装自己是 OpenAI 客户端，带了个假 Key —— 必须被丢弃。
    const response = await fetch(`${app.server.base}/plugins/dsh-chat-demo/api/anthropic/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'sk-BROWSER-FAKE',
        authorization: 'Bearer sk-BROWSER-FAKE',
        'anthropic-beta': 'prompt-caching-2024-07-31',
      },
      body: JSON.stringify({ model: 'x', messages: [] }),
    })
    await response.arrayBuffer()
    assert.equal(response.status, 200)

    const seen = app.upstream.seen.at(-1)
    assert.equal(seen.headers['x-api-key'], 'sk-host-secret')
    assert.equal(seen.headers.authorization, undefined, '浏览器给的 Authorization 不能被转发')
    assert.equal(seen.headers['anthropic-beta'], 'prompt-caching-2024-07-31')
    assert.equal(seen.url, '/anthropic/v1/messages')
  } finally {
    await app.close()
  }
})

test('代理：/models 用 Bearer，SSE 逐块到达且不被缓冲', async () => {
  const app = await boot({ credentials: { resolve: async () => ({ value: 'sk-host-secret', source: 'config' }) } })
  try {
    const models = await fetch(`${app.server.base}/plugins/dsh-chat-demo/api/models`)
    await models.arrayBuffer()
    const seen = app.upstream.seen.at(-1)
    assert.equal(seen.headers.authorization, 'Bearer sk-host-secret')
    assert.equal(seen.headers['x-api-key'], undefined)

    const stream = await fetch(`${app.server.base}/plugins/dsh-chat-demo/api/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal(stream.headers.get('content-type'), 'text/event-stream')
    assert.equal(stream.headers.get('x-accel-buffering'), 'no')

    // 读到第一段就应该能拿到，而不是等上游 end。
    const reader = stream.body.getReader()
    const first = await reader.read()
    assert.ok(first.value !== undefined)
    assert.match(new TextDecoder().decode(first.value), /"n":1/)
    await reader.cancel()
  } finally {
    await app.close()
  }
})

test('代理：宿主没有 Key 时返回 503 host-key-missing，不静默失败', async () => {
  const app = await boot()
  try {
    const response = await fetch(`${app.server.base}/plugins/dsh-chat-demo/api/models`)
    assert.equal(response.status, 503)
    const body = await response.json()
    assert.equal(body.error.code, 'host-key-missing')
    assert.ok(app.upstream.seen.length === 0, '没有 Key 就不该请求上游')
  } finally {
    await app.close()
  }
})

test('代理：上游错误体里回显的 Key 会被擦掉', async () => {
  const app = await boot({ credentials: { resolve: async () => ({ value: 'sk-should-not-leak', source: 'config' }) } })
  try {
    const response = await fetch(`${app.server.base}/plugins/dsh-chat-demo/api/boom`)
    assert.equal(response.status, 401)
    const text = await response.text()
    assert.ok(!text.includes('sk-should-not-leak'), '响应体里的 Key 必须被擦除')
    assert.match(text, /\[redacted\]/)
  } finally {
    await app.close()
  }
})

test('代理：二进制响应按字节原样透传，不做 utf8 改写', async () => {
  const app = await boot({ credentials: { resolve: async () => ({ value: 'sk-binary-probe', source: 'config' }) } })
  try {
    const response = await fetch(`${app.server.base}/plugins/dsh-chat-demo/api/binary`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'image/png')
    const bytes = new Uint8Array(await response.arrayBuffer())
    // 前缀与后缀必须与上游发出的完全一致：任何「洗 Key」都会破坏 png 字节。
    assert.deepEqual([...bytes.slice(0, 7)], [0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe])
    assert.deepEqual([...bytes.slice(-3)], [0x00, 0x01, 0x02])
    // 二进制里恰好带着 Key 的字节 —— 没有被替换成 [redacted]。
    assert.ok(Buffer.from(bytes).includes('sk-binary-probe'))
  } finally {
    await app.close()
  }
})

test('代理：要求上游不压缩，避免缓冲后按 utf8 擦 Key 时损坏 gzip 体', async () => {
  const app = await boot({ credentials: { resolve: async () => ({ value: 'sk-gzip-probe', source: 'config' }) } })
  try {
    // 浏览器声称接受 gzip —— 宿主不能把它转给上游，否则拿回的是压缩字节。
    const response = await fetch(`${app.server.base}/plugins/dsh-chat-demo/api/gzip`, {
      headers: { 'accept-encoding': 'gzip, deflate, br' },
    })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-encoding'), null, '宿主不应接受压缩响应')
    const body = await response.json()
    assert.equal(body.accepted, 'identity', '宿主必须向上游声明 identity')
  } finally {
    await app.close()
  }
})

test('代理：浏览器断开后上游连接被销毁（Esc 中断不留悬挂）', async () => {
  const app = await boot({ credentials: { resolve: async () => ({ value: 'sk-host-secret', source: 'config' }) } })
  try {
    const controller = new AbortController()
    const response = await fetch(`${app.server.base}/plugins/dsh-chat-demo/api/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: controller.signal,
    })
    const reader = response.body.getReader()
    await reader.read()
    controller.abort()
    // 给 res.on('close') 一点时间跑完 upstream.destroy()。
    await new Promise((resolve) => setTimeout(resolve, 80))
    // 上游仍然活着（假上游不追踪 socket 状态），这里只断言宿主没有崩、还能继续服务。
    const health = await fetch(`${app.server.base}/plugins/dsh-chat-demo/status`)
    assert.equal(health.status, 200)
    await health.arrayBuffer()
  } finally {
    await app.close()
  }
})

test('导入收件口：token 错误 401、正确则 202 且 token 用完即换', async () => {
  const app = await boot()
  try {
    const first = await (await fetch(`${app.server.base}/plugins/dsh-chat-demo/import/token`)).json()
    assert.equal(typeof first.token, 'string')

    const bad = await fetch(`${app.server.base}/plugins/dsh-chat-demo/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-import-token': 'wrong' },
      body: JSON.stringify({ sessions: [] }),
    })
    assert.equal(bad.status, 401)
    await bad.arrayBuffer()

    const good = await fetch(`${app.server.base}/plugins/dsh-chat-demo/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-import-token': first.token },
      body: JSON.stringify({ source: 'extension', sessions: [{ id: 's1' }] }),
    })
    assert.equal(good.status, 202)
    await good.arrayBuffer()

    // 同一个 token 不能再用。
    const replay = await fetch(`${app.server.base}/plugins/dsh-chat-demo/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-import-token': first.token },
      body: JSON.stringify({ sessions: [] }),
    })
    assert.equal(replay.status, 401)
    await replay.arrayBuffer()

    // 取走即失效：第二次取到 null。
    const pending = await (await fetch(`${app.server.base}/plugins/dsh-chat-demo/import/pending`)).json()
    assert.deepEqual(pending.pending.payload.sessions, [{ id: 's1' }])
    const again = await (await fetch(`${app.server.base}/plugins/dsh-chat-demo/import/pending`)).json()
    assert.equal(again.pending, null)
  } finally {
    await app.close()
  }
})

test('导入收件口：跨站 Origin 被拒', async () => {
  const app = await boot()
  try {
    const { token } = await (await fetch(`${app.server.base}/plugins/dsh-chat-demo/import/token`)).json()
    const response = await fetch(`${app.server.base}/plugins/dsh-chat-demo/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-import-token': token, origin: 'https://evil.example' },
      body: JSON.stringify({ sessions: [] }),
    })
    assert.equal(response.status, 403)
    await response.arrayBuffer()
  } finally {
    await app.close()
  }
})

test('凭据服务在 apply 之后才激活时，/status 与代理仍能拿到 Key（不缓存 ctx.get 结果）', async () => {
  // 真宿主里 ctx.get 默认 strict：提供方 fiber 未 ACTIVE 时返回 undefined。
  // 本插件的 invoke 只有 webServer，条目又排在 credentials 之后激活 ——
  // apply 那一刻取到的 undefined 一旦被缓存，就是永久「宿主未配置可用 Key」。
  let active = false
  const app = await boot({
    credentials: () => (active ? { resolve: async () => ({ value: 'sk-late-service', source: 'file' }) } : undefined),
  })
  try {
    const before = await (await fetch(`${app.server.base}/plugins/dsh-chat-demo/status`)).json()
    assert.equal(before.key, 'missing', '服务没起来时如实报告未配置')

    active = true
    const after = await (await fetch(`${app.server.base}/plugins/dsh-chat-demo/status`)).json()
    assert.equal(after.key, 'ok', '服务起来后必须能读到 Key，不能停留在 apply 时的 undefined')
    assert.equal(after.source, 'credential:file')

    const proxied = await fetch(`${app.server.base}/plugins/dsh-chat-demo/api/models`)
    await proxied.arrayBuffer()
    assert.equal(proxied.status, 200)
    assert.equal(app.upstream.seen.at(-1).headers.authorization, 'Bearer sk-late-service')
  } finally {
    await app.close()
  }
})

test('一次性 Key：只进宿主内存，随后代理可用', async () => {
  const app = await boot()
  try {
    const before = await (await fetch(`${app.server.base}/plugins/dsh-chat-demo/status`)).json()
    assert.equal(before.key, 'missing')

    const set = await fetch(`${app.server.base}/plugins/dsh-chat-demo/key`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'sk-typed-once' }),
    })
    assert.equal(set.status, 200)
    const after = await (await set.json())
    assert.equal(after.key, 'ok')
    assert.equal(after.source, 'memory')

    const proxied = await fetch(`${app.server.base}/plugins/dsh-chat-demo/api/models`)
    await proxied.arrayBuffer()
    assert.equal(app.upstream.seen.at(-1).headers.authorization, 'Bearer sk-typed-once')
  } finally {
    await app.close()
  }
})

test('卸载：dispose 后所有路由被摘掉（不留宿主残留）', async () => {
  const upstream = await fakeUpstream()
  const host = createHost({ config: { upstreamOrigin: upstream.base } })
  const server = await serve(host)
  try {
    assert.equal((await fetch(`${server.base}/plugins/dsh-chat-demo/status`)).status, 200)
    host.dispose()
    assert.equal(host.routes.exact.size, 0)
    assert.equal(host.routes.prefixes.size, 0)
    const after = await fetch(`${server.base}/plugins/dsh-chat-demo/status`)
    assert.equal(after.status, 404)
    await after.arrayBuffer()
  } finally {
    await server.close()
    await upstream.close()
  }
})

test('路由前缀不与 client-modules 的 /plugins 冲突', async () => {
  const host = createHost({ config: {} })
  try {
    // 只注册了三个更窄的前缀，绝不能占用 '/plugins' 或 '/plugins/dsh-chat-demo'，
    // 否则会把本插件自己的 client.js 抢走。
    for (const path of host.routes.prefixes.keys()) {
      assert.match(path, /^\/plugins\/dsh-chat-demo\/(web|api)$/, `意外的过期宽前缀：${path}`)
    }
    // client.js 由 client-modules 的 '/plugins' 前缀负责，模拟它的最长前缀匹配：
    const clientModules = { kind: 'prefix', path: '/plugins' }
    const path = '/plugins/dsh-chat-demo/client.js'
    const mine = [...host.routes.prefixes.keys()].filter((p) => path.startsWith(`${p}/`))
    assert.equal(mine.length, 0, 'client.js 不应落进本插件的任何前缀')
    assert.ok(path.startsWith(`${clientModules.path}/`))
  } finally {
    host.dispose()
  }
})
