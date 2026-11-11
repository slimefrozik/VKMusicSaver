(function () {
  'use strict';

  const VK_EXTRA_ALPHABET =
    'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN0PQRSTUVWXYZO123456789+/=';

  function decodeVkBase64(input) {
    if (!input || input.length % 4 === 1) return '';
    let result = '';
    let e = 0;
    let i = 0;
    for (let o = 0; o < input.length; o++) {
      const idx = VK_EXTRA_ALPHABET.indexOf(input.charAt(o));
      if (idx === -1) continue;
      e = i % 4 ? 64 * e + idx : idx;
      if (i++ % 4) {
        result += String.fromCharCode(255 & (e >> ((-2 * i) & 6)));
      }
    }
    return result;
  }

  function decodeVkExtraUrl(url, userId = 0) {
    if (!url || typeof url !== 'string' || !url.includes('audio_api_unavailable')) {
      return url;
    }
    const extraSplit = url.split('?extra=');
    if (extraSplit.length < 2) return url;
    const parts = extraSplit[1].split('#');
    if (parts.length < 2) return url;

    let decoded = decodeVkBase64(parts[0]);
    const opsRaw = decodeVkBase64(parts[1]);
    if (!decoded || !opsRaw) return url;

    const opsList = opsRaw.split('\x09').reverse();

    const ops = {
      v(str) {
        return str.split('').reverse().join('');
      },
      r(str, shift) {
        const arr = str.split('');
        const doubleAlpha = VK_EXTRA_ALPHABET + VK_EXTRA_ALPHABET;
        const offset = parseInt(shift, 10) || 0;
        for (let i = arr.length - 1; i >= 0; i--) {
          const idx = doubleAlpha.indexOf(arr[i]);
          if (idx !== -1) {
            const newIdx = idx - offset;
            if (newIdx >= 0) {
              arr[i] = doubleAlpha.charAt(newIdx);
            }
          }
        }
        return arr.join('');
      },
      s(str, seed) {
        const len = str.length;
        if (!len) return str;
        const shuffle = [];
        let s = Math.abs(parseInt(seed, 10) || 0);
        for (let i = len - 1; i >= 0; i--) {
          s = ((len * (i + 1)) ^ (s + i)) % len;
          shuffle[i] = s;
        }
        const arr = str.split('');
        for (let i = 1; i < len; i++) {
          const j = shuffle[len - 1 - i];
          const tmp = arr[i];
          arr[i] = arr[j];
          arr[j] = tmp;
        }
        return arr.join('');
      },
      i(str, seed) {
        return ops.s(str, (parseInt(seed, 10) || 0) ^ userId);
      },
      x(str, key) {
        const code = String(key || '').charCodeAt(0) || 0;
        let out = '';
        for (let i = 0; i < str.length; i++) {
          out += String.fromCharCode(str.charCodeAt(i) ^ code);
        }
        return out;
      },
    };

    for (const opLine of opsList) {
      const args = opLine.split('\x0b');
      const cmd = args.shift();
      if (ops[cmd]) {
        decoded = ops[cmd](decoded, args[0]);
      }
    }

    return decoded && decoded.startsWith('http') ? decoded : url;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { decodeVkExtraUrl, decodeVkBase64 };
    return;
  }

  const CHANNEL = 'VKMS_BRIDGE';
  const BROADCAST_RE = /транслировать\s+аудиозапис|broadcast\s+audio/i;
  const SNIPPET_RE = /открыть\s+сниппет|open\s+snippet/i;

  const audioCache = new Map(); // fullId -> { fullId, ownerId, audioId, artist, title, url, hashes, accessKey, updatedAt }
  const recentStreams = []; // Array<{ url, fullId, timestamp }>

  function getUserId() {
    return Number(window.vk?.id || 0) || 0;
  }

  function isUsefulAudioUrl(url) {
    if (!url || typeof url !== 'string') return false;
    if (url.startsWith('blob:') || url.includes('audio_api_unavailable')) return false;
    return url.startsWith('http://') || url.startsWith('https://');
  }

  function isMediaStreamUrl(url) {
    if (!url || typeof url !== 'string') return false;
    const lower = url.toLowerCase();
    if (lower.includes('/sound/') || lower.includes('bb2.mp3') || lower.includes('notify.mp3')) {
      return false;
    }
    if (lower.includes('audio_api_unavailable')) return false;
    return lower.includes('.m3u8') || /\.mp3(\?|$)/i.test(lower);
  }

  function getCurrentPlayerAudio() {
    try {
      const ap = typeof window.getAudioPlayer === 'function' ? window.getAudioPlayer() : window.ap;
      if (!ap) return null;

      let cur = null;
      if (typeof ap.getCurrentAudio === 'function') {
        cur = ap.getCurrentAudio();
      } else if (ap._currentAudio) {
        cur = ap._currentAudio;
      }

      if (Array.isArray(cur) && cur.length >= 5) {
        const audioId = String(cur[0] ?? '');
        const ownerId = String(cur[1] ?? '');
        const fullId = ownerId && audioId ? `${ownerId}_${audioId}` : '';
        let url = typeof cur[2] === 'string' ? cur[2] : '';
        if (url.includes('audio_api_unavailable')) {
          url = decodeVkExtraUrl(url, getUserId());
        }
        const title = String(cur[3] ?? '').trim();
        const artist = String(cur[4] ?? '').trim();
        const hashes = typeof cur[13] === 'string' ? cur[13] : '';
        return { fullId, ownerId, audioId, title, artist, url, hashes };
      }
    } catch (_) {
      // Ignore errors from VK internals
    }
    return null;
  }

  function getActiveAudioImplUrl() {
    try {
      const ap = typeof window.getAudioPlayer === 'function' ? window.getAudioPlayer() : window.ap;
      if (ap && ap._impl) {
        const hlsUrl = ap._impl._hls?.url || ap._impl.hls?.url;
        if (isUsefulAudioUrl(hlsUrl)) return hlsUrl;
        const elSrc = ap._impl._currentAudioEl?.src || ap._impl.audio?.src;
        if (isUsefulAudioUrl(elSrc)) return elSrc;
      }
    } catch (_) {
      // Ignore
    }

    const audioEls = document.querySelectorAll('audio');
    for (const el of audioEls) {
      if (isUsefulAudioUrl(el.currentSrc || el.src)) {
        return el.currentSrc || el.src;
      }
    }
    return '';
  }

  function cacheAudioTuple(tuple) {
    if (!Array.isArray(tuple) || tuple.length < 5) return;
    const audioId = tuple[0];
    const ownerId = tuple[1];
    if (
      (typeof audioId !== 'number' && typeof audioId !== 'string') ||
      (typeof ownerId !== 'number' && typeof ownerId !== 'string')
    ) {
      return;
    }
    const idStr = String(audioId);
    const ownerStr = String(ownerId);
    if (!/^-?\d+$/.test(ownerStr) || !/^\d+$/.test(idStr)) return;

    const fullId = `${ownerStr}_${idStr}`;
    let url = typeof tuple[2] === 'string' ? tuple[2] : '';
    if (url.includes('audio_api_unavailable')) {
      url = decodeVkExtraUrl(url, getUserId());
    }
    const title = typeof tuple[3] === 'string' ? tuple[3].trim() : '';
    const artist = typeof tuple[4] === 'string' ? tuple[4].trim() : '';
    const hashes = typeof tuple[13] === 'string' ? tuple[13] : '';
    const accessKey = typeof tuple[23] === 'string' ? tuple[23] : '';

    const prev = audioCache.get(fullId) || {};
    audioCache.set(fullId, {
      fullId,
      ownerId: ownerStr,
      audioId: idStr,
      title: title || prev.title || '',
      artist: artist || prev.artist || '',
      url: isUsefulAudioUrl(url) ? url : prev.url || '',
      hashes: hashes || prev.hashes || '',
      accessKey: accessKey || prev.accessKey || '',
      updatedAt: Date.now(),
    });
  }

  function cacheAudioObject(obj) {
    if (!obj || typeof obj !== 'object') return;
    const id = obj.id ?? obj.audio_id;
    const ownerId = obj.owner_id ?? obj.ownerId;
    if (id == null || ownerId == null) return;
    const idStr = String(id);
    const ownerStr = String(ownerId);
    if (!/^-?\d+$/.test(ownerStr) || !/^\d+$/.test(idStr)) return;

    const fullId = `${ownerStr}_${idStr}`;
    let url = typeof obj.url === 'string' ? obj.url : '';
    if (url.includes('audio_api_unavailable')) {
      url = decodeVkExtraUrl(url, getUserId());
    }
    const title = typeof obj.title === 'string' ? obj.title.trim() : '';
    const artist = typeof (obj.artist ?? obj.performer) === 'string'
      ? (obj.artist ?? obj.performer).trim()
      : '';
    const accessKey = typeof obj.access_key === 'string' ? obj.access_key : '';

    const prev = audioCache.get(fullId) || {};
    audioCache.set(fullId, {
      fullId,
      ownerId: ownerStr,
      audioId: idStr,
      title: title || prev.title || '',
      artist: artist || prev.artist || '',
      url: isUsefulAudioUrl(url) ? url : prev.url || '',
      hashes: prev.hashes || '',
      accessKey: accessKey || prev.accessKey || '',
      updatedAt: Date.now(),
    });
  }

  function extractAudioFromPayload(node, depth = 0) {
    if (!node || depth > 8) return;
    if (Array.isArray(node)) {
      if (
        node.length >= 6 &&
        (typeof node[0] === 'number' || typeof node[0] === 'string') &&
        (typeof node[1] === 'number' || typeof node[1] === 'string') &&
        typeof node[3] === 'string' &&
        typeof node[4] === 'string'
      ) {
        cacheAudioTuple(node);
        return;
      }
      for (let i = 0; i < Math.min(node.length, 500); i++) {
        extractAudioFromPayload(node[i], depth + 1);
      }
      return;
    }
    if (typeof node === 'object') {
      if ((node.id != null || node.audio_id != null) && (node.owner_id != null || node.ownerId != null)) {
        cacheAudioObject(node);
      }
      for (const key of Object.keys(node)) {
        if (key === 'parent' || key === 'window') continue;
        extractAudioFromPayload(node[key], depth + 1);
      }
    }
  }

  function tryParseVkResponseText(text) {
    if (!text || typeof text !== 'string') return;
    let clean = text.startsWith('<!--') ? text.slice(4) : text;

    // VK al_*.php sometimes splits chunks with <!> and prefixes JSON with <!json>
    const parts = clean.split('<!>');
    for (let part of parts) {
      if (part.startsWith('<!json>')) {
        part = part.slice(7);
      }
      part = part.trim();
      if (!part.startsWith('{') && !part.startsWith('[')) continue;
      try {
        const parsed = JSON.parse(part);
        extractAudioFromPayload(parsed, 0);
      } catch (_) {
        // Ignore non-JSON chunk
      }
    }
  }

  function recordMediaUrl(url) {
    if (!isMediaStreamUrl(url)) return;
    const current = getCurrentPlayerAudio();
    const fullId = current?.fullId || '';
    recentStreams.push({ url, fullId, timestamp: Date.now() });
    if (recentStreams.length > 30) {
      recentStreams.splice(0, recentStreams.length - 30);
    }
    if (fullId) {
      const cached = audioCache.get(fullId) || { fullId };
      audioCache.set(fullId, { ...cached, url, updatedAt: Date.now() });
    }
  }

  // Hook fetch
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (...args) {
      const reqUrl = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
      if (reqUrl) recordMediaUrl(reqUrl);

      const promise = origFetch.apply(this, args);
      if (
        reqUrl.includes('al_audio.php') ||
        reqUrl.includes('api.vk.') ||
        reqUrl.includes('method/audio')
      ) {
        promise
          .then((res) => {
            if (!res || !res.clone) return;
            res
              .clone()
              .text()
              .then(tryParseVkResponseText)
              .catch(() => {});
          })
          .catch(() => {});
      }
      return promise;
    };
  }

  // Hook XMLHttpRequest
  const origXhrOpen = XMLHttpRequest.prototype.open;
  const origXhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._vkmsUrl = typeof url === 'string' ? url : String(url || '');
    if (this._vkmsUrl) recordMediaUrl(this._vkmsUrl);
    return origXhrOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    const reqUrl = this._vkmsUrl || '';
    if (
      reqUrl.includes('al_audio.php') ||
      reqUrl.includes('api.vk.') ||
      reqUrl.includes('method/audio')
    ) {
      this.addEventListener('load', () => {
        try {
          if (typeof this.responseText === 'string') {
            tryParseVkResponseText(this.responseText);
          }
        } catch (_) {
          // Ignore
        }
      });
    }
    return origXhrSend.apply(this, args);
  };

  function getReactFiber(el) {
    if (!el) return null;
    for (const key of Object.keys(el)) {
      if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) {
        return el[key];
      }
    }
    return null;
  }

  function getReactProps(el) {
    if (!el) return null;
    for (const key of Object.keys(el)) {
      if (key.startsWith('__reactProps$')) {
        return el[key];
      }
    }
    return null;
  }

  function inspectPropsForRole(props) {
    if (!props || typeof props !== 'object') return null;
    const candidates = [
      props['aria-label'],
      props.title,
      props.text,
      props.tooltip,
      props.header,
      props.content,
      props.label,
    ];
    for (const c of candidates) {
      if (typeof c === 'string') {
        if (BROADCAST_RE.test(c)) return 'broadcast';
        if (SNIPPET_RE.test(c)) return 'snippet';
      }
    }
    return null;
  }

  function detectRoleFromReact(el) {
    const directProps = getReactProps(el);
    const directRole = inspectPropsForRole(directProps);
    if (directRole) return directRole;

    let fiber = getReactFiber(el);
    for (let depth = 0; fiber && depth < 6; depth++) {
      const role = inspectPropsForRole(fiber.memoizedProps);
      if (role) return role;
      fiber = fiber.return;
    }
    return null;
  }

  function scanAndTagRoleButtons() {
    const containers = document.querySelectorAll(
      '#top_audio_player, .top_audio_player, .audio_page_player, .audio_row, [data-testid="MusicTrackRow"], [class*="AudioPlayer"], [class*="audio_player"], [class*="PlayerControls"], [class*="TrackRow"]'
    );
    const visited = new Set();

    for (const container of containers) {
      const buttons = container.querySelectorAll(
        'button, [role="button"], .audio_page_player_btn, .audio_row__action, a[aria-label]'
      );
      for (const btn of buttons) {
        if (visited.has(btn) || btn.dataset.vkmsScanned === '1') continue;
        visited.add(btn);
        btn.dataset.vkmsScanned = '1';
        if (btn.classList.contains('vkms-download-btn')) continue;

        const role = detectRoleFromReact(btn);
        if (role) {
          btn.dataset.vkmsRole = role;
        }
      }
    }
  }

  function extractTrackFromReact(el) {
    let cur = el;
    for (let hop = 0; cur && hop < 10; hop++) {
      let fiber = getReactFiber(cur);
      for (let f = 0; fiber && f < 8; f++) {
        const props = fiber.memoizedProps;
        if (props && typeof props === 'object') {
          for (const key of ['audio', 'track', 'currentAudio', 'currentTrack', 'item']) {
            const obj = props[key];
            if (obj && typeof obj === 'object') {
              if (Array.isArray(obj) && obj.length >= 5) {
                cacheAudioTuple(obj);
                const fullId = `${obj[1]}_${obj[0]}`;
                return audioCache.get(fullId) || null;
              }
              if ((obj.id != null || obj.audio_id != null) && (obj.owner_id != null || obj.ownerId != null)) {
                cacheAudioObject(obj);
                const fullId = `${obj.owner_id ?? obj.ownerId}_${obj.id ?? obj.audio_id}`;
                return audioCache.get(fullId) || null;
              }
            }
          }
        }
        fiber = fiber.return;
      }
      cur = cur.parentElement;
    }
    return null;
  }

  function extractDomMeta(el) {
    const row = el.closest('.audio_row, [data-audio], [data-full-id], [data-testid="MusicTrackRow"], [data-audio-id]');
    if (row) {
      let fullId = row.getAttribute('data-full-id') || row.getAttribute('data-audio-id') || '';
      const rawAudio = row.getAttribute('data-audio');
      if (rawAudio) {
        try {
          const tuple = JSON.parse(rawAudio);
          cacheAudioTuple(tuple);
          if (Array.isArray(tuple) && tuple.length >= 5) {
            fullId = `${tuple[1]}_${tuple[0]}`;
          }
        } catch (_) {
          // Ignore
        }
      }

      const artistEl = row.querySelector(
        '.audio_row__performers, .audio_performer, [data-testid="MusicTrackRow_Authors"]'
      );
      const titleEl = row.querySelector(
        '.audio_row__title_inner, .audio_title, [data-testid="MusicTrackRow_Title"]'
      );

      const reactInfo = extractTrackFromReact(row);
      const cached = (fullId && audioCache.get(fullId)) || reactInfo;

      return {
        isRow: true,
        fullId: cached?.fullId || fullId,
        artist: cached?.artist || artistEl?.textContent?.trim() || '',
        title: cached?.title || titleEl?.textContent?.trim() || '',
        url: cached?.url || '',
        hashes: cached?.hashes || '',
        accessKey: cached?.accessKey || '',
      };
    }

    // Player bar context
    const player = el.closest(
      '#top_audio_player, .top_audio_player, .audio_page_player, [class*="AudioPlayer"], [class*="audio_player"], [class*="Player"]'
    );
    const current = getCurrentPlayerAudio();
    const reactInfo = extractTrackFromReact(el);

    let artist = current?.artist || reactInfo?.artist || '';
    let title = current?.title || reactInfo?.title || '';

    if (player && (!artist || !title)) {
      const perfEl = player.querySelector(
        '.audio_page_player_title_performer, .top_audio_player_title_performer'
      );
      const songEl = player.querySelector(
        '.audio_page_player_title_song, .top_audio_player_title_song'
      );
      if (perfEl && !artist) artist = perfEl.textContent.trim();
      if (songEl && !title) title = songEl.textContent.trim();

      if (!artist && !title) {
        const combinedEl = player.querySelector('.top_audio_player_title, .audio_page_player_title');
        const combined = combinedEl?.textContent?.trim() || '';
        const sepIdx = combined.indexOf(' – ');
        const dashIdx = sepIdx !== -1 ? sepIdx : combined.indexOf(' - ');
        if (dashIdx !== -1) {
          artist = combined.slice(0, dashIdx).trim();
          title = combined.slice(dashIdx + 3).trim();
        } else if (combined) {
          title = combined;
        }
      }
    }

    const fullId = current?.fullId || reactInfo?.fullId || '';
    const cached = fullId ? audioCache.get(fullId) : null;

    return {
      isRow: false,
      fullId,
      artist: artist || cached?.artist || '',
      title: title || cached?.title || '',
      url: current?.url || reactInfo?.url || cached?.url || '',
      hashes: current?.hashes || cached?.hashes || '',
      accessKey: reactInfo?.accessKey || cached?.accessKey || '',
    };
  }

  async function reloadAudioUrl(fullId, hashes, accessKey) {
    if (!fullId) return '';
    let idsParam = fullId;
    if (hashes) {
      const parts = hashes.split('/');
      const actionHash = parts[2] || '';
      const urlHash = parts[5] || '';
      if (actionHash && urlHash) {
        idsParam = `${fullId}_${actionHash}_${urlHash}`;
      }
    } else if (accessKey) {
      idsParam = `${fullId}_${accessKey}`;
    }

    try {
      const body = new URLSearchParams({
        act: 'reload_audio',
        al: '1',
        ids: idsParam,
      });
      const res = await origFetch('/al_audio.php?act=reload_audio', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: body.toString(),
      });
      if (!res.ok) return '';
      const text = await res.text();
      tryParseVkResponseText(text);
      const cached = audioCache.get(fullId);
      if (cached?.url && isUsefulAudioUrl(cached.url)) {
        return cached.url;
      }

      // Fallback regex extraction for m3u8/mp3 inside payload
      const m3u8Match = text.match(/https?:\\?\/\\?\/[^"'\s]+?\.m3u8[^"'\s]*/i);
      if (m3u8Match) {
        return m3u8Match[0].replace(/\\\//g, '/');
      }
      const mp3Match = text.match(/https?:\\?\/\\?\/[^"'\s]+?\.mp3[^"'\s]*/i);
      if (mp3Match) {
        const candidate = mp3Match[0].replace(/\\\//g, '/');
        if (!candidate.includes('audio_api_unavailable')) return candidate;
        return decodeVkExtraUrl(candidate, getUserId());
      }
    } catch (_) {
      // Ignore network errors
    }
    return '';
  }

  function findRecentPerformanceUrl() {
    try {
      const entries = performance.getEntriesByType('resource');
      for (let i = entries.length - 1; i >= 0; i--) {
        const name = entries[i].name;
        if (isMediaStreamUrl(name)) {
          return name;
        }
      }
    } catch (_) {
      // Ignore
    }
    return '';
  }

  async function resolveTrackForButton(btnId) {
    const el = document.querySelector(`[data-vkms-btn-id="${btnId}"]`);
    if (!el) {
      return { artist: '', title: '', url: '', fullId: '' };
    }

    const meta = extractDomMeta(el);
    let url = meta.url;

    if (!isUsefulAudioUrl(url) && meta.fullId) {
      url = await reloadAudioUrl(meta.fullId, meta.hashes, meta.accessKey);
    }

    const currentPlaying = getCurrentPlayerAudio();
    const isPlayingMatch = !meta.isRow || (meta.fullId && currentPlaying?.fullId === meta.fullId);

    if (!isUsefulAudioUrl(url) && isPlayingMatch) {
      url = getActiveAudioImplUrl();
    }

    if (!isUsefulAudioUrl(url) && meta.fullId) {
      const matchingStream = [...recentStreams].reverse().find((s) => s.fullId === meta.fullId);
      if (matchingStream) url = matchingStream.url;
    }

    if (!isUsefulAudioUrl(url) && isPlayingMatch) {
      const latestStream = recentStreams[recentStreams.length - 1];
      if (latestStream) {
        url = latestStream.url;
      } else {
        url = findRecentPerformanceUrl();
      }
    }

    return {
      fullId: meta.fullId || '',
      artist: meta.artist || '',
      title: meta.title || '',
      url: isUsefulAudioUrl(url) ? url : '',
      isRow: meta.isRow,
      isPlayingMatch,
    };
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.data.channel !== CHANNEL) return;

    if (event.data.type === 'VKMS_SCAN_ROLES') {
      scanAndTagRoleButtons();
      return;
    }

    if (event.data.type === 'VKMS_RESOLVE_TRACK') {
      const { requestId, btnId } = event.data;
      resolveTrackForButton(btnId)
        .then((result) => {
          window.postMessage(
            {
              channel: CHANNEL,
              type: 'VKMS_RESOLVE_RESULT',
              requestId,
              result,
            },
            '*'
          );
        })
        .catch((err) => {
          window.postMessage(
            {
              channel: CHANNEL,
              type: 'VKMS_RESOLVE_RESULT',
              requestId,
              error: err?.message || 'Failed to resolve track',
            },
            '*'
          );
        });
    }
  });
})();
