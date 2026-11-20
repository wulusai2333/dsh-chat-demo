/**
 * 归档 → 内存会话 —— src/sync/archive.ts（本插件新增，随 host-bridge 一起注入）
 *
 * 为什么不直接调上游的 importArchive()：
 * 那个函数把会话直接写进 IndexedDB 的「导入暂存」，而合并需要先拿到档案里的会话，
 * 与本机已有会话比对（见 sync/merge.js），算完并集再写暂存。所以这里做的是
 * 「同样的解析，但不落库」——校验口径完全复用上游（checkManifest / readSessionFile /
 * readSessionIndex / toLocalSession），条目顺序、CRC 校验、index 一致性检查也照搬，
 * 避免出现第二套宽容度不同的解析器。
 *
 * 唯一无法复用的一小段是图片 MIME 嗅探：上游把它写在 importArchive.ts 内部且未导出，
 * 而本插件只允许三处上游改动，不值得为它加第四处，故在此重写（纯函数、无副作用）。
 */

import { BackupError, fail } from '../services/chat/history/errors.js'
import {
  INDEX_PATH,
  MANIFEST_PATH,
  USER_PATH,
  parseSessionPath,
  sessionFilesDir,
} from '../services/chat/history/paths.js'
import { checkManifest, readSessionFile, readSessionIndex } from '../services/chat/history/schema.js'
import { toLocalSession } from '../services/chat/history/toLocal.js'
import {
  ArchiveError,
  isZipFile,
  readArchive,
  readEntry,
  skipEntry,
  type ArchiveEntry,
} from '../services/chat/history/zipReader.js'
import type { Session } from '../services/chat/types.js'

/** 归档解析结果：会话已归一为本地模型，图片原件按附件本地 id 取出 */
export type ArchiveContents = {
  /** 档案里的会话，顺序与归档一致 */
  sessions: Session[]
  /** 附件本地 id → 原始字节；仅包含归档里确实带了的图片，已带 MIME */
  files: Map<string, Blob>
}

/** 从原件字节补充图片 MIME；无法识别时为空字符串，图片身份仍由归档的 is_image 决定。 */
const imageType = (bytes: Uint8Array): string => {
  const startsWith = (...prefix: number[]) => prefix.every((byte, index) => bytes[index] === byte)
  const header = new TextDecoder('ascii').decode(bytes.subarray(0, 12))
  if (startsWith(0xff, 0xd8, 0xff)) {
    return 'image/jpeg'
  }
  if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) {
    return 'image/png'
  }
  if (header.startsWith('GIF87a') || header.startsWith('GIF89a')) {
    return 'image/gif'
  }
  if (header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP') {
    return 'image/webp'
  }
  if (startsWith(0x42, 0x4d)) {
    return 'image/bmp'
  }
  if (startsWith(0x49, 0x49, 0x2a, 0) || startsWith(0x4d, 0x4d, 0, 0x2a)) {
    return 'image/tiff'
  }
  if (header.slice(4, 8) === 'ftyp' && ['avif', 'avis'].includes(header.slice(8, 12))) {
    return 'image/avif'
  }
  return ''
}

const readJson = async (entry: ArchiveEntry): Promise<unknown> => {
  const text = await (await readEntry(entry)).text()
  try {
    return JSON.parse(text)
  } catch {
    return fail('backupInvalidJson')
  }
}

/** 归档条目 `chat_sessions/<id>_files/...` 里的会话 id；其他条目返回 '' */
const sessionOwner = (path: string): string =>
  /^chat_sessions\/([^/]+)_files\//.exec(path)?.[1] ?? ''

/**
 * 流式读一份官方导出归档，把会话与图片留在内存。
 *
 * 与上游 importArchive 的差异仅在于目的地：不调用 db.addStagingSession /
 * db.saveStagingFiles / db.updateStagingFileTypes，而是返回给调用方。任何结构问题
 * 都以 BackupError 抛出，调用方据此整批拒绝（L1 语义），绝不会把半份档案写进用户
 * 的会话库——这正是「上游导入是整体替换」陷阱的解法（见 docs/sync-feasibility.md §1）。
 *
 * @param file - 用户选中的 `deepseek_data-*.zip`，或扩展抓到的同格式字节
 * @returns 归一后的会话与图片原件
 */
export const readArchiveContents = async (file: File): Promise<ArchiveContents> => {
  if (!(await isZipFile(file))) {
    fail('backupUnrecognized')
  }
  const sessions: Session[] = []
  const files = new Map<string, Blob>()
  const imported = new Set<string>()
  /** 归档条目路径 → 附件本地 id；由 toLocalSession 给出，只有它引用的条目才需要读 */
  const images = new Map<string, string>()
  /** 同一张图片可能出现在多个会话目录下，只保存一次 */
  const saved = new Set<string>()
  let manifest = false
  let index: ReturnType<typeof readSessionIndex> | undefined
  let currentSessionId: string | undefined

  const saveImage = async (entry: ArchiveEntry, id: string) => {
    if (saved.has(id)) {
      await skipEntry(entry)
      return
    }
    const data = await readEntry(entry)
    const type = imageType(new Uint8Array(await data.slice(0, 16).arrayBuffer()))
    files.set(id, new Blob([data], { type }))
    saved.add(id)
  }

  try {
    for await (const entry of readArchive(file)) {
      const { path } = entry
      const sessionId = parseSessionPath(path)
      if (!manifest) {
        if (path !== MANIFEST_PATH) {
          fail('backupUnrecognized')
        }
        checkManifest(await readJson(entry))
        manifest = true
      } else if (path === USER_PATH && !index && imported.size === 0) {
        // 账号信息（已脱敏）不导入；文件可能缺失。
        await skipEntry(entry)
      } else if (sessionId !== null && !index) {
        const local = toLocalSession(readSessionFile(await readJson(entry)))
        if (local.session.id !== sessionId || imported.has(sessionId)) {
          fail('backupIncomplete')
        }
        imported.add(sessionId)
        currentSessionId = sessionId
        for (const [imagePath, id] of local.images) {
          images.set(imagePath, id)
        }
        sessions.push(local.session)
      } else if (path === INDEX_PATH && !index) {
        index = readSessionIndex(await readJson(entry))
      } else if (
        index
          ? imported.has(sessionOwner(path))
          : currentSessionId !== undefined && path.startsWith(sessionFilesDir(currentSessionId))
      ) {
        // 没有被引用的条目不保存，引用了但缺失的图片只展示文件名。
        const id = images.get(path)
        await (id === undefined ? skipEntry(entry) : saveImage(entry, id))
      } else {
        fail('backupIncomplete')
      }
    }
  } catch (error) {
    throw error instanceof ArchiveError ? new BackupError('backupIncomplete') : error
  }
  if (!manifest) {
    fail('backupUnrecognized')
  }
  // index 只列出成功读出的会话，与会话文件一一对应。
  const listed = new Set(index?.map((entry) => entry.id))
  if (
    !index ||
    listed.size !== index.length ||
    listed.size !== imported.size ||
    [...imported].some((id) => !listed.has(id))
  ) {
    fail('backupIncomplete')
  }
  return { sessions, files }
}
