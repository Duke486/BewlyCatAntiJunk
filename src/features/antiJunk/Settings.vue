<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import browser from 'webextension-polyfill'

import Button from '~/components/Button.vue'
import Input from '~/components/Input.vue'
import Radio from '~/components/Radio.vue'
import SettingsItem from '~/components/Settings/components/SettingsItem.vue'
import SettingsItemGroup from '~/components/Settings/components/SettingsItemGroup.vue'
import { ANTI_JUNK_SYSTEM_PROMPT } from '~/features/antiJunk/prompts'
import type { AntiJunkConfig, AntiJunkData } from '~/features/antiJunk/protocol'
import { ANTI_JUNK_DATA, ANTI_JUNK_MESSAGE, ANTI_JUNK_MODEL } from '~/features/antiJunk/protocol'

import AntiJunkLibrary from './Library.vue'

const { t } = useI18n()
const enabled = ref(false)
const inspect = ref(false)
const metadata = ref(true)
const batchSize = ref<string | number>(10)
const requestsPerSecond = ref<string | number>(1)
const apiKey = ref('')
const showKey = ref(false)
const busy = ref(false)
const ready = ref(false)
const status = ref('')
const error = ref('')
const query = ref('')
const data = ref<AntiJunkData>({ records: [], cache: [], checked: 0, blocked: 0, lastError: '', lastSuccess: 0 })
const records = computed(() => {
  const needle = query.value.trim().toLowerCase()
  return data.value.records.filter(item => !needle || `${item.text} ${item.author} ${item.title}`.toLowerCase().includes(needle))
})
const request = (action: string, payload?: unknown) => browser.runtime.sendMessage({ type: ANTI_JUNK_MESSAGE, action, payload })

async function refresh(loadConfig = false) {
  try {
    const result = await request('read') as { config: AntiJunkConfig, data: AntiJunkData }
    data.value = result.data
    if (loadConfig) {
      enabled.value = result.config.enabled
      inspect.value = result.config.inspect
      metadata.value = result.config.metadata
      batchSize.value = result.config.batchSize
      requestsPerSecond.value = result.config.requestsPerSecond
      apiKey.value = result.config.apiKey
    }
    ready.value = true
  }
  catch {
    error.value = 'storage-error'
  }
}

async function save() {
  busy.value = true
  error.value = ''
  status.value = ''
  try {
    const result = await request('save', { enabled: enabled.value, inspect: inspect.value, metadata: metadata.value, batchSize: Number(batchSize.value), requestsPerSecond: Number(requestsPerSecond.value), apiKey: apiKey.value }) as { error?: string }
    if (result.error)
      error.value = result.error
    else
      status.value = t('anti_junk.saved')
  }
  catch {
    error.value = 'storage-error'
  }
  finally {
    busy.value = false
  }
}

async function test() {
  busy.value = true
  error.value = ''
  status.value = ''
  try {
    const result = await request('test') as { error?: string }
    if (result.error)
      error.value = result.error
    else
      status.value = t('anti_junk.test_ok')
  }
  catch {
    error.value = 'network'
  }
  finally {
    busy.value = false
  }
}

async function clearRecords(all = false) {
  busy.value = true
  error.value = ''
  status.value = ''
  try {
    const result = await request('clear', { all }) as { error?: string }
    if (result.error) {
      error.value = result.error
      return
    }
    await refresh()
    status.value = t(all ? 'anti_junk.cleared_all' : 'anti_junk.cleared_records')
  }
  catch {
    error.value = 'storage-error'
  }
  finally {
    busy.value = false
  }
}

function storageChanged(changes: Record<string, browser.Storage.StorageChange>, area: string) {
  if (area === 'local' && changes[ANTI_JUNK_DATA])
    void refresh()
}
browser.storage.onChanged.addListener(storageChanged)
onScopeDispose(() => browser.storage.onChanged.removeListener(storageChanged))
onMounted(() => void refresh(true))
</script>

