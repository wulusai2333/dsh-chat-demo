# 历史同步可行性评估

> 先有可行性结论，再有 `sync/` 下的代码。
> 结论写在最前面，证据与未验证项在后。

---

## 0. 结论（决定实现范围）

| 层级 | 做法 | 结论 | 理由 |
|---|---|---|---|
| **L1** | 用户在 `chat.deepseek.com` 用官方「导出所有历史对话」拿到 `deepseek_data-*.zip`，在面板里选中该文件 | **可实现，作为主路径** | 归档格式有权威定义（见 §1），解析全在本地完成，零网络请求 |
| **L2** | MV3 扩展在用户登录态下抓取会话，POST 到宿主 `/import` | **只交付源码骨架，标注「未验证」，默认不可用** | 关键阻塞是 PoW 反爬挑战（见 §3），绕过它属于本项目明令禁止的行为 |
| **L3** | 用户手工粘贴 JSON / 选择本地文件 | **可实现，作为兜底** | 与 L1 共用同一导入通道，只是载荷来源不同 |

因此本插件的同步功能 **默认只走 L1 与 L3**，L2 的 UI 上明确显示「未验证」，不做静默降级。

---

## 1. L1：官方导出入口与格式（已确认）

### 1.1 入口

`chat.deepseek.com` 登录后：**点击头像 → 设置 → 数据管理 → 导出所有历史对话**。

依据：DeepSeek 官方隐私政策「2.2 查阅、复制、导出、更正、补充、删除您的个人信息」第 d 项原文即为该路径；Web 端补充说明「数据包含账号信息和全部聊天记录，导出需要等待一段时间，生成后的下载链接有效 7 天」。

要点：

- 导出是**异步生成 + 下载链接**，不是即时下载；链接 7 天后失效。
- 产物包含**账号信息**（脱敏），不只是会话。所以归档里存在 `user.json`，导入时必须跳过（见 §1.3）。
- App 端没有该入口，只能在 Web 端操作。

### 1.2 导出格式（`export_format_version: 3`）

格式权威定义在上游源码 `src/services/chat/history/format.ts`，语义说明在 `src/services/chat/history/README.md`。ZIP 条目顺序：

```
manifest.json                                              {"export_format_version": 3}，必须是首个条目
user.json                                                  账号信息，可能缺失；导入时跳过
chat_sessions/{session_id}.json                            每个会话一份，含完整消息树
chat_session_index.json                                    [{id,title,pinned,message_count,inserted_at,updated_at}]
chat_sessions/{session_id}_files/{file_id}_{file_name}     图片原件（其余附件只有元数据）
```

`chat_sessions/{id}.json`：

```jsonc
{
  "id": "...", "title": null, "pinned": false,
  "current_message_id": 42,          // 用户当前停留的消息，线性化消息树的唯一依据
  "inserted_at": "2026-11-11T02:33:23.270Z",
  "updated_at":  "2026-11-11T02:34:01.000Z",
  "messages": [                       // 消息树，分支靠 parent_id
    { "id": 1, "parent_id": null, "role": "USER", "status": "FINISHED",
      "thinking_enabled": true, "search_enabled": false,
      "accumulated_token_usage": 0, "inserted_at": "...",
      "fragments": [{ "type": "REQUEST", "content": "..." }] }
  ]
}
```

- 时间一律 UTC RFC 3339、`Z` 结尾，小数秒位数不固定。
- `status` ∈ `WIP | FINISHED | CONTENT_FILTER | FAILED | INCOMPLETE | CONTEXT_LENGTH_EXCEEDED | TIMEOUT`。
- 片段类型 13 种：`REQUEST / RESPONSE / THINK / TEMPLATE_RESPONSE / TIP / CONTENT_RISK / PARTIAL_FILE_READ / TOOL_SEARCH / TOOL_OPEN / TOOL_FIND / READ_LINK / FILE / TOOL_IMAGE_SEARCH`。
- ZIP 仅支持单卷 ZIP32 的 STORE / DEFLATE；ZIP64、加密、分卷、非 UTF-8 的非 ASCII 名不支持；条目名按 NFC 比较。

### 1.3 与本地模型的映射

上游 `history/toLocal.ts` 已完成映射，本插件**直接复用**，不重写：

- 消息树按 `id` / `parent_id` 还原；父 id 必须小于子 id、角色交替、根为提问。
- `current_message_id` 决定当前分支；其他节点默认选中 id 最大的子分支。
- `FINISHED`→已完成，`INCOMPLETE`/`WIP`→已停止，`FAILED`/`CONTEXT_LENGTH_EXCEEDED`/`TIMEOUT`→错误，`CONTENT_FILTER`→拒绝。
- 导入的回复统一 `prefix: false` —— **不能续写**。这是格式的既有限制，UI 必须如实体现，不能假装能继续。
- `TIP` / `CONTENT_RISK` / `PARTIAL_FILE_READ` / `TOOL_IMAGE_SEARCH` 无对应展示，直接丢弃。
- 只有图片原件在归档里；非图片附件保留文件名与大小，不进入请求。

