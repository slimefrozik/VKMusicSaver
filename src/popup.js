(function () {
  'use strict';

  const { DEFAULT_SETTINGS, loadSettings, saveSettings } = globalThis.VKMS.settings;

  const SELECT_FIELDS = ['quality', 'format', 'filenamePattern'];
  const CHECKBOX_FIELDS = [
    'embedMetadata',
    'showInPlayer',
    'showInTrackRows',
    'hideBroadcast',
    'hideSnippet',
    'showNotifications',
  ];

  let statusTimer = null;

  function showSaved() {
    const statusEl = document.getElementById('saveStatus');
    if (!statusEl) return;
    statusEl.textContent = 'Сохранено';
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      statusEl.textContent = '';
    }, 1500);
  }

  function applyToForm(settings) {
    for (const id of SELECT_FIELDS) {
      const el = document.getElementById(id);
      if (el) el.value = settings[id];
    }
    for (const id of CHECKBOX_FIELDS) {
      const el = document.getElementById(id);
      if (el) el.checked = Boolean(settings[id]);
    }
  }

  async function init() {
    const settings = await loadSettings();
    applyToForm(settings);

    for (const id of SELECT_FIELDS) {
      const el = document.getElementById(id);
      el?.addEventListener('change', async () => {
        await saveSettings({ [id]: el.value });
        showSaved();
      });
    }

    for (const id of CHECKBOX_FIELDS) {
      const el = document.getElementById(id);
      el?.addEventListener('change', async () => {
        await saveSettings({ [id]: el.checked });
        showSaved();
      });
    }

    document.getElementById('resetBtn')?.addEventListener('click', async () => {
      const reset = await saveSettings({ ...DEFAULT_SETTINGS });
      applyToForm(reset);
      showSaved();
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
