import browser from 'webextension-polyfill'

import type { AntiJunkComment, AntiJunkConfig, AntiJunkResult, AntiJunkState, AntiJunkStatus } from './protocol'
import { ANTI_JUNK_BATCH_SIZE, ANTI_JUNK_CONFIG, ANTI_JUNK_MESSAGE, antiJunkSignature, normalizeAntiJunkComment } from './protocol'
import { clearAntiJunkVideoCache, loadAntiJunkVideo } from './video'

let state: AntiJunkState = { enabled: false, inspect: false, metadata: true, batchSize: 10, requestsPerSecond: 1, cleared: false, revision: '' }
const listeners = new Set<(value: AntiJunkState) => void>()
const cached = new Map<string, boolean>()
interface Job {
  comment: AntiJunkComment
  resolve: Array<(value: boolean | undefined) => void>
  updates: Array<(status: AntiJunkStatus, detail?: { rule: string, round: number }) => void>
  invalidated?: boolean
  status: AntiJunkStatus
}
const jobs = new Map<string, Job>()
const batches = new Map<string, { revision: string, jobs: Job[] }>()
let timer: ReturnType<typeof setTimeout> | undefined
let running = 0
const inFlight = new Map<string, Job>()
let registered = false
let initializing: Promise<void> | undefined
let stateChanges = 0

function updateState(next: AntiJunkState) {
  if (next.revision === state.revision && next.enabled === state.enabled && next.inspect === state.inspect && next.metadata === state.metadata && next.cleared === state.cleared && next.batchSize === state.batchSize && next.requestsPerSecond === state.requestsPerSecond && next.feedback?.revision === state.feedback?.revision)
    return
  const detectionChanged = next.revision !== state.revision || next.enabled !== state.enabled
  if (next.feedback?.revision !== state.feedback?.revision && next.feedback) {
    const affected = new Set(next.feedback.identities)
    for (const key of cached.keys()) {
      if (affected.has(JSON.parse(key)[0]))
        cached.delete(key)
    }
    for (const map of [jobs, inFlight]) {
      for (const [key, job] of map) {
        if (affected.has(JSON.parse(key)[0])) {
          job.invalidated = true
          job.resolve.forEach(resolve => resolve(undefined))
          map.delete(key)
        }
      }
    }
  }
  state = next
  stateChanges++
  if (detectionChanged) {
    cached.clear()
    clearAntiJunkVideoCache()
    for (const job of jobs.values())
      job.resolve.forEach(resolve => resolve(undefined))
    jobs.clear()
    for (const requestId of batches.keys())
      void browser.runtime.sendMessage({ type: ANTI_JUNK_MESSAGE, action: 'cancel', payload: { requestId } }).catch(() => {})
    inFlight.clear()
    batches.clear()
  }
  listeners.forEach(listener => listener(state))
}

function initAntiJunkClient() {
  initializing ??= (async () => {
    const initialChanges = stateChanges
    if (!registered) {
      registered = true
      browser.runtime.onMessage.addListener((message: any, sender: browser.Runtime.MessageSender) => {
        if (sender.id !== browser.runtime.id || message?.type !== ANTI_JUNK_MESSAGE || message.action !== 'progress' || !Array.isArray(message.tokens))
          return false
        const batch = batches.get(message.requestId)
        if (!batch || batch.revision !== message.revision || batch.revision !== state.revision)
          return false
        for (const job of batch.jobs) {
          if (!job.invalidated && message.tokens.includes(job.comment.token)) {
            job.status = message.status === 'reviewing' ? 'reviewing' : message.status === 'approved' ? 'approved' : message.status === 'rejected' ? 'rejected' : 'pending'
            job.updates.forEach(update => update(job.status))
          }
        }
        return false
      })
      browser.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes[ANTI_JUNK_CONFIG])
          return
        const value = changes[ANTI_JUNK_CONFIG].newValue as AntiJunkConfig | undefined
        updateState({ feedback: value?.feedback, enabled: value?.enabled === true && Boolean(value.apiKey), inspect: value?.inspect === true, metadata: value?.metadata !== false, batchSize: value?.batchSize ?? 10, requestsPerSecond: value?.requestsPerSecond ?? 1, cleared: Boolean(value?.clearRevision) && value?.clearRevision === value?.revision, revision: value?.revision ?? '' })
      })
    }
    const next = await browser.runtime.sendMessage({ type: ANTI_JUNK_MESSAGE, action: 'state' }) as AntiJunkState
    if (stateChanges === initialChanges)
      updateState(next)
  })().catch(() => { initializing = undefined })
  return initializing
}

export function subscribeAntiJunk(listener: (value: AntiJunkState) => void) {
  listeners.add(listener)
  listener(state)
  void initAntiJunkClient().then(() => {
    if (listeners.has(listener))
      listener(state)
  })
  return () => {
    listeners.delete(listener)
  }
}

