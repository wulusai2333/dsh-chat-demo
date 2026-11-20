/**
 * 导入载荷的识别与拆解 —— sync/normalize.js
 *
 * 这一层只做「判断载荷是什么、把会话 JSON 拆出来」，不碰 IndexedDB、不碰 DOM，
 * 因此既能在浏览器里被 bundle 进 iframe，也能在 Node 里被 tests/ 直接调用。
 *
 * 【为什么三种来源最终都归一成「归档 v3 的会话对象」】
 * 上游已经写好了一整套格式校验（history/schema.ts 的 readSessionFile）与
 * 消息树还原（history/toLocal.ts 的 toLocalSession）。L1 的 ZIP、L3 的粘贴内容
 * 如果各写一条转换路径，就等于把 13 种片段类型的映射抄两遍，必然漂移。
 * 所以这里只负责把载荷拆成「未校验的会话 JSON 数组」，随后统一交给上游那套
 * readSessionFile + toLocalSession —— 校验口径与官方备份完全一致。
 */

/** 载荷大类：要么是一份归档（ZIP 字节），要么是已经解析好的会话 JSON */
export const PAYLOAD_KIND = {
  /** 官方导出的 deepseek_data-*.zip、扩展抓到的 ZIP、粘贴的 base64 */
  archive: 'archive',
  /** 手工粘贴 / 粘贴文件得到的会话 JSON */
  sessions: 'sessions',
}

/** 载荷来源，只用于给用户看「这份数据是哪条路进来的」 */
export const PAYLOAD_SOURCE = {
  zip: 'zip',
  json: 'json',
  extension: 'extension',
}

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * 判断一个对象是否「看起来是会话」。
 *
 * 为什么不干脆接受任何对象：`manifest.json`、`chat_session_index.json`、以及用户
 * 误粘贴的任意 JSON 都是对象。若照单全收，它们会被当成「一个没有 messages 的会话」
 * 塞进导入流程 —— 结果是界面报「新增 1 个会话」，库里却多出一条空对话。
 * 这里的门槛只要求「有 id 或有 messages」，剩下的交给上游 readSessionFile 严格校验。
 * @param {unknown} value 候选对象
 * @returns {boolean} 是否具备会话的必要形状
 */
const looksLikeSession = (value) =>
  isRecord(value) && (typeof value.id === 'string' || Array.isArray(value.messages))

/**
 * 跨 realm 的 Blob 判定。
 * 面板与 iframe 是同源但不同 window，`instanceof File` 跨 realm 会假；
 * 结构化克隆后仍是同一个底层 Blob，所以用能力探测而不是原型判断。
 */
const isBlobLike = (value) =>
  value !== null &&
  typeof value === 'object' &&
  typeof value.arrayBuffer === 'function' &&
  typeof value.size === 'number' &&
  typeof value.slice === 'function'

/**
 * 判断载荷形态。
 * @param {unknown} payload 面板通过 postMessage 送进 iframe 的载荷
 * @returns {{kind: 'archive', source: string, name: string, file?: Blob, base64?: string}
 *   | {kind: 'sessions', source: string, sessions: unknown[]}
 *   | null} 无法识别时返回 null（调用方据此报「格式无法识别」，不猜）
 */
export const classifyPayload = (payload) => {
  // 直接 postMessage 了一个 File/Blob：最省内存的一条路（不经过 base64 膨胀 33%）
  if (isBlobLike(payload)) {
    return archiveOf(payload, PAYLOAD_SOURCE.zip)
  }
  if (!isRecord(payload)) {
    return null
  }
  if (isBlobLike(payload.file)) {
    return archiveOf(
      payload.file,
      payload.fromExtension === true ? PAYLOAD_SOURCE.extension : PAYLOAD_SOURCE.zip,
      payload.name
    )
  }
  if (typeof payload.base64 === 'string' && payload.base64.length > 0) {
    return {
      kind: PAYLOAD_KIND.archive,
      source: payload.fromExtension === true ? PAYLOAD_SOURCE.extension : PAYLOAD_SOURCE.zip,
      name: typeof payload.name === 'string' && payload.name !== '' ? payload.name : 'archive.zip',
      base64: payload.base64,
    }
  }
  if (typeof payload.text === 'string') {
    return unwrapJson(payload.text)
  }
  if ('sessions' in payload) {
    return sessionsOf(payload.sessions)
  }
  // 直接就是单个会话对象或会话数组
  return unwrapJson(JSON.stringify(payload))
}

const archiveOf = (file, source, name) => ({
  kind: PAYLOAD_KIND.archive,
  source,
  name: typeof name === 'string' && name !== '' ? name : 'archive.zip',
  file,
})

/** 把 JSON 文本解析成载荷；解析失败或形状不对返回 null */
export const unwrapJson = (text) => {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (isRecord(parsed) && Array.isArray(parsed.sessions)) {
    return sessionsOf(parsed.sessions)
  }
  if (Array.isArray(parsed)) {
    return sessionsOf(parsed)
  }
  // 单个会话文件（chat_sessions/<id>.json 的内容）
  if (looksLikeSession(parsed)) {
    return { kind: PAYLOAD_KIND.sessions, source: PAYLOAD_SOURCE.json, sessions: [parsed] }
  }
  return null
}

/**
 * 只保留「看起来是会话」的条目，其余丢弃。
 * 这里**不做**宽容修正：字段不对就让 readSessionFile 明确失败，计入 failed，
 * 而不是猜一个默认值把坏数据写进用户的会话库。
 */
const sessionsOf = (value) => {
  const list = Array.isArray(value) ? value.filter((item) => looksLikeSession(item)) : looksLikeSession(value) ? [value] : []
  if (list.length === 0) {
    return null
  }
  return { kind: PAYLOAD_KIND.sessions, source: PAYLOAD_SOURCE.json, sessions: list }
}

/** base64 → Uint8Array（浏览器与 Node 18+ 都有 atob） */
export const decodeBase64 = (base64) => {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

/** 归档载荷 → File（上游 readArchive 只接受 File，用于取 size 与切片） */
export const toArchiveFile = (archive) => {
  if (archive.file !== undefined) {
    return archive.file
  }
  return new File([decodeBase64(archive.base64)], archive.name, { type: 'application/zip' })
}