<template>
  <SettingsItemGroup :title="t('anti_junk.title')" :desc="t('anti_junk.description')">
    <SettingsItem :title="t('anti_junk.enabled')" :desc="t('anti_junk.scope')" right-width="auto">
      <Radio v-model="enabled" :disabled="busy || !ready" />
    </SettingsItem>
    <SettingsItem :title="t('anti_junk.inspect')" :desc="t('anti_junk.inspect_desc')" right-width="auto">
      <Radio v-model="inspect" :disabled="busy || !ready" />
    </SettingsItem>
    <SettingsItem :title="t('anti_junk.metadata')" :desc="t('anti_junk.metadata_desc')" right-width="auto">
      <Radio v-model="metadata" :disabled="busy || !ready" />
    </SettingsItem>
    <SettingsItem :title="t('anti_junk.batch_size')" :desc="t('anti_junk.batch_size_desc')">
      <Input
        v-model="batchSize" type="number" :min="1" :max="50" :step="1"
        :disabled="busy || !ready" :aria-label="t('anti_junk.batch_size')"
      />
    </SettingsItem>
    <SettingsItem :title="t('anti_junk.requests_per_second')" :desc="t('anti_junk.requests_per_second_desc')">
      <Input
        v-model="requestsPerSecond" type="number" :min="1" :max="20" :step="1"
        :disabled="busy || !ready" :aria-label="t('anti_junk.requests_per_second')"
      />
    </SettingsItem>
    <p v-if="data.metrics" class="anti-junk-metrics">
      {{ t('anti_junk.metrics', data.metrics) }}
    </p>
    <div class="anti-junk-settings">
      <label>DeepSeek API Key</label>
      <div class="key-row">
        <Input
          v-model="apiKey" :type="showKey ? 'text' : 'password'"
          aria-label="DeepSeek API Key" placeholder="sk-…"
        />
        <Button :disabled="busy || !ready" @click="showKey = !showKey">
          {{ t(showKey ? 'anti_junk.conceal_key' : 'anti_junk.show_key') }}
        </Button>
      </div>
      <p>{{ t('anti_junk.model') }}: {{ ANTI_JUNK_MODEL }} · DeepSeek V4.1 Flash</p>
      <p>{{ t('anti_junk.key_note') }}</p>
      <div class="toolbar">
        <Button type="primary" :disabled="busy || !ready" @click="save">
          {{ t('anti_junk.save') }}
        </Button>
        <Button :disabled="busy || !ready" @click="test">
          {{ t('anti_junk.test') }}
        </Button>
      </div>
      <p v-if="status" role="status">
        {{ status }}
      </p>
      <p v-if="error || data.lastError" class="error" role="alert">
        {{ t(`anti_junk.errors.${error || data.lastError}`) }}
      </p>
      <details>
        <summary>{{ t('anti_junk.prompt') }}</summary>
        <pre>{{ ANTI_JUNK_SYSTEM_PROMPT }}</pre>
      </details>
    </div>
  </SettingsItemGroup>
  <AntiJunkLibrary />
  <SettingsItemGroup :title="t('anti_junk.records')" :desc="t('anti_junk.record_note')">
    <div class="anti-junk-settings">
      <p>{{ t('anti_junk.stats', { checked: data.checked, blocked: data.blocked, count: data.records.length }) }}</p>
      <div class="toolbar">
        <Input v-model="query" :placeholder="t('anti_junk.search')" :aria-label="t('anti_junk.search')" />
        <Button :disabled="busy" @click="refresh()">
          {{ t('anti_junk.refresh') }}
        </Button>
        <Button :disabled="busy || !data.records.length" @click="clearRecords()">
          {{ t('anti_junk.clear') }}
        </Button>
        <Button :disabled="busy || !ready" @click="clearRecords(true)">
          {{ t('anti_junk.clear_all') }}
        </Button>
      </div>
      <p>{{ t('anti_junk.clear_all_note') }}</p>
      <div class="record-list">
        <p v-if="!records.length">
          {{ t('anti_junk.empty') }}
        </p>
        <article v-for="record in records" :key="`${record.oid}:${record.id}:${record.time}`" class="record">
          <p v-if="record.rule">
            {{ t('anti_junk.decision_detail', { rule: t(`anti_junk.rules.${record.rule}`), round: record.round ?? 0 }) }}
          </p>
          <header>{{ record.author }} · {{ new Date(record.time).toLocaleString() }}</header>
          <a :href="record.url" target="_blank" rel="noopener noreferrer">{{ record.title || record.url }}</a>
          <p class="comment-text">
            {{ record.text }}
          </p>
          <details v-if="record.parentText">
            <summary>{{ t('anti_junk.parent') }}</summary>
            <p class="comment-text">
              {{ record.parentText }}
            </p>
          </details>
        </article>
      </div>
    </div>
  </SettingsItemGroup>
</template>

<style lang="scss" scoped>
.anti-junk-settings {
  display: grid;
  gap: var(--bew-space-3);
  padding-block: var(--bew-space-4);
  font-size: var(--bew-font-size-control);
  line-height: var(--bew-line-height-body);
  color: var(--bew-text-2);
  overflow-wrap: anywhere;
}

.key-row,
.toolbar {
  display: flex;
  gap: var(--bew-space-2);
  flex-wrap: wrap;
  align-items: center;

  > .b-input {
    flex: 1 1 200px;
    min-width: 0;
  }
}

.record-list,
pre {
  max-height: 480px;
  overflow: auto;
  overscroll-behavior: contain;
}

pre,
.comment-text {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.record {
  padding: var(--bew-space-3) 0;
  border-bottom: 1px solid var(--bew-border-color);
  display: grid;
  gap: var(--bew-space-2);

  .comment-text {
    color: var(--bew-text-1);
  }
}

summary {
  cursor: pointer;
  min-height: 24px;
}

.error {
  color: var(--bew-warning-color);
}
</style>
