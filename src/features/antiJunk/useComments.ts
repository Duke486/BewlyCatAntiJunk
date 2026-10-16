import type { MaybeRefOrGetter } from 'vue'
import { computed, onScopeDispose, ref, toValue, watch } from 'vue'

import { addAntiJunkExample, judgeAntiJunkComment, subscribeAntiJunk } from '~/features/antiJunk/client'
import type { AntiJunkComment, AntiJunkState, AntiJunkStatus } from '~/features/antiJunk/protocol'

import { antiJunkSignature } from './protocol'

export function useAntiJunkComments(comments: MaybeRefOrGetter<AntiJunkComment[]>) {
  const state = ref<AntiJunkState>({ enabled: false, inspect: false, metadata: true, batchSize: 10, requestsPerSecond: 1, cleared: false, revision: '' })
  const decisions = ref(new Map<string, boolean>())
  const pending = new Map<string, AbortController>()
  const failed = new Set<string>()
  const retryTick = ref(0)
  const statuses = ref(new Map<string, AntiJunkStatus>())
  const details = ref(new Map<string, { rule: string, round: number }>())
  let disposed = false
  const unsubscribe = subscribeAntiJunk((next) => {
    if (next.revision !== state.value.revision) {
      decisions.value.clear()
      pending.forEach(controller => controller.abort())
      pending.clear()
      failed.clear()
      statuses.value.clear()
      details.value.clear()
      // 清空时恢复当前评论，不立即重检而又填满刚清空的记录；新评论/刷新后照常检测。
      if (next.cleared && state.value.revision) {
        for (const item of toValue(comments))
          decisions.value.set(antiJunkSignature(item), false)
      }
    }
    if (next.feedback?.revision !== state.value.feedback?.revision && next.feedback) {
      const affected = new Set(next.feedback.identities)
      for (const item of toValue(comments)) {
        const key = antiJunkSignature(item)
        if (affected.has(JSON.parse(key)[0])) {
          pending.get(key)?.abort()
          pending.delete(key)
          decisions.value.delete(key)
          failed.delete(key)
          statuses.value.delete(item.id)
          details.value.delete(item.id)
        }
      }
    }
    state.value = next
  })
  watch(() => [state.value, toValue(comments), retryTick.value] as const, ([current, items]) => {
    const keys = new Set(items.map(antiJunkSignature))
    for (const [key, controller] of pending) {
      if (!keys.has(key) || !current.enabled) {
        controller.abort()
        pending.delete(key)
      }
    }
    for (const key of decisions.value.keys()) {
      if (!keys.has(key))
        decisions.value.delete(key)
    }
    for (const key of failed) {
      if (!keys.has(key))
        failed.delete(key)
    }
    const ids = new Set(items.map(item => item.id))
    for (const id of statuses.value.keys()) {
      if (!ids.has(id))
        statuses.value.delete(id)
    }
    for (const id of details.value.keys()) {
      if (!ids.has(id))
        details.value.delete(id)
    }
    if (!current.enabled)
      return
    for (const item of items) {
      const key = antiJunkSignature(item)
      if (decisions.value.has(key) || pending.has(key) || failed.has(key))
        continue
      const controller = new AbortController()
      pending.set(key, controller)
      const revision = current.revision
      void judgeAntiJunkComment(item, (status, detail) => {
        if (!disposed && !controller.signal.aborted && state.value.revision === revision) {
          statuses.value.set(item.id, status)
          if (detail)
            details.value.set(item.id, detail)
          if (status === 'approved' || status === 'rejected')
            decisions.value.set(key, status === 'rejected')
        }
      }, controller.signal).then((blocked) => {
        if (disposed || controller.signal.aborted || state.value.revision !== revision)
          return
        pending.delete(key)
        if (blocked === undefined) {
          failed.add(key)
          statuses.value.set(item.id, 'error')
        }
        else {
          decisions.value.set(key, blocked)
        }
      })
    }
  }, { immediate: true })
  onScopeDispose(() => {
    disposed = true
    pending.forEach(controller => controller.abort())
    unsubscribe()
  })
  const blocked = computed(() => new Set(state.value.enabled
    ? toValue(comments).filter(item => decisions.value.get(antiJunkSignature(item))).map(item => item.id)
    : []))
  async function addExample(id: string, verdict: 'block' | 'allow' = 'block') {
    const item = toValue(comments).find(comment => comment.id === id)
    return item ? addAntiJunkExample(item, verdict) : { error: 'invalid-library' }
  }
  return { blocked, statuses, details, addExample, retry: () => {
    failed.clear()
    retryTick.value++
  }, enabled: computed(() => state.value.enabled), inspect: computed(() => state.value.enabled && state.value.inspect) }
}
