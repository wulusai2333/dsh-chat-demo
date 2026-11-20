/**
 * 客户端半边（client.js）的契约验证。
 *
 * client.js 是手写的 `window.__ModuleLoader__.load({id, factory})` 模块，没有构建期类型检查。
 * 它的失败方式是「装上去之后侧栏没图标」或「关上之后宿主 DOM 留着浮层」——两者都很难在
 * 浏览器里靠肉眼发现是哪个环节错了。所以这里用最小 DOM 桩把它跑起来，直接断言：
 *
 *   · factory 只依赖 require('react')，不再 require 别的
 *   · exports 的注入项与 apply 契约正确
 *   · 注册到 sidebar.panellist 与 main，且两者用**同一个 id/key**
 *   · 卸载时浮层节点被移除、body 滚动锁还原
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SOURCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'client.js'), 'utf8')

/**
 * 搭一个最小 DOM 桩并加载 client.js，返回 factory 与记录下来的 DOM 操作。
 * @param {{locale?: string, scheme?: 'light'|'dark'}} [options] 语言与主题
 * @returns {object} 测试句柄
 */
const load = (options = {}) => {
  const appended = []
  const listeners = []
  const created = []
  /** iframe 内部文档上挂过的监听：Esc 转发就是靠它验证的。 */
  const subDocumentKeys = []

  /**
   * 造一个够用的元素：只要 client.js 用到的那些方法。
   * @returns {object} 假元素
   */
  const element = () => {
    const node = {
      // setProperty 是 client.js 写 -webkit-app-region 这类带连字符属性的通道；
      // 没有它就会退化成无效的 style['-webkit-app-region'] 赋值。
      style: {
        setProperty(name, value) {
          this[name] = value
        },
      },
      dataset: {},
      children: [],
      listeners: {},
      textContent: '',
      type: '',
      src: '',
      title: '',
      placeholder: '',
      rows: 0,
      files: null,
      value: '',
      contentDocument: {
        addEventListener(name, fn) {
          subDocumentKeys.push({ name, fn })
        },
        removeEventListener(name, fn) {
          const at = subDocumentKeys.findIndex((item) => item.name === name && item.fn === fn)
          if (at >= 0) subDocumentKeys.splice(at, 1)
        },
        /** 面板内「还开着的层」：Esc 应让给它们，而不是关掉整个面板。 */
        layers: [],
        querySelectorAll() {
          return this.layers
        },
      },
      // iframe 的 load 里会 pushTheme()/postKeyStatus()，都走 contentWindow.postMessage。
      contentWindow: { postMessage() {} },
      append(...children) {
        node.children.push(...children)
      },
      appendChild(child) {
        node.children.push(child)
        return child
      },
      addEventListener(name, fn) {
        const list = node.listeners[name] ?? []
        list.push(fn)
        node.listeners[name] = list
      },
      removeEventListener() {},
      setAttribute(name, value) {
        node[name] = value
      },
      querySelector() {
        return node.children.length > 0 ? null : null
      },
      /** 让测试能像用户那样「按一下」：找出子节点里的按钮并触发 click。 */
      find(predicate) {
        for (const child of node.children) {
          if (predicate(child)) return child
          const nested = typeof child.find === 'function' ? child.find(predicate) : undefined
          if (nested !== undefined) return nested
        }
        return undefined
      },
      remove() {
        appended.splice(appended.indexOf(node), 1)
      },
      click() {
        for (const fn of node.listeners.click ?? []) fn()
      },
    }
    created.push(node)
    return node
  }

  let captured
  const window = {
    __ModuleLoader__: {
      load(definition) {
        captured = definition
      },
    },
    location: { origin: 'http://127.0.0.1:1' },
    addEventListener(name, fn) {
      listeners.push({ name, fn })
    },
    removeEventListener(name, fn) {
      const at = listeners.findIndex((item) => item.name === name && item.fn === fn)
      if (at >= 0) listeners.splice(at, 1)
    },
    setTimeout: () => 1,
    clearTimeout: () => {},
    parent: { postMessage() {} },
  }
  const document = {
    body: {
      style: { overflow: 'auto' },
      append(node) {
        appended.push(node)
      },
    },
    documentElement: { dataset: { theme: options.scheme ?? 'light' } },
    createElement: () => element(),
    addEventListener(name, fn) {
      listeners.push({ name, fn })
    },
    removeEventListener(name, fn) {
      const at = listeners.findIndex((item) => item.name === name && item.fn === fn)
      if (at >= 0) listeners.splice(at, 1)
    },
  }

  const globals = globalThis
  const restore = {
    window: globals.window,
    document: globals.document,
    fetch: globals.fetch,
    FileReader: globals.FileReader,
  }
  globals.window = window
  globals.document = document
  globals.fetch = async () => ({ json: async () => ({ key: 'ok', source: 'stub' }) })
  globals.FileReader = class {
    readAsDataURL() {
      this.onerror?.(new Error('not used in this test'))
    }
  }

  // eslint-disable-next-line no-eval
  eval(SOURCE)

  const React = { createElement: (type, props, ...children) => ({ type, props, children }) }
  const required = []
  const module = captured.factory((name) => {
    required.push(name)
    if (name === 'react') return React
    throw new Error(`unexpected require: ${name}`)
  })

  return {
    module,
    React,
    appended,
    listeners,
    created,
    subDocumentKeys,
    required,
    document,
    restore(values = restore) {
      globals.window = values.window
      globals.document = values.document
      globals.fetch = values.fetch
      globals.FileReader = values.FileReader
    },
  }
}

