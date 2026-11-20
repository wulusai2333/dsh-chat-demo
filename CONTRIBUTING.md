# 参与开发

欢迎 issue 与 PR。这个仓库很小，所以规矩也少 —— 只有几条**不可协商**的。

## 环境

| 项 | 要求 |
| --- | --- |
| Node | `^22.19.0 \|\| >=24.0.0` |
| DSH | `0.2.1-rc.5` 或 `0.2.2-rc.5`（本包在这两个版本上验证过） |
| 其他 | 无。插件本体与测试**零第三方依赖**，只用 Node 内置模块 |

## 跑测试

```bash
node --test tests/*.test.mjs
```

预期 **46 pass / 0 fail**。测试不连真实的 DSH 进程，也不占固定端口：
`tests/harness.mjs` 用真实 `node:http` 起假宿主 + 假上游，把 `index.js` 的 `apply()`
挂在上面，按宿主 WebServer 的「精确优先、其次最长前缀」规则派发。

`node tests/smoke.mjs` 是另一回事：它会**真的**打一次上游 `/models`，需要宿主凭据，
只在手动验证接线时跑。

## 改上游补丁

`web/` 是上游 [`deepseek-ai/chat-demo`](https://github.com/deepseek-ai/chat-demo) 的构建产物。
我们对上游的改动**不直接改源码树**，而是写在 `scripts/prepare-web.mjs` 的补丁表里，
每条是 `(标记, 锚点, 替换)` 三元组：

```bash
node scripts/prepare-web.mjs                # 重建（复用已有 web-src/upstream）
node scripts/prepare-web.mjs --clean        # 删掉上游副本重新 clone
node scripts/prepare-web.mjs --skip-install # 复用已装好的依赖
node scripts/prepare-web.mjs --upstream /path/to/chat-demo  # 从本地克隆/镜像拉
```

**硬规矩：锚点找不到就必须硬失败。** 不许写「找不到就跳过」——
那会让上游实现变更被静默吞掉，产物看起来构建成功、实际没打上补丁。
现有实现用 `replaceOnce()` 保证这一点：标记已存在即跳过（幂等），锚点缺失即 `fail()`。

同理，**不许新增第四处上游改动**。只允许这三处：

1. `rspack.config.ts` 注入 `apiOrigin`（改成同源代理前缀）
2. `app/theme.ts` 新增 `?theme=` 读取 + `postMessage` 实时同步
3. `main.tsx` 挂一个导入入口（`src/host-bridge.ts`）

外加本项目自己新增的文件（`web-src/inject/*`、`sync/*`）。这三处之外的改动会破坏
「升级上游时只需要重放补丁」这个前提。

## 代码风格

- 2 空格、单引号、无分号、LF 行尾（见 `.editorconfig` 与 `.gitattributes`）。
- 每个导出的函数都要有 JSDoc；`@param` / `@returns` 写真实类型，不写 `any`。
- 注释解释**为什么**，不解释**是什么**。如果一段代码不看注释就懂，不要写注释。
- 提交前跑一遍测试。

## 什么时候该怀疑「这里有问题」

以下都是这个仓库已经踩过的坑，改相关代码时先读对应的注释：

- **`ctx.get(name)` 不能缓存。** 它在提供方 fiber 未 ACTIVE 时返回 `undefined`，
  缓存下来就是永久的 `undefined`。这就是 0.1.2 修的「面板一直说没有 Key」。
  → `index.js` 的 `credentialsOf`
- **`keydown` 不跨文档冒泡。** iframe 里的 Esc 父页面收不到，必须在 iframe 文档上再挂一份。
  → `client.js` 的 `createController`
- **桌面端的窗口拖动区是几何判定，不看层叠。** 抬高 z-index 没用，必须声明
  `-webkit-app-region: no-drag`。 → `client.js` 的浮层样式
- **上游 `importHistory()` 是整体替换**（`commitStaging()` 先清空再搬入）。
  想要「合并」必须自己把并集放进暂存。 → `sync/merge.js` 与
  [docs/sync-feasibility.md](docs/sync-feasibility.md) §1.4
- **CRLF 会让补丁锚点失配**，而报错看起来像「上游改了实现」。 → `prepare-web.mjs` 的 `readSource`

## 文档

- [README.md](README.md) — 这是什么、怎么装、架构与关键决策
- [docs/install.md](docs/install.md) — 安装、卸载、装完自查清单、已知不兼容
- [docs/sync-feasibility.md](docs/sync-feasibility.md) — 历史同步三档方案的可行性论证与未验证项
- [SECURITY.md](SECURITY.md) — 安全模型、威胁边界、漏洞报告渠道
- [CHANGELOG.md](CHANGELOG.md) — 版本变更

改行为时请一并更新对应文档；文档里写着「未验证」的地方，验证之后要改掉标注。
