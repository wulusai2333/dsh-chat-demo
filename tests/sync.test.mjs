/**
 * 合并与归一化的纯函数验证。
 *
 * 这两块是「导入不丢数据、不重复、不覆盖」的核心，必须能脱离浏览器单测：
 * sync/merge.js 与 sync/normalize.js 都不碰 IndexedDB、不碰 DOM。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FINGERPRINT_VERSION,
  collectFileIds,
  messageCount,
  sessionFingerprint,
  parseLedger,
  planMerge,
  buildUnion,
  summarize,
} from '../sync/merge.js'
import { classifyPayload, unwrapJson, PAYLOAD_KIND } from '../sync/normalize.js'

/**
 * 造一个最小会话。
 *
 * 形状对齐上游 src/services/chat/types.ts：附件是 UserMessage.files: FileAttachment[]，
 * 助手消息用 blocks: ReplyBlock[] —— 指纹与附件收集都依赖这两点，测试必须照着真实形状造。
 *
 * @param {object} spec 参数
 * @param {string} spec.id 会话 id
 * @param {number} spec.count 消息条数
 * @param {number} spec.updatedAt 更新时间
 * @param {string} [spec.tail] 末条消息内容，用来制造不同的指纹
 * @param {string[]} [spec.fileIds] 附件 id（挂在用户的末条消息上）
 * @returns {object} 会话对象
 */
const makeSession = ({ id, count, updatedAt, tail = 'hello', fileIds = [] }) => {
  // 附件只能挂在用户消息上（上游 UserMessage.files）；取最后一条用户消息来放。
  let lastUserIndex = -1
  for (let index = 0; index < count; index += 1) {
    if (index % 2 === 0) lastUserIndex = index
  }
  return {
    id,
    title: `session ${id}`,
    createdAt: 1,
    updatedAt,
    messages: Array.from({ length: count }, (_, index) => {
      const isLast = index === count - 1
      const content = isLast ? tail : `msg ${index}`
      if (index % 2 === 0) {
        return {
          id: `${id}-m${index}`,
          role: 'user',
          content,
          createdAt: index,
          files:
            index === lastUserIndex && fileIds.length > 0
              ? fileIds.map((fileId) => ({
                  id: fileId,
                  serverId: null,
                  name: `${fileId}.png`,
                  size: 1,
                  isImage: true,
                  mimeType: '',
                }))
              : [],
        }
      }
      return {
        id: `${id}-m${index}`,
        role: 'assistant',
        createdAt: index,
        model: null,
        prefix: false,
        status: 'done',
        blocks: [{ type: 'text', text: content }],
      }
    }),
  }
}

test('指纹：稳定的版本前缀，内容相同则相同、末条不同则不同', () => {
  const a = makeSession({ id: 's1', count: 3, updatedAt: 100 })
  const b = makeSession({ id: 's1', count: 3, updatedAt: 999 })
  // updatedAt 不参与指纹：同一份内容即使被重新导出也应认出来。
  assert.equal(sessionFingerprint(a), sessionFingerprint(b))
  assert.ok(sessionFingerprint(a).startsWith(`${FINGERPRINT_VERSION}:s1:`))

  const c = makeSession({ id: 's1', count: 3, updatedAt: 100, tail: 'different' })
  assert.notEqual(sessionFingerprint(a), sessionFingerprint(c))

  const d = makeSession({ id: 's1', count: 4, updatedAt: 100 })
  assert.notEqual(sessionFingerprint(a), sessionFingerprint(d))
})

test('台账解析：只认 value === true，脏数据一律丢弃', () => {
  assert.deepEqual(parseLedger(null), {})
  assert.deepEqual(parseLedger('not json'), {})
  assert.deepEqual(parseLedger('[]'), {})
  assert.deepEqual(parseLedger(JSON.stringify({ a: true, b: false, c: 1, d: 'true' })), { a: true })
})

test('合并：新会话追加，同 id 更新取新，旧版本跳过', () => {
  const incoming = [
    makeSession({ id: 'new', count: 2, updatedAt: 200 }),
    makeSession({ id: 'bump', count: 3, updatedAt: 200, tail: 'newer' }),
    makeSession({ id: 'stale', count: 2, updatedAt: 50 }),
  ]
  const existing = [
    makeSession({ id: 'bump', count: 3, updatedAt: 100, tail: 'older' }),
    makeSession({ id: 'stale', count: 2, updatedAt: 900 }),
  ]
  const plan = planMerge({ existing, incoming, ledger: {} })

  assert.deepEqual(plan.added, ['new'])
  assert.deepEqual(plan.updated, ['bump'])
  assert.deepEqual(plan.skipped, ['stale'])
  const reasons = new Map(plan.decisions.map((d) => [d.id, d.reason]))
  assert.equal(reasons.get('new'), 'new')
  assert.equal(reasons.get('bump'), 'newer')
  assert.equal(reasons.get('stale'), 'local-newer')
})

test('合并：同一份载荷重复导入是幂等的（第二遍全跳过）', () => {
  const incoming = [makeSession({ id: 's1', count: 2, updatedAt: 100 })]
  const first = planMerge({ existing: [], incoming, ledger: {} })
  assert.equal(first.added.length, 1)

  // 第一遍写完后，existing 里就是这份内容，台账也记上了指纹。
  const second = planMerge({ existing: incoming, incoming, ledger: first.ledger })
  assert.equal(second.added.length, 0)
  assert.equal(second.updated.length, 0)
  assert.equal(second.skipped.length, 1)
  assert.equal(second.decisions[0].reason, 'already-imported')
})