/**
 * 造一个记录注册与卸载的 ctx 桩。
 * @returns {object} 桩与记录
 */
const makeCtx = (options = {}) => {
  const registrations = []
  const effector = []
  const handlers = {}
  const snapshot = { activePanelId: null }
  const ctx = {
    effect(callback) {
      effector.push(callback())
      return () => {}
    },
    slots: {
      inject(_name, factory) {
        factory()
      },
      register(registration, component) {
        registrations.push({ registration, component })
        return () => {}
      },
    },
    layout: {
      selected: [],
      selectPanel(id) {
        ctx.layout.selected.push(id)
        snapshot.activePanelId = id
      },
      panelInfo: {
        subscribe(fn) {
          handlers.panel = fn
          return () => {}
        },
        getSnapshot: () => snapshot,
      },
    },
    theme: {
      getTheme: () => ({ active: { colorScheme: options.scheme ?? 'light' } }),
    },
    locale: {
      getLocale: () => ({ active: options.locale ?? 'zh-CN' }),
    },
    on(name, fn) {
      handlers[name] = fn
      return () => {}
    },
  }
  return { ctx, registrations, effector, handlers, snapshot }
}

test('factory 只依赖 react，不动全局其它模块', () => {
  const loaded = load()
  try {
    assert.deepEqual(loaded.required, ['react'])
    assert.equal(loaded.module.name, 'dsh-chat-demo')
  } finally {
    loaded.restore()
  }
})

test('注入项覆盖 slots/layout/theme/locale，缺一都会让面板静默失效', () => {
  const loaded = load()
  try {
    for (const service of ['slots', 'layout', 'theme', 'locale']) {
      assert.ok(loaded.module.inject.includes(service), `缺少 inject: ${service}`)
    }
  } finally {
    loaded.restore()
  }
})

test('侧栏图标与 main 面板使用同一个 id/key（否则点图标打不开）', () => {
  const loaded = load()
  try {
    const { ctx, registrations } = makeCtx()
    loaded.module.apply(ctx)

    const sidebar = registrations.find((item) => item.registration.name === 'sidebar.panellist')
    const main = registrations.find((item) => item.registration.name === 'main')
    assert.ok(sidebar !== undefined, '没有注册 sidebar.panellist')
    assert.ok(main !== undefined, '没有注册 main')
    assert.equal(sidebar.registration.id, main.registration.key)
    assert.equal(sidebar.registration.id, 'dsh-chat-demo')
    // 侧栏项必须是列表型注册：需要 id/order/label。
    assert.equal(typeof sidebar.registration.order, 'number')
    assert.equal(typeof sidebar.registration.label, 'function')
  } finally {
    loaded.restore()
  }
})

test('标签跟随语言切换（DSH 的语言 id 是 zh / en）', () => {
  const zh = load({ locale: 'zh' })
  let zhLabel
  try {
    const env = makeCtx({ locale: 'zh' })
    zh.module.apply(env.ctx)
    zhLabel = env.registrations.find((i) => i.registration.name === 'sidebar.panellist').registration.label()
  } finally {
    zh.restore()
  }

  for (const locale of ['en', 'en-US', 'en-GB']) {
    const en = load({ locale })
    try {
      const env = makeCtx({ locale })
      en.module.apply(env.ctx)
      const enLabel = env.registrations.find((i) => i.registration.name === 'sidebar.panellist').registration.label()
      assert.equal(enLabel, 'Chat history', `语言 ${locale} 应显示英文标签`)
      assert.equal(enLabel === zhLabel, false, '中英文标签不应相同')
    } finally {
      en.restore()
    }
  }
})

