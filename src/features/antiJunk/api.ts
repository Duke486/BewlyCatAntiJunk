import { recordMetric } from './metrics'
import { ANTI_JUNK_SUMMARY_AUDIT_PROMPT, ANTI_JUNK_SUMMARY_PROMPT, antiJunkPersonalizationPrompt, decodeAntiJunkSummary, decodeAntiJunkSummaryAudit } from './personalization'
import { ANTI_JUNK_REVIEW_PROMPT, ANTI_JUNK_SYSTEM_PROMPT } from './prompts'
import type { AntiJunkComment, AntiJunkDecision, AntiJunkLibrary } from './protocol'
import { ANTI_JUNK_ENDPOINT, ANTI_JUNK_MODEL, decodeAntiJunkVerdict } from './protocol'
import { RequestScheduler } from './scheduler'

export class JudgeError extends Error {
  constructor(public code: string, public retryable = false) {
    super(code)
  }
}

let requestsPerSecond = 1
let admissions = Promise.resolve()
let dispatchTimes: number[] = []
const scheduler = new RequestScheduler(3)
let paused = ''

export function resumeAntiJunkRequests() {
  paused = ''
}

export function configureAntiJunkRateLimit(limit: number) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 20)
    throw new Error('invalid-limits')
  requestsPerSecond = limit
}

function reserveRequest(signal: AbortSignal): Promise<void> {
  const task = admissions.catch(() => {}).then(async () => {
    while (true) {
      signal.throwIfAborted()
      const now = performance.now()
      dispatchTimes = dispatchTimes.filter(time => now - time < 1000)
      if (dispatchTimes.length < requestsPerSecond) {
        dispatchTimes.push(now)
        return
      }
      // 短等待使修改限速也及时生效；取消后不占用请求额度。
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, Math.min(100, Math.max(1, 1001 - (now - dispatchTimes[0]))))
        function done() {
          clearTimeout(timer)
          signal.removeEventListener('abort', done)
          resolve()
        }
        signal.addEventListener('abort', done, { once: true })
      })
    }
  })
  admissions = task
  return task
}

export async function callDeepSeek(comments: AntiJunkComment[], apiKey: string, signal: AbortSignal, includeMetadata = true, library?: AntiJunkLibrary, onDispatch?: () => void, owner = 'settings', review = false, questions?: AntiJunkDecision[]): Promise<AntiJunkDecision[]> {
  recordMetric(review ? 'secondPass' : 'firstPass', comments.length)
  return requestDeepSeek([
    { role: 'system', content: `${ANTI_JUNK_SYSTEM_PROMPT}${review ? `\n${ANTI_JUNK_REVIEW_PROMPT}` : ''}` },
    { role: 'user', content: JSON.stringify({
      metadataEnabled: includeMetadata,
      ...(includeMetadata ? { title: comments[0]?.title ?? '', video: comments[0]?.video ? { ...comments[0].video, description: comments[0].video.description.slice(0, review ? 4000 : 800) } : undefined } : {}),
      preferences: library ? antiJunkPersonalizationPrompt(library, includeMetadata) : '',
      comments: comments.map((item, index) => ({ n: index + 1, text: item.text, hasPictures: item.hasPictures, parent: item.parentText, context: item.context ? { ...item.context, topic: includeMetadata ? item.context.topic?.slice(0, review ? 8000 : 1200) : undefined, related: review ? item.context.related : undefined } : undefined, ...(review ? { question: questions?.[index] ? { reason: questions[index].reason, evidence: questions[index].evidence, need: questions[index].need } : undefined } : {}) })),
    }) },
  ], apiKey, signal, content => decodeAntiJunkVerdict(content, comments, review), Math.min(12000, 256 + comments.length * (review ? 100 : 220)), onDispatch, 20000, owner, review ? 1 : 0)
}

export async function summarizeAntiJunkLibrary(library: AntiJunkLibrary, apiKey: string, signal: AbortSignal, includeMetadata: boolean) {
  const source = { guidance: library.summary, examples: library.examples.map((example, index) => ({
    n: index + 1,
    verdict: example.verdict ?? 'block',
    context: example.comment.context ? { ...example.comment.context, topic: includeMetadata ? example.comment.context.topic : undefined } : undefined,
    text: example.comment.text,
    ...(typeof example.comment.hasPictures === 'boolean' ? { hasPictures: example.comment.hasPictures } : {}),
    parent: example.comment.parentText,
    ...(includeMetadata ? { title: example.comment.title, video: example.comment.video } : {}),
  })) }
  const summary = await requestDeepSeek([
    { role: 'system', content: ANTI_JUNK_SUMMARY_PROMPT },
    { role: 'user', content: JSON.stringify(source) },
  ], apiKey, signal, decodeAntiJunkSummary, 4096, undefined, 45000)
  const approved = await requestDeepSeek([
    { role: 'system', content: ANTI_JUNK_SUMMARY_AUDIT_PROMPT },
    { role: 'user', content: JSON.stringify({ source, candidate: summary }) },
  ], apiKey, signal, decodeAntiJunkSummaryAudit, 128, undefined, 45000)
  if (!approved)
    throw new JudgeError('summary-too-broad')
  return summary
}

async function requestDeepSeek<T>(messages: Array<{ role: string, content: string }>, apiKey: string, signal: AbortSignal, decode: (content: unknown) => T, maxTokens: number, onDispatch?: () => void, timeout = 20000, owner = 'settings', priority = 2): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const queuedAt = performance.now()
      return await scheduler.submit(owner, priority, signal, async () => {
        signal.throwIfAborted()
        if (paused)
          throw new JudgeError(paused)
        await reserveRequest(signal)
        signal.throwIfAborted()
        if (paused)
          throw new JudgeError(paused)
        onDispatch?.()
        recordMetric('queueMs', Math.round(performance.now() - queuedAt))
        recordMetric('requests')
        const dispatchedAt = performance.now()
        const response = await fetch(ANTI_JUNK_ENDPOINT, {
          method: 'POST',
          credentials: 'omit',
          redirect: 'error',
          signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
          body: JSON.stringify({
            model: ANTI_JUNK_MODEL,
            thinking: { type: 'disabled' },
            stream: false,
            temperature: 0,
            max_tokens: maxTokens,
            response_format: { type: 'json_object' },
            messages,
          }),
        })
        if (!response.ok) {
          const code = response.status === 401
            ? 'unauthorized'
            : response.status === 402
              ? 'balance'
              : response.status === 429 ? 'rate-limit' : 'api-error'
          if (code === 'unauthorized' || code === 'balance')
            paused = code
          throw new JudgeError(code, response.status >= 500 || response.status === 429)
        }
        const envelope = await response.json()
        recordMetric('requestMs', Math.round(performance.now() - dispatchedAt))
        const choice = envelope?.choices?.[0]
        if (choice?.finish_reason !== 'stop')
          throw new JudgeError('invalid-format', true)
        try {
          return decode(choice.message?.content)
        }
        catch {
          throw new JudgeError('invalid-format', true)
        }
      })
    }
    catch (error) {
      if (signal.aborted)
        throw new JudgeError('cancelled')
      const failure = error instanceof JudgeError ? error : new JudgeError('network', true)
      recordMetric('errors')
      if (!failure.retryable || attempt === 1)
        throw failure
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, 1000)
        function done() {
          clearTimeout(timer)
          signal.removeEventListener('abort', done)
          resolve()
        }
        signal.addEventListener('abort', done, { once: true })
      })
    }
  }
  throw new JudgeError('api-error')
}
