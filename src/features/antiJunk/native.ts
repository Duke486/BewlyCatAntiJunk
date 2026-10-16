import type { AntiJunkStatus } from '~/features/antiJunk/protocol'
import { ANTI_JUNK_STATUS_ICONS, ANTI_JUNK_TEXT_LIMIT, antiJunkIdentity } from '~/features/antiJunk/protocol'

interface TrackedComment {
  node: HTMLElement
  token: string
  signature: string
  revision: string
  id: string
  oid: string
  rootId: string
  commentType?: number
  sentSignature?: string
  parent: string
  text: string
  hasPictures: boolean
  author: string
  sent: boolean
  suppressed?: boolean
  blocked: boolean
  revealed: boolean
  button?: HTMLButtonElement
  tools?: HTMLSpanElement
  status: AntiJunkStatus
  adding?: boolean
  feedback?: string
  detail?: { rule: string, round: number }
}

/** 仅处理页面组件；密钥、请求和记录全部留在扩展环境。 */
export function createNativeAntiJunk(getData: (component: any) => any, translate: (key: string) => string, notifyLayout: (node: HTMLElement) => void) {
  const byNode = new WeakMap<HTMLElement, TrackedComment>()
  const tracked = new Map<string, TrackedComment>()
  const parents = new Map<string, string>()
  const related = new Map<string, Map<string, string>>()
  let serial = 0
  let enabled = false
  let inspect = false
  let revision = ''
  let feedbackRevision = ''
  let page = location.pathname
  let timer: ReturnType<typeof setTimeout> | undefined

  function render(item: TrackedComment) {
    const root = item.node.shadowRoot
    if (!root)
      return
    const active = enabled && item.blocked
    const content = root.querySelector<HTMLElement>('bili-rich-text, #content, #contents')
    const avatar = root.querySelector<HTMLElement>('#user-avatar, bili-avatar')
    // 不折叠整个 renderer/body：树线依赖头像和 footer 的实际坐标。
    const canFold = Boolean(content && !content.contains(avatar))
    item.node.toggleAttribute('data-bewly-antijunk-folded', active && !inspect && !item.revealed && canFold)
    item.node.toggleAttribute('data-bewly-antijunk-inspect', active && inspect)
    if (!active || inspect || !canFold) {
      item.button?.remove()
    }
    if (!root.querySelector('[data-bewly-antijunk-style]')) {
      const style = document.createElement('style')
      style.dataset.bewlyAntijunkStyle = ''
      style.textContent = `
        :host([data-bewly-antijunk-folded]) [data-bewly-antijunk-content],
        :host([data-bewly-antijunk-folded]) :is(#pictures, bili-comment-pictures-renderer) { display:none !important; }
        :host([data-bewly-antijunk-folded]) [data-bewly-antijunk-meta] { visibility:hidden !important; }
        :host([data-bewly-antijunk-folded]) [data-bewly-antijunk-avatar] { filter:grayscale(1) brightness(0) invert(.7); opacity:.3; clip-path:circle(50%); pointer-events:none; }
        /* 每条正文只染一层：优先富文本，兼容未嵌套富文本组件的正文容器。 */
        :host([data-bewly-antijunk-inspect]) bili-rich-text,
        :host([data-bewly-antijunk-inspect]) #contents:not(:has(bili-rich-text)),
        :host([data-bewly-antijunk-inspect]) #content:not(:has(bili-rich-text, #contents)) {
          background-color:var(--bew-antijunk-highlight,rgba(255,214,64,.2)) !important;
          border-radius:var(--bew-radius-sm,4px);
        }
        [data-bewly-antijunk-toggle] { display:inline-block; min-width:24px; min-height:24px; padding:0; margin:0; border:0; background:transparent; color:var(--bew-text-3,#9499a0); font:inherit; font-size:var(--bew-font-size-control,13px); line-height:var(--bew-line-height-body,24px); cursor:pointer; text-align:start; }
        [data-bewly-antijunk-toggle]:hover { color:var(--bew-text-1,inherit); }
        [data-bewly-antijunk-toggle]:active { opacity:.7; }
        [data-bewly-antijunk-toggle]:focus-visible { outline:2px solid var(--bew-theme-color,#888); outline-offset:2px; }
        [data-bewly-antijunk-tools] { display:inline-flex; align-items:center; vertical-align:baseline; gap:var(--bew-space-1,4px); margin-inline-end:var(--bew-space-1,4px); font-size:var(--bew-font-size-caption,12px); line-height:var(--bew-line-height-body,24px); }
        [data-bewly-antijunk-add] { display:inline-grid; place-items:center; width:24px; height:24px; padding:0; border:0; border-radius:var(--bew-radius-sm,4px); background:transparent; color:var(--bew-text-3,#9499a0); font:inherit; cursor:pointer; }
        [data-bewly-antijunk-add]:hover { color:var(--bew-error-color,#e64545); background:var(--bew-fill-1,rgba(128,128,128,.1)); }
        [data-bewly-antijunk-add]:active { opacity:.7; }
        [data-bewly-antijunk-add]:disabled { opacity:.4; cursor:wait; }
        [data-bewly-antijunk-add]:focus-visible { outline:2px solid var(--bew-theme-color,#888); outline-offset:2px; }
        [data-bewly-antijunk-status] { border:0; padding:0; background:transparent; color:inherit; font:inherit; min-width:24px; min-height:24px; }
        [data-bewly-antijunk-status]:enabled { cursor:pointer; }
        [data-bewly-antijunk-status]:focus-visible { outline:2px solid var(--bew-theme-color); }
        [data-bewly-antijunk-add][hidden], [data-bewly-antijunk-status][hidden] { display:none !important; }
      `
      root.append(style)
    }
    const toolsContent = root.querySelector<HTMLElement>('bili-rich-text') ?? root.querySelector<HTMLElement>('#contents, #content')
    if (enabled && (inspect || !item.blocked || item.revealed) && toolsContent) {
      if (!item.tools) {
        item.tools = document.createElement('span')
        item.tools.dataset.bewlyAntijunkTools = ''
        const indicator = document.createElement('button')
        indicator.type = 'button'
        indicator.dataset.bewlyAntijunkStatus = ''
        indicator.addEventListener('click', () => {
          if (item.status === 'error') {
            item.sent = false
            item.status = 'queued'
            flush()
          }
        })
        const add = document.createElement('button')
        add.type = 'button'
        add.textContent = '⊘'
        add.dataset.bewlyAntijunkAdd = ''
        add.addEventListener('click', (event) => {
          event.preventDefault()
          event.stopPropagation()
          if (item.adding)
            return
          item.adding = true
          item.feedback = ''
          render(item)
          window.postMessage({ type: 'BEWLY_ANTIJUNK_ADD_EXAMPLE', revision, comment: commentPayload(item), verdict: item.blocked ? 'allow' : 'block' }, location.origin)
        })
        item.tools.append(indicator, add)
      }
      const indicator = item.tools.querySelector<HTMLButtonElement>('[data-bewly-antijunk-status]')!
      indicator.hidden = !inspect
      indicator.disabled = item.status !== 'error'
      indicator.textContent = ANTI_JUNK_STATUS_ICONS[item.status]
      indicator.title = translate(`anti_junk.status_${item.status}`) + (item.detail ? ` · ${translate(`anti_junk.rules.${item.detail.rule}`)} · ${item.detail.round}` : '')
      indicator.setAttribute('aria-label', indicator.title)
      const add = item.tools.querySelector<HTMLButtonElement>('[data-bewly-antijunk-add]')!
      add.hidden = false
      add.disabled = item.adding === true
      add.textContent = item.feedback ? '⚠' : item.blocked ? '✓' : '⊘'
      add.title = translate(item.feedback ? `anti_junk.errors.${item.feedback}` : item.blocked ? 'anti_junk.keep_example' : 'anti_junk.add_example')
      add.setAttribute('aria-label', add.title)
      if (toolsContent.previousSibling !== item.tools)
        toolsContent.before(item.tools)
    }
    else {
      item.tools?.remove()
    }
    if (!active || inspect || !canFold) {
      notifyLayout(item.node)
      return
    }
    root.querySelectorAll('[data-bewly-antijunk-content], [data-bewly-antijunk-meta], [data-bewly-antijunk-avatar]').forEach((part) => {
      part.removeAttribute('data-bewly-antijunk-content')
      part.removeAttribute('data-bewly-antijunk-meta')
      part.removeAttribute('data-bewly-antijunk-avatar')
    })
    content!.setAttribute('data-bewly-antijunk-content', '')
    avatar?.setAttribute('data-bewly-antijunk-avatar', '')
    root.querySelectorAll('#header, #footer, bili-comment-user-info').forEach((part) => {
      if (!part.contains(avatar) && !part.contains(content))
        part.setAttribute('data-bewly-antijunk-meta', '')
    })
    if (!item.button) {
      item.button = document.createElement('button')
      item.button.type = 'button'
      item.button.dataset.bewlyAntijunkToggle = ''
      item.button.addEventListener('click', (event) => {
        event.stopPropagation()
        item.revealed = !item.revealed
        render(item)
      })
    }
    item.button.textContent = translate(item.revealed ? 'anti_junk.hide' : 'anti_junk.show')
    item.button.title = translate(item.revealed ? 'anti_junk.hide_title' : 'anti_junk.show_title')
    item.button.setAttribute('aria-expanded', String(item.revealed))
    if (item.revealed) {
      if (content!.nextSibling !== item.button)
        content!.after(item.button)
    }
    else if (content!.previousSibling !== item.button) {
      content!.before(item.button)
    }
    notifyLayout(item.node)
  }

  function commentPayload(item: TrackedComment) {
    return { context: { kind: location.pathname.includes('/video/') ? 'video' : /^\/(?:opus\/)?\d+/.test(location.pathname) ? 'moment' : 'unknown', commentType: item.commentType, rootId: item.rootId, parentId: item.parent, parentMissing: Boolean(item.parent && !parents.has(`${item.oid}:${item.parent}`)), rootText: parents.get(`${item.oid}:${item.rootId}`)?.slice(0, 4000), related: [...(related.get(`${item.oid}:${item.rootId}:${item.parent}`) ?? [])].filter(([id]) => id !== item.id).slice(0, 6).map(([, text]) => text.slice(0, 2000)) }, token: item.token, id: item.id, oid: item.oid, text: item.text, hasPictures: item.hasPictures, parentText: parents.get(`${item.oid}:${item.parent}`)?.slice(0, 2000) ?? '', author: item.author, title: document.title.slice(0, 300), url: `${location.origin}${location.pathname}` }
  }

  function flush() {
    timer = undefined
    for (const [token, item] of [...tracked]) {
      if (!item.node.isConnected) {
        window.postMessage({ type: 'BEWLY_ANTIJUNK_CANCEL', token }, location.origin)
        tracked.delete(token)
        continue
      }
      const signature = JSON.stringify(commentPayload(item))
      if (!enabled || item.suppressed || (item.sent && item.sentSignature === signature))
        continue
      if (item.sent && item.sentSignature !== signature) {
        window.postMessage({ type: 'BEWLY_ANTIJUNK_CANCEL', token }, location.origin)
        tracked.delete(token)
        item.token = `native-${++serial}`
        tracked.set(item.token, item)
        item.blocked = false
        item.status = 'queued'
        render(item)
      }
      item.sent = true
      item.sentSignature = JSON.stringify(commentPayload(item))
      window.postMessage({
        type: 'BEWLY_ANTIJUNK_COMMENT',
        revision,
        comment: commentPayload(item),
      }, location.origin)
    }
    while (parents.size > 3000)
      parents.delete(parents.keys().next().value!)
  }

  const checkNavigation = () => setTimeout(() => {
    if (page === location.pathname)
      return
    page = location.pathname
    for (const item of tracked.values()) {
      window.postMessage({ type: 'BEWLY_ANTIJUNK_CANCEL', token: item.token }, location.origin)
      item.blocked = false
      item.sent = false
      item.button?.remove()
      item.tools?.remove()
      item.node.removeAttribute('data-bewly-antijunk-folded')
      item.node.removeAttribute('data-bewly-antijunk-inspect')
      byNode.delete(item.node)
    }
    tracked.clear()
    parents.clear()
    related.clear()
    clearTimeout(timer)
    timer = undefined
  }, 0)
  for (const event of ['pushstate', 'replacestate', 'popstate'])
    window.addEventListener(event, checkNavigation)

  function observe(node: HTMLElement) {
    if (node.localName === 'bili-comment-thread-renderer' || node.localName === 'bili-comment-replies-renderer') {
      node.shadowRoot?.querySelectorAll<HTMLElement>('bili-comment-renderer, bili-comment-reply-renderer, bili-comment-replies-renderer').forEach(observe)
      return
    }
    if (node.localName !== 'bili-comment-renderer' && node.localName !== 'bili-comment-reply-renderer')
      return
    const raw = getData(node)
    const id = String(raw?.rpid_str ?? raw?.rpid ?? '')
    const oid = String(raw?.oid_str ?? raw?.oid ?? '')
    const message = typeof raw?.content?.message === 'string' ? raw.content.message : ''
    const hasPictures = Array.isArray(raw?.content?.pictures) && raw.content.pictures.length > 0
    const text = message || (hasPictures ? '[图片评论]' : '')
    let item = byNode.get(node)
    if (!id || !text || text.length > ANTI_JUNK_TEXT_LIMIT) {
      if (item) {
        tracked.delete(item.token)
        byNode.delete(node)
        item.button?.remove()
        item.tools?.remove()
        node.removeAttribute('data-bewly-antijunk-folded')
        node.removeAttribute('data-bewly-antijunk-inspect')
        notifyLayout(node)
      }
      return
    }
    parents.set(`${oid}:${id}`, text)
    const signature = JSON.stringify([location.pathname, oid, id, text, hasPictures, raw?.parent_str ?? raw?.parent, raw?.root_str ?? raw?.root])
    if (item?.signature === signature) {
      if (item.revision !== revision) {
        item.revision = revision
        item.sent = false
        item.blocked = false
        item.revealed = false
        item.status = 'queued'
      }
      tracked.set(item.token, item)
      render(item)
      if (!timer)
        timer = setTimeout(flush, 100)
      return
    }
    if (item) {
      window.postMessage({ type: 'BEWLY_ANTIJUNK_CANCEL', token: item.token }, location.origin)
      tracked.delete(item.token)
      item.button?.remove()
      item.tools?.remove()
      node.removeAttribute('data-bewly-antijunk-folded')
      node.removeAttribute('data-bewly-antijunk-inspect')
    }
    item = {
      node,
      id,
      oid,
      text,
      hasPictures,
      signature,
      revision,
      token: `native-${++serial}`,
      rootId: String(raw?.root_str ?? raw?.root ?? id) === '0' ? id : String(raw?.root_str ?? raw?.root ?? id),
      commentType: Number(raw?.type) > 0 ? Number(raw.type) : location.pathname.includes('/video/') ? 1 : undefined,
      parent: [raw?.parent_str, raw?.parent, raw?.root_str, raw?.root].map(value => String(value ?? '')).find(value => value && value !== '0') ?? '',
      author: String(raw?.member?.uname ?? '').slice(0, 100),
      sent: false,
      blocked: false,
      revealed: false,
      status: 'queued',
    }
    const familyKey = `${oid}:${item.rootId}:${item.parent}`
    const family = related.get(familyKey) ?? new Map<string, string>()
    family.set(id, text)
    while (family.size > 7) family.delete(family.keys().next().value!)
    related.set(familyKey, family)
    while (related.size > 500) related.delete(related.keys().next().value!)
    byNode.set(node, item)
    tracked.set(item.token, item)
    parents.set(`${oid}:${id}`, text)
    render(item)
    if (!timer)
      timer = setTimeout(flush, 100)
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin)
      return
    const message = event.data
    if (message?.type === 'BEWLY_ANTIJUNK_STATE' && typeof message.enabled === 'boolean' && typeof message.revision === 'string') {
      const nextInspect = message.inspect === true
      if (enabled === message.enabled && revision === message.revision && inspect === nextInspect && feedbackRevision === (message.feedback?.revision ?? ''))
        return
      const feedbackChanged = feedbackRevision !== (message.feedback?.revision ?? '')
      feedbackRevision = message.feedback?.revision ?? ''
      const affected = new Set<string>(feedbackChanged && Array.isArray(message.feedback?.identities) ? message.feedback.identities : [])
      const detectionChanged = enabled !== message.enabled || revision !== message.revision
      const cleared = detectionChanged && Boolean(revision) && message.cleared === true
      enabled = message.enabled
      revision = message.revision
      inspect = nextInspect
      for (const item of [...tracked.values()]) {
        item.revision = revision
        if (detectionChanged || affected.has(antiJunkIdentity(commentPayload(item) as import('./protocol').AntiJunkComment))) {
          window.postMessage({ type: 'BEWLY_ANTIJUNK_CANCEL', token: item.token }, location.origin)
          tracked.delete(item.token)
          item.token = `native-${++serial}`
          tracked.set(item.token, item)
          item.detail = undefined
          item.adding = false
          item.feedback = ''
          item.blocked = false
          item.sent = cleared
          item.suppressed = cleared
          item.revealed = false
          item.status = 'queued'
        }
        render(item)
      }
      if (cleared) {
        parents.clear()
        related.clear()
      }
      flush()
    }
    if (message?.type === 'BEWLY_ANTIJUNK_PROGRESS' && message.revision === revision && enabled
      && Object.hasOwn(ANTI_JUNK_STATUS_ICONS, message.status)) {
      const item = tracked.get(message.token)
      if (item?.node.isConnected) {
        item.status = message.status
        if (message.detail && typeof message.detail.rule === 'string' && typeof message.detail.round === 'number')
          item.detail = message.detail
        item.blocked = message.status === 'rejected'
        render(item)
      }
    }
    if (message?.type === 'BEWLY_ANTIJUNK_EXAMPLE_RESULT') {
      const item = tracked.get(message.token)
      if (item?.node.isConnected) {
        item.adding = false
        item.feedback = message.ok ? '' : message.error || 'storage-error'
        render(item)
      }
    }
    if (message?.type === 'BEWLY_ANTIJUNK_RESULT' && message.revision === revision && enabled) {
      const item = tracked.get(message.token)
      if (!item || !item.node.isConnected || message.checked !== true)
        return
      item.blocked = message.blocked === true
      render(item)
    }
  })
  window.addEventListener('pagehide', (event) => {
    tracked.forEach(item => window.postMessage({ type: 'BEWLY_ANTIJUNK_CANCEL', token: item.token }, location.origin))
    if (event.persisted) {
      tracked.forEach((item) => {
        item.sent = false
      })
    }
    else {
      tracked.clear()
      parents.clear()
      related.clear()
    }
    clearTimeout(timer)
    timer = undefined
  })
  window.addEventListener('pageshow', () => flush())
  window.postMessage({ type: 'BEWLY_ANTIJUNK_READY' }, location.origin)
  return { observe }
}
