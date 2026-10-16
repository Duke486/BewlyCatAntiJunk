import { addAntiJunkExample, judgeAntiJunkComment, subscribeAntiJunk } from '~/features/antiJunk/client'
import { parseAntiJunkPageRequest } from '~/features/antiJunk/protocol'

export function setupAntiJunkBridge() {
  const pending = new Map<string, AbortController>()
  const adding = new Set<string>()
  let latest = { enabled: false, inspect: false, metadata: true, batchSize: 10, requestsPerSecond: 1, cleared: false, revision: '' }
  const postState = () => window.postMessage({ type: 'BEWLY_ANTIJUNK_STATE', ...latest }, location.origin)
  subscribeAntiJunk((state) => {
    if (state.revision !== latest.revision || !state.enabled) {
      pending.forEach(controller => controller.abort())
      pending.clear()
    }
    latest = state
    postState()
  })
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin)
      return
    const message = parseAntiJunkPageRequest(event.data)
    if (!message)
      return
    if (message.type === 'BEWLY_ANTIJUNK_CANCEL') {
      pending.get(message.token)?.abort()
      pending.delete(message.token)
      return
    }
    if (message.type === 'BEWLY_ANTIJUNK_READY') {
      postState()
      return
    }
    if (!latest.enabled || message.revision !== latest.revision)
      return
    const comment = message.comment
    // 页面桥只开放评论判断，不转发配置、密钥或任意请求地址。
    comment.url = `${location.origin}${location.pathname}${/^\d+$/.test(comment.id) ? `#reply${comment.id}` : ''}`
    comment.title = document.title.slice(0, 300)
    const revision = latest.revision
    if (message.type === 'BEWLY_ANTIJUNK_ADD_EXAMPLE') {
      if (adding.has(comment.token) || !['block', 'allow'].includes(message.verdict ?? 'block'))
        return
      adding.add(comment.token)
      void addAntiJunkExample(comment, message.verdict ?? 'block').finally(() => adding.delete(comment.token)).then(result => window.postMessage({ type: 'BEWLY_ANTIJUNK_EXAMPLE_RESULT', token: comment.token, ...result }, location.origin))
      return
    }
    if (pending.has(comment.token))
      return
    if (pending.size >= 1000) {
      window.postMessage({ type: 'BEWLY_ANTIJUNK_PROGRESS', token: comment.token, revision, status: 'error' }, location.origin)
      return
    }
    const controller = new AbortController()
    pending.set(comment.token, controller)
    void judgeAntiJunkComment(comment, (status, detail) => window.postMessage({ type: 'BEWLY_ANTIJUNK_PROGRESS', token: comment.token, revision, status, detail }, location.origin), controller.signal).then((blocked) => {
      if (controller.signal.aborted)
        return
      window.postMessage({
        type: 'BEWLY_ANTIJUNK_RESULT',
        token: comment.token,
        revision,
        checked: blocked !== undefined,
        blocked: blocked === true,
      }, location.origin)
    }).finally(() => {
      if (pending.get(comment.token) === controller)
        pending.delete(comment.token)
    })
  })
  window.addEventListener('pagehide', () => {
    pending.forEach(controller => controller.abort())
    pending.clear()
  })
}
