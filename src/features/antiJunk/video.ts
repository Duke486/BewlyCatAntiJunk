import api from '~/utils/api'
import { getBilibiliPathname } from '~/utils/bilibiliLocale'

import type { AntiJunkVideo } from './protocol'
import { normalizeAntiJunkVideo } from './protocol'

const metadata = new Map<string, { expires: number, request: Promise<AntiJunkVideo | undefined> }>()

export function clearAntiJunkVideoCache() {
  metadata.clear()
}

/** 每个稿件共用一次请求；失败短暂缓存，跨视频导航不会复用上一稿件的语境。 */
export function loadAntiJunkVideo(url: string): Promise<AntiJunkVideo | undefined> {
  let id: string | undefined
  try {
    const parsed = new URL(url)
    if (!parsed.hostname.endsWith('.bilibili.com'))
      return Promise.resolve(undefined)
    id = getBilibiliPathname(url).match(/^\/video\/(BV[0-9a-z]{10}|av\d+)\/?$/i)?.[1]
  }
  catch {}
  if (!id)
    return Promise.resolve(undefined)
  id = /^av/i.test(id) ? `av${id.slice(2)}` : `BV${id.slice(2)}`
  const cached = metadata.get(id)
  if (cached && cached.expires > Date.now())
    return cached.request
  const videoId = id
  const entry = { expires: Date.now() + 30000, request: Promise.resolve<AntiJunkVideo | undefined>(undefined) }
  entry.request = (async () => {
    try {
      const params = videoId.startsWith('av') ? { aid: videoId.slice(2) } : { bvid: videoId }
      const result = await api.video.getVideoInfo(params, { signal: AbortSignal.timeout(5000) })
      const data = result?.data
      if (result?.code !== 0 || !data
        || (videoId.startsWith('av') ? String(data.aid) !== videoId.slice(2) : data.bvid !== videoId)) {
        return undefined
      }
      const video = normalizeAntiJunkVideo({
        id: videoId,
        title: String(data.title ?? '').slice(0, 300),
        durationSeconds: Number(data.duration),
        author: String(data.owner?.name ?? '').slice(0, 100),
        description: String(data.desc ?? '').slice(0, 4000),
        publishedAt: Number(data.pubdate),
      })
      if (video)
        entry.expires = Date.now() + 3600000
      return video
    }
    catch { return undefined }
  })()
  metadata.set(videoId, entry)
  while (metadata.size > 32)
    metadata.delete(metadata.keys().next().value!)
  return entry.request
}
