import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast } from 'vue-toastification'

import type { CommentPreviewState } from '~/components/MomentCard/commentPreview'
import type { DisplayMoment } from '~/components/MomentCard/types'

import { useAntiJunkComments } from './useComments'

export function useMomentAntiJunk(moment: DisplayMoment, state: CommentPreviewState) {
  const { t } = useI18n()
  const toast = useToast()
  const aiRevealed = ref(new Set<string>())
  const { blocked: aiBlocked, inspect: aiInspect, statuses: aiStatuses, details: aiDetails, enabled: aiEnabled, addExample, retry: retryAi } = useAntiJunkComments(computed(() => state.comments.flatMap((root) => {
    const comments = new Map([root, ...root.hotReplies, ...root.replies].map(comment => [comment.id, comment]))
    return [...comments.values()].map((comment) => {
      const parent = comment === root ? undefined : comments.get(comment.parentId)
      return {
        token: `moment-${comment.id}`,
        id: comment.id,
        oid: state.target?.oid ?? moment.id,
        text: comment.content.map(part => part.text).join('') || '[图片评论]',
        hasPictures: comment.pictures.length > 0,
        context: {
          kind: 'moment' as const,
          commentType: state.target?.type ?? moment.commentTarget?.type,
          rootId: root.id,
          parentId: comment === root ? undefined : comment.parentId,
          parentMissing: comment !== root && !parent,
          rootText: root.content.map(part => part.text).join('').slice(0, 4000),
          topic: [moment.title, moment.text, moment.forward ? `转发原文：${moment.forward.title}\n${moment.forward.text}` : ''].filter(Boolean).join('\n').slice(0, 8000),
          related: [...comments.values()].filter(other => other.id !== comment.id && other.parentId === comment.parentId).slice(0, 6).map(other => other.content.map(part => part.text).join('').slice(0, 2000)),
        },
        parentText: parent?.content.map(part => part.text).join('').slice(0, 2000) ?? '',
        author: comment.author.slice(0, 100),
        title: moment.title.slice(0, 300),
        url: `https://t.bilibili.com/${moment.id}#reply${comment.id}`,
      }
    })
  })))
  const aiLayoutKey = computed(() => JSON.stringify([aiInspect.value, [...aiBlocked.value], [...aiRevealed.value]]))
  const aiAdding = ref(new Set<string>())

  async function addAiExample(id: string, verdict: 'block' | 'allow' = 'block') {
    if (aiAdding.value.has(id))
      return
    aiAdding.value.add(id)
    try {
      const result = await addExample(id, verdict)
      if (result.error)
        toast.error(t(`anti_junk.errors.${result.error}`))
      else
        toast.success(t('anti_junk.example_added'))
    }
    finally { aiAdding.value.delete(id) }
  }

  function toggleAiComment(id: string) {
    if (aiRevealed.value.has(id))
      aiRevealed.value.delete(id)
    else
      aiRevealed.value.add(id)
  }

  return { aiRevealed, aiBlocked, aiInspect, aiStatuses, aiDetails, aiEnabled, aiLayoutKey, aiAdding, addAiExample, toggleAiComment, retryAi }
}
