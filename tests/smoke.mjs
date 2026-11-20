/**
 * 端到端冒烟：在独立端口上把 index.js 真的跑起来，验证「上层接线」没接错。
 *
 * 与 tests/host.test.mjs 的区别：那边用假上游验证协议细节；这里用**真实上游**
 * （api.deepseek.com）验证宿主 Key 能拿到、鉴权头能被接受、失败时我们如实报错。
 *
 * 需要宿主凭据，所以只在手动执行时跑：node tests/smoke.mjs
 * 不碰正在运行的 DSH，端口用 0 让系统分配。
 */

import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { apply } from '../index.js'

/** 从 $DSH_HOME/.credentials.yaml 里取 DEEPSEEK_API_KEY —— 只在本机进程内使用，不打印。 */
const readHostKey = () => {
  const candidates = [join(homedir(), '.dsh', '.credentials.yaml')]
  for (const file of candidates) {
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const line = /^\s*DEEPSEEK_API_KEY:\s*(.+?)\s*$/m.exec(text)
    if (line !== null) {
      return line[1].replace(/^['"]|['"]$/g, '')
    }
  }
  return undefined
}

const key = readHostKey()
const exact = new Map()
const prefixes = new Map()

const ctx = {
  effect(callback) {
    const dispose = callback()
    return () => dispose?.()
  },
  get: (service) => (service === 'credentials' ? { resolve: async () => (key === undefined ? undefined : { value: key, source: 'smoke' }) } : undefined),
  logger: { info() {}, warn() {}, error: console.error },
  webServer: {
    register(route) {
      ;(route.kind === 'exact' ? exact : prefixes).set(route.path, route)
      return () => {}
    },
    getOrigin: () => base,
  },
}

const server = createServer((req, res) => {
  const pathname = (req.url ?? '/').split('?')[0]
  const route = exact.get(pathname) ?? [...prefixes].filter(([p]) => pathname === p || pathname.startsWith(`${p}/`)).sort((a, b) => b[0].length - a[0].length)[0]?.[1]
  if (route === undefined) {
    res.writeHead(404).end('no route')
    return
  }
  Promise.resolve(route.handler(req, res)).catch((error) => {
    if (!res.headersSent) res.writeHead(500).end(String(error))
    else res.destroy()
  })
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
apply(ctx, {})

const check = async (label, url, init, expect = 'ok') => {
  try {
    const response = await fetch(`${base}${url}`, init)
    const text = await response.text()
    // expect='block' 表示「被正确拒绝」才是通过（例如路径穿越必须是 404）。
    const pass = expect === 'block' ? response.status === 404 : response.ok
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}  → HTTP ${response.status}  ${text.slice(0, 140)}`)
    return { ok: pass, status: response.status, text }
  } catch (error) {
    console.log(`FAIL  ${label}  → ${error.message}`)
    return { ok: false, status: 0, text: String(error) }
  }
}

console.log(`冒烟宿主：${base}`)
console.log(`宿主 Key：${key === undefined ? '未找到（将验证 503 分支）' : '已读取'}\n`)

await check('index.html', '/plugins/dsh-chat-demo/web/')
await check('路径穿越被拒（期望 404）', '/plugins/dsh-chat-demo/web/..%2f..%2fpackage.json', undefined, 'block')
await check('status', '/plugins/dsh-chat-demo/status')
const models = await check('上游 /models 探测', '/plugins/dsh-chat-demo/api/models')

// 真的发一次最小对话请求：这才是「接线对了」的证据。
if (key !== undefined && models.status === 200) {
  await check('上游 /anthropic/v1/messages', '/plugins/dsh-chat-demo/api/anthropic/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-chat',
      max_tokens: 8,
      messages: [{ role: 'user', content: 'say ok' }],
    }),
  })
}

// 断言 Key 没有回流到浏览器侧的任何响应里。
const statusText = await fetch(`${base}/plugins/dsh-chat-demo/status`).then((r) => r.text())
const leaked = key !== undefined && statusText.includes(key)
console.log(`\n状态响应里是否含 Key：${leaked ? '是（严重问题）' : '否'}`)
if (leaked) {
  process.exitCode = 1
}

server.close()
server.closeAllConnections?.()
