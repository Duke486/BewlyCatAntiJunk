export const ANTI_JUNK_CONFIG = 'antiJunkConfig'
export const ANTI_JUNK_DATA = 'antiJunkData'
export const ANTI_JUNK_LIBRARY = 'antiJunkLibrary'
export const ANTI_JUNK_MESSAGE = 'bewly-antijunk'
export const ANTI_JUNK_MODEL = 'deepseek-flash'
export const ANTI_JUNK_ENDPOINT = 'https://api.deepseek.com/chat/completions'
export const ANTI_JUNK_VERSION = 'v4-restored-preferences'
export const ANTI_JUNK_BATCH_SIZE = 50
export const ANTI_JUNK_TEXT_LIMIT = 12000

export interface AntiJunkConfig {
  feedback?: { revision: string, identities: string[] }
  enabled: boolean
  inspect: boolean
  metadata: boolean
  batchSize: number
  requestsPerSecond: number
  clearRevision?: string
  apiKey: string
  revision: string
}

export interface AntiJunkState {
  feedback?: { revision: string, identities: string[] }
  enabled: boolean
  inspect: boolean
  metadata: boolean
  batchSize: number
  requestsPerSecond: number
  cleared: boolean
  revision: string
}

export interface AntiJunkComment {
  token: string
  id: string
  oid: string
  text: string
  hasPictures?: boolean
  parentText: string
  title: string
  author: string
  url: string
  video?: AntiJunkVideo
  context?: AntiJunkContext
}

export interface AntiJunkContext {
  kind: 'video' | 'moment' | 'unknown'
  commentType?: number
  rootId?: string
  parentId?: string
  rootText?: string
  parentMissing?: boolean
  topic?: string
  related?: string[]
}

export interface AntiJunkVideo {
  id: string
  title: string
  durationSeconds: number
  author: string
  description: string
  publishedAt: number
}

export function normalizeAntiJunkVideo(value: unknown): AntiJunkVideo | undefined {
  if (!value || typeof value !== 'object')
    return undefined
  const item = value as Record<string, unknown>
  for (const [key, limit] of Object.entries({ id: 40, title: 300, author: 100, description: 4000 })) {
    if (typeof item[key] !== 'string' || (item[key] as string).length > limit)
      return undefined
  }
  if (!/^(?:BV[0-9a-z]{10}|av\d+)$/i.test(item.id as string)
    || typeof item.durationSeconds !== 'number' || !Number.isFinite(item.durationSeconds) || item.durationSeconds < 0
    || typeof item.publishedAt !== 'number' || !Number.isSafeInteger(item.publishedAt) || item.publishedAt < 0 || item.publishedAt > 8640000000000) {
    return undefined
  }
  return { id: item.id as string, title: item.title as string, durationSeconds: item.durationSeconds, author: item.author as string, description: item.description as string, publishedAt: item.publishedAt }
}

export interface AntiJunkRecord extends AntiJunkComment {
  time: number
  rule?: string
  round?: number
}

export interface AntiJunkData {
  metrics?: Record<import('./metrics').Metric, number>
  records: AntiJunkRecord[]
  cache: Array<[string, boolean]>
  checked: number
  blocked: number
  lastError: string
  lastSuccess: number
}

export interface AntiJunkResult {
  revision: string
  checked: string[]
  blocked: string[]
  error?: string
  details?: Record<string, { rule: string, round: number }>
}

export type AntiJunkStatus = 'queued' | 'pending' | 'reviewing' | 'approved' | 'rejected' | 'error'
export const ANTI_JUNK_STATUS_ICONS: Record<AntiJunkStatus, string> = { queued: '⚪️', pending: '🟡', reviewing: '🟠', approved: '🟢', rejected: '🔴', error: '⚫️' }

export interface AntiJunkExample {
  key: string
  verdict?: 'block' | 'allow'
  comment: AntiJunkComment
  time: number
}

export interface AntiJunkLibrary {
  examples: AntiJunkExample[]
  summary: string
  revision: string
}

