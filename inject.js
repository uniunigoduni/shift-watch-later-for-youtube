// Runs in the page's MAIN world at document_start.
// Bridges YouTube's InnerTube config (window.ytcfg) to content.js and
// observes native Watch Later playlist edits so state stays in sync.
(() => {
  'use strict';

  const TAG = '__swl__';
  const post = (msg) => {
    try {
      window.postMessage({ [TAG]: msg.type, ...msg }, location.origin);
    } catch {
      // Ignore cross-origin or detached frame errors.
    }
  };

  // --- 1. Respond to InnerTube config requests from content.js ---
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.[TAG] !== 'cfg?') return;
    const yc = window.ytcfg;
    const get = (k) => (yc?.get ? yc.get(k) : yc?.data_?.[k]);
    const context = get('INNERTUBE_CONTEXT');
    post({
      type: 'cfg',
      cfg: context
        ? {
            context,
            clientVersion: get('INNERTUBE_CLIENT_VERSION') || context.client?.clientVersion || '',
            sessionIndex: get('SESSION_INDEX') ?? 0,
            pageId: get('DELEGATED_SESSION_ID') || null,
          }
        : null,
    });
  });

  // --- 2. Observe native Watch Later edits made through YouTube's UI ---
  function extractAddedSetIds(respJson) {
    const map = {};
    const results = respJson?.playlistEditResults;
    if (!Array.isArray(results)) return map;
    for (const item of results) {
      const added = item?.playlistEditVideoAddedResultData;
      if (added?.videoId && added?.setVideoId) {
        map[added.videoId] = added.setVideoId;
      }
    }
    return map;
  }

  function reportEdit(bodyText, respJson) {
    let body;
    try {
      body = JSON.parse(bodyText);
    } catch {
      return;
    }
    if (body?.playlistId !== 'WL' || !Array.isArray(body.actions)) return;

    const added = [];
    const removed = [];
    let unknown = false;

    for (const action of body.actions) {
      if (action?.addedVideoId) {
        added.push(action.addedVideoId);
      } else if (action?.removedVideoId) {
        removed.push(action.removedVideoId);
      } else {
        unknown = true; // e.g., ACTION_REMOVE_VIDEO with setVideoId only
      }
    }

    const setIds = extractAddedSetIds(respJson);
    post({ type: 'edit', added, removed, setIds, unknown });
  }

  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      let bodyPromise = null;
      try {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input?.url || '';
        if (url.includes('/youtubei/v1/') && url.includes('edit_playlist')) {
          if (typeof init?.body === 'string') {
            bodyPromise = Promise.resolve(init.body);
          } else if (input instanceof Request) {
            bodyPromise = input.clone().text();
          }
        }
      } catch {
        // Never interfere with YouTube's own fetch.
      }

      const resPromise = origFetch.apply(this, arguments);
      if (bodyPromise) {
        resPromise.then(
          (res) => {
            if (!res?.ok) return;
            const jsonPromise = res
              .clone()
              .json()
              .catch(() => null);
            Promise.all([bodyPromise, jsonPromise]).then(
              ([bodyText, respJson]) => reportEdit(bodyText, respJson),
              () => {}
            );
          },
          () => {}
        );
      }
      return resPromise;
    };
  }
})();
