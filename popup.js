(() => {
  'use strict';

  const SETTING_KEY = 'shiftClickAction';
  const MODE_WATCH_LATER = 'watch_later';
  const MODE_OPEN_VIDEO = 'open_video';

  const toggle = document.getElementById('invertToggle');
  const shiftActionEl = document.getElementById('shiftAction');
  const normalActionEl = document.getElementById('normalAction');

  function renderMapping(inverted) {
    toggle.checked = inverted;
    if (inverted) {
      shiftActionEl.textContent = 'Open Video';
      shiftActionEl.removeAttribute('data-watch-later');
      normalActionEl.textContent = 'Watch Later';
      normalActionEl.setAttribute('data-watch-later', 'true');
    } else {
      shiftActionEl.textContent = 'Watch Later';
      shiftActionEl.setAttribute('data-watch-later', 'true');
      normalActionEl.textContent = 'Open Video';
      normalActionEl.removeAttribute('data-watch-later');
    }
  }

  chrome.storage.sync.get({ [SETTING_KEY]: MODE_WATCH_LATER }, (data) => {
    renderMapping(data[SETTING_KEY] === MODE_OPEN_VIDEO);
  });

  toggle.addEventListener('change', () => {
    const inverted = toggle.checked;
    renderMapping(inverted);
    chrome.storage.sync.set({
      [SETTING_KEY]: inverted ? MODE_OPEN_VIDEO : MODE_WATCH_LATER,
    });
  });
})();
