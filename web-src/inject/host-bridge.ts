/**
 * 宿主桥 —— src/host-bridge.ts
 *
 * 本插件新增的**唯一**导入入口（即允许的第三处上游改动）。它只做三件事，
 * 全部落在应用外壳上，不碰任何上游业务逻辑：
 *
 *   1. Key 哨兵：真正的 API Key 由宿主在服务端注入（见 index.js 的代理路由），
 *      浏览器里永远不该有 Key。但上游的 ensureApiKey() 只看「本地是否存过 Key」，
 *      没有就让用户去设置里填 —— 这在宿主模式下是死路。所以这里塞一个
 *      **非机密**的占位字符串，让 ensureApiKey() 放行；它会被当作 x-api-key 发到
 *      同源代理，而代理会用宿主 Key 覆盖掉它。占位符不是密钥，泄漏也无意义。
 *      反过来，宿主没配 Key 时**不静默**：面板会下发 host-status，这里挂一条常驻横幅。
 *
 *   2. 导入入口：window.__CHAT_DEMO_IMPORT__(payload)。备份 → 归一化 → 合并 → 原子提交 → 报数。
 *      语义与上游「导入备份」不同：上游是整体替换，这里是叠加。
 *
 *   3. 与面板的 postMessage 通道：面板把用户选中的 ZIP / 粘贴的 JSON 送进来，
 *      把 {added, updated, skipped, failed} 送回去。
 */

import { showToast } from './components/base/toastState.js'
import { exportHistory } from './services/chat/backup.js'
import * as db from './services/chat/db.js'
import { readSessionFile } from './services/chat/history/schema.js'
import { toLocalSession } from './services/chat/history/toLocal.js'
import { replaceHistory } from './services/chat/store.js'
import type { Session } from './services/chat/types.js'
import { useSettings } from './services/settings.js'
import { readArchiveContents } from './sync/archive.js'
import {
  buildUnion,
  parseLedger,
  planMerge,
  sessionFingerprint,
  summarize,
  type MergePlan,
} from './sync/merge.js'
import { classifyPayload, toArchiveFile, type ClassifiedPayload } from './sync/normalize.js'

/** 非机密占位符。不是密钥，不来自任何凭据来源，仅用于让上游的 Key 检查放行。 */
const SENTINEL = 'dsh-host-proxy'

/** 幂等台账：只存「指纹 → true」，不含标题、内容或任何凭据。 */
const LEDGER_KEY = 'chat-demo:import-ledger'

/**
 * 台账上限。超限时只保留本次导入的指纹。
 * 这不是正确性问题：台账只是**第一层**去重，第二层是 updatedAt 比较，
 * 台账丢条目最多让下次导入多比一次时间，绝不会重复追加或回退内容。
 */
const LEDGER_LIMIT = 5000

/** 面板 → iframe */
const IMPORT_MESSAGE = 'chat-demo:import'
const HOST_STATUS_MESSAGE = 'chat-demo:host-status'
const THEME_MESSAGE = 'chat-demo:theme'
/** iframe → 面板 */
const RESULT_MESSAGE = 'chat-demo:import-result'
const READY_MESSAGE = 'chat-demo:bridge-ready'
const STATUS_REQUEST_MESSAGE = 'chat-demo:host-status-request'

/** 宿主 Key 状态：ok 表示代理能注入 Key，missing 表示四条来源都取不到 */
export type HostKeyStatus = 'ok' | 'missing'

export type ImportResult = {
  added: number
  updated: number
  skipped: number
  failed: number
  errors: string[]
  /** 导入前自动备份的文件名；浏览器无法静默落盘，这是一次下载 */
  backup: string
  /** 载荷来源：zip / json / extension */
  source: string
}

declare global {
  interface Window {
    __CHAT_DEMO_IMPORT__?: (payload: unknown) => Promise<ImportResult>
  }
}

const errorMessage = (error: unknown): string =>
  error instanceof Error && error.message !== '' ? error.message : String(error)