export function parseAntiJunkLibrary(value: unknown): AntiJunkLibrary {
  const item = value as (AntiJunkLibrary & { groups?: string[][] }) | null
  if (!item || !Array.isArray(item.examples) || item.examples.length > 50 || (item.groups !== undefined && (!Array.isArray(item.groups) || item.groups.length > 50))
    || (item.summary !== undefined && (typeof item.summary !== 'string' || item.summary.length > 6000)) || typeof item.revision !== 'string' || item.revision.length > 100) {
    throw new Error('invalid-library')
  }
  const keys = new Set<string>()
  const examples = item.examples.map((example) => {
    const comment = normalizeAntiJunkComment(example?.comment)
    if (!comment || typeof example.key !== 'string' || !example.key || example.key.length > 100 || keys.has(example.key)
      || !Number.isFinite(example.time) || example.time < 0 || example.time > 8.64e15) {
      throw new Error('invalid-library')
    }
    keys.add(example.key)
    if (example.verdict !== undefined && example.verdict !== 'block' && example.verdict !== 'allow')
      throw new Error('invalid-library')
    return { key: example.key, verdict: example.verdict ?? 'block', comment, time: example.time }
  })
  if (new TextEncoder().encode(JSON.stringify(examples)).length > 64000)
    throw new Error('library-full')
  const grouped = new Set<string>()
  const groups = (item.groups ?? []).map((group) => {
    if (!Array.isArray(group) || group.length === 0 || group.length > examples.length)
      throw new Error('invalid-library')
    return group.map((key) => {
      if (typeof key !== 'string' || !keys.has(key) || grouped.has(key))
        throw new Error('invalid-library')
      grouped.add(key)
      return key
    })
  })
  if (groups.length && grouped.size !== examples.length)
    throw new Error('invalid-library')
  return { examples, summary: item.summary?.trim() ?? '', revision: item.revision }
}

export function normalizeAntiJunkComment(value: unknown): AntiJunkComment | null {
  if (!value || typeof value !== 'object')
    return null
  const item = value as Record<string, unknown>
  const limits = { token: 100, id: 160, oid: 160, text: ANTI_JUNK_TEXT_LIMIT, parentText: 2000, title: 300, author: 100, url: 2000 }
  for (const [field, limit] of Object.entries(limits)) {
    if (typeof item[field] !== 'string' || (item[field] as string).length > limit)
      return null
  }
  if (!item.token || !item.id || !(item.text as string).trim())
    return null
  if (item.hasPictures !== undefined && typeof item.hasPictures !== 'boolean')
    return null
  let context: AntiJunkContext | undefined
  if (item.context !== undefined) {
    const source = item.context as AntiJunkContext
    if (!source || !['video', 'moment', 'unknown'].includes(source.kind)
      || (source.commentType !== undefined && (!Number.isSafeInteger(source.commentType) || source.commentType < 1))
      || (source.parentMissing !== undefined && typeof source.parentMissing !== 'boolean')) {
      return null
    }
    for (const [key, limit] of Object.entries({ rootId: 160, parentId: 160, rootText: 4000, topic: 8000 })) {
      const field = source[key as keyof AntiJunkContext]
      if (field !== undefined && (typeof field !== 'string' || field.length > limit))
        return null
    }
    if (source.related !== undefined && (!Array.isArray(source.related) || source.related.length > 6 || source.related.some(text => typeof text !== 'string' || text.length > 2000)))
      return null
    context = { kind: source.kind, commentType: source.commentType, rootId: source.rootId, parentId: source.parentId, rootText: source.rootText, parentMissing: source.parentMissing, topic: source.topic, related: source.related }
  }
  try {
    if (item.url) {
      const url = new URL(item.url as string)
      if (!['https:', 'http:'].includes(url.protocol) || !url.hostname.endsWith('.bilibili.com'))
        return null
    }
  }
  catch {
    return null
  }
  return {
    token: item.token as string,
    id: item.id as string,
    oid: item.oid as string,
    text: item.text as string,
    ...(typeof item.hasPictures === 'boolean' ? { hasPictures: item.hasPictures } : {}),
    parentText: item.parentText as string,
    ...(context ? { context } : {}),
    title: item.title as string,
    author: item.author as string,
    url: item.url as string,
    ...(normalizeAntiJunkVideo(item.video) ? { video: normalizeAntiJunkVideo(item.video) } : {}),
  }
}

