/**
 * sync/merge.js 的类型声明 —— 随注入一起拷进 src/sync/merge.d.ts
 *
 * 为什么需要它：上游 tsconfig 是 `strict` + `noImplicitAny`，而 merge.js 是刻意的纯 JS
 * （要在 Node 里被 tests/ 直接跑，不经编译）。没有声明文件的话，host-bridge.ts 里
 * `import { planMerge } from './sync/merge.js'` 会直接 TS7016 报错。
 *
 * rspack 的 extensionAlias 是 ['.ts', '.tsx', '.js']，`merge.d.ts` 不在其中，
 * 所以打包仍然取 merge.js —— 声明文件只服务类型检查，不参与产物。
 */

import type { Session } from '../services/chat/types.js'

export declare const FINGERPRINT_VERSION: number

export type MergeReason =
  | 'new'
  | 'newer'
  | 'same-version'
  | 'local-newer'
  | 'already-imported'
  | 'duplicate-in-payload'
  | 'missing-id'

export type MergeDecision = {
  id: string
  action: 'add' | 'update' | 'skip'
  reason: MergeReason
}

export type MergePlan = {
  added: string[]
  updated: string[]
  skipped: string[]
  decisions: MergeDecision[]
  ledger: Record<string, true>
}

export type MergeSummary = {
  added: number
  updated: number
  skipped: number
  failed: number
  errors: string[]
}

export type UnionPlan = {
  staged: Session[]
  stagedFileIds: Set<string>
  kept: number
}

export declare const collectFileIds: (session: Session | undefined) => Set<string>

export declare const messageCount: (session: Session | undefined) => number

export declare const tailSignature: (session: Session | undefined) => string

export declare const hashString: (text: string) => string

export declare const sessionFingerprint: (session: Session | undefined) => string

export declare const parseLedger: (raw: string | null) => Record<string, true>

export declare const planMerge: (input: {
  existing: readonly Pick<Session, 'id' | 'title' | 'createdAt' | 'updatedAt'>[] | undefined
  incoming: readonly Session[] | undefined
  ledger: Record<string, true> | undefined
}) => MergePlan

export declare const buildUnion: (input: {
  incoming: readonly Session[] | undefined
  existingFull: readonly Session[] | undefined
  plan: MergePlan
}) => UnionPlan

export declare const summarize: (plan: MergePlan, failed?: string[]) => MergeSummary
