(function (root) {
  'use strict';

  const DEFAULT_SETTINGS = {
    quality: 'best', // 'best' | 'medium' | 'low'
    format: 'auto', // 'auto' | 'mp3' | 'm4a' | 'aac'
    filenamePattern: 'artist_title', // 'artist_title' | 'title_artist' | 'title'
    embedMetadata: true,
    showInPlayer: true,
    showInTrackRows: true,
    hideBroadcast: false,
    hideSnippet: false,
    showNotifications: true,
  };

  function normalizeSettings(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    return {
      quality: ['best', 'medium', 'low'].includes(src.quality)
        ? src.quality
        : DEFAULT_SETTINGS.quality,
      format: ['auto', 'mp3', 'm4a', 'aac'].includes(src.format)
        ? src.format
        : DEFAULT_SETTINGS.format,
      filenamePattern: ['artist_title', 'title_artist', 'title'].includes(src.filenamePattern)
        ? src.filenamePattern
        : DEFAULT_SETTINGS.filenamePattern,
      embedMetadata:
        typeof src.embedMetadata === 'boolean' ? src.embedMetadata : DEFAULT_SETTINGS.embedMetadata,
      showInPlayer:
        typeof src.showInPlayer === 'boolean' ? src.showInPlayer : DEFAULT_SETTINGS.showInPlayer,
      showInTrackRows:
        typeof src.showInTrackRows === 'boolean'
          ? src.showInTrackRows
          : DEFAULT_SETTINGS.showInTrackRows,
      hideBroadcast:
        typeof src.hideBroadcast === 'boolean' ? src.hideBroadcast : DEFAULT_SETTINGS.hideBroadcast,
      hideSnippet:
        typeof src.hideSnippet === 'boolean' ? src.hideSnippet : DEFAULT_SETTINGS.hideSnippet,
      showNotifications:
        typeof src.showNotifications === 'boolean'
          ? src.showNotifications
          : DEFAULT_SETTINGS.showNotifications,
    };
  }

  async function loadSettings() {
    const extApi = globalThis.browser ?? globalThis.chrome;
    if (!extApi?.storage?.local) {
      return { ...DEFAULT_SETTINGS };
    }
    try {
      const stored = await extApi.storage.local.get(DEFAULT_SETTINGS);
      return normalizeSettings(stored);
    } catch (_) {
      return { ...DEFAULT_SETTINGS };
    }
  }

  async function saveSettings(partial) {
    const extApi = globalThis.browser ?? globalThis.chrome;
    const current = await loadSettings();
    const next = normalizeSettings({ ...current, ...partial });
    if (extApi?.storage?.local) {
      await extApi.storage.local.set(next);
    }
    return next;
  }

  const api = {
    DEFAULT_SETTINGS,
    normalizeSettings,
    loadSettings,
    saveSettings,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.VKMS = root.VKMS || {};
    root.VKMS.settings = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
