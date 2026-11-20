/**
 * dsh-chat-demo —— 客户端半边
 *
 * 把 chat-demo 的静态产物以**同源 iframe 全屏面板**的形式接进 DSH：
 *
 *   · 原生入口：注册到 `sidebar.panellist`（图标）与 `main`（面板占位），
 *     用户从侧栏点进来，走的是 DSH 自己的面板导航，不是伪造的按钮。
 *   · 面板本体是一个 `position:fixed` 的浮层（顶部让出窗口自己的顶条），
 *     **只在 apply 里创建一次**，关闭时只改 `display`。iframe 因此从不卸载：
 *     来回切面板不会丢对话、不会重连。
 *   · 出口有三条：头部「← 返回」按钮、Esc（父文档与 iframe 内都挂）、以及宿主
 *     原生的「打开会话 / 新建会话」（ui-workspace 自己会 selectPanel(null)）。
 *     浮层有意盖住侧栏，所以前两条必须随时可用 —— 这是本插件最容易出问题的地方。
 *   · 卸载干净：浮层、body 滚动锁、键盘监听（含 iframe 内那份）、消息监听全部随
 *     ctx.effect 的 disposer 一起撤销，宿主 DOM 不留节点，不覆盖任何宿主 CSS 变量。
 *
 * Key 永不出宿主：iframe 只与同源的 /plugins/dsh-chat-demo/api 通信，
 * 由 index.js 在服务端注入凭据。这里只负责把「宿主有没有 Key」这个状态转达给 iframe。
 */