test('浮层让出窗口顶条并声明 no-drag（否则 Windows 上头部按钮点不动）', () => {
  const loaded = load()
  try {
    const env = makeCtx()
    loaded.module.apply(env.ctx)
    env.snapshot.activePanelId = 'dsh-chat-demo'
    env.handlers.panel?.()
    const overlay = loaded.appended[0]

    assert.equal(overlay.style.top, 'var(--dsh-frame-top-clearance, 0px)', '顶部必须让出宿主顶条')
    for (const side of ['right', 'bottom', 'left']) {
      assert.equal(overlay.style[side], '0', `${side} 应贴边`)
    }
    assert.equal(overlay.style.inset, undefined, '不能用 inset:0 把顶条也盖住')
    // 桌面端窗口拖动区按几何判定，不看层叠：浮层不挖掉这块，头部点击会变成拖窗口。
    assert.equal(overlay.style['-webkit-app-region'], 'no-drag')
    assert.equal(overlay.style.background, 'var(--dsw-alias-bg-base, #fff)', '深色主题下不能露白底')
    assert.ok(
      String(overlay.style.background).includes('--dsw-color-bg') === false,
      '--dsw-color-bg 不是宿主 token'
    )
  } finally {
    loaded.restore()
  }
})

test('头部「返回」按钮能回到对话（不依赖 Esc）', () => {
  const loaded = load()
  try {
    const env = makeCtx()
    loaded.module.apply(env.ctx)
    env.snapshot.activePanelId = 'dsh-chat-demo'
    env.handlers.panel?.()

    const overlay = loaded.appended[0]
    const back = overlay.find((node) => node.type === 'button' && /返回|Back/.test(String(node.textContent)))
    assert.ok(back !== undefined, '头部应有返回按钮')
    back.click()

    assert.deepEqual(env.ctx.layout.selected, [null], '点返回应调用 selectPanel(null)')
    assert.equal(overlay.style.display, 'none', '点返回应收起浮层')
  } finally {
    loaded.restore()
  }
})

test('焦点在 iframe 内按 Esc 也能返回（keydown 不跨文档冒泡）', () => {
  const loaded = load()
  try {
    const env = makeCtx()
    loaded.module.apply(env.ctx)
    env.snapshot.activePanelId = 'dsh-chat-demo'
    env.handlers.panel?.()

    const iframe = loaded.created.find((node) => String(node.src).includes('/web/'))
    assert.ok(iframe !== undefined, '应该建了 iframe')
    for (const fn of iframe.listeners.load ?? []) fn()
    assert.equal(loaded.subDocumentKeys.length, 1, 'iframe 载入后应在其文档上挂一个 keydown')

    loaded.subDocumentKeys[0].fn({ key: 'Escape', preventDefault() {}, stopPropagation() {} })
    assert.deepEqual(env.ctx.layout.selected, [null], 'iframe 内的 Esc 应回到对话')
    assert.equal(loaded.appended[0].style.display, 'none')
  } finally {
    loaded.restore()
  }
})

test('卸载时 iframe 内的 Esc 监听也一并撤销', () => {
  const loaded = load()
  try {
    const env = makeCtx()
    loaded.module.apply(env.ctx)
    env.snapshot.activePanelId = 'dsh-chat-demo'
    env.handlers.panel?.()
    const iframe = loaded.created.find((node) => String(node.src).includes('/web/'))
    for (const fn of iframe.listeners.load ?? []) fn()
    assert.equal(loaded.subDocumentKeys.length, 1)

    for (const dispose of env.effector) dispose()
    assert.equal(loaded.subDocumentKeys.length, 0, '卸载后 iframe 内的监听必须清干净')
  } finally {
    loaded.restore()
  }
})