/** 从任意未校验对象里尽量取出会话 id，只用于把失败原因写得具体一点。 */
const sessionIdOf = (value: unknown): string =>
  typeof value === 'object' && value !== null && typeof (value as { id?: unknown }).id === 'string'
    ? (value as { id: string }).id
    : ''

/** 触发一次浏览器下载。iframe 带 allow-downloads，单次下载不需要额外用户激活。 */
const download = (name: string, blob: Blob) => {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.rel = 'noopener'
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  // 立刻 revoke 会让部分浏览器中断下载；延时释放，避免留下泄漏的 Blob URL。
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

/** `chat-demo-backup-20261118-173000.zip`：与上游导出同名会让用户分不清哪份是退路。 */
const backupName = () => {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `chat-demo-backup-${stamp}.zip`
}

/**
 * 补齐附件 MIME。
 *
 * 上游导入靠 db.updateStagingFileTypes 回填，但那个函数对映射里没有的附件会把
 * mimeType 直接改成 ''（见 db.ts L190-192）——合并场景下暂存里还有本机原有会话，
 * 用它会把这些附件的 MIME 擦掉。所以这里在内存里只补空值：有原件就用原件 type，
 * 没有就保持原样。图片身份由 isImage 决定，不由此处的 sniff 结果决定。
 */
const fillMimeTypes = (session: Session, blobs: ReadonlyMap<string, Blob>): Session => ({
  ...session,
  messages: session.messages.map((message) => {
    if (message.role !== 'user' || message.files.length === 0) {
      return message
    }
    return {
      ...message,
      files: message.files.map((file) => {
        if (file.mimeType !== '') {
          return file
        }
        const type = blobs.get(file.id)?.type ?? ''
        return type === '' ? file : { ...file, mimeType: type }
      }),
    }
  }),
})

/** 归档载荷 → File（上游 readArchive 只接受 File，用它取 size 与切片） */
const archiveFile = (archive: Extract<ClassifiedPayload, { kind: 'archive' }>): File => {
  const value = toArchiveFile(archive)
  return value instanceof File
    ? value
    : new File([value], archive.name, { type: 'application/zip' })
}

export const installHostBridge = () => {
  if (window.__CHAT_DEMO_IMPORT__ !== undefined) {
    return
  }

  const text = (zh: string, en: string) => (useSettings.getState().locale === 'en-US' ? en : zh)

  /** 串行化：一次只允许一个导入，避免两个原子替换事务交错。 */
  let importing = false

  const readLedger = (): Record<string, true> => {
    try {
      return parseLedger(localStorage.getItem(LEDGER_KEY))
    } catch {
      // 存储不可用（隐私模式）：退化成「不用台账」，updatedAt 比较仍然兜底。
      return {}
    }
  }

  const writeLedger = (plan: MergePlan, incoming: readonly Session[]) => {
    const keys = Object.keys(plan.ledger)
    const value: Record<string, true> =
      keys.length > LEDGER_LIMIT
        ? Object.fromEntries(incoming.map((session) => [sessionFingerprint(session), true as const]))
        : plan.ledger
    try {
      localStorage.setItem(LEDGER_KEY, JSON.stringify(value))
    } catch {
      // 配额不足：放弃台账即可，「重复导入不重复追加」还有 updatedAt 这一层保护。
    }
  }

  /**
   * 导入前自动备份。
   *
   * 浏览器无法静默落盘，只能触发下载。备份失败就让整个导入抛错 —— 没有退路就不动数据。
   * 注意：下载被浏览器策略拦下时我们**无法感知**，所以返回结果里如实带上备份文件名，
   * 面板据此提示「若未看到备份文件请先允许下载再重试」，而不是假装备份成功。
   */
  const backupBeforeImport = async (): Promise<string> => {
    const { blob } = await exportHistory()
    const name = backupName()
    download(name, blob)
    return name
  }

  const merge = async (payload: unknown): Promise<ImportResult> => {
    if (importing) {
      throw new Error(text('已有一次历史导入正在进行中，请稍候。', 'An import is already running.'))
    }
    importing = true
    try {
      const classified = classifyPayload(payload)
      if (classified === null) {
        throw new Error(
          text(
            '无法识别的导入载荷：请选择 deepseek_data-*.zip，或粘贴 chat_sessions/*.json 的内容。',
            'Unrecognized payload: pick a deepseek_data-*.zip or paste the contents of chat_sessions/*.json.'
          )
        )
      }

      // 1) 先备份。备份失败直接抛出，后面一行都不会执行。
      const backup = await backupBeforeImport()

      // 2) 归一化：归档走完整 ZIP 解析，粘贴内容逐条走上游 schema 校验。
      const failed: string[] = []
      const incoming: Session[] = []
      const archived = new Map<string, Blob>()
      if (classified.kind === 'archive') {
        const contents = await readArchiveContents(archiveFile(classified))
        incoming.push(...contents.sessions)
        for (const [id, blob] of contents.files) {
          archived.set(id, blob)
        }
      } else {
        for (const item of classified.sessions) {
          try {
            // 校验口径与官方备份完全一致，避免出现第二套宽容度不同的解析器。
            incoming.push(toLocalSession(readSessionFile(item)).session)
          } catch (error) {
            failed.push(`${sessionIdOf(item) || '?'}: ${errorMessage(error)}`)
          }
        }
        if (incoming.length === 0 && failed.length > 0) {
          throw new Error(
            text(
              '载荷里的会话全部校验失败，未改动本地数据。',
              'Every session failed validation; local data untouched.'
            )
          )
        }
        if (incoming.length === 0) {
          throw new Error(text('载荷里没有可识别的会话。', 'The payload contains no recognizable session.'))
        }
      }

      // 3) 读本机现状：列表用于比时间，详情用于算并集。
      const summaries = await db.loadSessionSummaries()
      const existingFull: Session[] = []
      for (const summary of summaries) {
        const session = await db.loadSession(summary.id)
        if (session !== undefined) {
          existingFull.push(session)
        }
      }

      // 4) 合并决策 + 并集。都不落库，先算清楚再写。
      const plan = planMerge({ existing: summaries, incoming, ledger: readLedger() })
      const union = buildUnion({ incoming, existingFull, plan })

      // 5) 原件：归档带来的优先，否则从本机原有附件里取（并集保留本机会话，其原件必须一起搬）。
      const blobs = new Map<string, Blob>()
      for (const id of union.stagedFileIds) {
        const fromArchive = archived.get(id)
        if (fromArchive !== undefined) {
          blobs.set(id, fromArchive)
          continue
        }
        const existing = await db.loadFile(id)
        if (existing !== undefined) {
          blobs.set(id, existing)
        }
      }

      // 6) 只在确有增改时才动库。commitStaging 的「清空 → 搬入」是原子的，
      //    暂存里装的是并集，所以合并与原子性同时成立。
      if (plan.added.length > 0 || plan.updated.length > 0) {
        const staged = union.staged.map((session) => fillMimeTypes(session, blobs))
        const stored = [...blobs].map(([id, blob]) => ({ id, blob }))
        await replaceHistory(async () => {
          for (const session of staged) {
            // add() 遇重复 id 会抛错；并集里 id 已去重，这里抛错就是 bug，不能吞。
            await db.addStagingSession(session)
          }
          if (stored.length > 0) {
            await db.saveStagingFiles(stored)
          }
        })
      }

      // 7) 提交成功后才记台账：失败时不留下「已导入」的假记录。
      writeLedger(plan, incoming)

      return { ...summarize(plan, failed), backup, source: classified.source }
    } finally {
      importing = false
    }
  }

  // ── 宿主 Key 状态横幅 ─────────────────────────────────────────────────────

  /**
   * 常驻横幅，只在宿主没配 Key 时出现。
   *
   * 为什么不用 showToast：Toast 3 秒就消失，而「没有 Key」是一个持续状态。
   * 四条来源都取不到时，界面必须显示「宿主未配置可用 Key」，不允许静默失败；
   * 而全屏面板会盖住宿主自己的提示条，所以这个提示必须落在 iframe 自己身上。
   */
  let banner: HTMLElement | null = null
  let keyStatus: HostKeyStatus | null = null

  const removeBanner = () => {
    banner?.remove()
    banner = null
  }

  const showMissingKeyBanner = () => {
    if (banner !== null) {
      return
    }
    const element = document.createElement('div')
    element.setAttribute('role', 'alert')
    element.dataset.dshChatDemo = 'missing-key'
    element.textContent = text(
      '宿主未配置可用 Key：请在 DSH 侧配置 DEEPSEEK_API_KEY 后重试。此处填写的 Key 不会生效。',
      'No usable key on the host: configure DEEPSEEK_API_KEY in DSH and retry. A key typed here has no effect.'
    )
    // 内联样式：不注入任何全局样式表，卸载时随节点一起消失。
    Object.assign(element.style, {
      position: 'fixed',
      left: '50%',
      bottom: '16px',
      transform: 'translateX(-50%)',
      maxWidth: 'min(560px, calc(100vw - 32px))',
      padding: '10px 16px',
      borderRadius: '10px',
      background: '#8a2c2c',
      color: '#fff',
      font: '13px/1.5 system-ui, sans-serif',
      boxShadow: '0 6px 24px rgba(0, 0, 0, .28)',
      zIndex: '2147483647',
    })
    document.body.append(element)
    banner = element
  }

  const setKeyStatus = (status: HostKeyStatus) => {
    if (status === keyStatus) {
      return
    }
    keyStatus = status
    if (status === 'missing') {
      showMissingKeyBanner()
      return
    }
    removeBanner()
    showToast(
      text(
        'API Key 由 DSH 宿主注入，无需在此填写。',
        'The API Key is injected by the DSH host; no need to enter one here.'
      )
    )
  }

  // ── 面板消息 ──────────────────────────────────────────────────────────────

  const reply = (requestId: string, body: Record<string, unknown>) => {
    window.parent.postMessage({ type: RESULT_MESSAGE, requestId, ...body }, window.location.origin)
  }

  const onMessage = (event: MessageEvent) => {
    // 同源 iframe：只认父窗口发来的、同源的消息。载荷本身来自用户选择，这里挡的是串扰。
    if (event.source !== window.parent || event.origin !== window.location.origin) {
      return
    }
    const data: unknown = event.data
    if (typeof data !== 'object' || data === null) {
      return
    }
    const message = data as { type?: unknown; requestId?: unknown; payload?: unknown; key?: unknown }
    if (message.type === HOST_STATUS_MESSAGE) {
      setKeyStatus(message.key === 'ok' ? 'ok' : 'missing')
      return
    }
    if (message.type === THEME_MESSAGE) {
      // 主题本身由 theme.ts 的补丁消费；这里不重复处理，只避免被当成未知消息告警。
      return
    }
    if (message.type !== IMPORT_MESSAGE) {
      return
    }
    const requestId = typeof message.requestId === 'string' ? message.requestId : ''
    void merge(message.payload).then(
      (result) => reply(requestId, { ok: true, result }),
      (error: unknown) => {
        const reason = errorMessage(error)
        showToast(text(`导入失败：${reason}`, `Import failed: ${reason}`))
        reply(requestId, { ok: false, error: reason })
      }
    )
  }

  window.__CHAT_DEMO_IMPORT__ = merge
  window.addEventListener('message', onMessage)

  // Key 哨兵。只在本地没有值时补，绝不覆盖用户自己填过的值，也**不写 localStorage**：
  // 刷新时本函数会再跑一次，哨兵不需要持久化。
  if (!useSettings.getState().apiKey) {
    useSettings.setState({ apiKey: SENTINEL })
  }

  if (window.parent !== window) {
    window.parent.postMessage({ type: READY_MESSAGE }, window.location.origin)
    // 主动问一次宿主 Key 状态：面板可能在我们挂载前就发过广播，单靠被动监听会漏。
    window.parent.postMessage({ type: STATUS_REQUEST_MESSAGE }, window.location.origin)
    // 首屏挂载后再提示一次主题，避免上游 setupTheme 先按系统色渲染一帧。
    window.addEventListener('load', () => {
      window.parent.postMessage({ type: READY_MESSAGE }, window.location.origin)
    })
  }
}
