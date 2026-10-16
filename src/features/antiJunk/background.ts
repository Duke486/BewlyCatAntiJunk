import browser from 'webextension-polyfill'

import type { AntiJunkComment, AntiJunkConfig, AntiJunkData, AntiJunkLibrary, AntiJunkResult } from '~/features/antiJunk/protocol'
import {
  ANTI_JUNK_BATCH_SIZE,
  ANTI_JUNK_CONFIG,
  ANTI_JUNK_DATA,
  ANTI_JUNK_LIBRARY,
  ANTI_JUNK_MESSAGE,
  ANTI_JUNK_MODEL,
  ANTI_JUNK_VERSION,
  antiJunkIdentity,
  antiJunkSignature,
  normalizeAntiJunkComment,
  parseAntiJunkBackup,
  parseAntiJunkLibrary,
} from '~/features/antiJunk/protocol'

import { callDeepSeek, configureAntiJunkRateLimit, JudgeError, resumeAntiJunkRequests, summarizeAntiJunkLibrary } from './api'
import { enrichAntiJunkContext } from './context'
import { emptyMetrics, recordMetric, setMetricsSink } from './metrics'
import { selectAntiJunkExamples } from './personalization'
import type { AntiJunkStatus } from './protocol'

const emptyData = (): AntiJunkData => ({ metrics: emptyMetrics(), records: [], cache: [], checked: 0, blocked: 0, lastError: '', lastSuccess: 0 })
let config: AntiJunkConfig = { enabled: false, inspect: false, metadata: true, batchSize: 10, requestsPerSecond: 1, apiKey: '', revision: '0' }
let data = emptyData()
setMetricsSink((key, amount) => {
  data.metrics ??= emptyMetrics()
  data.metrics[key] += amount
})
const cache = new Map<string, boolean>()
const activeRequests = new Set<AbortController>()
const subscriptions = new Map<string, { controller: AbortController, tokens: Map<string, AbortController> }>()
function cancelActive() {
  activeRequests.forEach(controller => controller.abort())
  subscriptions.forEach(subscription => subscription.controller.abort())
}
interface Outcome { blocked?: boolean, error?: string, rule?: string, round?: number }
interface Flight {
  promise: Promise<Outcome>
  resolve: (result: Outcome) => void
  listeners: Set<(status: AntiJunkStatus) => void>
  controller: AbortController
  status: AntiJunkStatus
}
const flights = new Map<string, Flight>()
const identities = new Map<string, string>()
let persistRetry: ReturnType<typeof setTimeout> | undefined
let writing = Promise.resolve()
let changing = Promise.resolve()
let library: AntiJunkLibrary = { examples: [], summary: '', revision: '0' }
let summarizing = false

function withChanges<T>(change: () => Promise<T>): Promise<T> {
  const task = changing.then(change)
  changing = task.then(() => {}, () => {})
  return task
}

const ready = browser.storage.local.get([ANTI_JUNK_CONFIG, ANTI_JUNK_DATA, ANTI_JUNK_LIBRARY]).then((stored) => {
  const saved = stored[ANTI_JUNK_CONFIG] as AntiJunkConfig | undefined
  if (saved && typeof saved.apiKey === 'string' && typeof saved.revision === 'string') {
    config = { enabled: saved.enabled === true && Boolean(saved.apiKey), inspect: saved.inspect === true, metadata: saved.metadata !== false, batchSize: Number.isInteger(saved.batchSize) && saved.batchSize >= 1 && saved.batchSize <= ANTI_JUNK_BATCH_SIZE ? saved.batchSize : 10, requestsPerSecond: Number.isInteger(saved.requestsPerSecond) && saved.requestsPerSecond >= 1 && saved.requestsPerSecond <= 20 ? saved.requestsPerSecond : 1, clearRevision: typeof saved.clearRevision === 'string' ? saved.clearRevision : undefined, apiKey: saved.apiKey, revision: saved.revision }
  }
  configureAntiJunkRateLimit(config.requestsPerSecond)
  const savedData = stored[ANTI_JUNK_DATA] as AntiJunkData | undefined
  if (savedData && Array.isArray(savedData.records) && Array.isArray(savedData.cache)) {
    data = { ...emptyData(), ...savedData }
    data.records = data.records.filter(item => normalizeAntiJunkComment(item) && Number.isFinite(item.time)).slice(0, 200)
    for (const entry of data.cache.slice(-1500)) {
      if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'boolean')
        cache.set(entry[0], entry[1])
    }
  }
  if (stored[ANTI_JUNK_LIBRARY]) {
    try {
      library = parseAntiJunkLibrary(stored[ANTI_JUNK_LIBRARY])
    }
    catch { data.lastError = 'invalid-library' }
  }
})

