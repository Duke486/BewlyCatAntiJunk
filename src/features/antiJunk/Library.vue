<script setup lang="ts">
import { onMounted, onScopeDispose, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import browser from 'webextension-polyfill'

import Button from '~/components/Button.vue'
import Input from '~/components/Input.vue'
import SettingsItemGroup from '~/components/Settings/components/SettingsItemGroup.vue'
import type { AntiJunkLibrary } from '~/features/antiJunk/protocol'
import { ANTI_JUNK_LIBRARY, ANTI_JUNK_MESSAGE } from '~/features/antiJunk/protocol'

const { t } = useI18n()
const library = ref<AntiJunkLibrary>({ examples: [], summary: '', revision: '' })
const summaryDraft = ref('')
const summarizing = ref(false)
const text = ref('')
const verdict = ref<'block' | 'allow'>('block')
const parent = ref('')
const title = ref('')
const busy = ref(false)
const error = ref('')
const status = ref('')
const request = (action: string, payload?: unknown) => browser.runtime.sendMessage({ type: ANTI_JUNK_MESSAGE, action, payload })

async function refresh() {
  try {
    const result = await request('read') as { library: AntiJunkLibrary }
    if (result.library.summary !== library.value.summary)
      summaryDraft.value = result.library.summary
    library.value = result.library
  }
  catch { error.value = 'storage-error' }
}

async function change(action: string, payload?: unknown) {
  busy.value = true
  summarizing.value = action === 'library-summarize'
  error.value = status.value = ''
  try {
    const result = await request(action, payload) as { ok?: boolean, error?: string }
    if (result.error || !result.ok) {
      error.value = result.error || 'storage-error'
      return false
    }
    await refresh()
    if (action === 'library-clear')
      summaryDraft.value = ''
    status.value = t(action === 'library-summarize' ? 'anti_junk.library_summarized' : 'anti_junk.library_saved')
    return true
  }
  catch {
    error.value = 'storage-error'
    return false
  }
  finally {
    busy.value = false
    summarizing.value = false
  }
}

async function add() {
  if (busy.value || !text.value.trim())
    return
  const id = `manual-${crypto.randomUUID()}`
  if (await change('library-add', { verdict: verdict.value, comment: { token: id, id, oid: 'manual', text: text.value.trim(), parentText: parent.value.trim(), title: title.value.trim(), author: '', url: '' } })) {
    text.value = parent.value = title.value = ''
  }
}

function storageChanged(changes: Record<string, browser.Storage.StorageChange>, area: string) {
  if (area === 'local' && changes[ANTI_JUNK_LIBRARY])
    void refresh()
}
browser.storage.onChanged.addListener(storageChanged)
onScopeDispose(() => browser.storage.onChanged.removeListener(storageChanged))
onMounted(() => void refresh())
</script>

<template>
  <SettingsItemGroup :title="t('anti_junk.library_title')" :desc="t('anti_junk.library_desc')">
    <div class="case-library">
      <div class="case-form">
        <label for="antijunk-example-verdict">{{ t('anti_junk.example_verdict') }}</label>
        <select id="antijunk-example-verdict" v-model="verdict" :disabled="busy">
          <option value="block">
            {{ t('anti_junk.block_example') }}
          </option>
          <option value="allow">
            {{ t('anti_junk.keep_example') }}
          </option>
        </select>
        <label for="antijunk-example-text">{{ t('anti_junk.example_text') }}</label>
        <textarea
          id="antijunk-example-text" v-model="text" rows="3" maxlength="12000" :disabled="busy"
          required
        />
        <label for="antijunk-example-parent">{{ t('anti_junk.example_parent') }}</label>
        <textarea id="antijunk-example-parent" v-model="parent" rows="2" maxlength="2000" :disabled="busy" />
        <Input v-model="title" :placeholder="t('anti_junk.example_context')" :aria-label="t('anti_junk.example_context')" maxlength="300" :disabled="busy" />
        <div class="actions">
          <Button type="primary" :disabled="busy || !text.trim()" @click="add">
            {{ t('anti_junk.library_add') }}
          </Button>
          <Button :disabled="busy || (!library.examples.length && !library.summary)" @click="change('library-summarize')">
            {{ t(summarizing ? 'anti_junk.library_summarizing' : 'anti_junk.library_summarize') }}
          </Button>
          <Button type="error" :disabled="busy || (!library.examples.length && !library.summary)" @click="change('library-clear')">
            {{ t('anti_junk.library_clear') }}
          </Button>
        </div>
      </div>
      <p>{{ t('anti_junk.library_stats', { count: library.examples.length, length: library.summary.length }) }}</p>
      <p v-if="status" role="status">
        {{ status }}
      </p>
      <p v-if="error" class="error" role="alert">
        {{ t(`anti_junk.errors.${error}`) }}
      </p>
      <div class="case-form">
        <label for="antijunk-summary">{{ t('anti_junk.library_summary') }}</label>
        <textarea id="antijunk-summary" v-model="summaryDraft" rows="5" maxlength="6000" :disabled="busy" />
        <p>{{ t('anti_junk.library_summary_note') }}</p>
        <div class="actions">
          <Button :disabled="busy || summaryDraft === library.summary" @click="change('library-summary-save', { summary: summaryDraft })">
            {{ t('anti_junk.library_summary_save') }}
          </Button>
        </div>
      </div>
      <div class="case-list">
        <article v-for="example in library.examples" :key="example.key" class="case">
          <p>{{ t(example.verdict === 'allow' ? 'anti_junk.keep_example' : 'anti_junk.block_example') }}</p>
          <p class="case-text">
            {{ example.comment.text }}
          </p>
          <p v-if="example.comment.title" class="context">
            {{ example.comment.title }}
          </p>
          <details v-if="example.comment.parentText">
            <summary>{{ t('anti_junk.parent') }}</summary>
            <p class="case-text">
              {{ example.comment.parentText }}
            </p>
          </details>
          <Button size="small" :disabled="busy" @click="change('library-remove', { key: example.key })">
            {{ t('anti_junk.library_remove') }}
          </Button>
        </article>
      </div>
    </div>
  </SettingsItemGroup>
</template>

<style scoped lang="scss">
.case-library,
.case-form {
  display: grid;
  gap: var(--bew-space-3);
  font-size: var(--bew-font-size-control);
  line-height: var(--bew-line-height-body);
}
.case-library {
  padding-block: var(--bew-space-4);
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--bew-space-2);
}
textarea,
select {
  width: 100%;
  box-sizing: border-box;
  padding: var(--bew-space-2) var(--bew-space-3);
  border: 1px solid var(--bew-border-color);
  border-radius: var(--bew-interactive-radius);
  background: var(--bew-fill-1);
  color: var(--bew-text-1);
  font: inherit;
  resize: vertical;
  &:focus-visible {
    outline: 2px solid var(--bew-theme-color);
  }
  &:disabled {
    opacity: 0.5;
  }
}
.case-list {
  max-height: 480px;
  overflow: auto;
  overscroll-behavior: contain;
}
.case {
  display: grid;
  gap: var(--bew-space-2);
  padding-block: var(--bew-space-3);
  border-top: 1px solid var(--bew-border-color);
}
.case-text {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.context {
  color: var(--bew-text-2);
}
.error {
  color: var(--bew-error-color);
}
</style>