async function flush() {
  timer = undefined
  if (running >= 3 || !state.enabled || jobs.size === 0)
    return
  running++
  const revision = state.revision
  const first = jobs.values().next().value as Job
  const batch: Array<[string, Job]> = []
  let characters = 0
  for (const entry of jobs) {
    const item = entry[1].comment
    if (item.oid !== first.comment.oid || item.title !== first.comment.title || JSON.stringify(item.video) !== JSON.stringify(first.comment.video))
      continue
    if (batch.length && characters + JSON.stringify(item).length > 20000)
      break
    batch.push(entry)
    characters += JSON.stringify(item).length
    if (batch.length >= Math.min(state.batchSize, ANTI_JUNK_BATCH_SIZE))
      break
  }
  batch.forEach(([key, job]) => {
    jobs.delete(key)
    inFlight.set(key, job)
  })
  const requestId = crypto.randomUUID()
  batches.set(requestId, { revision, jobs: batch.map(([, job]) => job) })
  if (jobs.size && running < 3)
    timer = setTimeout(() => void flush(), 0)
  try {
    const result = await browser.runtime.sendMessage({
      type: ANTI_JUNK_MESSAGE,
      action: 'judge',
      payload: { revision, requestId, comments: batch.map(([, job]) => job.comment) },
    }) as AntiJunkResult
    for (const [key, job] of batch) {
      const valid = !job.invalidated && state.enabled && state.revision === revision && result.revision === revision
        && Array.isArray(result.checked) && Array.isArray(result.blocked) && result.checked.includes(job.comment.token)
      const value = valid ? result.blocked.includes(job.comment.token) : undefined
      if (value !== undefined)
        cached.set(key, value)
      if (!job.invalidated && state.enabled && state.revision === revision)
        job.updates.forEach(update => update(value === undefined ? 'error' : value ? 'rejected' : 'approved', result.details?.[job.comment.token]))
      job.resolve.forEach(resolve => resolve(value))
    }
    while (cached.size > 1500)
      cached.delete(cached.keys().next().value!)
  }
  catch {
    batch.forEach(([, job]) => {
      if (!job.invalidated && state.enabled && state.revision === revision)
        job.updates.forEach(update => update('error'))
      job.resolve.forEach(resolve => resolve(undefined))
    })
  }
  finally {
    running--
    batch.forEach(([key, job]) => {
      if (inFlight.get(key) === job)
        inFlight.delete(key)
    })
    batches.delete(requestId)
    if (jobs.size)
      timer = setTimeout(() => void flush(), 150)
  }
}

export async function judgeAntiJunkComment(comment: AntiJunkComment, onStatus?: (status: AntiJunkStatus, detail?: { rule: string, round: number }) => void, signal?: AbortSignal): Promise<boolean | undefined> {
  onStatus?.('queued')
  if (!normalizeAntiJunkComment(comment))
    return undefined
  await initAntiJunkClient()
  if (!state.enabled || signal?.aborted)
    return undefined
  const revision = state.revision
  const video = state.metadata ? await loadAntiJunkVideo(comment.url) : undefined
  if (!state.enabled || state.revision !== revision || signal?.aborted)
    return undefined
  comment = { ...comment, video, ...(video ? { title: video.title } : {}) }
  const key = antiJunkSignature(comment)
  if (cached.has(key)) {
    onStatus?.(cached.get(key) ? 'rejected' : 'approved')
    return cached.get(key)
  }
  return new Promise((resolve) => {
    const job = jobs.get(key) ?? inFlight.get(key)
    let current = job
    const done = (value: boolean | undefined) => {
      signal?.removeEventListener('abort', abort)
      resolve(value)
    }
    function abort() {
      if (!current)
        return
      current.resolve = current.resolve.filter(callback => callback !== done)
      current.updates = current.updates.filter(callback => callback !== onStatus)
      if (!current.resolve.length) {
        current.invalidated = true
        jobs.delete(key)
        if (inFlight.get(key) === current)
          inFlight.delete(key)
      }
      for (const [requestId, batch] of batches) {
        if (!current.resolve.length && batch.jobs.includes(current))
          void browser.runtime.sendMessage({ type: ANTI_JUNK_MESSAGE, action: 'cancel', payload: { requestId, tokens: [current.comment.token] } }).catch(() => {})
      }
      done(undefined)
    }
    if (job) {
      job.resolve.push(done)
      onStatus?.(job.status)
      if (onStatus)
        job.updates.push(onStatus)
    }
    else {
      current = { comment, resolve: [done], updates: onStatus ? [onStatus] : [], status: 'queued' }
      jobs.set(key, current)
    }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted)
      abort()
    if (!timer && running < 3)
      timer = setTimeout(() => void flush(), 150)
  })
}

export async function addAntiJunkExample(comment: AntiJunkComment, verdict: 'block' | 'allow' = 'block'): Promise<{ ok?: boolean, error?: string }> {
  const normalized = normalizeAntiJunkComment(comment)
  if (!normalized)
    return { error: 'invalid-library' }
  await initAntiJunkClient()
  const video = state.metadata ? await loadAntiJunkVideo(normalized.url) : undefined
  try {
    return await browser.runtime.sendMessage({ type: ANTI_JUNK_MESSAGE, action: 'library-add', payload: { verdict, comment: { ...normalized, video, ...(video ? { title: video.title } : {}) } } })
  }
  catch { return { error: 'storage-error' } }
}
