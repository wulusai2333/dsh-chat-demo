#!/usr/bin/env node
/**
 * 把上游 chat-demo 的固定提交 vendor 到 web-src/upstream/，施加本插件的补丁，
 * 再用上游自己的 rspack 配置构建，产物拷到 web/。
 *
 * 为什么是「重放式补丁」而不是直接改一份拷贝：
 * 上游会持续更新。补丁若只存在于磁盘上，升级时没人知道改过什么、也说不清是否还成立。
 * 这里把每一处改动写成 (锚点, 替换) 的可执行条目，标记已存在即跳过（幂等），
 * 找不到锚点就立刻报错停下（说明上游实现变了，必须人工确认），绝不静默跳过。
 *
 * 本插件只允许三处上游改动：
 *   ① rspack.config.ts 注入 apiOrigin
 *   ② 新增 ?theme= 读取
 *   ③ 新增一个导入入口
 * 补丁清单严格对应这三条 + 本项目自己新增的文件，不改上游任何业务逻辑。
 *
 * 用法：
 *   node scripts/prepare-web.mjs            有 web-src/upstream 就直接重建
 *   node scripts/prepare-web.mjs --clean    删掉 web-src/upstream 重新 vendor
 *   node scripts/prepare-web.mjs --skip-install
 *   node scripts/prepare-web.mjs --upstream <path-or-url>
 *                                           从指定的上游克隆/镜像拉取（默认走 GitHub）
 */

import { cpSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
/** 上游仓库。默认从 GitHub 拉；离线或内网环境用 --upstream 指定本地克隆/镜像。 */
const UPSTREAM_REMOTE = 'https://github.com/deepseek-ai/chat-demo.git'
const PINNED_COMMIT = '5d5dd754ebc1948e977ddb880a9eb5aa25f37b4c'

const SRC = join(ROOT, 'web-src')
const UPSTREAM = join(SRC, 'upstream')
const DIST = join(UPSTREAM, 'dist')
const OUT = join(ROOT, 'web')

const args = new Set(process.argv.slice(2))

const step = (message) => console.log(`\n=== ${message}`)
const info = (message) => console.log(`    ${message}`)
const fail = (message, hint) => {
  console.error(`\n✗ ${message}`)
  if (hint) {
    console.error(`${hint.split('\n').map((line) => `  ${line}`).join('\n')}`)
  }
  process.exit(1)
}

const mustExist = (path, message) => {
  if (!existsSync(path)) {
    fail(message, `缺失路径：${path}`)
  }
}

const run = (command, args, cwd) => {
  execFileSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
}

/**
 * 从 `--upstream <path-or-url>` 取上游地址。
 *
 * 刻意**不做**「隔壁目录存在就静默用它」：那会让构建结果依赖某台机器的目录布局，
 * 别人 clone 下来必然失败，而维护者又察觉不到自己的脚本已经不可移植。
 * 要复用本地克隆就显式传参 —— 参数进了命令行才是可复现的。
 * @returns {string} git 可接受的 path 或 URL
 */
const upstreamSource = () => {
  const argv = process.argv.slice(2)
  const at = argv.indexOf('--upstream')
  if (at < 0) {
    return UPSTREAM_REMOTE
  }
  const value = argv[at + 1]
  if (value === undefined || value === '' || value.startsWith('--')) {
    fail('--upstream 需要一个值', '例：--upstream https://github.com/deepseek-ai/chat-demo.git')
  }
  return value
}

// ── 1. vendor ───────────────────────────────────────────────────────────────

const ensureVendored = () => {
  if (args.has('--clean') && existsSync(UPSTREAM)) {
    step('清理旧的上游副本')
    rmSync(UPSTREAM, { recursive: true, force: true })
  }
  if (existsSync(join(UPSTREAM, '.git'))) {
    info('上游副本已存在')
    return
  }
  const source = upstreamSource()
  step(`vendor 上游 @ ${PINNED_COMMIT.slice(0, 8)}（来自 ${source}）`)
  mkdirSync(SRC, { recursive: true })
  // --no-hardlinks：从本地目录 clone 时不要把 object 硬链过去，
  // 否则后续对副本的改动会顺着硬链污染源仓库的工作副本。
  try {
    run('git', ['clone', '--no-hardlinks', source, UPSTREAM])
  } catch {
    fail(
      `无法从 ${source} 克隆上游`,
      [
        '确认网络可达，或改用本地克隆：',
        `  node scripts/prepare-web.mjs --upstream /path/to/chat-demo`,
      ].join('\n')
    )
  }
  run('git', ['checkout', '--detach', PINNED_COMMIT], UPSTREAM)
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: UPSTREAM, encoding: 'utf8' }).trim()
  if (head !== PINNED_COMMIT) {
    fail('上游提交与钉住的不一致', `期望 ${PINNED_COMMIT}\n实际 ${head}`)
  }
  info(`已检出 ${head.slice(0, 8)}`)
}