### 1.4 上游导入是「整体替换」，这是必须绕开的坑

`services/chat/backup.ts`：

```ts
export const importHistory = (file: File): Promise<number> =>
  enqueueBackup(async () => {
    const { checkArchiveFormat, importArchive } = await import('./history/importArchive.js')
    await checkArchiveFormat(file)
    return replaceHistory(() => importArchive(file))
  })
```

`replaceHistory(write)` 的语义是：中止流式回答 → 等删除任务 → 递增 `historyEpoch` → 清空暂存 → `write()` → `commitStaging()`；`commitStaging()` 先 `clear()` 正式表再搬入暂存。**即：直接用上游入口会抹掉本机已有会话。**

桌面端「导入备份」的语义是「恢复成备份时的样子」，覆盖是对的；本插件的目标是「把网页版的会话合并进来」，
覆盖等于数据丢失。因此必须实现 merge。

**合并而不破坏原子性的做法**：`commitStaging()` 的「清空 → 搬入」本身是原子的，只要**让暂存里装的是并集**即可同时得到合并与原子性：

1. 读现有正式表的会话（`loadSessionSummaries` + `loadSession`）与它们引用的附件原件（`loadFile`）；
2. 在内存里算并集：同 id 且导入的 `updated_at` 更新 → 用导入的；否则留本机；新 id 追加；
3. 调 `replaceHistory(async () => { 把并集逐条 addStagingSession / saveStagingFiles })`；
4. `commitStaging()` 一次性换库，事务失败则正式数据原封不动。

这样**不需要新增任何 db 函数**，只用上游公开的 `addStagingSession` / `saveStagingFiles` / `loadFile` / `loadSession` / `loadSessionSummaries` / `replaceHistory`。附件 MIME 也不需要 `updateStagingFileTypes`（它会把不在映射里的附件清空成 `''`）——直接沿用原件 Blob 自带的 `type`。

> 本插件只允许三处上游改动（`rspack.config.ts` 的 apiOrigin、新增 `?theme=` 读取、新增一个导入入口）。
> 上面的做法把 db 层改动降为 0，是达成该约束的关键。

---

## 2. 会话列表 / 消息接口（未能实测）

理想做法是在浏览器 DevTools 里观察用户手动翻页时产生的**真实**路径。
**本次没有可用的登录态浏览器会话**，无法观察，因此这一条**没有实测结论**。

根据公开资料的既有认知（未在本环境验证，不作为实现依据）：

- 列表分页大致为 `POST https://chat.deepseek.com/api/v0/chat_session/fetch_page`（游标式），历史消息为 `GET /api/v0/chat/history_messages?chat_session_id=...`。
- 接口普遍需要 `x-ds-pow-response`（SHA256 工作量证明）等由页面脚本现场计算的请求头，以及登录 Cookie。

**这些路径不会被写进任何代码。** L2 骨架里只有 `fetch` 的位置和注释，没有硬编码路径；需要后续有人在真实环境抓包后用实测值填充（README 的「下次升级需要复测的清单」里列了这一项）。

---

## 3. 反爬、限流与 Cookie 有效期

| 项目 | 结论 | 依据 |
|---|---|---|
| Cloudflare / 设备校验 | **未能实测** | 无登录态会话 |
| 工作量证明挑战 | **存在**（`x-ds-pow-response`，需先取 challenge 再本地算 SHA256） | 公开资料；与 §2 同样是未实测项 |
| 频率限制 | **未能实测** | 同上 |
| Cookie 有效期 | **未能实测** | 同上 |

关键判断：**PoW 挑战的存在与否，直接决定 L2 是否可做。** 实现 PoW 求解器 = 绕过站点的反自动化措施，
属于本项目明令禁止的「绕过验证码/风控」。所以：

- L2 **不做**自行求解任何挑战；扩展只在页面自身已授权的上下文里发请求（`host_permissions` 仅 `https://chat.deepseek.com/*`）。
- 如果实测发现所有接口都强制 PoW，L2 的唯一合规出路是「由用户手动在页面上点一次、扩展只读结果」，那就等价于 L3，应当**在文档里直接判 L2 出局**，而不是继续维护骨架。
- L2 限速固定 ≤ 1 req/s（串行 + 间隔），这是硬编码在扩展里的，不提供开关。

---

## 4. 三种方案的实际成功率与失败表现

