# 安装 dsh-chat-demo

把开源项目 [`deepseek-ai/chat-demo`](https://github.com/deepseek-ai/chat-demo)（MIT）作为 DSH 插件装进
现有 profile，复用宿主已配好的 API Key，并把 `chat.deepseek.com` 的历史对话导进来。

---

## 0. 前置条件

| 项 | 要求 | 怎么确认 |
| --- | --- | --- |
| DSH | `0.2.1-rc.5` 或 `0.2.2-rc.5`（本包在这两个版本上验证过） | `dsh --version` |
| Node | `^22.19.0 \|\| >=24.0.0` | `node --version` |
| 宿主的 Key | 已配置 `DEEPSEEK_API_KEY`（推荐），或装好后在面板里一次性填入 | 见 §4 |

装之前请确认**不要**在 DSH 运行中的 profile 上直接改文件；用下面 CLI 的方式装，它会走正常的
bundle 组装流程。

---

## 1. 安装

两条路，选一条。

### 1a. 从 GitHub 安装

```bash
dsh plugin --profile web add github:wulusai2333/dsh-chat-demo
```

`web/` 是入库的构建产物，所以这条路**不需要**本地构建。

### 1b. 从本地目录安装

路径必须是**绝对路径**（CLI 与桌面端插件管理都按这一条校验）。

```bash
dsh plugin --profile web add /absolute/path/to/dsh-chat-demo
```

Windows 上写成 `D:\path\to\dsh-chat-demo`。

装完会看到类似输出：

```
+ dsh-chat-demo 0.1.3
```

### 1c. 装进桌面端（DSH Desktop）

桌面端运行的是它自己的 `desktop` profile（`$DSH_HOME/profiles/desktop`），**与 `web` profile 完全独立**：
装到 `web` 不会出现在桌面窗口里，反之亦然。

两条路，选一条即可（**不要同时用**）：

- **桌面窗口内安装（推荐，先做）**：设置 → 插件管理 → 安装，填上面那个绝对路径。桌面端有 HMR，
  装完即热应用，`package.json` 的 `dependencies` 与 `dsh.profile.bundles` 会同时写入，无需重启。
  注意：安装会连带把 profile 里其它 bundle 更新到各自范围允许的最新版本（pnpm 的正常行为）。
- **命令行安装**：**必须先完全退出桌面端**，再执行

  ```bash
  dsh plugin --profile desktop add /absolute/path/to/dsh-chat-demo
  ```

  桌面端运行时会持有 profile 锁，未退出时该命令会失败。装完重新启动桌面端。

桌面端的 profile 有两处会被重置，装完发现图标消失时先查这里：

- **更新或崩溃恢复**会把 `dsh.profile.bundles` 重置为 `base + web-app`，所有第三方 bundle（含本插件、
  插件市场等）一并停用；用插件管理重新启用即可，不必重装。
- `profiles/desktop/node_modules` 里只有指向本仓库的软链，仓库目录被移动/删除后链接即失效。

## 2. 重启 profile

插件的宿主半边在 Web Server 进程里注册路由，**必须重启**才生效：

```bash
# 停掉当前 profile 的进程，再重新启动
dsh web --profile web
```

桌面端热应用后不需要这一步；只有命令行安装（桌面端已退出重开）或改过插件代码时才需要重启桌面端。

## 3. 硬刷新页面

浏览器里 `Ctrl+Shift+R`（macOS `Cmd+Shift+R`）；桌面端 `Ctrl+R`，仍不生效就完全退出重开。
客户端半边是 `client.js`，由 client-modules 以合并产物下发，强刷才会重新拉。

## 4. 打开入口

左侧栏出现 `chat-demo` 入口（对话气泡图标，展开侧栏时同时显示文字）。点开是全屏面板。

- 第一次打开时，宿主半边会探一次上游 `/models`。如果宿主没有可用 Key，面板顶部会出现一条
  **红色提示条**，里面可以直接填一次 Key（只保存在宿主进程内存，重启即失效，不落盘）。
- 建议的长期做法还是把 Key 配在宿主：

```bash
dsh config set credentials.DEEPSEEK_API_KEY sk-...
```

或者写进 `$DSH_HOME/.env`。插件按「宿主凭据服务 → 环境变量 → 一次性输入」的顺序取。

## 5. 导入历史对话

### 路线 A：官方导出（推荐，功能完整）

1. 登录 `chat.deepseek.com` → 设置 → 数据管理 → **导出所有历史对话**，拿到
   `deepseek_data-YYYY-MM-DD.zip`。
2. 打开插件面板 → 顶部「导入历史」→ 选这个 zip。
3. 面板会在导入**之前**自动先导出一份当前库作为备份（文件名
   `chat-demo-backup-<时间戳>.zip`）。**如果没看到下载，请先在浏览器里允许本站下载，再重试**——
   备份失败时插件会中止导入，不会在没有备份的情况下写库。
4. 导入完成后右下角会报「新增 / 更新 / 跳过 / 失败」的条数。

### 路线 B：手工粘贴（兜底）

从同一个 zip 里解出 `chat_sessions/<会话id>.json`，把文件内容粘贴到面板的「粘贴导入」框里。
适合只补一两个会话，或者官方导出拿不到的情况。

### 路线 C：浏览器扩展（**未验证**）

`extension/` 里是 MV3 源码骨架。它的采集端点**刻意留空**，因为 `chat.deepseek.com` 的会话接口
与反爬机制没有实测（详见 `docs/sync-feasibility.md` §2–§3）。直接加载会明确报错「接口尚未实测」，
不会静默返回空数据。补齐方式见该文档 §8。

---

## 6. 卸载

```bash
# web profile
dsh plugin --profile web remove dsh-chat-demo
# desktop profile（先完全退出桌面端）
dsh plugin --profile desktop remove dsh-chat-demo
```

桌面端也可以直接在插件管理里停用/移除该 bundle。重启 profile 后：

- 宿主半边的 7 条路由随插件卸载一起摘掉（`ctx.effect` 的 disposer）。
- 客户端半边的侧栏图标、面板、浮层全部撤销；`body` 的滚动锁会还原成卸载前的值。
- 浏览器里 `chat-demo` 这个 IndexedDB 是**上游自己的数据**，卸载插件不会删除。要清干净请手动
  在 DevTools → Application → IndexedDB 里删掉 `chat-demo`。

---

## 7. 装完自查

- [ ] 侧栏出现 `chat-demo` 入口（对话气泡图标），点开是全屏面板。
- [ ] **回得去**（三条都要过，这是 0.1.1 修的重大问题）：
      - 点头部最左的「← 返回」→ 回到当前对话；
      - 把焦点点进面板里的聊天输入框，再按 `Esc` → 同样回到对话；
      - 焦点不在 iframe 里时按 `Esc` → 同样回到对话。
- [ ] 面板里打开设置弹窗/模型下拉框后再按 `Esc`：**先关弹窗，面板不退出**；再按一次才回到对话。
- [ ] 桌面端（Windows）：**标题栏那一行不被面板盖住，窗口能拖**；面板头部的按钮**点得动**
      （不会被当成拖动区把窗口拖走）。
- [ ] 切到深色主题：面板背景、文字跟着变，不露白底。
- [ ] 切到 English：侧栏入口仍是 `chat-demo`，头部按钮变成 `← Back`。
- [ ] 打开 DevTools → Network，搜 `sk-`：**一条都不该有**（Key 只在宿主进程里）。
- [ ] 发一条消息，能看到流式逐字到达；按 `Esc` 中断后 Network 里那条请求立即变红/取消。
- [ ] 连续开关面板 10 次，Memory 面板里 iframe 数量不增长（关闭是 `display:none`，不是卸载）。
- [ ] 重复导入同一个 zip 两次：第二次全部「跳过」，会话总数不变。
- [ ] 卸载插件并重启，侧栏图标消失，`/plugins/dsh-chat-demo/status` 返回 404。

> 自查的 `/plugins/dsh-chat-demo/status` 只能用**带浏览器会话 cookie** 的窗口打开（地址栏直接访问）。
> 用 `curl` 之类不带 cookie 的脚本请求会拿到 404 —— 那不是插件故障，是 client-modules 的
> `/plugins` 资源路由与连接鉴权的正常结果（插件市场的 `client.js` 同样如此）。

---

## 8. 已知不兼容 / 限制

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 桌面端侧栏没有 `chat-demo` 入口 | 新 bundle 的浏览器行没进已加载的 boot graph（热应用只重排了宿主半边）；或该入口在「更多」里被取消固定 | 先 `Ctrl+R`；仍无则完全退出并重开桌面端；再从「更多」把它固定回侧栏 |
| 更新/崩溃恢复后图标消失，插件里其它 bundle 也一起没了 | 桌面端会把这些 profile 重置回 `base + web-app` | 插件管理里重新启用，不必重装 |
| 装完 pnpm 顺带升级了别的插件 | `dsh plugin add` 就是一次 pnpm 安装，会按锁文件重解 | 属正常行为；要固定版本就把 `dependencies` 改成精确版本 |
| 面板里发消息报 503 `host-key-missing`，但 `~/.dsh/.credentials.yaml` 里明明有 `DEEPSEEK_API_KEY` | 0.1.2 已修：旧代码在 `apply()` 里缓存了 `ctx.get('credentials')`，而 `ctx.get` 默认 strict —— 提供方 fiber 未 ACTIVE 时返回 `undefined`，被永久记住 | 无需处理；升级后面板顶部的 Key 提示条应消失（见 README 第 7 条） |
| ~~面板一直说「宿主未配置可用 Key」~~ | 同上，0.1.2 已修：改成每次操作现取凭据服务 | 无需处理 |
| 导入时提示「备份失败，已中止」 | 浏览器拦了下载 | 允许本站下载后重试 |
| 扩展推送报「接口尚未实测」 | L2 只交付骨架 | 用路线 A 的官方 zip |
| 面板白屏 | `web/` 产物缺失（没跑构建） | `node scripts/prepare-web.mjs` |
| ~~面板顶住 Windows 标题栏 / 深色下露白底 / 英文界面仍显示中文~~ | 0.1.1 已修：`inset:0` 改为让出 `--dsh-frame-top-clearance`、补 `-webkit-app-region: no-drag`、token 换成 `--dsw-alias-bg-base`、语言按 `en` 前缀判定 | 无需处理（见 README「0.1.1 之前修掉的桌面端问题」） |
| ~~点进来之后回不到工作页面~~ | 0.1.1 已修：Windows 上头部按钮落在 40px 窗口拖动条里（几何判定，抬高 z-index 无效）点不动，且 iframe 内的 `Esc` 不会冒泡到父文档 | 已加「← 返回」主按钮 + iframe 内 Esc 转发；见上节自查三条 |