// ── 2. 读文件：统一行尾 ──────────────────────────────────────────────────────

/**
 * Windows 检出是 CRLF，而补丁锚点是用 \n 写的多行字符串。
 * 不统一行尾的话 `includes(anchor)` 会失败，报错看起来像「上游改了实现」，
 * 实际只是换行符不同 —— 这个坑必须由脚本自己处理掉。
 */
const readSource = (relative) => {
  const full = join(UPSTREAM, relative)
  mustExist(full, `上游文件缺失：${relative}`)
  const text = readFileSync(full, 'utf8')
  const crlf = text.includes('\r\n')
  return {
    text: text.replace(/\r\n/g, '\n'),
    write: (next) => writeFileSync(full, crlf ? next.replace(/\n/g, '\r\n') : next),
  }
}

/** 幂等替换：marker 已存在即跳过；from 找不到即报错 */
const replaceOnce = (relative, marker, from, to) => {
  const source = readSource(relative)
  if (source.text.includes(marker)) {
    info(`${relative}: 补丁已存在，跳过`)
    return
  }
  if (!source.text.includes(from)) {
    fail(
      `${relative}: 找不到锚点，无法打补丁`,
      [
        '上游实现已变更，需要人工确认新位置后更新 scripts/prepare-web.mjs。',
        `期望锚点：${JSON.stringify(from.slice(0, 120))}`,
      ].join('\n')
    )
  }
  source.write(source.text.replace(from, to))
  info(`${relative}: 已打补丁`)
}

// ── 3. 注入本项目自己的源码 ─────────────────────────────────────────────────

/**
 * 本项目新增到上游源码树里的文件，`from` 相对项目根、`to` 相对上游副本。
 *
 * sync/ 下的两个 .js 刻意放在仓库根的 sync/ 而不是 web-src/inject/：
 * 它们是纯 JS、零依赖，既能被注入产物，也能被 tests/ 在 Node 里直接 import 来测幂等性。
 * 若放在 web-src/inject/ 就只能被注入，测试还得再拷一份，两份必然漂移。
 */
const injectSources = () => {
  const sources = [
    ['web-src/inject/host-bridge.ts', 'src/host-bridge.ts'],
    // 归档 → 内存会话的解析器。上游把这段逻辑写死在 importArchive 里且直接落库，
    // 合并需要先拿到会话再写，所以复制一份「只解析不落库」的版本（见文件头注释）。
    ['web-src/inject/sync-archive.ts', 'src/sync/archive.ts'],
    ['sync/normalize.js', 'src/sync/normalize.js'],
    ['sync/merge.js', 'src/sync/merge.js'],
    // 上面两个是纯 JS，上游 tsconfig 是 strict + noImplicitAny，没有声明文件会在
    // 类型检查时报 TS7016。声明只服务类型，rspack 的 extensionAlias 不含 .d.ts，不进产物。
    ['web-src/inject/sync-normalize.d.ts', 'src/sync/normalize.d.ts'],
    ['web-src/inject/sync-merge.d.ts', 'src/sync/merge.d.ts'],
  ]
  for (const [from, to] of sources) {
    const source = join(ROOT, from)
    mustExist(source, `缺少注入源文件 ${from}`)
    const target = join(UPSTREAM, to)
    mkdirSync(dirname(target), { recursive: true })
    cpSync(source, target)
    info(`注入 ${from} → ${to}`)
  }
}