window.__ModuleLoader__.load({
  id: 'dsh-chat-demo',
  factory(require) {
    var React = require('react')
    var h = React.createElement

    /** 侧栏 id 与 main 面板 key 必须是同一个值：侧栏按 id 派发到同名面板。 */
    var PANEL_ID = 'dsh-chat-demo'
    /**
     * 侧栏与面板头部的展示名。固定为上游项目名，不随语言切换：
     * 用「历史对话」会让首次安装的人以为这是一个历史管理页，而不是 chat-demo 本体。
     * 只有展示名用这个常量；PANEL_ID 不能改 —— 它同时是 client.js 的路由、main 面板 key
     * 与导入消息的命名空间。
     */
    var PANEL_LABEL = 'chat-demo'
    var BASE = '/plugins/dsh-chat-demo'
    var WEB_URL = BASE + '/web/'

    /** 与 iframe 约定的消息名，必须和 web-src/inject/host-bridge.ts 保持一致。 */
    var MSG = {
      import: 'chat-demo:import',
      result: 'chat-demo:import-result',
      ready: 'chat-demo:bridge-ready',
      hostStatus: 'chat-demo:host-status',
      statusRequest: 'chat-demo:host-status-request',
      theme: 'chat-demo:theme',
    }

    /** iframe 的沙箱权限。allow-same-origin 是必须的（同源取产物与 API）。 */
    var SANDBOX = 'allow-same-origin allow-scripts allow-forms allow-popups allow-downloads'

    /** 宿主主题 → 'light' | 'dark' */
    var themeOf = function (snapshot) {
      var scheme = snapshot && snapshot.active ? snapshot.active.colorScheme : undefined
      return scheme === 'dark' ? 'dark' : 'light'
    }

    /**
     * 语言：LocaleSnapshot 的字段是 { active, locales, revision }（不是 {id}）。
     *
     * DSH 内置的语言 id 是 `zh` / `en`（dsh-client-locale 的 LOCALE_IDS），
     * 不是 `en-US`。这里按 BCP 47 前缀判定，`en` / `en-US` / `en-GB` 都算英文，
     * 免得宿主哪天把 id 换成区域标签又悄悄退回中文。
     */
    var isEnglish = function (ctx) {
      try {
        var active = ctx.locale.getLocale().active
        return String(active || '').toLowerCase().indexOf('en') === 0
      } catch (error) {
        // 取不到语言时按中文兜底，绝不因为文案而让面板报错。
        void error
        return false
      }
    }

    /**
     * 面板控制器：持有一个长期存在的 iframe。
     *
     * 所有 DOM 都建在 apply 的闭包里、由 effect 统一回收，没有模块级状态，
     * 所以同页重载插件不会残留两份浮层。
     */
    function createController(ctx) {
      var overlay = null
      var frame = null
      var bar = null
      var banner = null
      var paste = null
      var fileInput = null
      /** iframe 内部真正挂上 keydown 的文档，卸载时要按它撤销。 */
      var frameDocument = null
      var ready = false
      var keyStatus = null
      var lastTheme = 'light'
      var requestId = 0
      var pendingRequests = {}
      var previousOverflow = null
      var visible = false

      var t = function (zh, en) {
        return isEnglish(ctx) ? en : zh
      }

      var api = function (path, init) {
        return fetch(BASE + path, Object.assign({ credentials: 'same-origin' }, init || {}))
      }

      // ── 浮层搭建 ─────────────────────────────────────────────────────

      var style = function (node, css) {
        for (var key in css) {
          // 带连字符的属性（-webkit-app-region 等）只能走 setProperty：
          // style['-webkit-app-region'] = ... 在真浏览器里是无效赋值，会被静默丢掉。
          if (key.indexOf('-') >= 0 && typeof node.style.setProperty === 'function') {
            node.style.setProperty(key, css[key])
          } else {
            node.style[key] = css[key]
          }
        }
        return node
      }

      function buildOverlay() {
        var el = document.createElement('div')
        el.dataset.dshChatDemo = 'panel'
        style(el, {
          position: 'fixed',
          // 四边分开写而不是 inset:0：顶部必须让出窗口自己的顶条，否则浮层会压住
          // Windows 的 40px 标题栏（连窗口按钮都点不到）与 macOS 的顶部条。
          // 这两个平台上 --dsh-frame-top-clearance 由宿主声明（Windows 等于标题栏高度），
          // 纯 web 端没有这个变量，回落到 0。
          top: 'var(--dsh-frame-top-clearance, 0px)',
          right: '0',
          bottom: '0',
          left: '0',
          display: 'none',
          zIndex: '2147483000',
          background: 'var(--dsw-alias-bg-base, #fff)',
          color: 'var(--dsw-alias-label-primary, inherit)',
          // 桌面端的窗口拖动区是**几何**判定、不看层叠：宿主那条 40px 高的
          // -webkit-app-region: drag 拖动条会盖到浮层头上，把点击变成拖窗口。
          // 浮层必须自己声明 no-drag 才能把这块从拖动区里挖回来。
          '-webkit-app-region': 'no-drag',
          flexDirection: 'column',
        })

        var header = document.createElement('div')
        style(header, {
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '6px 10px',
          borderBottom: '1px solid rgba(127,127,127,.28)',
          font: '13px/1.4 system-ui, sans-serif',
          flex: '0 0 auto',
        })

        /** 头部按钮。extra 用来叠加「返回」这种主操作自己的强调样式。 */
        var button = function (label, onClick, extra) {
          var b = document.createElement('button')
          b.type = 'button'
          b.textContent = label
          style(b, {
            font: '12px/1 system-ui, sans-serif',
            padding: '6px 10px',
            borderRadius: '6px',
            border: '1px solid rgba(127,127,127,.35)',
            background: 'transparent',
            color: 'inherit',
            cursor: 'pointer',
            flex: '0 0 auto',
          })
          if (extra) style(b, extra)
          b.addEventListener('click', onClick)
          return b
        }

        // 返回是**第一顺位**的控件，必须随时可见可点：全屏浮层盖住了侧栏，
        // 没有它用户就只能靠 Esc 出去，而 Esc 在焦点落进 iframe 时并不可靠。
        var backButton = button(t('← 返回', '← Back'), function () {
          close()
        }, {
          font: '600 12px/1 system-ui, sans-serif',
          // 主操作给一点对比度，但颜色仍取自宿主 token，跟随主题。
          background: 'rgba(127,127,127,.16)',
        })
        backButton.setAttribute('aria-label', t('返回工作页面', 'Back to the workspace'))
        backButton.title = t('返回工作页面（Esc）', 'Back to the workspace (Esc)')

        var title = document.createElement('strong')
        title.textContent = PANEL_LABEL
        style(title, { marginRight: 'auto', font: '600 13px/1.4 system-ui, sans-serif' })

        var importButton = button(t('导入历史', 'Import history'), function () {
          fileInput.click()
        })
        var pasteButton = button(t('粘贴导入', 'Paste import'), function () {
          togglePaste(true)
        })
        var closeButton = button(t('关闭 (Esc)', 'Close (Esc)'), function () {
          close()
        })

        fileInput = document.createElement('input')
        fileInput.type = 'file'
        fileInput.accept = '.zip,.json,application/zip,application/json'
        fileInput.style.display = 'none'
        fileInput.addEventListener('change', function () {
          var file = fileInput.files && fileInput.files[0]
          fileInput.value = ''
          if (file) void sendFile(file)
        })

        header.append(backButton, title, importButton, pasteButton, closeButton, fileInput)

        banner = document.createElement('div')
        banner.dataset.dshChatDemo = 'key-banner'
        style(banner, {
          display: 'none',
          alignItems: 'center',
          gap: '8px',
          padding: '8px 10px',
          background: 'rgba(190,80,80,.14)',
          borderBottom: '1px solid rgba(190,80,80,.4)',
          font: '12px/1.5 system-ui, sans-serif',
          flex: '0 0 auto',
        })

        var bannerText = document.createElement('span')
        bannerText.textContent = t(
          '宿主未配置可用 Key：请在 DSH 中配置 DEEPSEEK_API_KEY，或在此一次性填入（只保存在宿主内存）。',
          'No usable key on the host: set DEEPSEEK_API_KEY in DSH, or enter one here (host memory only).'
        )
        style(bannerText, { marginRight: 'auto' })

        var keyInput = document.createElement('input')
        keyInput.type = 'password'
        keyInput.placeholder = 'sk-...'
        keyInput.autocomplete = 'off'
        style(keyInput, {
          font: '12px/1 system-ui, sans-serif',
          padding: '6px 8px',
          borderRadius: '6px',
          border: '1px solid rgba(127,127,127,.4)',
          background: 'transparent',
          color: 'inherit',
          width: '220px',
        })

        var keySubmit = button(t('应用', 'Apply'), function () {
          var value = keyInput.value.trim()
          if (value === '') return
          keyInput.value = ''
          void api('/key', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ key: value }),
          })
            .then(function (response) {
              return response.json()
            })
            .then(function (body) {
              applyKeyStatus(body && body.key === 'ok' ? 'ok' : 'missing')
            })
            .catch(function () {
              applyKeyStatus('missing')
            })
        })

        banner.append(bannerText, keyInput, keySubmit)

        paste = document.createElement('div')
        paste.dataset.dshChatDemo = 'paste'
        style(paste, {
          display: 'none',
          gap: '6px',
          padding: '8px 10px',
          borderBottom: '1px solid rgba(127,127,127,.28)',
          flex: '0 0 auto',
          flexDirection: 'column',
        })

        var pasteArea = document.createElement('textarea')
        pasteArea.placeholder = t(
          '把 chat_sessions/<会话id>.json 的内容粘贴到这里（或整个 chat_session_index.json 所在目录里任意一个会话文件）',
          'Paste the contents of one chat_sessions/<session-id>.json here'
        )
        pasteArea.rows = 4
        style(pasteArea, {
          font: '12px/1.5 ui-monospace, monospace',
          padding: '6px 8px',
          borderRadius: '6px',
          border: '1px solid rgba(127,127,127,.4)',
          background: 'transparent',
          color: 'inherit',
          resize: 'vertical',
          width: '100%',
          boxSizing: 'border-box',
        })

        var pasteActions = document.createElement('div')
        style(pasteActions, { display: 'flex', gap: '8px', justifyContent: 'flex-end' })
        pasteActions.append(
          button(t('取消', 'Cancel'), function () {
            togglePaste(false)
          }),
          button(t('导入', 'Import'), function () {
            var text = pasteArea.value.trim()
            if (text === '') return
            send({ text: text, source: 'json' })
            pasteArea.value = ''
            togglePaste(false)
          })
        )
        paste.append(pasteArea, pasteActions)

        var stage = document.createElement('div')
        style(stage, { flex: '1 1 auto', position: 'relative', minHeight: '0' })

        // iframe 一旦建好就不再重建：切面板只切 display，对话状态与连接都留着。
        frame = document.createElement('iframe')
        frame.src = WEB_URL + '?theme=' + encodeURIComponent(lastTheme)
        frame.title = t('chat-demo 面板', 'chat-demo panel')
        frame.setAttribute('sandbox', SANDBOX)
        frame.setAttribute('allow', 'clipboard-write')
        style(frame, { border: '0', width: '100%', height: '100%', display: 'block', background: 'transparent' })
        frame.addEventListener('load', function () {
          ready = true
          pushTheme()
          if (keyStatus !== null) postKeyStatus()
          bindFrameKeys()
        })

        stage.append(frame)
        el.append(header, banner, paste, stage)
        document.body.append(el)

        overlay = el
        bar = header
        return el
      }

      // ── 显示/隐藏 ────────────────────────────────────────────────────

      function lockScroll() {
        if (previousOverflow !== null) return
        previousOverflow = document.body.style.overflow
        document.body.style.overflow = 'hidden'
      }

      function unlockScroll() {
        if (previousOverflow === null) return
        document.body.style.overflow = previousOverflow
        previousOverflow = null
      }

      function show() {
        if (overlay === null) buildOverlay()
        if (visible) return
        visible = true
        overlay.style.display = 'flex'
        lockScroll()
        document.addEventListener('keydown', onKeydown, true)
        // 打开时问一次宿主 Key 状态：可能上次打开后才在 DSH 里配好。
        void refreshKeyStatus()
        void drainPending()
      }

      function hide() {
        if (overlay === null || !visible) return
        visible = false
        overlay.style.display = 'none'
        unlockScroll()
        document.removeEventListener('keydown', onKeydown, true)
      }

      /** 关闭 = 隐藏浮层 + 把主区还给对话，不是卸载 iframe。 */
      function close() {
        hide()
        try {
          // 契约：selectPanel(null) 表示「显示 Conversation」，且不改变当前会话。
          ctx.layout.selectPanel(null)
        } catch (error) {
          // 极端组合下若面板已不在，仅隐藏即可；不把内部错误抛给用户。
          console.error('dsh-chat-demo: could not restore the conversation panel', error)
        }
      }

      /** 面板内「浮在最上面的那一层」：弹窗、菜单、下拉。Esc 应当先关它们。 */
      var LAYER_SELECTOR = '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"]'

      /**
       * 事件所在文档里是否还有打开的层。
       *
       * 上游的弹窗（Modal.tsx）与部分下拉是在 document 上监听 Esc 的**冒泡**阶段，
       * 并且**不** stopPropagation —— 我们这份监听会更早注册、也就更早执行，
       * 于是「按 Esc 关弹窗」会被我们抢成「关整个面板」。这里先问一句
       * 「这层还开着吗」，是就把 Esc 让给它们；等它们真关掉了，下一次 Esc 才归我们。
       */
      function hasOpenLayer(doc) {
        if (!doc || typeof doc.querySelectorAll !== 'function') return false
        try {
          var nodes = doc.querySelectorAll(LAYER_SELECTOR)
          for (var i = 0; i < nodes.length; i += 1) {
            var node = nodes[i]
            if (node.getAttribute('aria-hidden') === 'true') continue
            // 只认真正渲染出来的层：display:none 或已卸载的不算。
            if (node.offsetParent !== null) return true
            if (typeof node.getClientRects === 'function' && node.getClientRects().length > 0) return true
          }
        } catch (error) {
          // 取不到就当没有层：宁可 Esc 退出面板，也不要 Esc 完全没反应。
          void error
        }
        return false
      }

      function onKeydown(event) {
        if (event.key !== 'Escape' || !visible) return
        // 先让面板自己的弹窗/菜单消费这次 Esc（见 hasOpenLayer 的说明）。
        var source = event.target && event.target.ownerDocument
        if (source && source !== document && hasOpenLayer(source)) return
        event.preventDefault()
        event.stopPropagation()
        close()
      }

      /**
       * 把 Esc 的监听补进 iframe 自己的文档。
       *
       * 为什么需要：keydown 只在焦点所在的那个文档里派发并冒泡，**不会跨文档传到父页面**。
       * 用户一旦点了聊天输入框，Esc 就只在 iframe 内部生效，父文档那个监听收不到 ——
       * 于是「按 Esc 返回」在最常见的场景里是失效的。这里同源（sandbox 带
       * allow-same-origin）所以能直接挂监听；任何跨源/Timing 异常都静默降级，
       * 头部「返回」按钮与父文档 Esc 仍然可用。
       *
       * 挂在**冒泡**阶段而不是捕获阶段是有意的：面板内的弹窗/下拉用
       * `document.addEventListener('keydown', fn, true)` + `stopPropagation()` 吃掉 Esc
       * （见上游 anchored.ts 的 useDismiss），捕获会在它们之前跑、把「关弹窗」变成「关面板」。
       * 冒泡阶段让它们先消费；剩下那些**不** stopPropagation 的层（Modal.tsx）由
       * onKeydown 里的 hasOpenLayer 判定让出去。
       */
      function bindFrameKeys() {
        unbindFrameKeys()
        if (frame === null) return
        try {
          var target = frame.contentDocument
          if (!target) return
          target.addEventListener('keydown', onKeydown)
          frameDocument = target
        } catch (error) {
          // 跨源或文档还没就绪：不把它变成用户可见的故障。
          console.warn('dsh-chat-demo: could not mirror Escape into the panel', error)
        }
      }

      /** 只撤销、不重建：iframe 每次 load 都先调它，避免重复挂同一个处理器。 */
      function unbindFrameKeys() {
        if (frameDocument === null) return
        try {
          frameDocument.removeEventListener('keydown', onKeydown)
        } catch (error) {
          void error
        }
        frameDocument = null
      }

      function togglePaste(next) {
        paste.style.display = next ? 'flex' : 'none'
      }

      // ── 与 iframe 通信 ───────────────────────────────────────────────

      function post(message) {
        if (frame === null) return
        // 同源目标，收窄 targetOrigin 而不是 '*'，避免消息被别处读到。
        frame.contentWindow.postMessage(message, window.location.origin)
      }

      function pushTheme() {
        if (!ready) return
        post({ type: MSG.theme, theme: lastTheme })
      }

      function postKeyStatus() {
        if (!ready) return
        post({ type: MSG.hostStatus, key: keyStatus === 'ok' ? 'ok' : 'missing' })
      }

      function applyKeyStatus(next) {
        keyStatus = next
        if (banner !== null) banner.style.display = next === 'ok' ? 'none' : 'flex'
        postKeyStatus()
      }

      function refreshKeyStatus() {
        return api('/status')
          .then(function (response) {
            return response.json()
          })
          .then(function (body) {
            applyKeyStatus(body && body.key === 'ok' ? 'ok' : 'missing')
          })
          .catch(function () {
            // 控制面取不到时按「未配置」显示：宁可提示过度，也不让用户以为能发消息。
            applyKeyStatus('missing')
          })
      }

      /**
       * 把一份载荷送进 iframe，等它的回执。
       *
       * 面板只做搬运与报数展示，合并规则、备份、幂等全在 iframe 内的导入桥里 ——
       * 那里才拿得到 IndexedDB。这里的 requestId 用来把异步回执对应回这次请求。
       */
      function send(payload) {
        if (!ready) {
          return Promise.reject(new Error(t('面板还在加载，请稍候。', 'The panel is still loading.')))
        }
        requestId += 1
        var id = String(requestId)
        var promise = new Promise(function (resolve, reject) {
          pendingRequests[id] = { resolve: resolve, reject: reject }
          // 大 ZIP 解析 + 备份下载可能较久；给足 10 分钟后按超时失败。
          setTimeout(function () {
            if (pendingRequests[id] !== undefined) {
              delete pendingRequests[id]
              reject(new Error(t('导入超时。', 'Import timed out.')))
            }
          }, 10 * 60 * 1000)
        })
        post({ type: MSG.import, requestId: id, payload: payload })
        return promise
      }

      /** File → base64。跨 realm 拿不到 File 的对象身份也没关系，只取字节。 */
      function readAsBase64(file) {
        return new Promise(function (resolve, reject) {
          var reader = new FileReader()
          reader.onerror = function () {
            reject(new Error(t('读取文件失败。', 'Could not read the file.')))
          }
          reader.onload = function () {
            var result = String(reader.result || '')
            var comma = result.indexOf(',')
            resolve(comma < 0 ? '' : result.slice(comma + 1))
          }
          reader.readAsDataURL(file)
        })
      }

      function sendFile(file) {
        return readAsBase64(file)
          .then(function (base64) {
            if (base64 === '') throw new Error(t('文件是空的。', 'The file is empty.'))
            return send({
              base64: base64,
              name: file.name,
              source: file.name.slice(-4).toLowerCase() === '.zip' ? 'zip' : 'json',
            })
          })
          .then(report, reportError)
      }

      function report(result) {
        var lines = [
          t('已新增 ', 'Added ') + result.added,
          t('已更新 ', 'updated ') + result.updated,
          t('已跳过 ', 'skipped ') + result.skipped,
        ]
        if (result.failed > 0) lines.push(t('失败 ', 'failed ') + result.failed)
        var text = lines.join(' · ')
        if (result.backup) {
          // 浏览器无法静默落盘：备份是一次下载，必须如实说明「没看到就重来」。
          text +=
            '\n' +
            t('导入前已自动备份为 ', 'Auto-backup before import: ') +
            result.backup +
            t('（若没看到下载，请允许下载后重试）', ' (if no download appeared, allow downloads and retry)')
        }
        showToast(text, 'ok')
        return result
      }

      function reportError(error) {
        showToast((error && error.message) || String(error), 'error')
        throw error
      }

      /** 面板内的轻提示：自建节点，不写宿主 DOM 的其它位置，随浮层一起销毁。 */
      var toastTimer = 0
      function showToast(message, kind) {
        if (overlay === null) return
        var node = overlay.querySelector('[data-dsh-chat-demo="toast"]')
        if (node === null) {
          node = document.createElement('div')
          node.dataset.dshChatDemo = 'toast'
          node.setAttribute('role', 'status')
          style(node, {
            position: 'absolute',
            right: '16px',
            bottom: '16px',
            maxWidth: 'min(560px, calc(100vw - 48px))',
            whiteSpace: 'pre-wrap',
            padding: '10px 14px',
            borderRadius: '10px',
            font: '12px/1.5 system-ui, sans-serif',
            color: '#fff',
            boxShadow: '0 6px 24px rgba(0,0,0,.28)',
            zIndex: '1',
          })
          overlay.append(node)
        }
        node.style.background = kind === 'error' ? '#8a2c2c' : '#2c6a3f'
        node.textContent = message
        node.style.display = 'block'
        window.clearTimeout(toastTimer)
        toastTimer = window.setTimeout(function () {
          node.style.display = 'none'
        }, kind === 'error' ? 8000 : 6000)
      }

      // ── 扩展投递（L2）的取件 ────────────────────────────────────────

      /**
       * 扩展把载荷 POST 到宿主 /import，宿主暂存在内存里 5 分钟。
       * 面板打开时取一次：取走即失效，所以不会重复导入。
       */
      function drainPending() {
        return api('/import/pending')
          .then(function (response) {
            return response.json()
          })
          .then(function (body) {
            var pending = body && body.pending
            if (!pending || !ready) return
            // 宿主暂存的一定是已解析的 JSON（扩展提交的是 base64 或会话数组）。
            // 原样交给导入桥的归一化器判断，这里不预设类型。
            return send({
              text: JSON.stringify(pending.payload),
              source: 'extension',
            }).then(report, reportError)
          })
          .catch(function () {
            // 没有待处理载荷或控制面不可用：静默跳过，不打扰用户。
          })
      }

      // ── 消息与主题 ──────────────────────────────────────────────────

      function onWindowMessage(event) {
        if (frame === null || event.source !== frame.contentWindow) return
        if (event.origin !== window.location.origin) return
        var data = event.data
        if (typeof data !== 'object' || data === null) return
        if (data.type === MSG.ready) {
          ready = true
          pushTheme()
          if (keyStatus !== null) postKeyStatus()
          return
        }
        if (data.type === MSG.statusRequest) {
          // iframe 挂载后主动来问；此时我们可能还没查过状态。
          if (keyStatus === null) void refreshKeyStatus()
          else postKeyStatus()
          return
        }
        if (data.type === MSG.result) {
          var pending = pendingRequests[data.requestId]
          if (pending === undefined) return
          delete pendingRequests[data.requestId]
          if (data.ok) pending.resolve(data.result)
          else pending.reject(new Error(data.error || t('导入失败。', 'Import failed.')))
        }
      }

      function onTheme(snapshot) {
        var next = themeOf(snapshot)
        if (next === lastTheme) return
        lastTheme = next
        // 只发消息，**绝不重写 frame.src**：改 src 会让 iframe 重新加载，
        // 正在进行的对话与流式连接全部丢失（关闭/切换面板不得卸载 iframe）。
        pushTheme()
      }

      function onPanelChange() {
        var snapshot = ctx.layout.panelInfo.getSnapshot()
        if (snapshot.activePanelId === PANEL_ID) show()
        else hide()
      }

      return {
        start: function () {
          lastTheme = themeOf(ctx.theme.getTheme())
          var offTheme = ctx.on('theme/change', onTheme)
          var offPanel = ctx.layout.panelInfo.subscribe(onPanelChange)
          window.addEventListener('message', onWindowMessage)
          // 首帧就对齐现有状态：刷新时若本来就停在本面板，应当立刻显示。
          onPanelChange()
          return function () {
            window.removeEventListener('message', onWindowMessage)
            offTheme()
            offPanel()
            hide()
            unbindFrameKeys()
            window.clearTimeout(toastTimer)
            if (overlay !== null) {
              overlay.remove()
              overlay = null
              frame = null
              banner = null
              paste = null
              fileInput = null
              ready = false
            }
          }
        },
        show: show,
        hide: hide,
        isVisible: function () {
          return visible
        },
      }
    }

    /** 侧栏图标：只用 currentColor，跟随宿主主题，不自带颜色。 */
    function PanelIcon(props) {
      var size = props.size || 20
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('path', { d: 'M4 5.5h16v11H9.5L4 20V5.5z' }),
        h('path', { d: 'M8.5 9.5h7M8.5 12.5h4.5' })
      )
    }

    /**
     * main 面板的占位：真正的界面在同源 iframe 浮层里。
     *
     * 为什么还要注册：`sidebar.panellist` 的每一项都按 id 派发到同名 main 面板，
     * 不注册的话点图标会因为没有对应面板而报错。这里保持空渲染，让浮层独占视线。
     */
    function PanelSlot() {
      return null
    }

    return {
      name: PANEL_ID,
      inject: ['slots', 'layout', 'theme', 'locale'],
      apply: function (ctx) {
        var controller = createController(ctx)
        // 直接注册（而不是等 slots.inject 的回调）是为了让面板能在宿主面板切换时
        // 被立即点亮；start() 返回的清理函数统一挂在 effect 上，卸载即撤销。
        ctx.effect(function () {
          return controller.start()
        }, 'dsh-chat-demo: panel')

        ctx.slots.inject('sidebar.panellist', function () {
          return ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 30,
              // thunk：每次投影都重读。展示名不随语言变化，但保持 thunk 形态，
              // 语言切换时宿主重新投影的路径不变。
              label: function () {
                return PANEL_LABEL
              },
            },
            PanelIcon
          )
        })

        ctx.slots.inject('main', function () {
          return ctx.slots.register({ name: 'main', key: PANEL_ID }, PanelSlot)
        })
      },
    }
  },
})
