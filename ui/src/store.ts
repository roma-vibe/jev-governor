import { reactive, watch } from 'vue';

import { api, type GovernorConfig, type KeyStatus } from './api.ts';
import { setLang } from './i18n/index.ts';

/** Config and key status shared by the header and the settings page. */
export const store = reactive<{ config: GovernorConfig | null; key: KeyStatus | null }>({
  config: null,
  key: null,
});

// The saved language wins over the one remembered in this browser.
watch(
  () => store.config?.ui.language,
  (language) => {
    if (language) setLang(language);
  },
  { flush: 'sync' },
);

export async function refreshConfig(): Promise<void> {
  store.config = await api.config();
}

export async function refreshKey(): Promise<void> {
  store.key = await api.key();
}

export async function toggleEnabled(): Promise<void> {
  if (!store.config) return;
  store.config = await api.saveConfig({ enabled: !store.config.enabled });
}