async function saveLibrary(next: AntiJunkLibrary, targeted = false) {
  next = parseAntiJunkLibrary(next)
  const previous = config
  const changedIdentities = new Set([...library.examples, ...next.examples].filter((example) => {
    const before = library.examples.find(item => antiJunkIdentity(item.comment) === antiJunkIdentity(example.comment))
    const after = next.examples.find(item => antiJunkIdentity(item.comment) === antiJunkIdentity(example.comment))
    return before?.verdict !== after?.verdict || Boolean(before) !== Boolean(after)
  }).map(example => antiJunkIdentity(example.comment)))
  const nextConfig = { ...config, revision: targeted ? config.revision : crypto.randomUUID(), feedback: targeted ? { revision: crypto.randomUUID(), identities: [...changedIdentities] } : undefined }
  config = nextConfig
  if (!targeted)
    cancelActive()
  try {
    await writing.catch(() => {})
    const nextData = { ...data, cache: targeted ? [...cache].filter(([key]) => !changedIdentities.has(identities.get(key) ?? '')) : [] }
    await browser.storage.local.set({ [ANTI_JUNK_LIBRARY]: next, [ANTI_JUNK_CONFIG]: nextConfig, [ANTI_JUNK_DATA]: nextData })
    library = next
    cache.clear()
    for (const [key, value] of nextData.cache) cache.set(key, value)
    data = nextData
    return { ok: true }
  }
  catch {
    config = previous
    return { error: 'storage-error' }
  }
}

function persistData() {
  writing = writing.catch(() => {}).then(async () => {
    data.cache = [...cache].slice(-1500)
    // 留完整原文，按总字节数淘汰最旧记录，避免撑满扩展存储。
    while (data.records.length > 200 || new TextEncoder().encode(JSON.stringify(data.records)).length > 1_500_000)
      data.records.pop()
    try {
      await browser.storage.local.set({ [ANTI_JUNK_DATA]: data })
      clearTimeout(persistRetry)
      persistRetry = undefined
    }
    catch (error) {
      data.lastError = 'storage-error'
      if (!persistRetry) {
        persistRetry = setTimeout(() => {
          persistRetry = undefined
          void persistData().catch(() => {})
        }, 5000)
      }
      throw error
    }
  })
  return writing
}

async function cacheKey(item: AntiJunkComment, revision: string) {
  const feedback = library.examples.find(example => antiJunkIdentity(example.comment) === antiJunkIdentity(item))
  const input = JSON.stringify([ANTI_JUNK_VERSION, ANTI_JUNK_MODEL, revision, feedback?.key, antiJunkSignature(item)])
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')
}

