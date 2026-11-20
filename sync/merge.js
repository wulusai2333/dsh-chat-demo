/**
 * 合并决策 —— sync/merge.js
 *
 * 纯函数，不 import 上游任何模块、不碰 IndexedDB、不碰 DOM。
 * 这样这份「合并/去重/幂等」的判断逻辑可以在 Node 里被 tests/ 直接覆盖，
 * 而不必启动浏览器或伪造 IndexedDB。真正的落库动作由 import-bridge.ts 做。
 *
 * 【为什么不能照抄上游的导入】
 * 上游 importHistory() 的语义是**整体替换**：
 *   replaceHistory(() => importArchive(file))  →  commitStaging() 先清空 sessions / files 再搬入暂存
 * 也就是说，直接调用它会把用户现有的全部会话换成 ZIP 里的那些。
 * 本插件的导入必须叠加，所以走的是同一条暂存通道，但往暂存里放的是**并集**：
 *   暂存 = ZIP 里的会话 ∪ 库里已有的会话（同 id 按 updatedAt 取新）
 * 这样 commitStaging() 仍然是唯一写入正式库的点 —— 原子性不变，且不需要给上游加任何导出函数。
 */

/** 指纹版本：将来调整算法时改变它，旧账本自然失效而不是误判为「已导入」 */
export const FINGERPRINT_VERSION = 1

/** 会话里的附件本地 id 集合（用于决定要把哪些原件 blob 一起搬进暂存） */
export const collectFileIds = (session) => {
  const ids = new Set()
  const messages = Array.isArray(session?.messages) ? session.messages : []
  for (const message of messages) {
    if (!Array.isArray(message?.files)) {
      continue
    }
    for (const file of message.files) {
      if (typeof file?.id === 'string' && file.id !== '') {
        ids.add(file.id)
      }
    }
  }
  return ids
}

/** 会话消息条数：指纹的一部分 */
export const messageCount = (session) =>
  Array.isArray(session?.messages) ? session.messages.length : 0

/**
 * 末条消息的形状摘要。
 * 只取「结构 + 长度 + 少量文本」，不取全量内容：
 * 指纹要写进 localStorage，逐字存下整个会话会把配额吃光。
 * 用「条数 + 末条形状」已经足以区分「同一会话的新旧两次导出」，
 * 而**不是**用来做密码学意义上的唯一性 —— 它只服务于「这份 ZIP 我导过没有」。
 */
export const tailSignature = (session) => {
  const messages = Array.isArray(session?.messages) ? session.messages : []
  const last = messages[messages.length - 1]
  if (last === undefined) {
    return 'empty'
  }
  const blocks = Array.isArray(last.blocks) ? last.blocks : []
  // blocks 里每种类型的出现顺序也纳入：内容改了但长度没变时仍能区分
  const shape = blocks
    .map((block) => {
      const text = typeof block?.text === 'string' ? block.text : ''
      const content = typeof block?.content === 'string' ? block.content : ''
      return `${block?.type ?? '?'}:${text.length}:${content.length}`
    })
    .join(',')
  const content = typeof last.content === 'string' ? last.content : ''
  return `${last.role ?? '?'}|${content.length}|${blocks.length}[${shape}]`
}

/** FNV-1a 32 位；配合长度做二次校验，够用于幂等判断，且无需 crypto */
export const hashString = (text) => {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(36)
}

/** 幂等指纹：id + 消息条数 + 末条摘要 */
export const sessionFingerprint = (session) => {
  const id = typeof session?.id === 'string' ? session.id : '?'
  const tail = tailSignature(session)
  return `${FINGERPRINT_VERSION}:${id}:${messageCount(session)}:${hashString(tail)}:${tail.length}`
}

/** 账本读：结构不对就当空账本，绝不让坏数据阻断导入 */
export const parseLedger = (raw) => {
  if (typeof raw !== 'string' || raw === '') {
    return {}
  }
  try {
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {}
    }
    const ledger = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (value === true) {
        ledger[key] = true
      }
    }
    return ledger
  } catch {
    return {}
  }
}

/**
 * 合并计划。
 *
 * 规则：
 *   · 会话 id 相同 → 按 updatedAt 取新；相等视为「已是最新」，跳过
 *   · 会话 id 不同 → 追加
 *   · 同一份数据重复导入 → 指纹命中账本，跳过（会话总数不变）
 *   · 任何情况下都不删除库里已有的会话
 *
 * @param {object} input
 * @param {Array<{id:string, updatedAt:number}>} input.existing 库中已有会话（只需 id/updatedAt）
 * @param {Array<object>} input.incoming 本次档案里解析出的会话（已归一为本地模型）
 * @param {Record<string, true>} input.ledger 幂等账本
 * @returns {{
 *   added: string[], updated: string[], skipped: string[],
 *   decisions: Array<{id:string, action:'add'|'update'|'skip', reason:string}>,
 *   ledger: Record<string, true>
 * }}
 */
