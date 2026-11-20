name: Feature request
description: 提一个新功能或改进
labels: ['enhancement']
body:
  - type: markdown
    attributes:
      value: |
        这个项目有两条边界请先看，落在外面的需求大概率会被关掉：

        1. **只允许三处上游改动**（`apiOrigin`、`?theme=`、一个导入入口）。
           任何需要改上游业务逻辑的方案都不行 —— 见 [CONTRIBUTING.md](../blob/main/CONTRIBUTING.md)。
        2. **不绕过任何验证码 / 风控 / 付费墙。** 涉及抓取 `chat.deepseek.com`
           的提议，先读 [docs/sync-feasibility.md](../blob/main/docs/sync-feasibility.md) §3。

  - type: textarea
    id: problem
    attributes:
      label: 你想解决什么问题
      description: 描述场景，而不是直接给方案。现在你是怎么绕过去的？
    validations:
      required: true

  - type: textarea
    id: proposal
    attributes:
      label: 你设想的做法
      description: 如果有多个方案，都写出来并说明取舍。
    validations:
      required: true

  - type: dropdown
    id: area
    attributes:
      label: 涉及的部分
      options:
        - 宿主半边（index.js）
        - 客户端半边（client.js）
        - 历史同步（sync/）
        - 构建与补丁（scripts/prepare-web.mjs）
        - 文档
        - 其他
    validations:
      required: true

  - type: checkboxes
    id: boundaries
    attributes:
      label: 边界确认
      options:
        - label: 这个提议不需要新增第四处上游改动
          required: true
        - label: 这个提议不涉及绕过验证码、风控或付费墙
          required: true