export interface AntiJunkBackup {
  format: 'BewlyCatAntiJunk'
  version: 2
  config: { enabled: boolean, inspect: boolean, metadata: boolean, batchSize: number, requestsPerSecond: number, apiKey?: string }
  data: { records: AntiJunkRecord[], checked: number, blocked: number }
  library?: AntiJunkLibrary
}

/** 与原版设置备份使用不同的标识；全部验证通过后才允许写入。 */
export function parseAntiJunkBackup(value: unknown): AntiJunkBackup {
  if (!value || typeof value !== 'object')
    throw new Error('invalid-backup')
  const backup = value as Record<string, any>
  const config = backup.config
  const data = backup.data
  if (backup.format !== 'BewlyCatAntiJunk' || ![1, 2].includes(backup.version)
    || !config || typeof config.enabled !== 'boolean' || typeof config.inspect !== 'boolean'
    || (config.metadata !== undefined && typeof config.metadata !== 'boolean')
    || (config.batchSize !== undefined && (!Number.isInteger(config.batchSize) || config.batchSize < 1 || config.batchSize > ANTI_JUNK_BATCH_SIZE))
    || (config.requestsPerSecond !== undefined && (!Number.isInteger(config.requestsPerSecond) || config.requestsPerSecond < 1 || config.requestsPerSecond > 20))
    || (config.apiKey !== undefined && (typeof config.apiKey !== 'string' || config.apiKey.length > 512 || /[\r\n]/.test(config.apiKey)))
    || !data || !Array.isArray(data.records) || data.records.length > 200
    || !Number.isSafeInteger(data.checked) || !Number.isSafeInteger(data.blocked)
    || data.blocked < 0 || data.checked < data.blocked) {
    throw new Error('invalid-backup')
  }
  const records = data.records.map((item: unknown) => {
    const normalized = normalizeAntiJunkComment(item)
    const time = (item as AntiJunkRecord | null)?.time
    const rule = (item as AntiJunkRecord | null)?.rule
    const round = (item as AntiJunkRecord | null)?.round
    if (!normalized || typeof time !== 'number' || !Number.isFinite(time) || time < 0 || time > 8.64e15)
      throw new Error('invalid-backup')
    if ((rule !== undefined && (typeof rule !== 'string' || rule.length > 40)) || (round !== undefined && ![0, 1, 2].includes(round)))
      throw new Error('invalid-backup')
    return { ...normalized, time, ...(rule !== undefined ? { rule } : {}), ...(round !== undefined ? { round } : {}) }
  })
  if (new TextEncoder().encode(JSON.stringify(records)).length > 1_500_000)
    throw new Error('invalid-backup')
  return {
    format: 'BewlyCatAntiJunk',
    version: 2,
    config: { enabled: config.enabled, inspect: config.inspect, metadata: config.metadata !== false, batchSize: config.batchSize ?? 10, requestsPerSecond: config.requestsPerSecond ?? 1, ...(config.apiKey !== undefined ? { apiKey: config.apiKey.trim() } : {}) },
    data: { records, checked: data.checked, blocked: data.blocked },
    ...(backup.library !== undefined ? { library: parseAntiJunkLibrary(backup.library) } : {}),
  }
}

export interface AntiJunkDecision {
  n: number
  verdict: 'allow' | 'block' | 'review'
  rule: string
  reason?: 'interpretation' | 'parent' | 'topic'
  evidence?: string
  need?: string
}

