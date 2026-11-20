# 更新日志

本文件记录本插件（宿主半边 + 客户端半边 + 同步通道）的变更，**不记录上游
[`deepseek-ai/chat-demo`](https://github.com/deepseek-ai/chat-demo) 的变更** ——
后者固定在一个 commit 上，升级方式见 README 的「对上游的改动」。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 计划中

- 补测 L2 浏览器扩展的采集端点（当前 `ENDPOINTS` 刻意留空，加载即报错，见
  [docs/sync-feasibility.md](docs/sync-feasibility.md) §8）。

## [0.1.2] — 2026-11-18

### 修复

- **面板一直说「宿主未配置可用 Key」，即使凭据文件里明明有值。**
  `apply()` 里曾把 `ctx.get('credentials')` 的结果**缓存**下来。`ctx.get(name)` 默认
  `strict`：提供方 fiber 必须已经 ACTIVE，否则返回 `undefined`；本插件的 `inject` 只有
  `webServer`，条目在 profile 里又排在 `credentials` 之后激活，于是 apply 那一刻取到的
  `undefined` 被永久记住 —— 表现为 `/status` 永远是 `{"key":"missing"}`，面板一直要求
  「一次性填入」。

  现在改成 `const credentialsOf = () => ctx.get('credentials')`，每次操作现取，
  与官方 `dsh-llm-deepseek/src/credential.ts` 的做法一致。
  回归用例：`tests/host.test.mjs` 的「凭据服务在 apply 之后才激活」。

## [0.1.1] — 2026-11-17

### 修复

桌面端（Windows）上「点进来回不去」的一组问题。保留记录，回归时对照。

1. **全屏浮层盖住 Windows 标题栏** → 浮层改用 `top: var(--dsh-frame-top-clearance, 0px)`
   四边分开写：Windows 上让出 40px 标题栏、macOS 上让出顶部条，纯 web 端回落到 0。
2. **头部按钮在 Windows 上点不动（点一下变成拖窗口）** → 桌面端的窗口拖动区是
   **几何判定、不看层叠**（`AppFrame.module.css` 里 40px 的 `.frame::before` 拖动条），
   光把浮层 z-index 抬高没用，必须由浮层自己声明 `-webkit-app-region: no-drag`。
   这是「点进来就回不到工作页面」的直接原因之一：唯一的「关闭」按钮收不到点击。
3. **焦点进聊天输入框后 Esc 失效** → `keydown` 只在焦点所在文档派发、**不跨文档冒泡**，
   父页面上的监听收不到。现在 iframe 载入后会在其文档上再挂一份 Esc（同源，跨源异常静默降级）。
   这份监听挂**冒泡**阶段，并在 `[role=dialog|menu|listbox]` 还开着时把 Esc 让出去 ——
   否则「关设置弹窗」会被抢成「关整个面板」。
4. **头部缺少第一顺位的返回入口** → 新增「← 返回 / ← Back」主按钮，
   不依赖宿主状态、不依赖 iframe 是否加载完成。
5. 浮层背景用了不存在的 token `--dsw-color-bg`（深色下露白底）→ 改用 `--dsw-alias-bg-base`，
   并补上 `color: var(--dsw-alias-label-primary)`。
6. `isEnglish()` 判断 `active === 'en-US'`，而 DSH 的语言 id 是 `en` / `zh` →
   改为按 `en` 前缀判定。

### 说明

退出路径共有三条，任一条都够：头部「← 返回」、Esc（父文档与 iframe 内各一份）、
以及宿主原生的「打开会话 / 新建会话」（`ui-workspace` 自己会 `selectPanel(null)`）。
浮层仍然**有意**全屏覆盖侧栏，所以前两条必须随时可用 —— 上面第 2、3 条就是这个前提
被打破时出的故障。

## [0.1.0] — 2026-11-16

### 新增

- 宿主半边：静态托管 `web/`、`/api/*` 反向代理（每请求现取 Key 并注入鉴权头）、
  历史导入收件口（内存暂存，5 分钟 TTL，一次性 token）。
- 客户端半边：侧栏 `panellist` 入口 + 同源全屏 iframe 面板 + 三条退出路径。
- 同步三档：官方导出 ZIP 导入（L1）、手工粘贴（L3）、MV3 扩展骨架（L2，未验证）。
- 导入语义为**并集合并**而非整体替换：复用上游暂存通道，`commitStaging()` 仍是唯一写入点。
- 测试台：假宿主 + 假上游 + 真实 `node:http`，46 个用例，零第三方依赖。

[Unreleased]: https://github.com/wulusai2333/dsh-chat-demo/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/wulusai2333/dsh-chat-demo/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/wulusai2333/dsh-chat-demo/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/wulusai2333/dsh-chat-demo/releases/tag/v0.1.0