async function judge(comments: AntiJunkComment[], revision: string, owner: string, signal: AbortSignal, tokenSignals: Map<string, AbortController>, onProgress: (tokens: string[], status: AntiJunkStatus) => void): Promise<AntiJunkResult> {
  const result: AntiJunkResult = { revision, checked: [], blocked: [], details: {} }
  if (!config.enabled || revision !== config.revision || signal.aborted)
    return result
  const keys = await Promise.all(comments.map(item => cacheKey(item, revision)))
  if (!config.enabled || revision !== config.revision || signal.aborted)
    return result
  keys.forEach((key, index) => identities.set(key, antiJunkIdentity(comments[index])))
  while (identities.size > 3000) identities.delete(identities.keys().next().value!)
  const fresh: Array<{ item: AntiJunkComment, key: string, flight: Flight }> = []
  const controller = new AbortController()
  const outcomes = comments.map((item, index) => {
    const key = keys[index]
    const manual = library.examples.find(example => antiJunkIdentity(example.comment) === antiJunkIdentity(item))
    if (manual)
      cache.set(key, manual.verdict !== 'allow')
    if (cache.has(key)) {
      recordMetric('cacheHits')
      return Promise.resolve<Outcome>({ blocked: cache.get(key), rule: manual ? 'feedback' : 'cached', round: 0 })
    }
    let flight = flights.get(key)
    if (flight?.controller.signal.aborted)
      flight = undefined
    if (!flight) {
      let resolve!: (result: Outcome) => void
      const promise = new Promise<Outcome>((done) => {
        resolve = done
      })
      flight = { promise, resolve, listeners: new Set(), controller, status: 'queued' }
      flights.set(key, flight)
      fresh.push({ item, key, flight })
    }
    const current = flight
    const subscriberSignal = tokenSignals.get(item.token)?.signal ?? signal
    return new Promise<Outcome>((resolve) => {
      const listener = (status: AntiJunkStatus) => onProgress([item.token], status)
      current.listeners.add(listener)
      listener(current.status)
      const cleanup = () => {
        subscriberSignal.removeEventListener('abort', abort)
        current.listeners.delete(listener)
        if (![...flights.values()].some(entry => entry.controller === current.controller && entry.listeners.size))
          current.controller.abort()
      }
      function abort() {
        cleanup()
        resolve({ error: 'cancelled' })
      }
      subscriberSignal.addEventListener('abort', abort, { once: true })
      if (subscriberSignal.aborted)
        abort()
      void current.promise.then((value) => {
        cleanup()
        resolve(value)
      })
    })
  })
  if (fresh.length) {
    activeRequests.add(controller)
    void (async () => {
      const snapshot = { ...config }
      const preferences = library
      const emit = (entry: typeof fresh[number], status: AntiJunkStatus) => {
        entry.flight.status = status
        entry.flight.listeners.forEach(listener => listener(status))
      }
      const finish = (entry: typeof fresh[number], outcome: Outcome) => {
        const before = preferences.examples.find(example => antiJunkIdentity(example.comment) === antiJunkIdentity(entry.item))
        const after = library.examples.find(example => antiJunkIdentity(example.comment) === antiJunkIdentity(entry.item))
        if (before?.key !== after?.key)
          outcome = after ? { blocked: after.verdict !== 'allow', rule: 'feedback', round: 0 } : { error: 'cancelled' }
        if (revision !== config.revision || controller.signal.aborted || !entry.flight.listeners.size)
          outcome = { error: 'cancelled' }
        if (outcome.blocked !== undefined) {
          emit(entry, outcome.blocked ? 'rejected' : 'approved')
          cache.set(entry.key, outcome.blocked)
          data.checked++
          if (outcome.blocked) {
            data.blocked++
            if (!data.records.some(record => antiJunkIdentity(record) === antiJunkIdentity(entry.item)))
              data.records.unshift({ ...entry.item, time: Date.now(), rule: outcome.rule, round: outcome.round })
          }
          data.lastSuccess = Date.now()
          data.lastError = ''
        }
        entry.flight.resolve(outcome)
        if (flights.get(entry.key) === entry.flight)
          flights.delete(entry.key)
      }
      const batches: typeof fresh[] = []
      let batch: typeof fresh = []
      let size = 0
      for (const entry of fresh) {
        const length = JSON.stringify(entry.item).length
        if (batch.length && (size + length > 24000 || batch.length >= snapshot.batchSize)) {
          batches.push(batch)
          batch = []
          size = 0
        }
        batch.push(entry)
        size += length
      }
      if (batch.length)
        batches.push(batch)
      await Promise.all(batches.map(async (entries) => {
        try {
          const input = entries.map(entry => entry.item)
          const selected = selectAntiJunkExamples(preferences, input)
          const decisions = await callDeepSeek(input, snapshot.apiKey, controller.signal, snapshot.metadata, selected, () => entries.forEach(entry => emit(entry, 'pending')), owner)
          const reviews: Promise<void>[] = []
          for (const decision of decisions) {
            const entry = entries[decision.n - 1]
            if (decision.verdict !== 'review') {
              finish(entry, { blocked: decision.verdict === 'block', rule: decision.rule, round: 1 })
              continue
            }
            reviews.push((async () => {
              if (!entry.flight.listeners.size) {
                finish(entry, { error: 'cancelled' })
                return
              }
              emit(entry, 'reviewing')
              const enriched = await enrichAntiJunkContext(entry.item, snapshot.metadata, controller.signal)
              const [review] = await callDeepSeek([enriched], snapshot.apiKey, controller.signal, snapshot.metadata, selectAntiJunkExamples(preferences, [enriched]), undefined, owner, true, [decision])
              finish(entry, { blocked: review.verdict === 'block', rule: review.rule, round: 2 })
            })().catch(error => finish(entry, { error: error instanceof JudgeError ? error.code : 'network' })))
          }
          await Promise.all(reviews)
        }
        catch (error) {
          const code = error instanceof JudgeError ? error.code : controller.signal.aborted ? 'cancelled' : 'network'
          entries.forEach(entry => finish(entry, { error: code }))
        }
      }))
      while (cache.size > 1500) cache.delete(cache.keys().next().value!)
      if (revision === config.revision)
        void persistData().catch(() => {})
    })().finally(() => activeRequests.delete(controller))
  }
  const values = await Promise.all(outcomes)
  if (revision !== config.revision || signal.aborted)
    return result
  values.forEach((value, index) => {
    const token = comments[index].token
    if (value.blocked !== undefined) {
      result.checked.push(token)
      if (value.blocked)
        result.blocked.push(token)
      result.details![token] = { rule: value.rule ?? '', round: value.round ?? 0 }
    }
    else if (value.error) {
      result.error = value.error
      if (value.error !== 'cancelled')
        data.lastError = value.error
    }
  })
  void persistData().catch(() => {})
  return result
}