/** Missing, duplicated and unknown IDs invalidate the entire response. */
export function decodeAntiJunkVerdict(content: unknown, comments: AntiJunkComment[], review = false): AntiJunkDecision[] {
  if (typeof content !== 'string' || content.length > 64000 || !comments.length || comments.length > ANTI_JUNK_BATCH_SIZE)
    throw new Error('invalid-format')
  let text = content.replace(/^\uFEFF/, '').trim()
  if (text.startsWith('```') && text.endsWith('```'))
    text = text.slice(3, -3).replace(/^json\b/i, '').trim()
  const parsed = JSON.parse(text)
  if (!parsed || typeof parsed !== 'object' || Object.keys(parsed).length !== 1 || !Array.isArray(parsed.decisions) || parsed.decisions.length !== comments.length)
    throw new Error('invalid-format')
  const seen = new Set<number>()
  const rules = ['normal', 'flood', 'offtopic', 'identity', 'attack', 'showoff', 'dismissal', 'mockery', 'spam', 'feedback']
  for (const item of parsed.decisions) {
    if (!item || !Number.isInteger(item.n) || item.n < 1 || item.n > comments.length || seen.has(item.n)
      || !(review ? ['allow', 'block'] : ['allow', 'block', 'review']).includes(item.verdict) || !rules.includes(item.rule)) {
      throw new Error('invalid-format')
    }
    const keys = item.verdict === 'review' ? ['n', 'verdict', 'rule', 'reason', 'evidence', 'need'] : ['n', 'verdict', 'rule']
    if (Object.keys(item).length !== keys.length || Object.keys(item).some(key => !keys.includes(key)))
      throw new Error('invalid-format')
    if (item.verdict === 'review' && (!['interpretation', 'parent', 'topic'].includes(item.reason)
      || typeof item.evidence !== 'string' || !item.evidence.trim() || item.evidence.length > 160 || !comments[item.n - 1].text.includes(item.evidence)
      || typeof item.need !== 'string' || !item.need.trim() || item.need.length > 160 || item.rule === 'normal')) {
      throw new Error('invalid-format')
    }
    seen.add(item.n)
  }
  return parsed.decisions.sort((a: AntiJunkDecision, b: AntiJunkDecision) => a.n - b.n)
}

export function antiJunkIdentity(item: AntiJunkComment) {
  return JSON.stringify([item.context?.commentType ?? '', item.oid, item.id, item.text, item.hasPictures ?? null])
}

export function antiJunkSignature(item: AntiJunkComment) {
  return JSON.stringify([antiJunkIdentity(item), item.parentText, item.title, item.video, item.context])
}

export type AntiJunkPageRequest
  = | { type: 'BEWLY_ANTIJUNK_READY' }
    | { type: 'BEWLY_ANTIJUNK_CANCEL', token: string }
    | { type: 'BEWLY_ANTIJUNK_COMMENT' | 'BEWLY_ANTIJUNK_ADD_EXAMPLE', revision: string, comment: AntiJunkComment, verdict: 'block' | 'allow' }

export function parseAntiJunkPageRequest(value: unknown): AntiJunkPageRequest | undefined {
  if (!value || typeof value !== 'object')
    return
  const item = value as Record<string, unknown>
  if (item.type === 'BEWLY_ANTIJUNK_READY')
    return { type: item.type }
  if (item.type === 'BEWLY_ANTIJUNK_CANCEL')
    return typeof item.token === 'string' && item.token.length <= 100 ? { type: item.type, token: item.token } : undefined
  if (item.type !== 'BEWLY_ANTIJUNK_COMMENT' && item.type !== 'BEWLY_ANTIJUNK_ADD_EXAMPLE')
    return
  if (typeof item.revision !== 'string' || item.revision.length > 100 || (item.verdict !== undefined && item.verdict !== 'block' && item.verdict !== 'allow'))
    return
  const comment = normalizeAntiJunkComment(item.comment)
  if (!comment || JSON.stringify(comment).length > 48000)
    return
  return { type: item.type, revision: item.revision, comment, verdict: item.verdict === 'allow' ? 'allow' : 'block' }
}
