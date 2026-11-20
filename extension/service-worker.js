/**
 * dsh-chat-demo 扩展 —— service worker（**源码骨架，未验证**）
 *
 * 定位（见 docs/sync-feasibility.md §0、§2、§3）：
 *
 *   L2 只交付骨架。原因不是偷懒，而是两件事没实测：
 *   · chat.deepseek.com 的会话列表 / 详情接口路径与响应字段（§2 明确「未测量」，
 *     所以本仓库的代码里**故意不写任何猜出来的路径**）；
 *   · 反爬机制（x-ds-pow-response 一类）是否存在、何时触发（§3）。
 *
 * 因此本文件只实现「与上游无关、已能确定的部分」，并把「采集」留成一个必须由维护者
 * 补齐后再启用的空位：
 *
 *   ✔ 串行、≤1 req/s 的节流器（§3 硬性合规要求，写死在代码里，不是可调参数）
 *   ✔ 只访问自己的账号（复用浏览器里已有的登录态，不搬运、不落盘任何 cookie）
 *   ✔ 一次性 X-Import-Token 投递到 127.0.0.1 的宿主收件口
 *   ✔ 任何疑似风控/验证码响应立即中止并如实上报，绝不尝试绕过
 *   ✘ 采集本身：ENDPOINTS 为空时直接报错，**不会静默返回空结果**
 *
 * 补齐方式：在 chat.deepseek.com 上抓一次真实请求，把路径与字段写进下面的
 * ENDPOINTS / mapSession，再按 §8 的重测清单验证。
 */

/** 上游来源。host_permissions 里只声明了这一个站点，扩展结构上访问不到别处。 */
const UPSTREAM = 'https://chat.deepseek.com'

/**
 * 采集端点表 —— **刻意留空**。
 *
 * 不填就不会工作；填了就是「已实测」的声明。这样维护者不会把猜测的路径当成事实。
 * 需要的形状：
 *   list: { path: '/api/v0/...', ... }  返回会话 id 列表（或分页）
 *   detail: (id) => '/api/v0/...'       返回单个会话的消息树
 */
const ENDPOINTS = {
  list: null,
  detail: null,
}

/** 最小请求间隔。合规要求 ≤1 req/s，所以下限写死 1000ms，不提供开关。 */
const MIN_INTERVAL_MS = 1000

/** 单次运行最多拉多少会话，避免一次把账号刷爆。 */
const MAX_SESSIONS = 500

/** 一个朴素的串行节流器：保证「上一次结束到下一次开始」至少 MIN_INTERVAL_MS。 */
const createPacer = () => {
  let last = 0
  return async () => {
    const wait = Math.max(0, last + MIN_INTERVAL_MS - Date.now())
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
    last = Date.now()
  }
}

/** 向 popup 报一行进度；popup 关了就静默失败（不是错误）。 */
const progress = (line) => {
  chrome.runtime.sendMessage({ type: 'dsh-chat-demo/progress', line }).catch(() => {})
}

/**
 * 判断一个响应是否表示「被风控/验证拦住了」。
 *
 * 命中就**停止**，不重试、不求解、不换 IP —— 本项目明令禁止绕过验证与风控。
 * @param {Response} response 上游响应
 * @returns {boolean} 是否应当中止
 */
const looksLikeChallenge = (response) =>
  response.status === 403 ||
  response.status === 429 ||
  response.status === 401 ||
  (response.headers.get('content-type') ?? '').includes('text/html')

/**
 * 带节流的同源 GET。证书与登录态由浏览器自己带上，扩展不接触 cookie 值。
 * @param {string} path 上游路径
 * @param {string} pacer 节流器
 * @returns {Promise<unknown>} 解析后的 JSON
 */
const fetchJson = async (path, pacer) => {
  await pacer()
  const response = await fetch(`${UPSTREAM}${path}`, {
    credentials: 'include',
    headers: { accept: 'application/json' },
  })
  if (looksLikeChallenge(response)) {
    throw new Error(
      `上游要求验证或被限流（HTTP ${response.status}）。本扩展不会绕过验证码或风控，已停止。请改用官方导出 ZIP 导入。`,
    )
  }
  if (!response.ok) {
    throw new Error(`上游返回 HTTP ${response.status}`)
  }
  return response.json()
}

/**
 * 采集全部会话，返回可交给宿主归一化器的载荷。
 * @returns {Promise<{sessions: unknown[], source: string}>} 会话数组
 */
const collectSessions = async () => {
  if (ENDPOINTS.list === null || ENDPOINTS.detail === null) {
    throw new Error(
      '会话接口尚未实测（docs/sync-feasibility.md §2）。请改用官方导出 ZIP 导入，或先补齐 extension/service-worker.js 的 ENDPOINTS。',
    )
  }
  const pacer = createPacer()
  const list = await fetchJson(ENDPOINTS.list, pacer)
  const ids = Array.isArray(list?.data) ? list.data.map((item) => item?.id).filter((id) => typeof id === 'string') : []
  if (ids.length === 0) {
    throw new Error('上游没有返回任何会话 id；可能是接口字段已变更，请重新测量。')
  }
  const chosen = ids.slice(0, MAX_SESSIONS)
  progress(`共 ${ids.length} 个会话，本次处理 ${chosen.length} 个（≤1 请求/秒）`)

  const sessions = []
  for (const [index, id] of chosen.entries()) {
    const detail = await fetchJson(ENDPOINTS.detail(id), pacer)
    sessions.push(detail)
    progress(`已取 ${index + 1}/${chosen.length}`)
  }
  return { sessions, source: 'extension' }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'dsh-chat-demo/run') return false
  void (async () => {
    try {
      const { sessions } = await collectSessions()
      // 端点必须是**本机**回环地址：manifest 的 host_permissions 也只放开了 127.0.0.1。
      const endpoint = String(message.endpoint ?? '')
      if (!/^http:\/\/127\.0\.0\.1(:\d+)?$/.test(endpoint) && !/^http:\/\/localhost(:\d+)?$/.test(endpoint)) {
        throw new Error('插件地址必须是本机 127.0.0.1 或 localhost。')
      }
      progress('投递给 DSH…')
      const response = await fetch(`${endpoint}/plugins/dsh-chat-demo/import`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // 一次性 token：宿主用过即轮换，泄漏一次也只能用一次。
          'x-import-token': String(message.token ?? ''),
        },
        body: JSON.stringify({ source: 'extension', sessions }),
      })
      if (!response.ok) {
        const body = await response.text()
        throw new Error(`DSH 拒收（HTTP ${response.status}）：${body.slice(0, 200)}`)
      }
      progress('已交给 DSH。回到 DSH 面板打开本插件即会导入。')
      sendResponse({ ok: true })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      progress(`失败：${reason}`)
      sendResponse({ ok: false, error: reason })
    }
  })()
  // 异步响应：告诉 Chrome 稍后用 sendResponse。
  return true
})
