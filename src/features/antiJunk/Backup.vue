<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import browser from 'webextension-polyfill'

import Button from '~/components/Button.vue'
import Radio from '~/components/Radio.vue'
import SettingsItem from '~/components/Settings/components/SettingsItem.vue'
import SettingsItemGroup from '~/components/Settings/components/SettingsItemGroup.vue'
import { ANTI_JUNK_MESSAGE } from '~/features/antiJunk/protocol'

const { t } = useI18n()
const input = ref<HTMLInputElement>()
const includeKey = ref(false)
const busy = ref(false)
const status = ref('')
const error = ref('')
const request = (action: string, payload?: unknown) => browser.runtime.sendMessage({ type: ANTI_JUNK_MESSAGE, action, payload })

async function exportBackup() {
  busy.value = true
  status.value = error.value = ''
  try {
    const result = await request('export-download', { includeKey: includeKey.value }) as { ok?: boolean }
    if (!result?.ok)
      error.value = 'storage-error'
  }
  catch { error.value = 'storage-error' }
  finally { busy.value = false }
}

async function importBackup(event: Event) {
  const element = event.target as HTMLInputElement
  const file = element.files?.[0]
  element.value = ''
  if (!file)
    return
  busy.value = true
  status.value = error.value = ''
  try {
    if (file.size > 2_000_000) {
      error.value = 'invalid-backup'
      return
    }
    let backup: unknown
    try {
      backup = JSON.parse(await file.text())
    }
    catch {
      error.value = 'invalid-backup'
      return
    }
    const result = await request('import', backup) as { ok?: boolean, keyMissing?: boolean, error?: string }
    if (result.error || !result.ok)
      error.value = result.error ?? 'storage-error'
    else
      status.value = t(result.keyMissing ? 'anti_junk.backup_key_missing' : 'anti_junk.backup_imported')
  }
  catch { error.value = 'storage-error' }
  finally { busy.value = false }
}
</script>

<template>
  <SettingsItemGroup :title="t('anti_junk.backup_title')" :desc="t('anti_junk.backup_desc')">
    <SettingsItem :title="t('anti_junk.backup_include_key')" :desc="t('anti_junk.backup_key_note')" right-width="auto">
      <Radio v-model="includeKey" :disabled="busy" />
    </SettingsItem>
    <div class="anti-junk-backup">
      <div class="actions">
        <Button :disabled="busy" @click="input?.click()">
          {{ t('anti_junk.backup_import') }}
        </Button>
        <Button :disabled="busy" @click="exportBackup">
          {{ t('anti_junk.backup_export') }}
        </Button>
      </div>
      <input ref="input" type="file" accept=".json,application/json" hidden @change="importBackup">
      <p v-if="status" role="status">
        {{ status }}
      </p>
      <p v-if="error" class="error" role="alert">
        {{ t(`anti_junk.errors.${error}`) }}
      </p>
    </div>
  </SettingsItemGroup>
</template>

<style scoped lang="scss">
.anti-junk-backup {
  display: flex;
  flex-direction: column;
  gap: var(--bew-space-3);
  padding: var(--bew-space-4);
  font-size: var(--bew-font-size-control);
  line-height: var(--bew-line-height-control);
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--bew-space-2);
}
.error {
  color: var(--bew-error-color);
}
</style>