test('面板内还有弹窗/菜单时，Esc 先关它们，不关整个面板', () => {
  const loaded = load()
  try {
    const env = makeCtx()
    loaded.module.apply(env.ctx)
    env.snapshot.activePanelId = 'dsh-chat-demo'
    env.handlers.panel?.()
    const iframe = loaded.created.find((node) => String(node.src).includes('/web/'))
    for (const fn of iframe.listeners.load ?? []) fn()

    // 面板里开着一个弹窗：这次 Esc 属于它，面板不能关。
    iframe.contentDocument.layers = [{ getAttribute: () => null, offsetParent: {}, getClientRects: () => ({ length: 1 }) }]
    loaded.subDocumentKeys[0].fn({ key: 'Escape', preventDefault() {}, stopPropagation() {}, target: { ownerDocument: iframe.contentDocument } })
    assert.deepEqual(env.ctx.layout.selected, [], '还有开着的层时不该退出面板')
    assert.equal(loaded.appended[0].style.display, 'flex')

    // 弹窗关掉之后，Esc 才归面板。
    iframe.contentDocument.layers = []
    loaded.subDocumentKeys[0].fn({ key: 'Escape', preventDefault() {}, stopPropagation() {}, target: { ownerDocument: iframe.contentDocument } })
    assert.deepEqual(env.ctx.layout.selected, [null], '层都关掉后 Esc 应退出面板')
  } finally {
    loaded.restore()
  }
})

test('面板被选中时才建浮层，且 iframe 只建一次（关闭不卸载）', () => {
  const loaded = load()
  try {
    const env = makeCtx()
    loaded.module.apply(env.ctx)
    assert.equal(loaded.appended.length, 0, '一开始不该有浮层')

    // 模拟宿主把面板切到本插件。
    env.snapshot.activePanelId = 'dsh-chat-demo'
    env.handlers.panel?.()
    assert.equal(loaded.appended.length, 1, '选中后应建一个浮层')
    const overlay = loaded.appended[0]
    assert.equal(overlay.style.display, 'flex')
    assert.equal(loaded.document.body.style.overflow, 'hidden', '打开时应锁住 body 滚动')

    // 关闭：只切 display，不摘节点。
    env.snapshot.activePanelId = null
    env.handlers.panel?.()
    assert.equal(overlay.style.display, 'none')
    assert.equal(loaded.document.body.style.overflow, 'auto', '关闭时应还原 body 滚动')

    // 再打开：还是同一个节点，没有第二个浮层。
    env.snapshot.activePanelId = 'dsh-chat-demo'
    env.handlers.panel?.()
    assert.equal(loaded.appended.length, 1, '重开不能新建第二个浮层')
    assert.equal(overlay.style.display, 'flex')
  } finally {
    loaded.restore()
  }
})

test('卸载时浮层被移除、body 滚动锁还原（不留宿主残留）', () => {
  const loaded = load()
  try {
    const env = makeCtx()
    loaded.module.apply(env.ctx)
    env.snapshot.activePanelId = 'dsh-chat-demo'
    env.handlers.panel?.()
    assert.equal(loaded.document.body.style.overflow, 'hidden')

    for (const dispose of env.effector) dispose()
    assert.equal(loaded.appended.length, 0, '卸载后浮层必须被移除')
    assert.equal(loaded.document.body.style.overflow, 'auto', '卸载后滚动锁必须还原')
  } finally {
    loaded.restore()
  }
})

test('Esc 关闭面板并回到对话（selectPanel(null)）', () => {
  const loaded = load()
  try {
    const env = makeCtx()
    loaded.module.apply(env.ctx)
    env.snapshot.activePanelId = 'dsh-chat-demo'
    env.handlers.panel?.()

    const keydown = loaded.listeners.filter((item) => item.name === 'keydown').at(-1)
    assert.ok(keydown !== undefined, '打开时应挂上键盘监听')
    keydown.fn({ key: 'Escape', preventDefault() {}, stopPropagation() {} })
    assert.deepEqual(env.ctx.layout.selected, [null], '关闭应调用 selectPanel(null) 回到对话')
  } finally {
    loaded.restore()
  }
})

test('主题变化只发消息，绝不重写 iframe.src（否则对话被重置）', () => {
  const loaded = load({ scheme: 'light' })
  try {
    const env = makeCtx({ scheme: 'light' })
    loaded.module.apply(env.ctx)
    env.snapshot.activePanelId = 'dsh-chat-demo'
    env.handlers.panel?.()

    const iframe = loaded.created.find((node) => node.title !== undefined && String(node.src).includes('/web/'))
    assert.ok(iframe !== undefined, '应该建了 iframe')
    const before = iframe.src
    env.handlers['theme/change']?.({ active: { colorScheme: 'dark' } })
    assert.equal(iframe.src, before, '切主题不能改 src，否则 iframe 重新加载、对话丢失')
  } finally {
    loaded.restore()
  }
})
