/**
 * sync/normalize.js 的类型声明 —— 随注入一起拷进 src/sync/normalize.d.ts
 *
 * 同 sync-merge.d.ts 的理由：normalize.js 是纯 JS（要在 Node 里被测），
 * 而 host-bridge.ts 需要它的返回类型来区分「归档」与「会话 JSON」两条分支。
 */

/** 载荷大类：一份归档（ZIP 字节），或已经解析好的会话 JSON */
export type PayloadKind = 'archive' | 'sessions'

/** 载荷来源，只用于向用户说明数据从哪条路进来 */
export type PayloadSource = 'zip' | 'json' | 'extension'

export type ArchivePayload = {
  kind: 'archive'
  source: PayloadSource
  /** 展示用文件名；无扩展名的原始 Blob 走默认值 archive.zip */
  name: string
  /** 直接透传的 File/Blob；与 base64 二选一 */
  file?: Blob
  /** 粘贴或扩展传来的 base64 归档；与 file 二选一 */
  base64?: string
}

export type SessionsPayload = {
  kind: 'sessions'
  source: PayloadSource
  /** 未校验的会话对象，交由上游 readSessionFile 逐条校验 */
  sessions: unknown[]
}

export type ClassifiedPayload = ArchivePayload | SessionsPayload

export declare const PAYLOAD_KIND: { readonly archive: 'archive'; readonly sessions: 'sessions' }

export declare const PAYLOAD_SOURCE: {
  readonly zip: 'zip'
  readonly json: 'json'
  readonly extension: 'extension'
}

export declare const isBlobLike: (value: unknown) => value is Blob

export declare const classifyPayload: (payload: unknown) => ClassifiedPayload | null

export declare const unwrapJson: (text: string) => ClassifiedPayload | null

export declare const decodeBase64: (base64: string) => Uint8Array

export declare const toArchiveFile: (archive: ArchivePayload) => Blob