export const planMerge = ({ existing, incoming, ledger }) => {
  const existingById = new Map()
  for (const session of existing ?? []) {
    if (typeof session?.id === 'string') {
      existingById.set(session.id, session)
    }
  }
  const nextLedger = { ...(ledger ?? {}) }
  const decisions = []
  const added = []
  const updated = []
  const skipped = []
  /** 同一份档案里重复出现的 id，只保留第一条，避免暂存 add() 抛错 */
  const seenIncoming = new Set()

  for (const session of incoming ?? []) {
    const id = typeof session?.id === 'string' ? session.id : ''
    if (id === '') {
      skipped.push('?')
      decisions.push({ id: '?', action: 'skip', reason: 'missing-id' })
      continue
    }
    if (seenIncoming.has(id)) {
      skipped.push(id)
      decisions.push({ id, action: 'skip', reason: 'duplicate-in-payload' })
      continue
    }
    seenIncoming.add(id)

    const fingerprint = sessionFingerprint(session)
    if (nextLedger[fingerprint] === true) {
      skipped.push(id)
      decisions.push({ id, action: 'skip', reason: 'already-imported' })
      continue
    }

    const current = existingById.get(id)
    if (current === undefined) {
      nextLedger[fingerprint] = true
      added.push(id)
      decisions.push({ id, action: 'add', reason: 'new' })
      continue
    }

    const previous = typeof current.updatedAt === 'number' ? current.updatedAt : 0
    const next = typeof session.updatedAt === 'number' ? session.updatedAt : 0
    if (next > previous) {
      nextLedger[fingerprint] = true
      updated.push(id)
      decisions.push({ id, action: 'update', reason: 'newer' })
      continue
    }
    // 相等或更旧：库里那份更新，保留。**仍然记指纹**，
    // 否则同一份旧档案每次导入都会走到这里再比一遍，虽无害但账本失去意义。
    nextLedger[fingerprint] = true
    skipped.push(id)
    decisions.push({ id, action: 'skip', reason: next === previous ? 'same-version' : 'local-newer' })
  }

  return { added, updated, skipped, decisions, ledger: nextLedger }
}

/**
 * 从合并计划推导「暂存区最终应该包含哪些会话」。
 *
 * @param {object} input
 * @param {Array<object>} input.incoming 档案里解析出的会话
 * @param {Array<object>} input.existingFull 库里已有的完整会话（含 messages）
 * @param {ReturnType<typeof planMerge>} input.plan
 * @returns {{ staged: Array<object>, stagedFileIds: Set<string>, kept: number }}
 */
export const buildUnion = ({ incoming, existingFull, plan }) => {
  const incomingById = new Map()
  for (const session of incoming ?? []) {
    if (typeof session?.id === 'string') {
      if (!incomingById.has(session.id)) {
        incomingById.set(session.id, session)
      }
    }
  }
  const updateIds = new Set(plan.updated)
  const addIds = new Set(plan.added)
  const staged = []
  const stagedFileIds = new Set()

  // 1) 本次要新增或替换的会话
  for (const id of [...addIds, ...updateIds]) {
    const session = incomingById.get(id)
    if (session === undefined) {
      continue
    }
    staged.push(session)
    for (const fileId of collectFileIds(session)) {
      stagedFileIds.add(fileId)
    }
  }

  // 2) 库里已有、且本次不替换的会话原样保留 —— 这是「不整体替换」的关键一步
  let kept = 0
  for (const session of existingFull ?? []) {
    if (typeof session?.id !== 'string' || updateIds.has(session.id)) {
      continue
    }
    // 新增的 id 不可能同时存在于库里；跳过已在上面的
    if (addIds.has(session.id)) {
      continue
    }
    staged.push(session)
    kept += 1
    for (const fileId of collectFileIds(session)) {
      stagedFileIds.add(fileId)
    }
  }

  return { staged, stagedFileIds, kept }
}

/** 结果汇总，给面板展示 */
export const summarize = (plan, failed = []) => ({
  added: plan.added.length,
  updated: plan.updated.length,
  skipped: plan.skipped.length,
  failed: failed.length,
  errors: failed,
})