// ── 4. 补丁 ─────────────────────────────────────────────────────────────────

const applyPatches = () => {
  // ① rspack.config.ts：把 API 根改成本插件自己的同源代理前缀。
  //    上游把 apiOrigin 作为 createConfig 的参数暴露出来，正是为这种用法准备的；
  //    这里只改默认值，不动 createConfig 的任何逻辑。
  replaceOnce(
    'rspack.config.ts',
    'dsh-chat-demo: proxy apiOrigin',
    "  apiOrigin = 'https://api.deepseek.com',",
    [
      '  // dsh-chat-demo: proxy apiOrigin —— 产物必须只与同源代理通信，',
      '  // 由宿主半边注入凭据；浏览器里永远不出现 Key。',
      "  apiOrigin = '/plugins/dsh-chat-demo/api',"
    ].join('\n')
  )

  // ①b rspack.config.ts：把 publicPath 从 'auto' 改成**挂载点的绝对前缀**。
  //
  //      'auto' 由浏览器按「当前文档地址」推断基准路径，只在「index.html 与 static/ 同级」
  //      的常规部署下正确。本插件的 SPA 回退会把任意未知路径（如 /web/conversation/abc）
  //      也返回 index.html，此时 'auto' 推出的基准是 /web/conversation/，去那里找
  //      static/js/... 必然 404 —— 面板整页白屏。
  //      固定成绝对前缀后，无论从哪个 URL 进入，资源都指向同一个真实目录。
  replaceOnce(
    'rspack.config.ts',
    'dsh-chat-demo: absolute publicPath',
    "    publicPath: 'auto',",
    [
      '    // dsh-chat-demo: absolute publicPath —— 必须固定，不能跟随文档地址推断，',
      '    // 否则 SPA 回退出来的深层 URL 会把资源相对路径解析到不存在的目录。',
      "    publicPath: '/plugins/dsh-chat-demo/web/',"
    ].join('\n')
  )

  // ② app/theme.ts：新增 ?theme= 读取 + postMessage 实时同步。
  //    上游主题偏好存 localStorage（'light' | 'dark' | 'system'），默认跟随系统。
  //    嵌在 iframe 里时「系统」是宿主所在机器的系统，与宿主实际主题未必一致，
  //    所以宿主通过 ?theme= 与 postMessage 下发实际生效的深浅色，覆盖偏好。
  replaceOnce(
    'src/app/theme.ts',
    'dsh-chat-demo: host theme override',
    'let appliedTheme: Theme | null = null',
    [
      '/**',
      ' * 宿主下发的主题；dsh-chat-demo: host theme override 新增。',
      ' * null 表示没有宿主主题，回落到上游的「偏好 / 跟随系统」逻辑。',
      ' */',
      'let hostTheme: Theme | null = null',
      '',
      '/** 宿主主题是外部状态，必须能被 useSyncExternalStore 订阅，否则 useTheme() 不会重渲染。 */',
      'const hostThemeListeners = new Set<() => void>()',
      '',
      'const subscribeHostTheme = (listener: () => void) => {',
      '  hostThemeListeners.add(listener)',
      '  return () => {',
      '    hostThemeListeners.delete(listener)',
      '  }',
      '}',
      '',
      'const getHostTheme = (): Theme | null => hostTheme',
      '',
      '/** 从 ?theme= 读宿主主题；非法值忽略，回落到上游的主题偏好。 */',
      'const readHostTheme = (): Theme | null => {',
      '  try {',
      "    const value = new URLSearchParams(window.location.search).get('theme')",
      "    return value === 'light' || value === 'dark' ? value : null",
      '  } catch {',
      '    return null',
      '  }',
      '}',
      '',
      '/** 宿主主题改变后通知订阅者并重新应用页面主题；?theme= 与 postMessage 走同一条路径。 */',
      'const setHostTheme = (theme: Theme | null) => {',
      '  if (theme === hostTheme) {',
      '    return',
      '  }',
      '  hostTheme = theme',
      '  for (const listener of hostThemeListeners) {',
      '    listener()',
      '  }',
      '  syncTheme()',
      '}',
      '',
      'let appliedTheme: Theme | null = null',
    ].join('\n')
  )

  // useTheme() 是组件读主题的唯一入口（MermaidDiagram 等），必须一起认宿主主题。
  // 只改 syncTheme 不够：那只会切换 body 的 class，组件仍按系统色渲染图表。
  replaceOnce(
    'src/app/theme.ts',
    'dsh-chat-demo: host theme in useTheme',
    [
      'export const useTheme = (): Theme => {',
      '  const preference = useSettings((state) => state.themePreference)',
      '  const osTheme = useSyncExternalStore(subscribeOsTheme, getOsTheme)',
      '  return resolveTheme(preference, osTheme)',
      '}',
    ].join('\n'),
    [
      'export const useTheme = (): Theme => {',
      '  const preference = useSettings((state) => state.themePreference)',
      '  const osTheme = useSyncExternalStore(subscribeOsTheme, getOsTheme)',
      '  // dsh-chat-demo: host theme in useTheme —— 宿主下发过主题时以它为准。',
      '  // 订阅而非直接读变量，否则宿主切换主题后组件不会重渲染。',
      '  const hosted = useSyncExternalStore(subscribeHostTheme, getHostTheme)',
      '  return hosted ?? resolveTheme(preference, osTheme)',
      '}',
    ].join('\n')
  )

  replaceOnce(
    'src/app/theme.ts',
    'dsh-chat-demo: host theme wins',
    'const syncTheme = () => {\n  const theme = resolveTheme(useSettings.getState().themePreference, getOsTheme())',
    [
      'const syncTheme = () => {',
      '  // dsh-chat-demo: host theme wins —— 宿主下发过主题时以它为准；',
      '  // 上游的「跟随系统」在 iframe 里读到的是宿主机系统，语义上不等价。',
      '  const theme =',
      '    hostTheme ?? resolveTheme(useSettings.getState().themePreference, getOsTheme())'
    ].join('\n')
  )

  replaceOnce(
    'src/app/theme.ts',
    'dsh-chat-demo: subscribe host theme',
    '  query.addEventListener(\'change\', syncTheme)\n  useSettings.subscribe(syncTheme)',
    [
      '  // dsh-chat-demo: subscribe host theme —— 初始值来自 ?theme=，',
      '  // 之后由宿主 postMessage({type: "chat-demo:theme", theme}) 实时下发。',
      '  setHostTheme(readHostTheme())',
      '  window.addEventListener(\'message\', (event: MessageEvent) => {',
      '    const data: unknown = event.data',
      '    if (typeof data !== \'object\' || data === null) {',
      '      return',
      '    }',
      '    const message = data as { type?: unknown; theme?: unknown }',
      '    if (message.type !== \'chat-demo:theme\') {',
      '      return',
      '    }',
      "    setHostTheme(message.theme === 'light' || message.theme === 'dark' ? message.theme : null)",
      '  })',
      "  query.addEventListener('change', syncTheme)",
      '  useSettings.subscribe(syncTheme)'
    ].join('\n')
  )

  // ③ main.tsx：唯一的导入入口。
  //    导入桥必须在上游 App 挂载之前装好 —— App 的 effect 会调 ensureApiKey()，
  //    而宿主模式下 Key 由宿主代理注入，前端只需要一个非机密哨兵占位。
  replaceOnce(
    'src/main.tsx',
    'dsh-chat-demo: host bridge',
    "import { ensureKatex } from './services/markdown/katex.js'",
    [
      "import { ensureKatex } from './services/markdown/katex.js'",
      '// dsh-chat-demo: host bridge —— 本插件新增的唯一导入入口。',
      '// 负责：无 Key 哨兵（Key 由宿主代理注入）、合并导入桥、宿主消息通道。',
      "import { installHostBridge } from './host-bridge.js'",
    ].join('\n')
  )

  replaceOnce(
    'src/main.tsx',
    'dsh-chat-demo: install bridge',
    'ensureKatex()\nsetupTheme()',
    [
      'installHostBridge()',
      'ensureKatex()',
      'setupTheme()'
    ].join('\n')
  )
}

