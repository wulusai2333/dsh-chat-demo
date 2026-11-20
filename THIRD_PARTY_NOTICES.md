# 第三方组件声明

本仓库自身以 MIT 发布（见 [LICENSE](LICENSE)）。它**分发了第三方代码的构建产物**，
详情如下。

## deepseek-ai/chat-demo

| 项 | 值 |
| --- | --- |
| 来源 | <https://github.com/deepseek-ai/chat-demo> |
| 版本 | v0.1.1 |
| 固定 commit | `5d5dd754ebc1948e977ddb880a9eb5aa25f37b4c` |
| 许可 | MIT |
| 在本仓库中的位置 | `web/`（构建产物，152 个文件） |
| 原始许可文本 | [`web/LICENSE`](web/LICENSE)，随产物一起分发 |

`web/` 是上游 `rspack` 构建的**完整产物**，包含上游打包进去的所有前端依赖
（React 18、KaTeX、Mermaid、highlight.js 等）。这些依赖各自的许可声明由上游
在其发布流程中统一处理；本仓库只做原样分发，不额外引入依赖。

关于本插件对上游源码所做的三处改动，见
[README 的「对上游的改动」](README.md#对上游的改动)与
[`scripts/prepare-web.mjs`](scripts/prepare-web.mjs) 的补丁表。

### 为什么分发产物而不是源码

`web-src/upstream/` **不入库**（已在 `.gitignore` 里排除）：它自带 `.git`，
直接入库会变成一个没有 `.gitmodules` 的 gitlink，别人 clone 只会得到空目录。
产物入库换来的是「装上即用，不必本地构建」，代价是仓库多 4.2 MB 二进制。

重建方式：

```bash
node scripts/prepare-web.mjs
```

## 运行时依赖

**无。**

本仓库的插件代码（`index.js`、`client.js`、`sync/`、`tests/`、`scripts/`）
只使用 Node.js 内置模块（`node:fs`、`node:http`、`node:https`、`node:crypto`、
`node:path`、`node:url`、`node:zlib`、`node:test` 等），没有任何 `dependencies`
或 `devDependencies`。`react` 由 DSH 宿主在运行时通过 `window.__ModuleLoader__`
提供，不在本仓库内。

## 商标

「DeepSeek」是杭州深度求索人工智能基础技术研究有限公司的商标。
本仓库是**非官方**项目，与 DeepSeek 无关联，也不代表其立场。
