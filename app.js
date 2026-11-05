// nogGD — OpenGD Remastered Web Shell
const ASSETS_URLS = [
  '/resources_assets.zip',
  'https://raw.githubusercontent.com/nagatesz/nogGD/main/public/resources_assets.zip',
  'https://cdn.jsdelivr.net/gh/nagatesz/nogGD@main/public/resources_assets.zip'
];

const AUDIO_URLS = [
  '/resources_audio.zip',
  'https://raw.githubusercontent.com/nagatesz/nogGD/main/public/resources_audio.zip',
  'https://cdn.jsdelivr.net/gh/nagatesz/nogGD@main/public/resources_audio.zip'
];

const RESOURCES_VERSION = 'resources-v5';

const game = document.querySelector('#game');
const statusText = document.querySelector('#status');
const statusDot = document.querySelector('#status-dot');
const welcome = document.querySelector('#welcome');
const resourceInput = document.querySelector('#resources');
const levelInput = document.querySelector('#levels');
const progressBar = document.querySelector('#dl-progress');
const progressWrap = document.querySelector('#dl-progress-wrap');
const dlLabel = document.querySelector('#dl-label');

function setStatus(message, state = 'ready') {
  if (statusText) statusText.textContent = message;
  if (statusDot) statusDot.className = `status-dot ${state}`;
}

function setProgress(pct, label) {
  if (progressBar) progressBar.style.width = `${Math.min(100, Math.max(0, pct))}%`;
  if (progressWrap) progressWrap.style.display = pct >= 100 ? 'none' : 'block';
  if (label && dlLabel) dlLabel.textContent = label;
}

document.querySelector('#start')?.addEventListener('click', () => resourceInput.click());
document.querySelector('#fullscreen').addEventListener('click', async () => {
  const target = document.querySelector('.game-frame');
  if (!document.fullscreenElement) await target.requestFullscreen();
  else await document.exitFullscreen();
});

resourceInput.addEventListener('change', () => {
  const files = Array.from(resourceInput.files || []);
  if (!files.length) return;
  welcome.classList.add('hidden');
  setStatus(`Copying ${files.length.toLocaleString()} resource files…`, 'busy');
  game.contentWindow.postMessage({type: 'import-resources', files}, location.origin);
});

levelInput.addEventListener('change', () => {
  const files = Array.from(levelInput.files || []);
  if (!files.length) return;
  setStatus('Reading local level data…', 'busy');
  game.contentWindow.postMessage({type: 'import-level-files', files}, location.origin);
});

window.addEventListener('message', event => {
  if (event.origin !== location.origin || event.source !== game.contentWindow) return;
  const message = event.data || {};
  if (message.type === 'noggd-status') {
    setStatus(message.text || 'Ready', message.state || 'ready');
    if (message.gameReady) {
      welcome.classList.add('hidden');
      if (progressWrap) progressWrap.style.display = 'none';
    }
  }
  if (message.type === 'noggd-ready-for-resources') {
    autoLoadResources();
  }
});

game.addEventListener('load', () => {
  setStatus('Game runtime loaded. Preparing resources…', 'busy');
});

async function downloadBuffer(urls, labelPrefix, onProgress) {
  let lastError = null;
  for (const url of urls) {
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const total = parseInt(resp.headers.get('content-length') || '0', 10);
      let loaded = 0;
      const reader = resp.body.getReader();
      const chunks = [];
      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.length;
        if (onProgress) onProgress(loaded, total);
      }
      const blob = new Blob(chunks);
      return await blob.arrayBuffer();
    } catch (err) {
      console.warn(`[nogGD] download failed from ${url}:`, err);
      lastError = err;
    }
  }
  throw lastError || new Error(`All sources failed for ${labelPrefix}`);
}

let autoLoadStarted = false;
async function autoLoadResources() {
  if (autoLoadStarted) return;
  autoLoadStarted = true;

  const cached = await isCached();
  if (cached) {
    setStatus('Stored resources found — launching game…', 'busy');
    welcome.classList.add('hidden');
    game.contentWindow.postMessage({type: 'trigger-cached-resources'}, location.origin);
    return;
  }

  welcome.classList.add('hidden');
  if (progressWrap) progressWrap.style.display = 'block';

  try {
    // 1. Download game assets (UI, textures, icons, levels)
    setStatus('Downloading game assets (first load only)…', 'busy');
    const assetsBuffer = await downloadBuffer(ASSETS_URLS, 'assets', (loaded, total) => {
      const pct = total ? Math.round((loaded / total) * 100) : 0;
      const mb = (loaded / 1048576).toFixed(1);
      const totalMb = total ? (total / 1048576).toFixed(1) : '?';
      setProgress(pct, `Downloading game textures… ${pct}% (${mb} / ${totalMb} MB)`);
      setStatus(`Downloading assets… ${pct}%`, 'busy');
    });

    setProgress(100, 'Unpacking game textures…');
    setStatus('Unpacking game textures…', 'busy');
    game.contentWindow.postMessage({type: 'import-resources-zip', buffer: assetsBuffer}, location.origin, [assetsBuffer]);

    await markCached();

    // 2. Download audio in background
    setTimeout(async () => {
      try {
        console.log('[nogGD] Starting background audio download…');
        const audioBuffer = await downloadBuffer(AUDIO_URLS, 'audio', null);
        console.log('[nogGD] Audio downloaded, importing…');
        game.contentWindow.postMessage({type: 'import-resources-zip', buffer: audioBuffer}, location.origin, [audioBuffer]);
      } catch (err) {
        console.warn('[nogGD] Background audio download error:', err);
      }
    }, 2000);

  } catch (err) {
    if (progressWrap) progressWrap.style.display = 'none';
    setStatus(`Auto-download failed: ${err.message}. Choose Resources folder to load manually.`, 'busy');
    welcome.classList.remove('hidden');
    autoLoadStarted = false;
  }
}

async function isCached() {
  try {
    const db = await openDb();
    return new Promise(res => {
      const tx = db.transaction('meta', 'readonly');
      const req = tx.objectStore('meta').get('resources_version');
      req.onsuccess = () => res(req.result === RESOURCES_VERSION);
      req.onerror = () => res(false);
    });
  } catch { return false; }
}

async function markCached() {
  try {
    const db = await openDb();
    return new Promise((res, rej) => {
      const tx = db.transaction('meta', 'readwrite');
      tx.objectStore('meta').put(RESOURCES_VERSION, 'resources_version');
      tx.oncomplete = res;
      tx.onerror = rej;
    });
  } catch {}
}

function openDb() {
  return new Promise((res, rej) => {
    const req = indexedDB.open('noggd', 1);
    req.onupgradeneeded = e => {
      if (!e.target.result.objectStoreNames.contains('meta')) {
        e.target.result.createObjectStore('meta');
      }
    };
    req.onsuccess = e => res(e.target.result);
    req.onerror = rej;
  });
}
