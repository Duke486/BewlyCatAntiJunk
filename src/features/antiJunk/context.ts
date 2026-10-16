import type { AntiJunkComment } from './protocol'

/** Bounded enrichment, never fetches an entire thread or sends images. */
export async function enrichAntiJunkContext(item: AntiJunkComment, metadata: boolean, signal: AbortSignal): Promise<AntiJunkComment> {
  const context = { ...item.context, kind: item.context?.kind ?? 'unknown' }
  const result = { ...item, context }
  const read = async (url: URL) => {
    const response = await fetch(url, { credentials: 'include', signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) })
    if (!response.ok)
      return undefined
    const envelope = await response.json()
    return envelope?.code === 0 ? envelope.data : undefined
  }
  const tasks: Promise<void>[] = []
  if (context.parentMissing && context.rootId && context.commentType && /^\d+$/.test(item.oid) && /^\d+$/.test(context.rootId)) {
    tasks.push((async () => {
      const url = new URL('https://api.bilibili.com/x/v2/reply/reply')
      url.search = new URLSearchParams({ oid: item.oid, type: String(context.commentType), root: context.rootId!, pn: '1', ps: '20' }).toString()
      const data = await read(url)
      const replies = Array.isArray(data?.replies) ? data.replies : []
      const candidates = [data?.root, ...replies].filter(Boolean)
      const parent = candidates.find(row => String(row.rpid_str ?? row.rpid) === context.parentId)
      if (typeof parent?.content?.message === 'string') {
        result.parentText = parent.content.message.slice(0, 2000)
        context.parentMissing = false
      }
      if (typeof data?.root?.content?.message === 'string')
        context.rootText = data.root.content.message.slice(0, 4000)
      context.related = candidates.filter(row => String(row.parent_str ?? row.parent) === context.parentId && String(row.rpid_str ?? row.rpid) !== item.id)
        .slice(0, 6)
        .map(row => String(row.content?.message ?? '').slice(0, 2000))
    })().catch(() => {}))
  }
  if (metadata && context.kind === 'moment' && !context.topic) {
    const id = new URL(item.url).pathname.match(/^\/(?:opus\/)?(\d+)/)?.[1]
    if (id) {
      tasks.push((async () => {
        const url = new URL('https://api.bilibili.com/x/polymer/web-dynamic/v1/detail')
        url.searchParams.set('id', id)
        const dynamic = (await read(url))?.item
        const description = dynamic?.modules?.module_dynamic
        const original = dynamic?.orig?.modules?.module_dynamic
        context.topic = [description?.desc?.text, description?.major?.opus?.summary?.text, original?.desc?.text].filter(text => typeof text === 'string').join('\n').slice(0, 8000)
      })().catch(() => {}))
    }
  }
  await Promise.all(tasks)
  signal.throwIfAborted()
  return result
}