function currentState() {
  return { feedback: config.feedback, enabled: config.enabled, inspect: config.inspect, metadata: config.metadata, batchSize: config.batchSize, requestsPerSecond: config.requestsPerSecond, cleared: config.clearRevision === config.revision, revision: config.revision }
}

async function handle(action: unknown, payload: any, sender: browser.Runtime.MessageSender) {
  await ready
  if (sender.id !== browser.runtime.id)
    throw new Error('Invalid sender')
  if (action === 'state')
    return currentState()
  if (action === 'read')
    return { config, data: { ...data, cache: [] }, library }
  if (action === 'library-add') {
    const comment = normalizeAntiJunkComment(payload?.comment)
    if (!comment)
      return { error: 'invalid-library' }
    const verdict = payload.verdict ?? 'block'
    if (!['allow', 'block'].includes(verdict))
      return { error: 'invalid-library' }
    const existing = library.examples.find(example => antiJunkIdentity(example.comment) === antiJunkIdentity(comment))
    if (existing?.verdict === verdict)
      return { ok: true }
    if (!existing && library.examples.length >= 50)
      return { error: 'library-full' }
    try {
      return await saveLibrary({ ...library, examples: [...library.examples.filter(example => example !== existing), { key: crypto.randomUUID(), verdict, comment, time: Date.now() }], revision: crypto.randomUUID() }, true)
    }
    catch (error) {
      return { error: error instanceof Error && error.message === 'library-full' ? 'library-full' : 'invalid-library' }
    }
  }
  if (action === 'library-remove') {
    if (typeof payload?.key !== 'string' || !library.examples.some(example => example.key === payload.key))
      return { error: 'invalid-library' }
    return saveLibrary({ ...library, examples: library.examples.filter(example => example.key !== payload.key), revision: crypto.randomUUID() }, true)
  }
  if (action === 'library-clear')
    return saveLibrary({ examples: [], summary: '', revision: crypto.randomUUID() })
  if (action === 'library-summary-save') {
    if (typeof payload?.summary !== 'string' || payload.summary.length > 6000)
      return { error: 'invalid-library' }
    return saveLibrary({ ...library, summary: payload.summary.trim(), revision: crypto.randomUUID() })
  }
  if (action === 'library-summarize') {
    if (!config.apiKey)
      return { error: 'missing-key' }
    if (!library.examples.length && !library.summary)
      return { error: 'empty-library' }
    if (summarizing)
      return { error: 'busy' }
    summarizing = true
    const snapshot = library
    const controller = new AbortController()
    activeRequests.add(controller)
    const revision = config.revision
    try {
      const summary = await summarizeAntiJunkLibrary(snapshot, config.apiKey, controller.signal, config.metadata)
      return await withChanges(async () => {
        if (library.revision !== snapshot.revision || config.revision !== revision)
          return { error: 'stale-library' }
        return saveLibrary({ examples: [], summary, revision: crypto.randomUUID() })
      })
    }
    catch (error) { return { error: error instanceof JudgeError ? error.code : 'storage-error' } }
    finally {
      activeRequests.delete(controller)
      summarizing = false
    }
  }
  if (action === 'save') {
    if (typeof payload?.enabled !== 'boolean' || typeof payload?.apiKey !== 'string' || payload.apiKey.length > 512 || /[\r\n]/.test(payload.apiKey))
      throw new Error('Invalid configuration')
    if (payload.enabled && !payload.apiKey.trim())
      return { error: 'missing-key' }
    if (payload.inspect !== undefined && typeof payload.inspect !== 'boolean')
      throw new Error('Invalid inspection mode')
    if (payload.metadata !== undefined && typeof payload.metadata !== 'boolean')
      throw new Error('Invalid metadata setting')
    const batchSize = payload.batchSize ?? config.batchSize
    const requestsPerSecond = payload.requestsPerSecond ?? config.requestsPerSecond
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > ANTI_JUNK_BATCH_SIZE
      || !Number.isInteger(requestsPerSecond) || requestsPerSecond < 1 || requestsPerSecond > 20) {
      return { error: 'invalid-limits' }
    }
    const metadata = payload.metadata ?? config.metadata
    const changed = ['unauthorized', 'balance'].includes(data.lastError) || config.enabled !== payload.enabled || config.apiKey !== payload.apiKey.trim() || config.metadata !== metadata
    const next = { ...config, enabled: payload.enabled, inspect: payload.inspect ?? config.inspect, metadata, batchSize, requestsPerSecond, apiKey: payload.apiKey.trim(), revision: changed ? crypto.randomUUID() : config.revision }
    await browser.storage.local.set({ [ANTI_JUNK_CONFIG]: next })
    config = next
    configureAntiJunkRateLimit(config.requestsPerSecond)
    resumeAntiJunkRequests()
    if (changed)
      cancelActive()
    data.lastError = ''
    await persistData()
    return currentState()
  }
  if (action === 'export' || action === 'export-download') {
    const backup = {
      format: 'BewlyCatAntiJunk',
      version: 2,
      config: { enabled: config.enabled, inspect: config.inspect, metadata: config.metadata, batchSize: config.batchSize, requestsPerSecond: config.requestsPerSecond, ...(payload?.includeKey === true ? { apiKey: config.apiKey } : {}) },
      data: { records: data.records, checked: data.checked, blocked: data.blocked },
      library,
    }
    if (action === 'export')
      return backup
    // Download from the extension context; page navigation and activation must not control backup delivery.
    await browser.downloads.download({
      url: `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(backup, null, 2))}`,
      filename: `antijunk-backup-${new Date().toISOString().slice(0, 10)}.json`,
      saveAs: true,
    })
    return { ok: true }
  }
  if (action === 'import') {
    let backup
    try {
      backup = parseAntiJunkBackup(payload)
    }
    catch {
      return { error: 'invalid-backup' }
    }
    const previous = config
    const apiKey = backup.config.apiKey ?? config.apiKey
    const next = { enabled: backup.config.enabled && Boolean(apiKey), inspect: backup.config.inspect, metadata: backup.config.metadata, batchSize: backup.config.batchSize, requestsPerSecond: backup.config.requestsPerSecond, apiKey, revision: crypto.randomUUID() }
    // 先使旧请求失效，避免导入时把过期判断写回新状态。
    config = next
    cancelActive()
    try {
      await writing.catch(() => {})
      const records = [...data.records, ...backup.data.records].sort((a, b) => b.time - a.time)
      const seen = new Set<string>()
      const merged = records.filter((item) => {
        const key = JSON.stringify([item.oid, item.id, item.text, item.hasPictures === true])
        if (seen.has(key))
          return false
        seen.add(key)
        return true
      }).slice(0, 200)
      while (new TextEncoder().encode(JSON.stringify(merged)).length > 1_500_000)
        merged.pop()
      const nextData = { ...data, records: merged, cache: [], checked: Math.max(data.checked, backup.data.checked), blocked: Math.max(data.blocked, backup.data.blocked), lastError: '' }
      await browser.storage.local.set({ [ANTI_JUNK_CONFIG]: next, [ANTI_JUNK_DATA]: nextData, ...(backup.library ? { [ANTI_JUNK_LIBRARY]: backup.library } : {}) })
      if (backup.library)
        library = backup.library
      data = nextData
      cache.clear()
      configureAntiJunkRateLimit(config.requestsPerSecond)
      resumeAntiJunkRequests()
      return { ok: true, keyMissing: backup.config.enabled && !apiKey }
    }
    catch {
      config = previous
      return { error: 'storage-error' }
    }
  }
  if (action === 'clear') {
    if (payload?.all === true) {
      const previous = config
      const revision = crypto.randomUUID()
      const next = { ...config, revision, clearRevision: revision }
      // 使正在请求、排队和页面内的旧判断一并失效，避免清空后被写回。
      config = next
      cancelActive()
      try {
        await writing.catch(() => {})
        const nextData = emptyData()
        await browser.storage.local.set({ [ANTI_JUNK_CONFIG]: next, [ANTI_JUNK_DATA]: nextData })
        cache.clear()
        data = nextData
        return { ok: true }
      }
      catch {
        config = previous
        return { error: 'storage-error' }
      }
    }
    data.records = []
    await persistData()
    return { ok: true }
  }
  if (action === 'test') {
    if (!config.apiKey)
      return { error: 'missing-key' }
    try {
      const item: AntiJunkComment = { token: 'test', id: 'test', oid: 'test', text: '沙发', parentText: '', title: '连接测试', author: '', url: '' }
      const ids = await callDeepSeek([item], config.apiKey, new AbortController().signal, config.metadata)
      if (ids[0]?.verdict === 'block') {
        data.lastError = ''
        await persistData()
      }
      return ids[0]?.verdict === 'block' ? { ok: true } : { error: 'unexpected-verdict' }
    }
    catch (error) {
      return { error: error instanceof JudgeError ? error.code : 'network' }
    }
  }
  if (action === 'judge') {
    if (!Array.isArray(payload?.comments) || payload.comments.length === 0 || payload.comments.length > ANTI_JUNK_BATCH_SIZE || typeof payload.revision !== 'string')
      throw new Error('Invalid batch')
    const comments = payload.comments.map(normalizeAntiJunkComment)
    if (comments.some((item: AntiJunkComment | null) => !item) || new Set(comments.map((item: AntiJunkComment) => item.token)).size !== comments.length)
      throw new Error('Invalid comment')
    if (comments.some((item: AntiJunkComment) => item.oid !== comments[0].oid || item.title !== comments[0].title || JSON.stringify(item.video) !== JSON.stringify(comments[0].video)))
      throw new Error('Mixed comment context')
    if (typeof payload.requestId !== 'string' || payload.requestId.length > 100)
      throw new Error('Invalid request')
    const owner = String(sender.tab?.id ?? 'settings')
    const requestKey = `${owner}:${sender.frameId ?? 0}:${payload.requestId}`
    if (subscriptions.has(requestKey))
      throw new Error('Duplicate request')
    const controller = new AbortController()
    const tokens = new Map<string, AbortController>(comments.map((item: AntiJunkComment) => [item.token, new AbortController()]))
    controller.signal.addEventListener('abort', () => tokens.forEach(token => token.abort()), { once: true })
    subscriptions.set(requestKey, { controller, tokens })
    const onProgress = (tokens: string[], status: AntiJunkStatus) => {
      if (sender.tab?.id === undefined)
        return
      void browser.tabs.sendMessage(sender.tab.id, { type: ANTI_JUNK_MESSAGE, action: 'progress', requestId: payload.requestId, revision: payload.revision, tokens, status }, { frameId: sender.frameId ?? 0 }).catch(() => controller.abort())
    }
    try {
      return await judge(comments, payload.revision, owner, controller.signal, tokens, onProgress)
    }
    finally { subscriptions.delete(requestKey) }
  }
  if (action === 'cancel') {
    const subscription = subscriptions.get(`${String(sender.tab?.id ?? 'settings')}:${sender.frameId ?? 0}:${payload?.requestId}`)
    if (Array.isArray(payload?.tokens))
      payload.tokens.slice(0, ANTI_JUNK_BATCH_SIZE).forEach((token: string) => subscription?.tokens.get(token)?.abort())
    else subscription?.controller.abort()
    return { ok: true }
  }

  throw new Error('Unknown anti-junk action')
}

export function setupAntiJunk() {
  browser.tabs.onRemoved.addListener((tabId) => {
    for (const [key, subscription] of subscriptions) {
      if (key.startsWith(`${String(tabId)}:`))
        subscription.controller.abort()
    }
  })
  browser.runtime.onMessage.addListener((message: any, sender: browser.Runtime.MessageSender) => {
    if (message?.type !== ANTI_JUNK_MESSAGE)
      return false
    if (['save', 'import', 'clear', 'library-add', 'library-remove', 'library-clear', 'library-summary-save'].includes(message.action))
      return withChanges(() => handle(message.action, message.payload, sender))
    return handle(message.action, message.payload, sender)
  })
}
