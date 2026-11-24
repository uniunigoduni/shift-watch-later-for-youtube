// Shift Watch Later for YouTube — content script (ISOLATED world).
//
// - Scope is strictly limited to YouTube video/Shorts thumbnail regions.
// - Uses a single fixed floating hover overlay (portal) synced to the hovered
//   thumbnail's bounding rect, so YouTube swapping thumbnails with inline
//   video previews (ytd-video-preview) never causes the overlay to flicker.
// - Suppresses thumbnail hover/move events while in active overlay mode so
//   inline video previews do not hijack the thumbnail unnecessarily.
// - Modes (configurable via popup):
//     * Default ("watch_later"): Shift + Hover / Shift + Left Click
//     * Reversed ("open_video"): Normal Hover / Normal Left Click
//       (Shift + Left Click keeps Chrome's default behavior)
// - Middle-click, Right-click, Ctrl/Alt/Meta + Click always keep default behavior.
// - Saved videos always show a small persistent corner bookmark badge.
// - In-page English toast notifications (no chrome.notifications API).
(() => {
  'use strict';

  const TAG = '__swl__';
  const CACHE_KEY = 'swl_cache';
  const SETTING_KEY = 'shiftClickAction';
  const MODE_WATCH_LATER = 'watch_later';
  const MODE_OPEN_VIDEO = 'open_video';

  const ORIGIN = 'https://www.youtube.com';
  const STALE_MS = 10 * 60 * 1000;
  const MAX_PAGES = 60; // 100 items/page; Watch Later caps at 5,000

  const THUMB_LINK_SELECTOR = 'a[href*="watch?v="], a[href*="/shorts/"]';
  const PREVIEW_LINK_SELECTOR =
    'a.ytdVideoPreviewMediaContainerLink, a#media-container-link, a[href*="watch?v="], a[href*="/shorts/"]';
  const PREVIEW_HOST_SELECTOR =
    '.ytdVideoPreviewMediaContainer, .ytdVideoPreviewVideoPreviewContainer, #video-preview-container';
  const THUMB_CONTENT_SELECTOR =
    'img:not(.emoji):not(.small-emoji), yt-image, yt-thumbnail-view-model, .shortsLockupViewModelHostThumbnailContainer';
  const THUMB_SUBHOST_SELECTOR =
    'yt-thumbnail-view-model, .shortsLockupViewModelHostThumbnailContainer, ytd-thumbnail';
  const TITLE_LINK_SELECTOR =
    'a#video-title, a#video-title-link, a.ytLockupMetadataViewModelTitle, a.yt-lockup-metadata-view-model__title';
  const EXCLUDED_ANCESTOR_SELECTOR = [
    'ytd-guide-entry-renderer',
    'ytd-mini-guide-entry-renderer',
    'ytd-rich-metadata-renderer',
    'ytd-notification-renderer',
    'ytd-comment-view-model',
    'ytd-comment-renderer',
    'ytd-macro-markers-list-item-renderer',
    'ytd-macro-markers-list-renderer',
    'ytd-engagement-panel-section-list-renderer[target-id*="macro-markers"]',
    'ytd-engagement-panel-section-list-renderer[target-id*="chapters"]',
    'ytd-expandable-metadata-renderer',
    '#shorts-player',
    'ytd-reel-player-overlay-renderer',
  ].join(', ');
  const BLOCKING_UI_SELECTOR = [
    '#masthead-container',
    'ytd-masthead',
    'ytd-popup-container',
    'tp-yt-iron-dropdown',
    'tp-yt-paper-dialog',
    'tp-yt-app-drawer[opened]',
    'ytd-miniplayer[active]',
  ].join(', ');

  /** @type {'watch_later' | 'open_video'} */
  let mode = MODE_WATCH_LATER;

  /** @type {Map<string, string>} videoId -> setVideoId ('' if unknown yet) */
  let wl = new Map();
  let syncedAt = 0;
  let account = null;
  let syncing = null;
  let resyncQueued = false;
  let editEpoch = 0;

  // Serial queue & per-video pending tracking for Watch Later mutations
  const pendingCountByVideo = new Map();
  const desiredStateByVideo = new Map();
  let editQueue = Promise.resolve();
  let lastEditFinishedAt = 0;

  const anchorToHost = new WeakMap();

  function isVideoBusy(videoId) {
    return (pendingCountByVideo.get(videoId) || 0) > 0;
  }

  // Modifier key + pointer position state
  // physicalMods tracks actual keydown/keyup so layout-triggered pointer events
  // (e.g., when YouTube's inline video preview mounts) can never drop a held Shift key.
  const physicalMods = { shift: false, ctrl: false, alt: false, meta: false };
  const mods = { shift: false, ctrl: false, alt: false, meta: false };
  const pointer = { x: -1, y: -1, inside: false };

  // Current single floating overlay state
  const overlayState = {
    visible: false,
    videoId: null,
    href: '',
    host: null,
    rect: null,
  };

  // ------------------------------------------------------------------ mode & modifiers
  function isActionReady() {
    if (mods.ctrl || mods.alt || mods.meta) return false;
    return mode === MODE_WATCH_LATER ? mods.shift : !mods.shift;
  }

  function isToggleModifiers(e) {
    const ctrl = physicalMods.ctrl || Boolean(e.ctrlKey);
    const alt = physicalMods.alt || Boolean(e.altKey);
    const meta = physicalMods.meta || Boolean(e.metaKey);
    if (ctrl || alt || meta) return false;
    const shift = physicalMods.shift || Boolean(e.shiftKey);
    return mode === MODE_WATCH_LATER ? shift : !shift;
  }

  function isBadgeClickable() {
    if (mods.ctrl || mods.alt || mods.meta) return false;
    if (mode === MODE_OPEN_VIDEO && mods.shift) return false;
    return true;
  }

  function isBadgeClickModifiers(e) {
    const ctrl = physicalMods.ctrl || Boolean(e.ctrlKey);
    const alt = physicalMods.alt || Boolean(e.altKey);
    const meta = physicalMods.meta || Boolean(e.metaKey);
    if (ctrl || alt || meta) return false;
    const shift = physicalMods.shift || Boolean(e.shiftKey);
    if (mode === MODE_OPEN_VIDEO && shift) return false;
    return true;
  }

  function updateRootMode() {
    const root = document.documentElement;
    if (!root) return;
    if (root.dataset.swlMode !== mode) root.dataset.swlMode = mode;
    const readyStr = isActionReady() ? 'true' : 'false';
    if (root.dataset.swlActionReady !== readyStr) {
      root.dataset.swlActionReady = readyStr;
    }
    const badgeStr = isBadgeClickable() ? 'true' : 'false';
    if (root.dataset.swlBadgeClickable !== badgeStr) {
      root.dataset.swlBadgeClickable = badgeStr;
    }
  }

  function applyMods(shift, ctrl, alt, meta) {
    const changed =
      shift !== mods.shift ||
      ctrl !== mods.ctrl ||
      alt !== mods.alt ||
      meta !== mods.meta;
    if (changed) {
      mods.shift = shift;
      mods.ctrl = ctrl;
      mods.alt = alt;
      mods.meta = meta;
      updateRootMode();
      refreshHoverOverlay();
    }
  }

  const pressedShiftCodes = new Set();

  function syncModsFromKeyEvent(e) {
    if (!e.isTrusted) return;
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
      if (e.type === 'keydown') pressedShiftCodes.add(e.code);
      else if (e.type === 'keyup') pressedShiftCodes.delete(e.code);
    } else if (!e.shiftKey) {
      pressedShiftCodes.clear();
    }
    physicalMods.shift = pressedShiftCodes.size > 0 || Boolean(e.shiftKey);
    physicalMods.ctrl = Boolean(e.ctrlKey);
    physicalMods.alt = Boolean(e.altKey);
    physicalMods.meta = Boolean(e.metaKey);
    applyMods(physicalMods.shift, physicalMods.ctrl, physicalMods.alt, physicalMods.meta);
  }

  function syncModsFromPointerEvent(e) {
    if (!e.isTrusted) return;
    // Preserve physically held modifiers even if a browser-generated pointer event omits them
    const shift = physicalMods.shift || Boolean(e.shiftKey);
    const ctrl = physicalMods.ctrl || Boolean(e.ctrlKey);
    const alt = physicalMods.alt || Boolean(e.altKey);
    const meta = physicalMods.meta || Boolean(e.metaKey);
    applyMods(shift, ctrl, alt, meta);
  }

  function resetModsAndOverlay() {
    pressedShiftCodes.clear();
    physicalMods.shift = false;
    physicalMods.ctrl = false;
    physicalMods.alt = false;
    physicalMods.meta = false;
    mods.shift = false;
    mods.ctrl = false;
    mods.alt = false;
    mods.meta = false;
    pointer.inside = false;
    updateRootMode();
    hideHoverOverlay();
  }

  // ------------------------------------------------------------------ settings & storage
  async function loadSettings() {
    try {
      const data = await chrome.storage.sync.get({ [SETTING_KEY]: MODE_WATCH_LATER });
      mode = data[SETTING_KEY] === MODE_OPEN_VIDEO ? MODE_OPEN_VIDEO : MODE_WATCH_LATER;
    } catch {
      mode = MODE_WATCH_LATER;
    }
    updateRootMode();
    refreshHoverOverlay();
  }

  async function loadCache() {
    try {
      const { [CACHE_KEY]: s } = await chrome.storage.local.get(CACHE_KEY);
      if (s?.entries) {
        wl = new Map(s.entries);
        syncedAt = s.ts || 0;
        account = s.account || null;
      }
    } catch {
      // Ignore storage read error.
    }
  }

  function saveCache() {
    chrome.storage.local
      .set({ [CACHE_KEY]: { entries: [...wl], ts: syncedAt, account } })
      .catch(() => {});
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes[SETTING_KEY]) {
      const next = changes[SETTING_KEY].newValue;
      mode = next === MODE_OPEN_VIDEO ? MODE_OPEN_VIDEO : MODE_WATCH_LATER;
      updateRootMode();
      refreshHoverOverlay();
    }
    if (area === 'local' && changes[CACHE_KEY]?.newValue) {
      const s = changes[CACHE_KEY].newValue;
      if (!s?.entries || (account && s.account !== account)) return;
      wl = new Map(s.entries);
      syncedAt = s.ts || 0;
      refreshAll();
    }
  });

  // ------------------------------------------------------------------ InnerTube API
  function getCookie(name) {
    for (const part of document.cookie.split('; ')) {
      const idx = part.indexOf('=');
      if (idx !== -1 && part.slice(0, idx) === name) {
        return decodeURIComponent(part.slice(idx + 1));
      }
    }
    return null;
  }

  const sidCookie = () => getCookie('SAPISID') || getCookie('__Secure-3PAPISID');

  async function sha1Hex(str) {
    const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(str));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  async function accountKey(cfg) {
    const sid = sidCookie();
    if (!sid) return 'signed-out';
    return (await sha1Hex(`${sid}|${cfg?.sessionIndex ?? 0}|${cfg?.pageId || ''}`)).slice(0, 16);
  }

  let cfgPromise = null;
  function getConfig() {
    cfgPromise ??= new Promise((resolve) => {
      const done = (cfg) => {
        clearTimeout(timeoutId);
        clearInterval(pollId);
        window.removeEventListener('message', onMsg);
        if (!cfg) cfgPromise = null;
        resolve(cfg);
      };
      const onMsg = (e) => {
        if (e.source === window && e.data?.[TAG] === 'cfg' && e.data.cfg) {
          done(e.data.cfg);
        }
      };
      window.addEventListener('message', onMsg);
      const ask = () => window.postMessage({ [TAG]: 'cfg?' }, location.origin);
      const pollId = setInterval(ask, 400);
      const timeoutId = setTimeout(() => done(null), 5000);
      ask();
    });
    return cfgPromise;
  }

  async function innertube(endpoint, payload) {
    const cfg = await getConfig();
    const sid = sidCookie();
    if (!cfg || !sid) {
      const err = new Error('NOT_SIGNED_IN');
      err.code = 'NOT_SIGNED_IN';
      throw err;
    }

    const ts = Math.floor(Date.now() / 1000);
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `SAPISIDHASH ${ts}_${await sha1Hex(`${ts} ${sid} ${ORIGIN}`)}`,
      'X-Origin': ORIGIN,
      'X-Goog-AuthUser': String(cfg.sessionIndex ?? 0),
      'X-Youtube-Client-Name': '1',
      'X-Youtube-Client-Version': cfg.clientVersion || '',
    };
    if (cfg.pageId) headers['X-Goog-PageId'] = cfg.pageId;

    const res = await fetch(`/youtubei/v1/${endpoint}?prettyPrint=false`, {
      method: 'POST',
      credentials: 'same-origin',
      headers,
      body: JSON.stringify({ context: cfg.context, ...payload }),
    });
    if (!res.ok) throw new Error(`${endpoint} HTTP ${res.status}`);
    return res.json();
  }

  // ------------------------------------------------------------------ Watch Later sync
  function findKey(root, key) {
    const stack = [root];
    while (stack.length) {
      const o = stack.pop();
      if (!o || typeof o !== 'object') continue;
      if (typeof o[key] === 'string') return o[key];
      for (const k in o) stack.push(o[k]);
    }
    return null;
  }

  function findToken(root) {
    const stack = [root];
    while (stack.length) {
      const o = stack.pop();
      if (!o || typeof o !== 'object') continue;
      if (typeof o.continuationCommand?.token === 'string') {
        return o.continuationCommand.token;
      }
      for (const k in o) stack.push(o[k]);
    }
    return null;
  }

  function collectPlaylistItems(root, out) {
    const stack = [root];
    while (stack.length) {
      const o = stack.pop();
      if (!o || typeof o !== 'object') continue;
      if (Array.isArray(o)) {
        for (const v of o) stack.push(v);
        continue;
      }
      const pv = o.playlistVideoRenderer;
      if (pv?.videoId) {
        out.entries.push([pv.videoId, pv.setVideoId || '']);
        continue;
      }
      const lk = o.lockupViewModel;
      if (lk?.contentId && lk.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO') {
        out.entries.push([lk.contentId, findKey(lk, 'setVideoId') || '']);
        continue;
      }
      if (o.continuationItemRenderer) {
        out.token = findToken(o.continuationItemRenderer) || out.token;
        continue;
      }
      for (const k in o) stack.push(o[k]);
    }
  }

  async function fetchWatchLaterMap() {
    const all = new Map();
    if (!sidCookie()) return all;
    let payload = { browseId: 'VLWL' };
    const seenTokens = new Set();
    for (let page = 0; page < MAX_PAGES; page++) {
      const out = { entries: [], token: null };
      collectPlaylistItems(await innertube('browse', payload), out);
      for (const [id, sv] of out.entries) all.set(id, sv);
      if (!out.token || seenTokens.has(out.token)) break;
      seenTokens.add(out.token);
      payload = { continuation: out.token };
    }
    return all;
  }

  function sync() {
    if (syncing) {
      resyncQueued = true;
      return syncing;
    }
    syncing = (async () => {
      const startEpoch = editEpoch;
      try {
        const cfg = await getConfig();
        if (!cfg) return;
        account = await accountKey(cfg);
        const all = await fetchWatchLaterMap();
        // If user edited Watch Later while this sync was in flight, avoid overwriting with stale data
        if (startEpoch !== editEpoch || pendingCountByVideo.size > 0) {
          resyncQueued = true;
          return;
        }
        wl = all;
        syncedAt = Date.now();
        saveCache();
        refreshAll();
      } catch (err) {
        console.warn('[Shift Watch Later] sync failed:', err);
      } finally {
        syncing = null;
        if (resyncQueued) {
          resyncQueued = false;
          if (pendingCountByVideo.size > 0) {
            syncSoon(800);
          } else {
            sync();
          }
        }
      }
    })();
    return syncing;
  }

  let syncTimer = 0;
  const syncSoon = (ms = 1200) => {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(sync, ms);
  };
  const syncIfStale = () => {
    if (Date.now() - syncedAt > STALE_MS) sync();
  };

  function applyEdit(added, removed, setIds = null) {
    editEpoch++;
    for (const id of added) {
      const sv = setIds?.[id] || wl.get(id) || '';
      wl.set(id, sv);
    }
    for (const id of removed) {
      wl.delete(id);
    }
    if (syncing) resyncQueued = true;
    saveCache();
    refreshAll();
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.[TAG] !== 'edit') return;
    const { added = [], removed = [], setIds = null, unknown = false } = e.data;
    if (added.length || removed.length) applyEdit(added, removed, setIds);
    if (unknown) syncSoon();
  });

  // ------------------------------------------------------------------ in-page stacked toast UI
  let toastStackEl = null;
  /** @type {Array<{ el: HTMLElement, timer: number }>} newest first (index 0 = front) */
  const activeToasts = [];
  const TOAST_DURATION_MS = 2400;
  const TOAST_OFFSETS = [0, -10, -19, -27, -34, -40];
  const TOAST_SCALES = [1, 0.95, 0.9, 0.85, 0.8, 0.76];
  const TOAST_OPACITIES = [1, 0.88, 0.72, 0.54, 0.36, 0.2];

  const SVG_NS = 'http://www.w3.org/2000/svg';

  const TOAST_ICONS = {
    added: {
      circleFill: '#22c55e',
      pathD: 'M7.5 12.4l3 3 6-6.4',
      stroke: '#0b140d',
      strokeWidth: '2.4',
      strokeLinejoin: 'round',
    },
    removed: {
      circleFill: '#71717a',
      pathD: 'M8.5 8.5l7 7M15.5 8.5l-7 7',
      stroke: '#ffffff',
      strokeWidth: '2.2',
    },
    error: {
      circleFill: '#ef4444',
      pathD: 'M12 7.5v5.5M12 16.5h.01',
      stroke: '#ffffff',
      strokeWidth: '2.4',
    },
  };

  function createToastIconSvg(kind) {
    const spec = TOAST_ICONS[kind] || TOAST_ICONS.added;
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');

    const circle = document.createElementNS(SVG_NS, 'circle');
    circle.setAttribute('cx', '12');
    circle.setAttribute('cy', '12');
    circle.setAttribute('r', '10');
    circle.setAttribute('fill', spec.circleFill);

    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', spec.pathD);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', spec.stroke);
    path.setAttribute('stroke-width', spec.strokeWidth);
    path.setAttribute('stroke-linecap', 'round');
    if (spec.strokeLinejoin) path.setAttribute('stroke-linejoin', spec.strokeLinejoin);

    svg.append(circle, path);
    return svg;
  }

  function getToastStackEl() {
    if (toastStackEl && toastStackEl.isConnected) return toastStackEl;
    toastStackEl = document.createElement('div');
    toastStackEl.className = 'swl-toast-stack';
    toastStackEl.setAttribute('aria-live', 'polite');
    toastStackEl.setAttribute('aria-relevant', 'additions');
    (document.body || document.documentElement).appendChild(toastStackEl);
    return toastStackEl;
  }

  function layoutToasts() {
    for (let idx = 0; idx < activeToasts.length; idx++) {
      const { el } = activeToasts[idx];
      const depth = Math.min(idx, TOAST_OFFSETS.length - 1);
      const opacity = idx >= TOAST_OPACITIES.length ? 0 : TOAST_OPACITIES[depth];
      el.style.setProperty('--swl-y', `${TOAST_OFFSETS[depth]}px`);
      el.style.setProperty('--swl-scale', String(TOAST_SCALES[depth]));
      el.style.setProperty('--swl-opacity', String(opacity));
      el.style.zIndex = String(1000 - idx);
    }
  }

  function dismissToast(item) {
    const idx = activeToasts.indexOf(item);
    if (idx !== -1) {
      activeToasts.splice(idx, 1);
      layoutToasts();
    }
    clearTimeout(item.timer);
    item.el.setAttribute('data-swl-leaving', 'true');
    setTimeout(() => {
      item.el.remove();
    }, 240);
  }

  function showToast(kind, message) {
    const stack = getToastStackEl();

    const el = document.createElement('div');
    el.className = 'swl-toast';
    el.dataset.swlKind = kind;
    el.setAttribute('role', 'status');
    el.setAttribute('data-swl-entering', 'true');

    const iconWrap = document.createElement('span');
    iconWrap.className = 'swl-toast-icon';
    iconWrap.appendChild(createToastIconSvg(kind));

    const textWrap = document.createElement('span');
    textWrap.className = 'swl-toast-text';
    textWrap.textContent = message;

    el.append(iconWrap, textWrap);
    stack.appendChild(el);

    const item = { el, timer: 0 };
    activeToasts.unshift(item);

    // Force initial entering style before transitioning to front stack position
    void el.offsetWidth;
    el.removeAttribute('data-swl-entering');
    layoutToasts();

    item.timer = setTimeout(() => dismissToast(item), TOAST_DURATION_MS);
  }

  // ------------------------------------------------------------------ toggle Watch Later
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function extractSetVideoIdFromResponse(resp, videoId) {
    const results = resp?.playlistEditResults;
    if (!Array.isArray(results)) return '';
    for (const item of results) {
      const added = item?.playlistEditVideoAddedResultData;
      if (added?.setVideoId && (!added.videoId || added.videoId === videoId)) {
        return added.setVideoId;
      }
    }
    return '';
  }

  async function editPlaylistWithRetry(actions) {
    const retryDelays = [300, 700];
    let lastErr = null;

    for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
      try {
        const resp = await innertube('browse/edit_playlist', {
          playlistId: 'WL',
          actions,
        });
        if (resp?.status === 'STATUS_FAILED') {
          const err = new Error('edit_playlist STATUS_FAILED');
          err.retryable = true;
          throw err;
        }
        return resp;
      } catch (err) {
        lastErr = err;
        if (err?.code === 'NOT_SIGNED_IN') throw err;
        const retryable =
          Boolean(err?.retryable) ||
          /HTTP (409|429|5\d\d)/.test(err?.message || '') ||
          err?.name === 'TypeError';
        if (!retryable || attempt === retryDelays.length) throw err;
        await sleep(retryDelays[attempt]);
      }
    }
    throw lastErr;
  }

  async function executeSingleToggle(videoId, adding) {
    if (adding) {
      const resp = await editPlaylistWithRetry([
        { action: 'ACTION_ADD_VIDEO', addedVideoId: videoId },
      ]);
      const setVideoId = extractSetVideoIdFromResponse(resp, videoId);
      applyEdit([videoId], [], setVideoId ? { [videoId]: setVideoId } : null);
      showToast('added', 'Added to Watch Later');
      return;
    }

    // Prefer direct removal by videoId (no setVideoId lookup/resync required)
    try {
      await editPlaylistWithRetry([
        { action: 'ACTION_REMOVE_VIDEO_BY_VIDEO_ID', removedVideoId: videoId },
      ]);
    } catch (err) {
      if (err?.code === 'NOT_SIGNED_IN') throw err;

      // Fallback to setVideoId-based removal if direct removal is rejected
      let setVideoId = wl.get(videoId);
      if (!setVideoId) {
        const latest = await fetchWatchLaterMap();
        setVideoId = latest.get(videoId) || '';
        if (!latest.has(videoId)) {
          applyEdit([], [videoId]);
          showToast('removed', 'Removed from Watch Later');
          return;
        }
      }
      if (!setVideoId) throw err;
      await editPlaylistWithRetry([{ action: 'ACTION_REMOVE_VIDEO', setVideoId }]);
    }

    applyEdit([], [videoId]);
    showToast('removed', 'Removed from Watch Later');
  }

  function enqueueWatchLaterMutation(videoId, adding) {
    desiredStateByVideo.set(videoId, adding);
    pendingCountByVideo.set(videoId, (pendingCountByVideo.get(videoId) || 0) + 1);
    refreshByVideoId(videoId);

    editQueue = editQueue
      .catch(() => {})
      .then(async () => {
        // Short gap between back-to-back mutations avoids YouTube backend lock contention
        const sinceLast = Date.now() - lastEditFinishedAt;
        if (sinceLast < 80) await sleep(80 - sinceLast);

        try {
          await executeSingleToggle(videoId, adding);
        } catch (err) {
          console.warn('[Shift Watch Later] failed to update Watch Later:', err);
          if (err?.code === 'NOT_SIGNED_IN') {
            showToast('error', 'Sign in to YouTube to use Watch Later');
          } else {
            showToast('error', 'Failed to update Watch Later');
          }
        } finally {
          lastEditFinishedAt = Date.now();
          const remaining = (pendingCountByVideo.get(videoId) || 1) - 1;
          if (remaining <= 0) {
            pendingCountByVideo.delete(videoId);
            desiredStateByVideo.delete(videoId);
          } else {
            pendingCountByVideo.set(videoId, remaining);
          }
          refreshByVideoId(videoId);
        }
      });
  }

  function toggleWatchLater(videoId) {
    if (!videoId) return;
    const effectiveOn = desiredStateByVideo.has(videoId)
      ? desiredStateByVideo.get(videoId)
      : wl.has(videoId);
    enqueueWatchLaterMutation(videoId, !effectiveOn);
  }

  function removeWatchLater(videoId) {
    if (!videoId) return;
    const effectiveOn = desiredStateByVideo.has(videoId)
      ? desiredStateByVideo.get(videoId)
      : wl.has(videoId);
    if (!effectiveOn) return; // Already removed or removal already queued
    enqueueWatchLaterMutation(videoId, false);
  }

  // ------------------------------------------------------------------ SVG & DOM templates
  function makeSvg(cls, viewBox, d, fillRule) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', cls);
    svg.setAttribute('viewBox', viewBox);
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    if (fillRule) path.setAttribute('fill-rule', fillRule);
    svg.appendChild(path);
    return svg;
  }

  // Persistent diagonal top-left corner marker injected per thumbnail host
  const badgeLayerTemplate = (() => {
    const layer = document.createElement('div');
    layer.className = 'swl-badge-layer';

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'swl-badge');
    svg.setAttribute('viewBox', '0 0 48 48');

    const hit = document.createElementNS(SVG_NS, 'g');
    hit.setAttribute('class', 'swl-badge-hit');
    hit.setAttribute('role', 'button');
    hit.setAttribute('aria-label', 'Remove from Watch Later');

    const title = document.createElementNS(SVG_NS, 'title');
    title.textContent = 'Remove from Watch Later';

    const tri = document.createElementNS(SVG_NS, 'path');
    tri.setAttribute('class', 'swl-badge-bg');
    tri.setAttribute('d', 'M0 0 L48 0 L0 48 Z');

    const edge = document.createElementNS(SVG_NS, 'line');
    edge.setAttribute('class', 'swl-badge-edge');
    edge.setAttribute('x1', '48');
    edge.setAttribute('y1', '0');
    edge.setAttribute('x2', '0');
    edge.setAttribute('y2', '48');

    const bookmark = document.createElementNS(SVG_NS, 'path');
    bookmark.setAttribute('class', 'swl-badge-icon');
    bookmark.setAttribute(
      'd',
      'M10.1 7 H18.9 A1.6 1.6 0 0 1 20.5 8.6 V22 L14.5 18.4 L8.5 22 V8.6 A1.6 1.6 0 0 1 10.1 7 Z'
    );

    hit.append(title, tri, edge, bookmark);
    svg.appendChild(hit);
    layer.appendChild(svg);
    return layer;
  })();

  // Single fixed floating hover overlay (portal) as a real <a> element:
  // - pointer-events: auto while visible blocks underlying YouTube hover/preview completely
  // - real href preserves native middle-click (new tab) and right-click link context menu
  let hoverOverlayEl = null;

  function getHoverOverlayEl() {
    if (hoverOverlayEl && hoverOverlayEl.isConnected) return hoverOverlayEl;

    const el = document.createElement('a');
    el.className = 'swl-hover-overlay';
    el.tabIndex = -1;
    el.draggable = false;

    // Outer circle (r=28 around 32,32) with cutout rounded Plus (evenodd)
    const addCirclePath =
      'M32 4 A28 28 0 1 0 32 60 A28 28 0 1 0 32 4 Z ' +
      'M29 20 A3 3 0 0 1 35 20 V29 H44 A3 3 0 0 1 44 35 H35 V44 A3 3 0 0 1 29 44 V35 H20 A3 3 0 0 1 20 29 H29 Z';

    // Outer circle (r=28 around 32,32) with cutout Bookmark (evenodd)
    const savedCirclePath =
      'M32 4 A28 28 0 1 0 32 60 A28 28 0 1 0 32 4 Z ' +
      'M24 18 H40 A3 3 0 0 1 43 21 V46 L32 39.2 L21 46 V21 A3 3 0 0 1 24 18 Z';

    el.append(
      makeSvg('swl-icon swl-icon-add', '0 0 64 64', addCirclePath, 'evenodd'),
      makeSvg('swl-icon swl-icon-saved', '0 0 64 64', savedCirclePath, 'evenodd')
    );

    // If cursor exits the overlay directly (e.g. out of viewport or into an iframe), re-evaluate
    el.addEventListener('pointerleave', (e) => {
      if (!e.isTrusted) return;
      pointer.x = e.clientX;
      pointer.y = e.clientY;
      refreshHoverOverlay();
    });

    (document.documentElement || document.body).appendChild(el);
    hoverOverlayEl = el;
    return el;
  }

  // ------------------------------------------------------------------ thumbnail detection
  function extractVideoIdFromHref(href) {
    if (!href) return null;
    let m = /[?&]v=([\w-]{11})/.exec(href);
    if (m) {
      if (/[?&]list=WL(?:&|$)/.test(href)) return null;
      return m[1];
    }
    m = /\/shorts\/([\w-]{11})/.exec(href);
    return m ? m[1] : null;
  }

  function resolveThumbInfo(anchor) {
    if (!(anchor instanceof HTMLAnchorElement)) return null;
    if (anchor.id === 'wc-endpoint' || anchor.matches(TITLE_LINK_SELECTOR)) return null;

    const videoId = extractVideoIdFromHref(anchor.getAttribute('href'));
    if (!videoId) return null;

    if (anchor.closest(EXCLUDED_ANCESTOR_SELECTOR)) return null;

    const previewRoot = anchor.closest('ytd-video-preview');
    if (!previewRoot && anchor.closest('#movie_player, .html5-video-player')) {
      return null;
    }

    if (previewRoot) {
      if (anchor.closest('.ytdVideoPreviewMetadata, #details, #meta')) return null;
      const previewHost = anchor.closest(PREVIEW_HOST_SELECTOR) || anchor;
      return { videoId, href: anchor.href, host: previewHost, isPreview: true };
    }

    // Ignore outer wrapper anchors (e.g. playlist panel rows) that wrap an inner thumbnail link
    if (anchor.querySelector(THUMB_LINK_SELECTOR)) return null;

    if (!anchor.querySelector(THUMB_CONTENT_SELECTOR)) {
      return null;
    }

    const subHost = anchor.querySelector(THUMB_SUBHOST_SELECTOR);
    const host = subHost || anchor;
    return { videoId, href: anchor.href, host, isPreview: false };
  }

  function pointInRect(x, y, r) {
    return r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }

  function isUsableRect(r) {
    return r && r.width >= 24 && r.height >= 24;
  }

  /**
   * Resolves the thumbnail host & videoId directly under viewport coordinates (x, y).
   * Inspects the full hit-test stack so swaps between thumbnails and inline previews
   * are handled seamlessly.
   */
  function findThumbAtPoint(x, y) {
    if (x < 0 || y < 0) return null;
    const stack = document.elementsFromPoint(x, y);
    if (!stack.length) return null;

    // Skip our own floating overlay/toast to find the top-most real YouTube element
    const topReal = stack.find(
      (el) => !el.closest('.swl-hover-overlay, .swl-toast-stack, .swl-toast')
    );
    if (!topReal || topReal.closest(BLOCKING_UI_SELECTOR)) return null;

    let sawPreviewWithoutHref = false;

    for (const el of stack) {
      if (el.closest('.swl-hover-overlay, .swl-toast-stack, .swl-toast')) {
        continue;
      }

      const previewRoot = el.closest('ytd-video-preview');
      if (previewRoot) {
        if (el.closest('.ytdVideoPreviewMetadata, #details, #meta')) return null;
        const previewHost = el.closest(PREVIEW_HOST_SELECTOR);
        if (previewHost) {
          const previewLink = previewRoot.querySelector(PREVIEW_LINK_SELECTOR);
          const info = resolveThumbInfo(previewLink);
          const rect = previewHost.getBoundingClientRect();
          if (info && isUsableRect(rect) && pointInRect(x, y, rect)) {
            return { ...info, rect };
          }
          if (isUsableRect(rect) && pointInRect(x, y, rect)) {
            sawPreviewWithoutHref = true;
          }
        }
        continue;
      }

      const markedHost = el.closest('[data-swl-host]');
      if (markedHost) {
        const videoId = markedHost.dataset.swlId;
        const rect = markedHost.getBoundingClientRect();
        if (videoId && isUsableRect(rect) && pointInRect(x, y, rect)) {
          const href =
            markedHost.dataset.swlHref ||
            markedHost.closest('a[href]')?.href ||
            `${ORIGIN}/watch?v=${videoId}`;
          return { videoId, href, host: markedHost, rect, isPreview: false };
        }
      }

      const anchor = el.closest(THUMB_LINK_SELECTOR);
      if (anchor) {
        const info = resolveThumbInfo(anchor);
        if (info && info.host.contains(el)) {
          const rect = info.host.getBoundingClientRect();
          if (isUsableRect(rect) && pointInRect(x, y, rect)) {
            return { ...info, rect };
          }
        }
      }
    }

    if (sawPreviewWithoutHref) {
      return { transitioningPreview: true };
    }
    return null;
  }

  function findThumbTarget(target, clientX, clientY) {
    if (target instanceof Element) {
      if (target.closest('.swl-hover-overlay') && overlayState.visible && overlayState.videoId) {
        return {
          videoId: overlayState.videoId,
          href: overlayState.href,
          host: overlayState.host,
          rect: overlayState.rect,
        };
      }
      if (target.closest(BLOCKING_UI_SELECTOR)) return null;
    }

    if (typeof clientX === 'number' && typeof clientY === 'number') {
      const hit = findThumbAtPoint(clientX, clientY);
      if (hit && hit.videoId) return hit;
      // During a 1-frame preview swap right under the cursor, trust the active overlay
      if (
        overlayState.visible &&
        overlayState.videoId &&
        pointInRect(clientX, clientY, overlayState.rect)
      ) {
        return {
          videoId: overlayState.videoId,
          host: overlayState.host,
          rect: overlayState.rect,
        };
      }
    }

    if (!(target instanceof Element)) return null;
    const previewRoot = target.closest('ytd-video-preview');
    if (previewRoot) {
      if (target.closest('.ytdVideoPreviewMetadata, #details, #meta')) return null;
      const previewLink = previewRoot.querySelector(PREVIEW_LINK_SELECTOR);
      const info = resolveThumbInfo(previewLink);
      if (info && info.host.contains(target)) return info;
      return null;
    }

    const markedHost = target.closest('[data-swl-host]');
    if (markedHost && markedHost.dataset.swlId) {
      return { host: markedHost, videoId: markedHost.dataset.swlId };
    }

    const anchor = target.closest(THUMB_LINK_SELECTOR);
    if (!anchor) return null;
    const info = resolveThumbInfo(anchor);
    if (!info || !info.host.contains(target)) return null;
    return info;
  }

  // ------------------------------------------------------------------ single floating overlay
  function resolveBorderRadius(host) {
    const candidates = [
      host,
      host?.parentElement,
      host?.closest?.('ytd-video-preview, ytd-thumbnail, yt-thumbnail-view-model'),
      host?.querySelector?.('.ytThumbnailViewModelImage, img'),
    ];
    for (const el of candidates) {
      if (!el) continue;
      const br = getComputedStyle(el).borderRadius;
      if (br && br !== '0px') return br;
    }
    return '0px';
  }

  function getHeaderBottom() {
    const masthead = document.getElementById('masthead-container');
    if (!masthead) return 0;
    const r = masthead.getBoundingClientRect();
    return r.height > 0 && r.bottom > 0 ? r.bottom : 0;
  }

  function clearActiveHostMarkers() {
    for (const el of document.querySelectorAll('[data-swl-overlay-active]')) {
      el.removeAttribute('data-swl-overlay-active');
    }
  }

  function markActiveHosts(videoId, rect) {
    clearActiveHostMarkers();
    if (!videoId || !rect) return;
    for (const host of document.querySelectorAll('[data-swl-host]')) {
      if (host.dataset.swlId !== videoId) continue;
      const r = host.getBoundingClientRect();
      // Only hide badge on the hovered thumbnail (or preview directly over it)
      if (
        r.width > 0 &&
        Math.abs(r.left - rect.left) < 40 &&
        Math.abs(r.top - rect.top) < 40
      ) {
        host.setAttribute('data-swl-overlay-active', '');
      }
    }
    const activePreview = document.querySelector('ytd-video-preview .ytdVideoPreviewMediaContainer');
    if (activePreview) {
      const pr = activePreview.getBoundingClientRect();
      if (
        pr.width > 0 &&
        Math.abs(pr.left - rect.left) < 40 &&
        Math.abs(pr.top - rect.top) < 40
      ) {
        activePreview.setAttribute('data-swl-overlay-active', '');
      }
    }
  }

  function syncOverlayIconState() {
    if (!hoverOverlayEl || !overlayState.visible || !overlayState.videoId) return;
    hoverOverlayEl.toggleAttribute('data-swl-on', wl.has(overlayState.videoId));
    hoverOverlayEl.toggleAttribute('data-swl-busy', isVideoBusy(overlayState.videoId));
  }

  function sendLeaveEvents(target, relatedTarget) {
    if (!target) return;
    try {
      target.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget }));
      target.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget }));
      target.dispatchEvent(new PointerEvent('pointerleave', { bubbles: false, relatedTarget }));
      target.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false, relatedTarget }));
    } catch {
      // Ignore synthetic event errors.
    }
  }

  function dismissUnderlyingHover(host, overlayEl) {
    // Cancel pending hover/preview timers on the thumbnail and its parent video card
    if (host) {
      sendLeaveEvents(host, overlayEl);
      const card = host.closest(
        'ytd-thumbnail, yt-lockup-view-model, ytd-rich-grid-media, ytd-video-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer'
      );
      if (card && card !== host) {
        sendLeaveEvents(card, overlayEl);
      }
    }

    // Close any active inline video preview cleanly
    const activePreviewTargets = document.querySelectorAll(
      '[data-ytd-video-preview-hit-box].ytdVideoPreviewLoaderActive, ytd-video-preview.ytdVideoPreviewActive'
    );
    for (const target of activePreviewTargets) {
      sendLeaveEvents(target, overlayEl);
    }
  }

  function hideHoverOverlay() {
    if (!overlayState.visible) return;
    overlayState.visible = false;
    overlayState.videoId = null;
    overlayState.href = '';
    overlayState.host = null;
    overlayState.rect = null;
    clearActiveHostMarkers();
    if (hoverOverlayEl) {
      hoverOverlayEl.removeAttribute('data-swl-visible');
      hoverOverlayEl.removeAttribute('data-swl-busy');
      hoverOverlayEl.removeAttribute('href');
    }
    document.documentElement?.removeAttribute('data-swl-overlay-visible');
  }

  function showHoverOverlay(videoId, href, host, rect) {
    const el = getHoverOverlayEl();

    const sameSpot =
      overlayState.visible &&
      overlayState.videoId === videoId &&
      overlayState.rect &&
      Math.abs(overlayState.rect.left - rect.left) < 1 &&
      Math.abs(overlayState.rect.top - rect.top) < 1 &&
      Math.abs(overlayState.rect.width - rect.width) < 1 &&
      Math.abs(overlayState.rect.height - rect.height) < 1;

    const resolvedHref = href || `${ORIGIN}/watch?v=${videoId}`;

    overlayState.visible = true;
    overlayState.videoId = videoId;
    overlayState.href = resolvedHref;
    overlayState.host = host;
    overlayState.rect = rect;

    if (el.href !== resolvedHref) {
      el.href = resolvedHref;
    }

    if (!sameSpot) {
      const headerBottom = getHeaderBottom();
      const topClip = Math.max(0, headerBottom - rect.top);
      el.style.left = `${rect.left}px`;
      el.style.top = `${rect.top}px`;
      el.style.width = `${rect.width}px`;
      el.style.height = `${rect.height}px`;
      el.style.borderRadius = resolveBorderRadius(host);
      el.style.clipPath = topClip > 0 ? `inset(${topClip}px 0 0 0)` : '';
      markActiveHosts(videoId, rect);
    } else if (host && !host.hasAttribute('data-swl-overlay-active')) {
      host.setAttribute('data-swl-overlay-active', '');
    }

    syncOverlayIconState();

    const wasVisible = el.hasAttribute('data-swl-visible');
    if (!wasVisible) {
      el.setAttribute('data-swl-visible', 'true');
    }
    document.documentElement?.setAttribute('data-swl-overlay-visible', 'true');

    // Cancel underlying YouTube hover/preview when overlay activates or switches thumbnails
    if (!wasVisible || !sameSpot || host?.closest?.('ytd-video-preview')) {
      dismissUnderlyingHover(host, el);
    }
  }

  function refreshHoverOverlay() {
    if (!pointer.inside || !isActionReady()) {
      hideHoverOverlay();
      return;
    }

    const hit = findThumbAtPoint(pointer.x, pointer.y);
    if (!hit) {
      // If YouTube is closing an active preview and momentarily hiding the thumbnail under our overlay,
      // hold steady as long as cursor remains inside the current thumbnail rect.
      if (overlayState.visible && pointInRect(pointer.x, pointer.y, overlayState.rect)) {
        const stack = document.elementsFromPoint(pointer.x, pointer.y);
        const under = stack.find(
          (el) => !el.closest('.swl-hover-overlay, .swl-toast-stack, .swl-toast')
        );
        if (under && under.closest('ytd-thumbnail, yt-thumbnail-view-model, ytd-video-preview, [data-ytd-video-preview-hit-box]')) {
          return;
        }
      }
      hideHoverOverlay();
      return;
    }

    if (hit.transitioningPreview) {
      if (overlayState.visible && pointInRect(pointer.x, pointer.y, overlayState.rect)) {
        return;
      }
      hideHoverOverlay();
      return;
    }

    showHoverOverlay(hit.videoId, hit.href, hit.host, hit.rect);
  }

  // ------------------------------------------------------------------ input & hover listeners
  window.addEventListener('keydown', syncModsFromKeyEvent, true);
  window.addEventListener('keyup', syncModsFromKeyEvent, true);

  function onPointerPosition(e) {
    if (!e.isTrusted) return;
    pointer.x = e.clientX;
    pointer.y = e.clientY;
    pointer.inside = true;
    // Do not sync modifier flags from layout-triggered pointerover events
    if (e.type !== 'pointerover') {
      syncModsFromPointerEvent(e);
    }
    refreshHoverOverlay();
  }

  window.addEventListener('pointerover', onPointerPosition, { capture: true, passive: true });
  window.addEventListener('pointermove', onPointerPosition, { capture: true, passive: true });
  window.addEventListener('pointerdown', onPointerPosition, true);
  window.addEventListener('pointerup', onPointerPosition, true);

  document.documentElement.addEventListener('mouseleave', () => {
    pointer.inside = false;
    hideHoverOverlay();
  });

  window.addEventListener('blur', resetModsAndOverlay);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) resetModsAndOverlay();
  });

  // Track scroll / resize so the fixed overlay stays glued to the thumbnail or hides cleanly
  let scrollRaf = 0;
  function scheduleOverlayRefresh() {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0;
      refreshHoverOverlay();
    });
  }
  window.addEventListener('scroll', scheduleOverlayRefresh, { capture: true, passive: true });
  window.addEventListener('resize', scheduleOverlayRefresh, { passive: true });

  // Suppress YouTube's inline preview triggers while hovering a thumbnail in active overlay mode,
  // or while hovering the clickable saved-video corner triangle.
  // Never intercepts mouseleave/mouseout so any open preview closes normally.
  for (const type of ['pointerenter', 'mouseenter', 'pointerover', 'mouseover', 'pointermove', 'mousemove']) {
    window.addEventListener(
      type,
      (e) => {
        if (!e.isTrusted) return;
        if (!(e.target instanceof Element)) return;

        // Keep YouTube's preview/hover out of the way when hovering the clickable corner marker
        const badgeHit = e.target.closest('.swl-badge-hit');
        if (badgeHit && isBadgeClickModifiers(e)) {
          const host = badgeHit.closest('[data-swl-host][data-swl-on]');
          if (host) {
            e.stopPropagation();
            return;
          }
        }

        if (e.target.closest('.swl-hover-overlay, ytd-video-preview')) return;
        if (!isToggleModifiers(e)) return;
        if (e.target.closest(BLOCKING_UI_SELECTOR)) return;

        // Only block propagation strictly on thumbnail hosts (never titles or buttons outside)
        const markedHost = e.target.closest('[data-swl-host], ytd-thumbnail');
        if (markedHost) {
          e.stopPropagation();
          return;
        }
        const anchor = e.target.closest(THUMB_LINK_SELECTOR);
        if (anchor) {
          const info = resolveThumbInfo(anchor);
          if (info && info.host.contains(e.target)) {
            e.stopPropagation();
          }
        }
      },
      true
    );
  }

  // ------------------------------------------------------------------ click interception
  // Capture-phase interception strictly on thumbnail regions (and the clickable corner triangle).
  // - Never intercepts middle-click (button 1), right-click (button 2), auxclick,
  //   or Ctrl / Alt / Meta clicks.
  // - In reversed mode, never intercepts Shift + Left Click so Chrome handles it natively.
  /** @type {{ videoId: string, rect: DOMRect | null, time: number, fromBadge: boolean } | null} */
  let activePress = null;

  function findClickableBadgeTarget(target) {
    if (!(target instanceof Element)) return null;
    const hit = target.closest('.swl-badge-hit');
    if (!hit) return null;
    const host = hit.closest('[data-swl-host][data-swl-on]');
    if (!host || !host.dataset.swlId) return null;
    return {
      videoId: host.dataset.swlId,
      host,
      rect: hit.getBoundingClientRect(),
      fromBadge: true,
    };
  }

  function clearActivePressSoon() {
    const snapshot = activePress;
    setTimeout(() => {
      if (activePress === snapshot) activePress = null;
    }, 50);
  }

  for (const type of ['pointerdown', 'mousedown']) {
    window.addEventListener(
      type,
      (e) => {
        if (!e.isTrusted || e.button !== 0) return;

        const badgeInfo = isBadgeClickModifiers(e) ? findClickableBadgeTarget(e.target) : null;
        if (badgeInfo) {
          activePress = {
            videoId: badgeInfo.videoId,
            rect: badgeInfo.rect,
            time: Date.now(),
            fromBadge: true,
          };
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          return;
        }

        if (!isToggleModifiers(e)) return;

        const targetInfo = findThumbTarget(e.target, e.clientX, e.clientY);
        if (!targetInfo) return;

        activePress = {
          videoId: targetInfo.videoId,
          rect: targetInfo.rect || targetInfo.host?.getBoundingClientRect?.() || null,
          time: Date.now(),
          fromBadge: false,
        };
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
      },
      true
    );
  }

  for (const type of ['pointerup', 'mouseup']) {
    window.addEventListener(
      type,
      (e) => {
        if (!e.isTrusted || e.button !== 0 || !activePress) return;
        const fresh = Date.now() - activePress.time < 1200;
        const badgeInfo = activePress.fromBadge ? findClickableBadgeTarget(e.target) : null;
        const targetInfo = badgeInfo || findThumbTarget(e.target, e.clientX, e.clientY);
        const sameTarget =
          (targetInfo && targetInfo.videoId === activePress.videoId) ||
          pointInRect(e.clientX, e.clientY, activePress.rect);
        if (fresh && sameTarget) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
        }
        clearActivePressSoon();
      },
      true
    );
  }

  window.addEventListener(
    'click',
    (e) => {
      if (!e.isTrusted || e.button !== 0) return;

      const badgeInfo = isBadgeClickModifiers(e) ? findClickableBadgeTarget(e.target) : null;
      if (badgeInfo) {
        activePress = null;
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        removeWatchLater(badgeInfo.videoId);
        return;
      }

      const targetInfo = findThumbTarget(e.target, e.clientX, e.clientY);
      const matchedPress =
        activePress &&
        Date.now() - activePress.time < 1200 &&
        ((targetInfo && targetInfo.videoId === activePress.videoId) ||
          pointInRect(e.clientX, e.clientY, activePress.rect));

      const videoId = targetInfo?.videoId || (matchedPress ? activePress.videoId : null);
      if (!videoId) {
        activePress = null;
        return;
      }

      const noOtherMods = !e.ctrlKey && !e.altKey && !e.metaKey;
      const earlyShiftRelease =
        mode === MODE_WATCH_LATER && matchedPress && !activePress.fromBadge && noOtherMods;
      const badgePressRelease = matchedPress && activePress.fromBadge && isBadgeClickModifiers(e);
      const shouldToggle =
        (isToggleModifiers(e) && noOtherMods) || earlyShiftRelease || badgePressRelease;

      const wasFromBadge = Boolean(badgePressRelease);
      activePress = null;
      if (!shouldToggle) return;

      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      if (wasFromBadge) {
        removeWatchLater(videoId);
      } else {
        toggleWatchLater(videoId);
      }
    },
    true
  );

  window.addEventListener(
    'dblclick',
    (e) => {
      if (!e.isTrusted || e.button !== 0) return;
      if (isBadgeClickModifiers(e) && findClickableBadgeTarget(e.target)) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        return;
      }
      if (!isToggleModifiers(e)) return;
      if (!findThumbTarget(e.target, e.clientX, e.clientY)) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    },
    true
  );

  // ------------------------------------------------------------------ persistent badge management
  function renderHost(host) {
    const id = host.dataset.swlId;
    if (!id) return;
    host.toggleAttribute('data-swl-on', wl.has(id));
    host.toggleAttribute('data-swl-busy', isVideoBusy(id));
  }

  function cleanupHost(host) {
    if (!host) return;
    host.removeAttribute('data-swl-host');
    host.removeAttribute('data-swl-id');
    host.removeAttribute('data-swl-href');
    host.removeAttribute('data-swl-on');
    host.removeAttribute('data-swl-busy');
    host.removeAttribute('data-swl-overlay-active');
    host.querySelector(':scope > .swl-badge-layer')?.remove();
  }

  function refreshAll() {
    for (const host of document.querySelectorAll('[data-swl-host]')) {
      renderHost(host);
    }
    syncOverlayIconState();
  }

  function refreshByVideoId(videoId) {
    for (const host of document.querySelectorAll('[data-swl-host]')) {
      if (host.dataset.swlId === videoId) renderHost(host);
    }
    if (overlayState.videoId === videoId) syncOverlayIconState();
  }

  function applyAnchorSync(anchor) {
    if (!anchor || !anchor.isConnected) {
      const oldHost = anchor && anchorToHost.get(anchor);
      if (oldHost?.isConnected) cleanupHost(oldHost);
      if (anchor) anchorToHost.delete(anchor);
      return;
    }
    const info = resolveThumbInfo(anchor);
    const prevHost = anchorToHost.get(anchor) || null;
    if (prevHost && prevHost !== info?.host) cleanupHost(prevHost);
    if (!info) {
      anchorToHost.delete(anchor);
      return;
    }
    const { host, videoId, href } = info;
    anchorToHost.set(anchor, host);
    if (!host.querySelector(':scope > .swl-badge-layer')) {
      if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
      const layer = badgeLayerTemplate.cloneNode(true);
      const br = resolveBorderRadius(host);
      if (br && br !== '0px') layer.style.borderRadius = br;
      host.appendChild(layer);
    }
    host.setAttribute('data-swl-host', '');
    if (host.dataset.swlId !== videoId) host.dataset.swlId = videoId;
    if (href && host.dataset.swlHref !== href) host.dataset.swlHref = href;
    renderHost(host);
  }

  const pendingAnchors = new Set();
  let flushScheduled = false;

  function queueAnchor(anchor) {
    if (anchor.closest('ytd-video-preview')) {
      applyAnchorSync(anchor);
      return;
    }
    pendingAnchors.add(anchor);
    if (!flushScheduled) {
      flushScheduled = true;
      requestAnimationFrame(flush);
    }
  }

  function flush() {
    flushScheduled = false;
    const work = [];

    for (const anchor of pendingAnchors) {
      if (!anchor.isConnected) {
        const oldHost = anchorToHost.get(anchor);
        if (oldHost?.isConnected) cleanupHost(oldHost);
        anchorToHost.delete(anchor);
        continue;
      }

      const info = resolveThumbInfo(anchor);
      const prevHost = anchorToHost.get(anchor) || null;
      const needsLayer = Boolean(info && !info.host.querySelector(':scope > .swl-badge-layer'));
      const isStatic = needsLayer && getComputedStyle(info.host).position === 'static';
      const borderRadius = needsLayer ? resolveBorderRadius(info.host) : null;
      work.push({ anchor, info, prevHost, needsLayer, isStatic, borderRadius });
    }
    pendingAnchors.clear();

    for (const { anchor, info, prevHost, needsLayer, isStatic, borderRadius } of work) {
      if (prevHost && prevHost !== info?.host) cleanupHost(prevHost);
      if (!info) {
        anchorToHost.delete(anchor);
        continue;
      }
      const { host, videoId, href } = info;
      anchorToHost.set(anchor, host);

      if (needsLayer) {
        if (isStatic) host.style.position = 'relative';
        const layer = badgeLayerTemplate.cloneNode(true);
        if (borderRadius && borderRadius !== '0px') layer.style.borderRadius = borderRadius;
        host.appendChild(layer);
      }

      host.setAttribute('data-swl-host', '');
      if (host.dataset.swlId !== videoId) host.dataset.swlId = videoId;
      if (href && host.dataset.swlHref !== href) host.dataset.swlHref = href;
      renderHost(host);
    }
  }

  const observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'attributes') {
        const t = r.target;
        if (t instanceof HTMLAnchorElement) {
          if (t.matches(THUMB_LINK_SELECTOR) || anchorToHost.has(t)) {
            queueAnchor(t);
          }
        }
        continue;
      }

      for (const node of r.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (
          node.classList.contains('swl-badge-layer') ||
          node.classList.contains('swl-hover-overlay') ||
          node.classList.contains('swl-toast-stack') ||
          node.classList.contains('swl-toast')
        ) {
          continue;
        }
        const ancestorLink = node.closest(THUMB_LINK_SELECTOR);
        if (ancestorLink) queueAnchor(ancestorLink);
        if (node.firstElementChild) {
          for (const link of node.querySelectorAll(THUMB_LINK_SELECTOR)) {
            queueAnchor(link);
          }
        }
      }
    }
  });

  // ------------------------------------------------------------------ bootstrap
  (async () => {
    await Promise.all([loadSettings(), loadCache()]);

    for (const anchor of document.querySelectorAll(THUMB_LINK_SELECTOR)) {
      queueAnchor(anchor);
    }

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['href'],
    });

    const currentAccount = await accountKey(await getConfig());
    if (currentAccount !== account) {
      account = currentAccount;
      wl = new Map();
      syncedAt = 0;
      refreshAll();
    }
    syncIfStale();

    document.addEventListener('yt-navigate-finish', () => {
      hideHoverOverlay();
      syncIfStale();
      for (const anchor of document.querySelectorAll(THUMB_LINK_SELECTOR)) {
        queueAnchor(anchor);
      }
    });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) syncIfStale();
    });
  })();
})();
