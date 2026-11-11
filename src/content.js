(function () {
  'use strict';

  const extApi = globalThis.browser ?? globalThis.chrome;
  const settingsApi = globalThis.VKMS?.settings;
  const CHANNEL = 'VKMS_BRIDGE';
  const BROADCAST_RE = /транслировать\s+аудиозапис|broadcast\s+audio/i;
  const SNIPPET_RE = /открыть\s+сниппет|open\s+snippet/i;

  let currentSettings = settingsApi
    ? { ...settingsApi.DEFAULT_SETTINGS }
    : {
        showInPlayer: true,
        showInTrackRows: true,
        hideBroadcast: false,
        hideSnippet: false,
        showNotifications: true,
      };

  let seqCounter = 0;
  let scanTimer = null;
  const pendingResolves = new Map();
  const activeButtonsByDownloadId = new Map();

  const DOWNLOAD_ICON_SVG = `
    <svg class="vkms-icon vkms-icon-dl" viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden="true">
      <path d="M12 4v10m0 0l-4-4m4 4l4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M5 17v1.5A1.5 1.5 0 006.5 20h11a1.5 1.5 0 001.5-1.5V17" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  `;

  const CHECK_ICON_SVG = `
    <svg class="vkms-icon vkms-icon-ok" viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden="true">
      <path d="M5 13l4 4L19 7" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  `;

  const ERROR_ICON_SVG = `
    <svg class="vkms-icon vkms-icon-err" viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/>
      <path d="M12 8v4m0 4h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
    </svg>
  `;

  function createSpinnerHtml(percent) {
    const pctText = typeof percent === 'number' && percent > 0 ? `${percent}%` : '';
    return `
      <span class="vkms-spinner-wrap" aria-hidden="true">
        <span class="vkms-spinner"></span>
        ${pctText ? `<span class="vkms-pct">${pctText}</span>` : ''}
      </span>
    `;
  }

  function setButtonState(btn, state, infoText) {
    btn.dataset.vkmsState = state;
    btn.classList.remove('vkms-state-loading', 'vkms-state-done', 'vkms-state-error');

    if (state === 'loading') {
      btn.classList.add('vkms-state-loading');
      btn.innerHTML = createSpinnerHtml(0);
      btn.title = infoText || 'Скачивание трека...';
      btn.setAttribute('aria-label', btn.title);
    } else if (state === 'done') {
      btn.classList.add('vkms-state-done');
      btn.innerHTML = CHECK_ICON_SVG;
      btn.title = infoText || 'Трек скачан';
      btn.setAttribute('aria-label', btn.title);
    } else if (state === 'error') {
      btn.classList.add('vkms-state-error');
      btn.innerHTML = ERROR_ICON_SVG;
      btn.title = infoText || 'Ошибка скачивания';
      btn.setAttribute('aria-label', btn.title);
    } else {
      btn.innerHTML = DOWNLOAD_ICON_SVG;
      btn.title = 'Скачать трек (лучшее качество)';
      btn.setAttribute('aria-label', btn.title);
    }
  }

  function resolveTrackInPage(btn) {
    const requestId = `req_${++seqCounter}_${Date.now()}`;
    const btnId = btn.dataset.vkmsBtnId;

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingResolves.delete(requestId);
        resolve({ artist: '', title: '', url: '', fullId: '' });
      }, 5000);

      pendingResolves.set(requestId, (payload) => {
        clearTimeout(timer);
        resolve(payload || { artist: '', title: '', url: '', fullId: '' });
      });

      window.postMessage(
        {
          channel: CHANNEL,
          type: 'VKMS_RESOLVE_TRACK',
          requestId,
          btnId,
        },
        '*'
      );
    });
  }

  let toastTimer = null;

  function showToast(message, isError = false) {
    let toast = document.getElementById('vkms-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'vkms-toast';
      toast.className = 'vkms-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.toggle('vkms-toast-error', isError);
    toast.classList.add('vkms-toast-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.classList.remove('vkms-toast-visible');
    }, isError ? 6000 : 3000);
  }

  async function handleDownloadClick(event) {
    event.preventDefault();
    event.stopPropagation();

    const btn = event.currentTarget;
    if (btn.dataset.vkmsState === 'loading') return;

    const dlId = `dl_${++seqCounter}_${Date.now()}`;
    btn.dataset.vkmsBtnId = dlId;
    btn.dataset.vkmsDownloadId = dlId;
    activeButtonsByDownloadId.set(dlId, btn);

    setButtonState(btn, 'loading', 'Получение ссылки на трек...');

    try {
      const trackInfo = await resolveTrackInPage(btn);
      let url = trackInfo.url || '';

      if (!url && (!trackInfo.isRow || trackInfo.isPlayingMatch)) {
        const res = await extApi.runtime.sendMessage({ type: 'VKMS_GET_RECENT_STREAM' });
        if (res?.stream?.url) {
          url = res.stream.url;
        }
      }

      if (!url) {
        throw new Error('Ссылка на трек не найдена. Включите воспроизведение трека и нажмите снова.');
      }

      const label = [trackInfo.artist, trackInfo.title].filter(Boolean).join(' - ');
      setButtonState(btn, 'loading', label ? `Скачивание: ${label}` : 'Скачивание трека...');

      const response = await extApi.runtime.sendMessage({
        type: 'VKMS_DOWNLOAD_TRACK',
        downloadId: dlId,
        url,
        artist: trackInfo.artist || '',
        title: trackInfo.title || '',
      });

      if (!response || !response.ok) {
        throw new Error(response?.error || 'Не удалось скачать трек');
      }

      setButtonState(btn, 'done', `Скачано: ${response.filename}`);
      setTimeout(() => {
        if (btn.isConnected && btn.dataset.vkmsState === 'done') {
          setButtonState(btn, 'idle');
        }
      }, 2500);
    } catch (err) {
      const msg = err?.message || 'Ошибка скачивания';
      console.error('[VK Music Saver]', err);
      if (currentSettings.showNotifications) {
        showToast(`VK Music Saver: ${msg}`, true);
      }
      setButtonState(btn, 'error', msg);
      setTimeout(() => {
        if (btn.isConnected && btn.dataset.vkmsState === 'error') {
          setButtonState(btn, 'idle');
        }
      }, 4500);
    } finally {
      activeButtonsByDownloadId.delete(dlId);
    }
  }

  function createDownloadButton(templateEl) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'vkms-download-btn';

    // Inherit classic VK player button sizing if applicable
    if (templateEl.classList.contains('audio_page_player_btn')) {
      btn.classList.add('vkms-in-player');
    } else if (templateEl.classList.contains('audio_row__action')) {
      btn.classList.add('vkms-in-row');
    }

    setButtonState(btn, 'idle');
    btn.addEventListener('click', handleDownloadClick);
    return btn;
  }

  function getElementLabelStrings(el) {
    const strings = [];
    for (const attr of [
      'aria-label',
      'title',
      'data-tooltip',
      'data-title',
      'data-label',
      'data-original-title',
      'onmouseover',
    ]) {
      const val = el.getAttribute(attr);
      if (val) strings.push(val);
    }

    const blind = el.querySelector('.blind_label, [class*="VisuallyHidden"], [class*="visuallyHidden"]');
    if (blind?.textContent) strings.push(blind.textContent);

    const svgTitle = el.querySelector('svg title');
    if (svgTitle?.textContent) strings.push(svgTitle.textContent);

    const text = el.textContent?.trim();
    if (text && text.length < 80) strings.push(text);

    return strings;
  }

  function classifyTargetButton(el) {
    if (!el || el.nodeType !== 1) return null;
    if (el.classList.contains('vkms-download-btn')) return null;
    if (el.dataset.vkmsProcessed === '1' || el.dataset.vkmsHidden === '1') return null;

    if (el.dataset.vkmsRole === 'broadcast') return 'broadcast';
    if (el.dataset.vkmsRole === 'snippet') return 'snippet';

    if (
      el.classList.contains('audio_page_player_status') ||
      el.classList.contains('audio_page_player_btn_status')
    ) {
      return 'broadcast';
    }

    const labels = getElementLabelStrings(el);
    for (const str of labels) {
      if (BROADCAST_RE.test(str)) return 'broadcast';
      if (SNIPPET_RE.test(str)) return 'snippet';
    }

    const testId = el.getAttribute('data-testid') || '';
    if (testId) {
      const inAudio = Boolean(
        el.closest(
          '.audio_row, .audio_page_player, #top_audio_player, .top_audio_player, [data-testid="MusicTrackRow"], [class*="AudioPlayer"], [class*="audio_player"]'
        )
      );
      if (inAudio && /snippet/i.test(testId)) return 'snippet';
      if (inAudio && /broadcast/i.test(testId)) return 'broadcast';
    }

    return null;
  }

  function findControlsScope(el) {
    const known = el.closest(
      '.audio_page_player_btns, .audio_page_player_controls, .audio_row__actions, .top_audio_player_btns, [class*="PlayerControls"], [class*="AudioPlayer"]'
    );
    if (known) return known;

    let cur = el.parentElement;
    for (let i = 0; cur && i < 4; i++) {
      const btnCount = cur.querySelectorAll('button, [role="button"], .audio_page_player_btn, .audio_row__action').length;
      if (btnCount >= 2) return cur;
      cur = cur.parentElement;
    }
    return el.parentElement;
  }

  function getHideTarget(el, scope) {
    // If VK wrapped the button in a single-child Tooltip wrapper inside scope,
    // hide the wrapper so the old tooltip does not trigger around our button.
    let node = el;
    if (
      node.parentElement &&
      node.parentElement !== scope &&
      node.parentElement.children.length === 1 &&
      !node.parentElement.classList.contains('audio_page_player_btns') &&
      !node.parentElement.classList.contains('audio_row__actions')
    ) {
      node = node.parentElement;
    }
    return node;
  }

  function setNodeVisibility(node, visible) {
    if (visible) {
      node.style.removeProperty('display');
      node.removeAttribute('data-vkms-hidden');
    } else {
      node.style.setProperty('display', 'none', 'important');
      node.setAttribute('data-vkms-hidden', '1');
    }
  }

  function applyRoleVisibility(node, role) {
    const shouldHide =
      (role === 'broadcast' && currentSettings.hideBroadcast) ||
      (role === 'snippet' && currentSettings.hideSnippet);
    setNodeVisibility(node, !shouldHide);
  }

  function applyDownloadButtonVisibility(btn) {
    const ctx = btn.dataset.vkmsContext;
    const visible = ctx === 'row' ? currentSettings.showInTrackRows : currentSettings.showInPlayer;
    setNodeVisibility(btn, visible);
  }

  function applyAllSettingsToDom() {
    for (const node of document.querySelectorAll('[data-vkms-hide-role]')) {
      applyRoleVisibility(node, node.dataset.vkmsHideRole);
    }
    for (const btn of document.querySelectorAll('.vkms-download-btn')) {
      applyDownloadButtonVisibility(btn);
    }
  }

  function processTargetButton(target, role) {
    target.dataset.vkmsProcessed = '1';
    const scope = findControlsScope(target);
    const hideNode = getHideTarget(target, scope);
    hideNode.dataset.vkmsHideRole = role;
    applyRoleVisibility(hideNode, role);

    const isRow = Boolean(
      target.closest(
        '.audio_row, [data-testid="MusicTrackRow"], [data-audio], [data-full-id], [data-audio-id]'
      )
    );

    if (scope && !scope.querySelector(':scope .vkms-download-btn')) {
      const dlBtn = createDownloadButton(target);
      dlBtn.dataset.vkmsContext = isRow ? 'row' : 'player';
      if (isRow) {
        dlBtn.classList.add('vkms-in-row');
      } else {
        dlBtn.classList.add('vkms-in-player');
      }
      applyDownloadButtonVisibility(dlBtn);
      hideNode.insertAdjacentElement('afterend', dlBtn);
    }
  }

  function ensureTrackRowButtons() {
    if (!currentSettings.showInTrackRows) return;
    const actionBars = document.querySelectorAll('.audio_row__actions');
    for (const bar of actionBars) {
      if (bar.querySelector(':scope .vkms-download-btn')) continue;
      const dlBtn = document.createElement('button');
      dlBtn.type = 'button';
      dlBtn.className = 'vkms-download-btn vkms-in-row';
      dlBtn.dataset.vkmsContext = 'row';
      setButtonState(dlBtn, 'idle');
      dlBtn.addEventListener('click', handleDownloadClick);
      bar.appendChild(dlBtn);
    }
  }

  function scanDom() {
    const candidates = document.querySelectorAll(
      '[data-vkms-role], .audio_page_player_status, .audio_page_player_btn_status, button, [role="button"], .audio_page_player_btn, .audio_row__action, a[aria-label], a[title]'
    );

    for (const el of candidates) {
      const role = classifyTargetButton(el);
      if (role) {
        processTargetButton(el, role);
      }
    }

    ensureTrackRowButtons();
    window.postMessage({ channel: CHANNEL, type: 'VKMS_SCAN_ROLES' }, '*');
  }

  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scanDom();
    }, 100);
  }

  // Listen to page-hook responses
  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.data.channel !== CHANNEL) return;
    if (event.data.type === 'VKMS_RESOLVE_RESULT') {
      const resolver = pendingResolves.get(event.data.requestId);
      if (resolver) {
        pendingResolves.delete(event.data.requestId);
        resolver(event.data.result);
      }
    }
  });

  // Listen to progress updates from background
  extApi.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== 'VKMS_PROGRESS') return;
    const btn = activeButtonsByDownloadId.get(msg.downloadId);
    if (!btn || btn.dataset.vkmsState !== 'loading') return;
    const pctEl = btn.querySelector('.vkms-pct');
    if (pctEl) {
      pctEl.textContent = msg.percent > 0 ? `${msg.percent}%` : '';
    } else {
      btn.innerHTML = createSpinnerHtml(msg.percent);
    }
  });

  // Observe DOM mutations on VK SPA
  const observer = new MutationObserver((mutations) => {
    let needsScan = false;
    for (const m of mutations) {
      if (m.type === 'attributes' && m.attributeName === 'data-vkms-role') {
        const role = classifyTargetButton(m.target);
        if (role) {
          processTargetButton(m.target, role);
        }
        continue;
      }
      if (m.type === 'childList' && m.addedNodes.length > 0) {
        for (const node of m.addedNodes) {
          if (node.nodeType === 1 && !node.classList?.contains('vkms-download-btn')) {
            needsScan = true;
            break;
          }
        }
      } else if (m.type === 'attributes' && !m.target.classList?.contains('vkms-download-btn')) {
        needsScan = true;
      }
      if (needsScan) break;
    }
    if (needsScan) {
      scheduleScan();
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['aria-label', 'title', 'data-tooltip', 'data-vkms-role', 'class'],
  });

  if (extApi.storage?.onChanged) {
    extApi.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local' || !settingsApi) return;
      const updated = { ...currentSettings };
      for (const [key, change] of Object.entries(changes)) {
        updated[key] = change.newValue;
      }
      currentSettings = settingsApi.normalizeSettings(updated);
      applyAllSettingsToDom();
      scheduleScan();
    });
  }

  async function bootstrap() {
    if (settingsApi) {
      currentSettings = await settingsApi.loadSettings();
    }
    scanDom();
    applyAllSettingsToDom();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
  } else {
    bootstrap();
  }
})();