// ── 5. 依赖与构建 ───────────────────────────────────────────────────────────

const ensureDependencies = () => {
  if (args.has('--skip-install') || existsSync(join(UPSTREAM, 'node_modules', '.pnpm'))) {
    info('上游依赖已就绪')
    return
  }
  step('安装上游依赖')
  run('pnpm', ['install', '--frozen-lockfile'], UPSTREAM)
}

/** 递归收集文件，只用于构建后自检 */
const walk = (dir) => {
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      found.push(...walk(full))
    } else {
      found.push(full)
    }
  }
  return found
}

const build = () => {
  step('构建 web/（rspack，production）')
  // 上游 package.json 的 build 脚本是 POSIX 的（rm -rf + NODE_ENV=production），
  // Windows 上直接调用会报「NODE_ENV 不是内部或外部命令」，所以这里自己设环境变量。
  run('npx', ['rspack', 'build', '-c', 'rspack.config.ts'], UPSTREAM)
  mustExist(join(DIST, 'index.html'), '构建没有产出 dist/index.html')

  // 自检 1：代理前缀真的进了产物。漏了就等于浏览器直连上游、拿不到宿主注入的鉴权。
  const scripts = walk(join(DIST, 'static', 'js')).filter((file) => file.endsWith('.js'))
  const hit = scripts.some((file) => readFileSync(file, 'utf8').includes('/plugins/dsh-chat-demo/api'))
  if (!hit) {
    fail(
      '产物里找不到代理前缀 /plugins/dsh-chat-demo/api',
      'rspack.config.ts 的 apiOrigin 补丁没生效，检查 applyPatches 是否被跳过。'
    )
  }
  info(`代理前缀已注入产物（${scripts.length} 个 js 文件）`)

  // 自检 2：产物里绝不能出现 Key。上游不含 Key，但这是「Key 不出宿主」的硬约束，
  // 一旦将来有人把测试 Key 写进源码，必须在这里被拦住。
  const leaked = scripts.filter((file) => /\bsk-[A-Za-z0-9]{16,}/.test(readFileSync(file, 'utf8')))
  if (leaked.length > 0) {
    fail(
      '产物中含疑似 API Key 的字符串',
      leaked.map((file) => `命中：${file}`).join('\n')
    )
  }
  info('产物中未发现 sk- 形式的密钥')

  // 自检 3：index.html 必须用绝对资源前缀。
  // 宿主的 SPA 回退会把深层 URL（/web/conversation/abc）也返回 index.html，
  // 相对路径在那种地址下会解析到不存在的目录，整页白屏。
  const indexHtml = readFileSync(join(DIST, 'index.html'), 'utf8')
  const assetUrl = /<(?:script|link)[^>]+(?:src|href)="([^"]+)"/.exec(indexHtml)
  if (assetUrl === null || !assetUrl[1].startsWith('/plugins/dsh-chat-demo/web/')) {
    fail(
      `index.html 的资源路径不是绝对前缀：${assetUrl === null ? '(没找到)' : assetUrl[1]}`,
      'rspack.config.ts 的 publicPath 补丁没生效。'
    )
  }
  info(`资源前缀固定为 ${assetUrl[1].slice(0, assetUrl[1].indexOf('/static/'))}`)
}

const copyDist = () => {
  step('拷贝产物 → web/')
  rmSync(OUT, { recursive: true, force: true })
  cpSync(DIST, OUT, { recursive: true })
  const indexHtml = readFileSync(join(OUT, 'index.html'), 'utf8')
  info(`web/index.html ${indexHtml.length} 字节`)
}

const main = () => {
  ensureVendored()
  ensureDependencies()
  step('注入本项目源码')
  injectSources()
  step('应用上游补丁')
  applyPatches()
  build()
  copyDist()
  step('完成')
}

main()
