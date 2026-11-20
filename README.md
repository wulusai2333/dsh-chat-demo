# dsh-chat-demo

[![CI](https://github.com/wulusai2333/dsh-chat-demo/actions/workflows/ci.yml/badge.svg)](https://github.com/wulusai2333/dsh-chat-demo/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

把开源项目 [`deepseek-ai/chat-demo`](https://github.com/deepseek-ai/chat-demo)
（React 18 + rspack，MIT）作为 **DSH 插件**接入：原生侧栏入口 + 同源全屏面板 +
宿主注入 API Key + 历史对话导入。

不是另起一个站点：装完就在 DSH 里，卸载后不留痕迹。

> **非官方项目。** 与 DeepSeek 官方无任何关联，不代表其立场。
> 仓库内**不含上游源码副本**，只含构建产物 `web/`、补丁表、插件代码与文档；
> 上游许可与署名见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
>
> API Key 需要你自己准备，费用与额度由上游服务决定。

当前版本 **0.1.3**。安装步骤见 [docs/install.md](docs/install.md)；
历史同步的三档方案与其可行性证据见 [docs/sync-feasibility.md](docs/sync-feasibility.md)；
变更史见 [CHANGELOG.md](CHANGELOG.md)。

---

## 目录

- [这是什么 / 不是什么](#这是什么--不是什么)
- [功能](#功能)
- [安装](#安装)
- [入口在哪](#入口在哪)
- [从源码构建](#从源码构建)
- [架构与关键决策](#架构与关键决策)
- [对上游的改动](#对上游的改动)
- [Key 安全模型](#key-安全模型)
- [目录结构](#目录结构)
- [已知限制](#已知限制)
- [升级 DSH 后请复测](#升级-dsh-后请复测)
- [许可](#许可)

---

## 这是什么 / 不是什么

**是**：一个 DSH 插件。装上之后，DSH 侧栏多一个 `chat-demo` 入口，点开是一个全屏面板，
里面是完整的 `chat-demo` 聊天界面。它复用宿主已配好的 API Key（浏览器侧永远拿不到明文），
并且能把 `chat.deepseek.com` 的历史会话**合并**进面板本地的会话库。

**不是**：

- 不是独立应用，没有自己的服务器与端口 —— 路由挂在 DSH 宿主的 Web Server 上。
- 不是 `chat-demo` 的 fork —— 上游固定在一个 commit 上，改动以可重放的补丁形式表达。
- 不是历史会话的「同步器」—— 只有你主动触发的导入，没有后台轮询，也不会删除任何东西。
- 不是 DeepSeek 官方产品。

## 功能

| 需求 | 实现 |
| --- | --- |
| 原生入口，不要假按钮 | `client.js` 注册 `sidebar.panellist`（图标）与 `main`（面板 key），走 DSH 自己的导航 |
| 面板 | 同源 iframe 全屏浮层（顶部让出窗口顶条）；关闭只切 `display:none`，iframe 从不卸载，对话不丢 |
| 退出 | 三条路都通：头部「← 返回」、Esc（父文档与 iframe 内各一份）、宿主原生的「打开/新建会话」 |
| Key 不出宿主 | 前端 `__API_ORIGIN__` 被改成同源 `/plugins/dsh-chat-demo/api`，宿主半边每请求现取 Key 并注入鉴权头 |
| 流式 | 宿主原样逐块下转（`flushHeaders` + `X-Accel-Buffering: no`），不解析、不改写 SSE |
| 中断 | `res.on('close')` 销毁上游请求，Esc 中断不留悬挂连接 |
| 历史导入 | 官方导出 zip / 手工粘贴 / 扩展骨架三档；按会话 id 并集合并，幂等台账，导入前自动备份 |
| 卸载干净 | 全部注册都是 `ctx.effect` 的副作用，卸载即撤销；`body` 滚动锁还原原值 |
| 主题与语言 | 跟随宿主：`?theme=` 下发深浅色；侧栏入口名固定为 `chat-demo`，面板内头部按钮随 DSH 语言切换中英文 |

## 安装

```bash
# 从 GitHub
dsh plugin --profile web add github:wulusai2333/dsh-chat-demo

# 或从本地目录（必须是绝对路径）
dsh plugin --profile web add /absolute/path/to/dsh-chat-demo
```

装完**必须重启 profile** 并硬刷新页面（宿主半边在 Web Server 进程里注册路由，
客户端半边由 client-modules 合并下发）。桌面端的 profile 与 web profile 互相独立，
两边的完整步骤、卸载方式、装完自查清单，以及常见故障的对照表都在
**[docs/install.md](docs/install.md)**。

## 入口在哪

装完重启 profile 并硬刷新之后，入口在 **DSH 左侧栏的全局面板区**：

- **展开侧栏**：「新建会话」下面多一行「对话气泡图标 + `chat-demo`」；
- **收起成窄栏**：只剩那个对话气泡图标，鼠标悬停显示 `chat-demo`；
- **点开**是同源全屏面板（顶部让出窗口标题栏）；**退出**用头部「← 返回」或 `Esc`，
  也可以直接点侧栏里任意会话 / 新建会话。

桌面端与 Web 端入口位置相同。侧栏里找不到时按顺序查：

1. 装完是否**重启了 profile** 并**硬刷新**（`Ctrl+Shift+R`）—— 少一步图标就不会出现；
2. 点面板区的「更多」（应用格子图标），看 `chat-demo` 是不是被取消固定在里面；
3. 仍没有，对照 [docs/install.md](docs/install.md) 的「已知不兼容 / 限制」。

## 从源码构建

`web/` 是入库的构建产物，所以一般**不需要**构建。只有改了补丁表或要跟进上游新版本时才需要：

```bash
node scripts/prepare-web.mjs              # 完整重建
node scripts/prepare-web.mjs --clean      # 删掉上游副本重新 clone
node scripts/prepare-web.mjs --skip-install
node scripts/prepare-web.mjs --upstream /path/to/chat-demo   # 从本地克隆/镜像拉
```

跑测试：

```bash
node --test tests/*.test.mjs     # 46 个用例，零第三方依赖
node tests/smoke.mjs             # 可选：真的打一次上游 /models（需要宿主凭据）
```

构建脚本在产物落盘前做三件自检，任何一条不满足就中断构建：
代理前缀确实进了产物、产物里不含 `sk-` 形式的密钥、`index.html` 用绝对资源前缀。
细节见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 架构与关键决策

两个半边，共享一个前缀 `/plugins/dsh-chat-demo`：

```
index.js    宿主半边：静态托管 + 反向代理 + 导入收件口
client.js   客户端半边：侧栏入口 + 全屏 iframe 浮层 + 三条退出路径
```

**Key 只在宿主进程里。** 上游 chat-demo 把 `__API_ORIGIN__` 编译进产物、并在前端持有 Key。
本插件在构建时把它改成同源代理前缀，于是 iframe 的所有请求都打到宿主，由宿主用
`credentials.resolve()` 现取 Key 注入。浏览器侧拿到的是一个非密文的哨兵值（`dsh-host-proxy`），
只为让上游的 `ensureApiKey()` 不拦截、`streamMessage()` 不把空串当令牌。

**路由前缀是被迫的窄。** client-modules 已经用 `kind:'prefix'` 占了 `/plugins`
来发每个插件的 `client.js`，而它按最长前缀优先匹配。如果这里注册
`/plugins/dsh-chat-demo`，就会把本插件自己的 `client.js` 抢走、变成 404。
所以只注册 `web/` `api/` `import` 三个更窄的路径与几个 `exact` 路径。

**导入必须走「并集」而不是上游的导入函数。** 上游 `importHistory()` 的语义是整体替换
（`commitStaging()` 先清空 5 张表再搬入）。所以这里复用同一条暂存通道，但往暂存里放
`ZIP 里的会话 ∪ 库里已有的会话`，`commitStaging()` 仍是唯一写入点，原子性不变，
且不需要给上游加任何新导出。`commitStaging()` 的「清空 → 搬入」本身是原子的，
只要**让暂存里装的是并集**即可同时得到合并与原子性。

**卸载后不留痕迹。** 所有注册都是 `ctx.effect` 的副作用，卸载即撤销；
`body` 的滚动锁还原成装载前的值，宿主 DOM 不留节点，不覆盖任何宿主 CSS 变量。

## 对上游的改动

**只改三处**，全部写在 `scripts/prepare-web.mjs` 里，形如 `(标记, 锚点, 替换)` 的可执行条目：

1. `rspack.config.ts` 的 `apiOrigin` → 同源代理前缀（并顺手把 `publicPath` 固定成绝对前缀，
   否则 SPA 回退出来的深层 URL 会把资源路径解析到不存在的目录、整页白屏）。
2. `app/theme.ts` 新增 `?theme=` 读取 + `postMessage` 实时同步。
3. `main.tsx` 挂一个导入入口（`src/host-bridge.ts`）。

锚点找不到就**硬失败**，不会静默跳过 —— 否则上游实现变更会被吞掉，产物看起来构建成功、
实际没打上补丁。标记已存在即跳过，所以补丁可重复执行（幂等）。

## Key 安全模型

| 边界 | 规则 |
| --- | --- |
| Key 的取用顺序 | ① 宿主凭据服务（它自己叠加了环境变量与 `.env`）② 面板里一次性输入（仅宿主内存，重启即失效，不落盘） |
| 浏览器侧 | 任何响应、日志、产物里都不出现 Key 明文；构建时自检产物中无 `sk-` 形式字符串 |
| 导入 token | 一次性，每次成功使用后立刻轮换；宿主重启后内存里的旧 token 全部失效 |
| 导入载荷 | 内存里解包，暂存 5 分钟或取走即失效，从不写磁盘 |
| 来源校验 | `/import` 要求 `Host` 是环回地址且 `Origin` 与本站一致（防 DNS rebinding 与跨站 POST） |

完整的威胁模型、明确**不在**威胁模型内的部分、以及漏洞报告渠道，见 [SECURITY.md](SECURITY.md)。

## 目录结构

```
index.js                    宿主半边：静态托管 + 反向代理 + 导入收件口
client.js                   客户端半边：侧栏入口 + 全屏 iframe 浮层 + 三条退出路径
web/                        上游 chat-demo 的构建产物（入库，装完即用）
  LICENSE                   上游许可原文，随产物分发
sync/normalize.js           导入载荷识别（纯函数，可在 Node 里单测）
sync/merge.js               合并决策与幂等指纹（纯函数）
web-src/inject/             被注入上游源码树的三个文件 + 两份 .d.ts
  host-bridge.ts            导入入口：哨兵 Key、合并导入、宿主消息通道
  sync-archive.ts           归档解析（只解析不落库），供合并流程使用
scripts/prepare-web.mjs     拉上游、打补丁、构建、自检、产出 web/
extension/                  MV3 扩展骨架（未验证，见下）
tests/                      独立验证台：假宿主 + 假上游 + 真 node:http
docs/                       安装说明、同步可行性论证
```

`web-src/upstream/` **不入库**（已在 `.gitignore` 排除）：它由
`scripts/prepare-web.mjs` 按固定 commit 克隆并重建，自带 `.git` 与 230 MB 的 `node_modules`。

## 已知限制

- **只验证过 DSH 0.2.1-rc.5 与 0.2.2-rc.5。** `dsh.bundle` 的 `patch` 与
  `dsh.client.platform` 是 rc 期接口，后续若改了 manifest 字段，`dsh plugin add` 会报校验失败。
- **L2 浏览器扩展未验证。** 采集端点刻意留空，加载后会明确报错而不是静默失败。
  `chat.deepseek.com` 的会话接口路径与反爬机制（PoW）没有实测，
  本仓库**故意不写猜出来的路径**。
- **导入只做增量，从不删除。** 如果你在 DSH 里删掉某个会话，再导入一份含它的旧 zip，
  它会回来。这是「绝不整库替换」的代价，宁可重复也不丢数据。
- **一次导入的内存峰值约为 zip 解压后的大小。** 归档在内存里解包（不落盘），
  特别大的导出建议分批。
- **浏览器无法确认下载是否真的落盘。** 备份失败时插件会中止导入，但「下载被静默拦截」
  这种情况只能靠面板上的文案提醒用户自查。
- **导入的回复不能续写。** 这是导出格式的既有限制，UI 如实体现，不假装能继续。

## 升级 DSH 后请复测

本包在 **DSH 0.2.1-rc.5** 与 **0.2.2-rc.5**（桌面端实际版本）上验证。以下契约若变动，
需要重新确认：

1. `ctx.webServer.register({kind, path, handler})` 与最长前缀派发规则
   （`packages/host/webserver/src/index.ts`）。
2. `client-modules` 仍以 `kind:'prefix'` 占用 `/plugins` —— 本插件因此只用
   `/plugins/dsh-chat-demo/{web,api}` 与三个 `exact` 路径，**不能**注册
   `/plugins/dsh-chat-demo`，否则会抢走自己的 `client.js`。
3. `sidebar.panellist` / `main` 两个 slot 的名称与注册参数。
4. `ctx.theme.getTheme()` 的 `colorScheme` 与 `theme/change` 事件。
5. `credentials.resolve(ref)` 的返回形状（`{value, source}`）。
6. `window.__ModuleLoader__.load({id, factory})` 工厂约定。
7. 上游 chat-demo 是否仍是 commit `5d5dd754ebc1948e977ddb880a9eb5aa25f37b4c`
   （`prepare-web.mjs` 的 `PINNED_COMMIT`），以及 `importArchive` / `db.commitStaging` /
   `replaceHistory` 的签名是否变化 —— 变了就要同步 `web-src/inject/sync-archive.ts`。
8. 退出路径的三个前提：`--dsh-frame-top-clearance` 仍由宿主在 `html` 上声明
   （Windows = 标题栏高度）、桌面窗口仍有那条 40px 的 `-webkit-app-region: drag` 拖动条、
   `ctx.layout.selectPanel(null)` 仍是「回到 Conversation」。任一条变了，「点进来回不去」
   会复发 —— 桌面端实机点一遍：**窗口能拖、头部按钮能点、iframe 里按 Esc 能退**。
9. 凭据服务的激活时机 —— 见 [CHANGELOG.md](CHANGELOG.md) 的 0.1.2 条目。

0.1.1 修掉的三个桌面端问题（浮层盖标题栏、头部按钮点不动、Esc 不跨文档）
保留在 [CHANGELOG.md](CHANGELOG.md) 里，回归时对照。

## 许可

本插件以 **MIT** 发布，见 [LICENSE](LICENSE)。

分发的上游 `deepseek-ai/chat-demo`（MIT）构建产物保留其原始许可文本于
[`web/LICENSE`](web/LICENSE)。第三方组件清单见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 合规

只处理用户自己的账号数据，全部由用户主动触发；采集串行且 ≤1 请求/秒；
不绕过任何验证码或风控；不上传任何第三方；不把 cookie 落盘。
