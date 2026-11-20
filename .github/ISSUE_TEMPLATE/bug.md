name: Bug report
description: 报告一个可复现的故障
labels: ['bug']
body:
  - type: markdown
    attributes:
      value: |
        **先等一下。** 如果你要报告的是**安全漏洞**，请不要在这里发 ——
        见 [SECURITY.md](../blob/main/SECURITY.md) 里的私密报告渠道。

        另外，`docs/install.md` 的「已知不兼容 / 限制」表里已经有常见的安装故障，
        请先扫一眼，可能不用等回复就能解决。

  - type: input
    id: version
    attributes:
      label: 插件版本
      description: |
        `package.json` 的 `version`，或 `web/index.html` 里的
        `<meta content="..." name="application-version">`。
        （后者是**上游 chat-demo** 的版本，不是本插件的版本 —— 两个都给最好。）
      placeholder: '0.1.2'
    validations:
      required: true

  - type: input
    id: dsh
    attributes:
      label: DSH 版本与平台
      description: '`dsh --version`，以及 web profile 还是桌面端、操作系统。'
      placeholder: '0.2.2-rc.5 / 桌面端 / Windows 11'
    validations:
      required: true

  - type: dropdown
    id: area
    attributes:
      label: 出问题的部分
      options:
        - 安装 / 卸载（`dsh plugin add|remove`）
        - 侧栏图标 / 面板打不开 / 白屏
        - 退不出去（返回按钮、Esc）
        - 发消息 / 流式 / 中断
        - 主题或语言
        - 历史导入（官方 zip / 粘贴 / 扩展）
        - 其他
    validations:
      required: true

  - type: textarea
    id: steps
    attributes:
      label: 复现步骤
      description: 从干净状态开始，一步步写。可复现是最重要的信息。
      placeholder: |
        1. 装好插件并重启 profile
        2. 点侧栏「历史对话」
        3. 按 Esc
        4. 现象：……
    validations:
      required: true

  - type: textarea
    id: expected
    attributes:
      label: 期望行为
      description: 你以为会发生什么？如果文档里写了应该这样，请引用那一行。
    validations:
      required: true

  - type: textarea
    id: actual
    attributes:
      label: 实际行为
      description: |
        报错原文、DevTools Console 的堆栈、Network 里的状态码。
        **不要贴 API Key** —— 把它替换成 `sk-REDACTED` 再贴。
    validations:
      required: true

  - type: checkboxes
    id: checks
    attributes:
      label: 提交前确认
      options:
        - label: 我已搜索过现有 issue，没有重复
          required: true
        - label: 我确认贴出的内容里**不含真实 API Key** 或任何凭据
          required: true
        - label: 我确认贴出的内容里**不含我自己的会话数据**（如需要请脱敏）
          required: true