| 层级 | 预期成功率 | 失败时的表现 | 用户看到什么 |
|---|---|---|---|
| L1 | 高（唯一网络环节是用户在浏览器里下载 ZIP） | ZIP 结构坏 / 版本不是 3 → 整批拒绝，本地数据不变 | 「归档格式无法识别，本地会话未改动」 |
| L2 | 未知（阻塞在 PoW + 未实测的接口） | 扩展抓取失败 / 401 / 429 → 不发送任何载荷 | 「一键抓取（未验证）：当前环境不可用，请改用官方导出」 |
| L3 | 高（只要 JSON 可解析） | JSON 不合法 → 整批拒绝；单条会话字段不合法 → 该条计入 `failed` | 「已合并：新增 3、更新 1、跳过 2、失败 1」 |

三条路径最终都落到同一个前端入口 `window.__CHAT_DEMO_IMPORT__(data)`，所以「哪一层」只影响载荷来源，不影响导入语义（自动备份 → 归一化 → 合并 → 台账 → 原子提交 → 报数）。

---

## 5. 导入通道（执行位置）

IndexedDB 属于浏览器 origin（`http://127.0.0.1:<port>`），宿主进程**写不进去**。所以：

```
扩展 / 书签  ──POST /plugins/dsh-chat-demo/import（X-Import-Token，仅 127.0.0.1）──▶ Host
                                                                                    │ 内存暂存（不落盘，5 分钟过期）
                                                                                    ▼
面板（client.js）──GET /plugins/dsh-chat-demo/import/pending（打开面板时取一次）─────── Host
   │ iframe.contentWindow.postMessage({type:'chat-demo:import', requestId, payload})
   ▼
chat-demo iframe ──window.__CHAT_DEMO_IMPORT__(payload)──▶ 备份 → 归一化 → 合并 → 提交
   │ postMessage({type:'chat-demo:import-result', requestId, result})
   ▼
面板显示 {added, updated, skipped, failed}
```

- **取件是一次性拉取，不是 SSE 推送**：面板打开时 `GET …/import/pending` 取一次，宿主随即把该载荷从内存删掉。少一条长连接要维护，也天然满足「同一份载荷不会被导两次」；扩展投递时面板没开，载荷在内存里等 5 分钟，下次打开面板被取走。
- 一次性令牌由宿主生成，只有同源的面板能取到（`GET /plugins/dsh-chat-demo/import/token`）；**每次成功使用后立刻轮换**（不是定时过期），一条泄漏的 token 最多用一次；宿主重启后内存里的旧 token 全部失效。
- `/import` 只接受来自 `127.0.0.1` / `localhost` 且 `Origin` 为本站的连接，载荷不写磁盘。
- L1（ZIP 文件）与 L3（粘贴 JSON）由面板直接 `postMessage` 进 iframe，不经过宿主暂存，因此也不受 5 分钟 TTL 影响。

---

## 6. 幂等与备份

- **幂等台账**：`localStorage['chat-demo:import-ledger']`，只存 `指纹 → true`，无任何内容、标题或凭据。指纹 = `v1:会话id:消息条数:FNV1a(末条摘要):摘要长度`，末条摘要取 `role|content 长度|blocks 数量[每块 type:长度]`。**不含 updatedAt**——同一份内容被重新导出仍能认出来。命中即 `skipped`，台账保留最近 5000 条。
- **第二层保护**：导入的 `updated_at` 不比本机新 → `skipped`。台账被清掉也不会重复追加或回退内容。
- **导入前自动备份**：先调用上游 `exportHistory()` 生成 ZIP；浏览器环境无法静默落盘，因此触发一次下载（文件名 `chat-demo-backup-<时间戳>.zip`）作为退路。备份失败 → **中止导入**，不在没有退路的情况下动数据。

---

## 7. 合规自检

- [x] 只读用户本人账号数据（L1 的文件来自用户自己的导出）
- [x] 由用户主动触发（选文件 / 粘贴 / 点扩展），无后台轮询
- [x] 限速：L2 扩展串行 ≤ 1 req/s
- [x] 不绕过验证码 / 风控 / 付费墙（PoW 不求解，见 §3）
- [x] 不向任何第三方上传会话（所有解析在本地 iframe 内完成）
- [x] Cookie 不落到插件目录，宿主侧也从不接触 Cookie
- [x] 不上传 API Key：导出归档本身不含 Key，代理路由剥离回显

---

## 8. 未验证项清单（下次必须实测）

1. `chat.deepseek.com` 会话列表 / 消息接口的真实路径、分页方式、必需请求头。
2. PoW 挑战是否强制；若强制，L2 是否应直接删除而非保留骨架。
3. 导出链接 7 天有效期的实现细节（是否需要跨域 Cookie 才能下载）。
4. 大体量账号（数千会话）下 ZIP 解析的内存表现与浏览器上限。
5. `export_format_version` 是否会升级到 4——升级后 `checkManifest` 会整批拒绝，本插件需要同步跟进。
