<script setup lang="ts">
import { useI18n } from 'vue-i18n'

import type { AntiJunkStatus } from './protocol'
import { ANTI_JUNK_STATUS_ICONS } from './protocol'

defineProps<{ inspect: boolean, status?: AntiJunkStatus, detail?: { rule: string, round: number }, blocked: boolean, busy: boolean }>()
defineEmits<{ feedback: [verdict: 'block' | 'allow'], retry: [] }>()
const { t } = useI18n()
</script>

<template>
  <span class="anti-junk-tools">
    <span v-if="inspect" :title="detail ? t('anti_junk.decision_detail', { ...detail, rule: t(`anti_junk.rules.${detail.rule}`) }) : t(`anti_junk.status_${status || 'queued'}`)">{{ ANTI_JUNK_STATUS_ICONS[status || 'queued'] }}</span>
    <button
      v-if="status === 'error'" type="button" class="anti-junk-add" :title="t('anti_junk.retry')" :aria-label="t('anti_junk.retry')"
      @click.stop="$emit('retry')"
    >↻</button>
    <button
      type="button" class="anti-junk-add" :disabled="busy" :title="t(blocked ? 'anti_junk.keep_example' : 'anti_junk.add_example')" :aria-label="t(blocked ? 'anti_junk.keep_example' : 'anti_junk.add_example')"
      @click.stop="$emit('feedback', blocked ? 'allow' : 'block')"
    >{{ blocked ? '✓' : '⊘' }}</button>
  </span>
</template>

<style scoped lang="scss">
.anti-junk-tools {
  display: inline-flex;
  align-items: center;
  gap: var(--bew-space-1);
  margin-inline-end: var(--bew-space-1);
  font-size: var(--bew-font-size-caption);
  vertical-align: baseline;
}
.anti-junk-add {
  display: inline-grid;
  place-items: center;
  width: var(--bew-space-6);
  height: var(--bew-space-6);
  padding: 0;
  border: 0;
  border-radius: var(--bew-radius-sm);
  background: transparent;
  color: var(--bew-text-3);
  font: inherit;
  cursor: pointer;
  &:hover {
    color: var(--bew-theme-color);
    background: var(--bew-fill-1);
  }
  &:active {
    opacity: 0.7;
  }
  &:disabled {
    opacity: 0.4;
    cursor: wait;
  }
  &:focus-visible {
    outline: 2px solid var(--bew-theme-color);
    outline-offset: 2px;
  }
}
</style>
