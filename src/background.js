(function (root) {
  'use strict';

  function sanitizeFilename(name, fallback = 'VK Track') {
    const cleaned = String(name || '')
      .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '')
      .replace(/[<>:"/\\|?*]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^[.\s]+|[.\s]+$/g, '');
    if (!cleaned) return fallback;
    return cleaned.slice(0, 160).replace(/[.\s]+$/g, '') || fallback;
  }

  function buildFilename(artist, title, extension) {
    const safeArtist = sanitizeFilename(artist, '');
    const safeTitle = sanitizeFilename(title, '');
    let base = 'VK Audio';
    if (safeArtist && safeTitle) {
      base = sanitizeFilename(`${safeArtist} - ${safeTitle}`, 'VK Audio');
    } else if (safeTitle) {
      base = safeTitle;
    } else if (safeArtist) {
      base = safeArtist;
    }
    return `${base}.${extension}`;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { sanitizeFilename, buildFilename };
    return;
  }

  const extApi = globalThis.browser ?? globalThis.chrome;
  const tabStreams = new Map(); // tabId -> Array<{ url, timestamp }>
  const pendingObjectUrls = new Map(); // downloadId -> objectUrl

  function isAudioStreamUrl(url) {
    if (!url || typeof url !== 'string') return false;
    const lower = url.toLowerCase();
    if (lower.includes('audio_api_unavailable')) return false;
    if (lower.includes('/sound/') || lower.includes('bb2.mp3') || lower.includes('notify.mp3')) {
      return false;
    }
    if (lower.includes('.m3u8')) return true;
    if (/\.mp3(\?|$)/i.test(lower)) return true;
    return false;
  }

  if (extApi.webRequest?.onBeforeRequest) {
    extApi.webRequest.onBeforeRequest.addListener(
      (details) => {
        if (details.tabId < 0 || !isAudioStreamUrl(details.url)) return;
        let list = tabStreams.get(details.tabId);
        if (!list) {
          list = [];
          tabStreams.set(details.tabId, list);
        }
        // Prefer master/index m3u8 over individual chunk playlists if duplicate
        list.push({ url: details.url, timestamp: Date.now() });
        if (list.length > 25) {
          list.splice(0, list.length - 25);
        }
      },
      {
        urls: ['https://*/*'],
      }
    );
  }

  if (extApi.tabs?.onRemoved) {
    extApi.tabs.onRemoved.addListener((tabId) => {
      tabStreams.delete(tabId);
    });
  }

  if (extApi.downloads?.onChanged) {
    extApi.downloads.onChanged.addListener((delta) => {
      if (!delta.state) return;
      const state = delta.state.current;
      if (state === 'complete' || state === 'interrupted') {
        const objUrl = pendingObjectUrls.get(delta.id);
        if (objUrl) {
          URL.revokeObjectURL(objUrl);
          pendingObjectUrls.delete(delta.id);
        }
      }
    });
  }

  function sendProgress(tabId, downloadId, percent) {
    if (typeof tabId !== 'number' || tabId < 0) return;
    extApi.tabs
      .sendMessage(tabId, {
        type: 'VKMS_PROGRESS',
        downloadId,
        percent,
      })
      .catch(() => {});
  }

  function detectFormatFromBytes(bytes, url) {
    if (bytes.length >= 12) {
      if (bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53) {
        return { ext: 'ogg', mimeType: 'audio/ogg' };
      }
      if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
        return { ext: 'm4a', mimeType: 'audio/mp4' };
      }
    }
    if (/\.m4a(\?|$)/i.test(url)) return { ext: 'm4a', mimeType: 'audio/mp4' };
    if (/\.ogg(\?|$)/i.test(url)) return { ext: 'ogg', mimeType: 'audio/ogg' };
    return { ext: 'mp3', mimeType: 'audio/mpeg' };
  }

  function looksLikeM3u8(url, contentType, bytes) {
    if (/\.m3u8(\?|$)/i.test(url)) return true;
    if (contentType && contentType.toLowerCase().includes('mpegurl')) return true;
    if (bytes && bytes.length >= 7) {
      const head = new TextDecoder().decode(bytes.subarray(0, 7));
      if (head === '#EXTM3U') return true;
    }
    return false;
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error('FileReader error'));
      reader.readAsDataURL(blob);
    });
  }

  async function saveBlobToDownloads(blob, filename) {
    const objectUrl = URL.createObjectURL(blob);
    try {
      const dlId = await extApi.downloads.download({
        url: objectUrl,
        filename,
        saveAs: false,
      });
      pendingObjectUrls.set(dlId, objectUrl);
      setTimeout(() => {
        if (pendingObjectUrls.has(dlId)) {
          URL.revokeObjectURL(objectUrl);
          pendingObjectUrls.delete(dlId);
        }
      }, 120000);
      return dlId;
    } catch (blobErr) {
      URL.revokeObjectURL(objectUrl);
      console.warn('[VK Music Saver] blob: download failed, trying data: URI fallback:', blobErr);
      const dataUrl = await blobToDataUrl(blob);
      return extApi.downloads.download({
        url: dataUrl,
        filename,
        saveAs: false,
      });
    }
  }

  async function processAndDownload({ tabId, downloadId, url, artist, title }) {
    let targetUrl = url;
    if (!targetUrl && typeof tabId === 'number') {
      const recent = tabStreams.get(tabId);
      if (recent && recent.length > 0) {
        targetUrl = recent[recent.length - 1].url;
      }
    }

    if (!targetUrl || targetUrl.includes('audio_api_unavailable')) {
      throw new Error('Не удалось получить ссылку на аудиопоток. Запустите воспроизведение трека и попробуйте снова.');
    }

    sendProgress(tabId, downloadId, 5);

    if (/\.m3u8(\?|$)/i.test(targetUrl)) {
      const result = await root.VKMS.hlsDownloader.downloadHlsAudio(targetUrl, {
        title,
        artist,
        onProgress: (pct) => sendProgress(tabId, downloadId, pct),
      });
      const filename = buildFilename(artist, title, result.ext);
      const blob = new Blob([result.data], { type: result.mimeType });
      await saveBlobToDownloads(blob, filename);
      sendProgress(tabId, downloadId, 100);
      return { ok: true, filename, format: result.ext };
    }

    // Direct URL (or unknown content-type that might still be an m3u8)
    let response = await fetch(targetUrl, { credentials: 'include' });
    if (!response.ok && (response.status === 401 || response.status === 403)) {
      response = await fetch(targetUrl, { credentials: 'omit' });
    }
    if (!response.ok) {
      throw new Error(`Ошибка загрузки аудио: HTTP ${response.status}`);
    }

    const contentType = response.headers.get('content-type') || '';
    const bytes = new Uint8Array(await response.arrayBuffer());

    if (looksLikeM3u8(targetUrl, contentType, bytes)) {
      const result = await root.VKMS.hlsDownloader.downloadHlsAudio(targetUrl, {
        title,
        artist,
        onProgress: (pct) => sendProgress(tabId, downloadId, pct),
      });
      const filename = buildFilename(artist, title, result.ext);
      const blob = new Blob([result.data], { type: result.mimeType });
      await saveBlobToDownloads(blob, filename);
      sendProgress(tabId, downloadId, 100);
      return { ok: true, filename, format: result.ext };
    }

    sendProgress(tabId, downloadId, 90);
    const fmt = detectFormatFromBytes(bytes, targetUrl);
    const finalBytes =
      fmt.ext === 'mp3'
        ? root.VKMS.mp3Tagger.prependId3v2Tag(bytes, { title, artist })
        : bytes;

    const filename = buildFilename(artist, title, fmt.ext);
    const blob = new Blob([finalBytes], { type: fmt.mimeType });
    await saveBlobToDownloads(blob, filename);
    sendProgress(tabId, downloadId, 100);
    return { ok: true, filename, format: fmt.ext };
  }

  extApi.runtime.onMessage.addListener((msg, sender) => {
    if (!msg || typeof msg !== 'object') return undefined;

    if (msg.type === 'VKMS_GET_RECENT_STREAM') {
      const tabId = sender.tab?.id;
      const list = typeof tabId === 'number' ? tabStreams.get(tabId) : null;
      const latest = list && list.length > 0 ? list[list.length - 1] : null;
      return Promise.resolve({ stream: latest });
    }

    if (msg.type === 'VKMS_DOWNLOAD_TRACK') {
      const tabId = sender.tab?.id ?? -1;
      return processAndDownload({
        tabId,
        downloadId: msg.downloadId,
        url: msg.url,
        artist: msg.artist || '',
        title: msg.title || '',
      }).catch((err) => {
        console.error('[VK Music Saver] Download failed:', err);
        return {
          ok: false,
          error: err?.message || String(err),
        };
      });
    }

    return undefined;
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
