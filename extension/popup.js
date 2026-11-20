/**
 * popup 脚本：读两个输入框，把任务丢给 service worker，显示进度。
 *
 * 不在这里发请求：popup 一关就死，采集是长任务，必须跑在 service worker 里。
 */

const endpoint = document.getElementById('endpoint')
const token = document.getElementById('token')
const run = document.getElementById('run')
const log = document.getElementById('log')

/**
 * 把一行进度追加到日志区。
 * @param {string} line 要显示的内容
 * @returns {void}
 */
const write = (line) => {
  log.textContent = `${log.textContent}${line}\n`
}

chrome.storage.local.get(['endpoint', 'token'], (saved) => {
  if (typeof saved.endpoint === 'string' && saved.endpoint !== '') endpoint.value = saved.endpoint
  if (typeof saved.token === 'string') token.value = saved.token
})

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'dsh-chat-demo/progress') write(message.line)
})

run.addEventListener('click', async () => {
  const target = endpoint.value.trim().replace(/\/+$/, '')
  const secret = token.value.trim()
  if (target === '' || secret === '') {
    write('请先填写插件地址与 token。')
    return
  }
  await chrome.storage.local.set({ endpoint: target, token: secret })
  run.disabled = true
  log.textContent = ''
  write('开始…')
  try {
    const reply = await chrome.runtime.sendMessage({ type: 'dsh-chat-demo/run', endpoint: target, token: secret })
    write(reply?.ok === true ? '完成，已交给 DSH 面板。' : `失败：${reply?.error ?? '未知错误'}`)
  } catch (error) {
    write(`失败：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    run.disabled = false
  }
})