test('合并：台账命中优先于「更新」，不会把已导入的旧数据又写一遍', () => {
  const incoming = [makeSession({ id: 's1', count: 2, updatedAt: 500 })]
  const existing = [makeSession({ id: 's1', count: 2, updatedAt: 100 })]
  // 即使载荷看起来更新，只要指纹在台账里，就认为这份内容导过了。
  const plan = planMerge({ existing, incoming, ledger: { [sessionFingerprint(incoming[0])]: true } })
  assert.equal(plan.updated.length, 0)
  assert.equal(plan.skipped.length, 1)
  assert.equal(plan.decisions[0].reason, 'already-imported')
})

test('合并：载荷内重复 id 只取第一条，第二条记为 duplicate-in-payload', () => {
  const incoming = [
    makeSession({ id: 'dup', count: 2, updatedAt: 100 }),
    makeSession({ id: 'dup', count: 2, updatedAt: 999 }),
  ]
  const plan = planMerge({ existing: [], incoming, ledger: {} })
  assert.deepEqual(plan.added, ['dup'], '只应新增一次')
  assert.deepEqual(plan.updated, [])
  assert.deepEqual(
    plan.decisions.map((d) => d.reason),
    ['new', 'duplicate-in-payload'],
  )
})

test('合并：没有 id 的条目被拒绝而不是静默塞进库', () => {
  const plan = planMerge({ existing: [], incoming: [{ title: 'no id', messages: [] }], ledger: {} })
  assert.equal(plan.added.length, 0)
  assert.equal(plan.decisions[0].reason, 'missing-id')
})

test('并集写入：保留未涉及的会话，且不重复 staging', () => {
  const incoming = [makeSession({ id: 's2', count: 1, updatedAt: 200 })]
  const existingFull = [makeSession({ id: 's1', count: 3, updatedAt: 100 })]
  const plan = planMerge({ existing: existingFull, incoming, ledger: {} })
  const union = buildUnion({ incoming, existingFull, plan })

  // s2 是新的、s1 必须原样保留：导入绝不能整库替换。
  assert.deepEqual(union.staged.map((s) => s.id).sort(), ['s1', 's2'])
  const ids = union.staged.map((s) => s.id)
  assert.equal(new Set(ids).size, ids.length, 'staging 里不能有重复 id（IndexedDB add 会抛错）')
})

test('并集写入：更新一个会话时，该会话的旧副本不重复出现', () => {
  const incoming = [makeSession({ id: 's1', count: 3, updatedAt: 200, tail: 'v2' })]
  const existingFull = [makeSession({ id: 's1', count: 3, updatedAt: 100, tail: 'v1' })]
  const plan = planMerge({ existing: existingFull, incoming, ledger: {} })
  assert.equal(plan.updated.length, 1)

  const union = buildUnion({ incoming, existingFull, plan })
  assert.equal(union.staged.length, 1)
  assert.equal(union.staged[0].messages.at(-1).content, 'v2')
})

test('并集写入：附件 id 去重，未带回的 blob 由调用方按 id 补读', () => {
  const incoming = [makeSession({ id: 's1', count: 2, updatedAt: 200, fileIds: ['f1'] })]
  const existingFull = [makeSession({ id: 's2', count: 2, updatedAt: 100, fileIds: ['f1', 'f2'] })]
  const plan = planMerge({ existing: existingFull, incoming, ledger: {} })
  const union = buildUnion({ incoming, existingFull, plan })

  const ids = [...union.stagedFileIds]
  assert.equal(new Set(ids).size, ids.length)
  assert.ok(ids.includes('f1') && ids.includes('f2'))
  assert.deepEqual([...collectFileIds(existingFull[0])].sort(), ['f1', 'f2'])
})

test('汇总：计数与失败项一一对应，errors 可展示', () => {
  const incoming = [makeSession({ id: 's1', count: 1, updatedAt: 100 })]
  const plan = planMerge({ existing: [], incoming, ledger: {} })
  const summary = summarize(plan, [{ id: 'bad', error: 'boom' }])
  assert.equal(summary.added, 1)
  assert.equal(summary.failed, 1)
  assert.equal(summary.errors[0].error, 'boom')
})

test('消息计数：缺 messages 视为 0，不抛错', () => {
  assert.equal(messageCount({}), 0)
  assert.equal(messageCount({ messages: null }), 0)
  assert.equal(messageCount(makeSession({ id: 'x', count: 4, updatedAt: 1 })), 4)
})

test('归一化：ZIP blob 认成 archive', () => {
  const blob = new Blob([new Uint8Array([0x50, 0x4b, 3, 4])], { type: 'application/zip' })
  const result = classifyPayload(blob)
  assert.equal(result.kind, PAYLOAD_KIND.archive)
  assert.equal(result.file, blob)
})

test('归一化：会话数组认成 sessions，脏元素被过滤', () => {
  const result = classifyPayload({ sessions: [makeSession({ id: 's1', count: 1, updatedAt: 1 }), null, 42] })
  assert.equal(result.kind, PAYLOAD_KIND.sessions)
  assert.equal(result.sessions.length, 1)
})

test('归一化：空数组不算有效载荷（不能假装导入成功）', () => {
  assert.equal(classifyPayload({ sessions: [] }), null)
})

test('归一化：JSON 文本里的会话对象能被解包', () => {
  const session = makeSession({ id: 's1', count: 1, updatedAt: 1 })
  const result = classifyPayload({ text: JSON.stringify(session) })
  assert.equal(result.kind, PAYLOAD_KIND.sessions)
  assert.equal(result.sessions[0].id, 's1')
})

test('归一化：无法识别时返回 null，由调用方报错而不是静默通过', () => {
  assert.equal(classifyPayload({ text: 'not json at all {' }), null)
  assert.equal(classifyPayload({ firmware: 1 }), null)
  assert.equal(unwrapJson(''), null)
})
