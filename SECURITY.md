# 安全策略

## 这个插件的安全模型

理解边界比读漏洞列表更重要。本插件有四个明确的信任边界：

| 边界 | 规则 | 实现位置 |
| --- | --- | --- |
| **API Key 不出宿主进程** | 浏览器侧任何响应、任何日志、任何产物里都不出现 Key 明文。iframe 只与同源 `/plugins/dsh-chat-demo/api` 通信，由宿主现取 Key 注入鉴权头 | `index.js` 的代理路由 |
| **一次性导入 token** | 扩展投递到 `/import` 需要 token，且**每次成功使用后立刻轮换**；宿主重启后内存里的旧 token 全部失效 | `index.js` 的 `importToken` |
| **导入载荷不落盘** | 归档在内存里解包，暂存 5 分钟或取走即失效，从不写磁盘 | `index.js` 的 `staged` |
| **只接受本机来源** | `/import` 要求 `Host` 是环回地址且 `Origin` 与本站一致（防 DNS rebinding 与跨站 POST） | `index.js` 的 `isLocalTrusted` |

`scripts/prepare-web.mjs` 在每次构建后自检**产物里不含 `sk-` 形式的密钥**，命中即中断构建。

### 明确不在威胁模型内

- **本机上的其他进程**。它们能读到 `~/.dsh/.credentials.yaml`，绕过插件没有任何收益。
- **宿主本身被攻破**。插件运行在宿主进程内，宿主被攻破时插件没有额外的隔离能力。
- **上游 `api.deepseek.com` 的行为**。插件不校验上游返回内容，只做转发。
- **导入归档的可信度**。归档被当作数据解析，不执行其中任何内容；但恶意归档仍可能消耗
  大量内存（见下方「已知限制」）。

## 报告漏洞

**请不要在公开 issue 里讨论未修复的漏洞。**

优先使用 GitHub 的
[Private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
（仓库 **Security** 标签页 → *Report a vulnerability*），这样讨论与修复过程不会公开。

本仓库**不提供邮箱渠道**：所有报告统一走上面的 GitHub Private vulnerability reporting，
不接受公开 issue、也不通过其它渠道受理。

报告里请包含：

- 受影响的版本（`package.json` 的 `version`）与 DSH 版本（`dsh --version`）。
- 可复现的最小步骤。**不要附上真实 API Key** —— 用 `sk-test` 之类的假值即可。
- 你判断的影响范围（能读到什么 / 能写到什么 / 是否需要本机访问权限）。

## 已知限制（不是漏洞）

这些是**有意的设计取舍**，报告前请先确认不是其中一种：

- **一次导入的内存峰值约为 zip 解压后的大小。** 归档在内存里解包（不落盘），
  特别大的导出建议分批导入。恶意构造的高压缩比归档可能耗尽内存 —— 缓解方式是
  `STAGING_MAX_BYTES`（64 MB）限制投递载荷，但面板直接 `postMessage` 的路径不受此限。
- **导入只做增量，从不删除。** 在 DSH 里删掉某个会话后，再导入一份含它的旧 zip，它会回来。
  这是「绝不整库替换」的代价。
- **浏览器无法确认下载是否真的落盘。** 备份失败时插件会中止导入，但「下载被静默拦截」
  这种情况只能靠面板上的文案提醒用户自查。
- **L2 浏览器扩展未验证。** 采集端点刻意留空，加载后会明确报错而不是静默失败。

## 支持范围

只对**最新发布版本**提供安全修复。本插件是个人项目，不承诺响应时限。
