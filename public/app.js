// nogGD — auto-fetches OpenGD resources from GitHub Release on first load
const RESOURCES_URL = '/api/resources';
const RESOURCES_VERSION = 'resources-v3';

const game = document.querySelector('#game');
const statusText = document.querySelector('#status');
const statusDot = document.querySelector('#status-dot');
const welcome = document.querySelector('#welcome');
const resourceInput = document.querySelector('#resources');
const levelInput = document.querySelector('#levels');
const progressBar = document.querySelector('#dl-progress');
const progressWrap = document.querySelector('#dl-progress-wrap');

function setStatus(message, state = 'ready') {
  statusText.textContent = message;
  statusDot.className = `status-dot ${state}`;
}

function setProgress(pct) {
  if (progressBar) progressBar.style.width = `${Math.min(100, pct)}%`;
  if (progressWrap) progressWrap.style.display = pct >= 100 ? 'none' : 'block';
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
    if (message.gameReady) welcome.classList.add('hidden');
  }
  if (message.type === 'noggd-ready-for-resources') {
    autoLoadResources();
  }
});

game.addEventListener('load', () => {
  setStatus('Game runtime loaded. Fetching resources…', 'busy');
});

// --- Auto resource loader ---
async function autoLoadResources() {
  // Check if resources already cached in this browser via IDB flag
  const cached = await isCached();
  if (cached) {
    setStatus('Stored resources found — starting game…', 'busy');
    welcome.classList.add('hidden');
    game.contentWindow.postMessage({type: 'trigger-cached-resources'}, location.origin);
    return;
  }

  setStatus('Downloading OpenGD resources (first load only)…', 'busy');
  if (progressWrap) progressWrap.style.display = 'block';
  welcome.classList.add('hidden');

  try {
    const resp = await fetch(RESOURCES_URL);
    if (!resp.ok) throw new Error(`Download failed: ${resp.status}`);
    const total = parseInt(resp.headers.get('content-length') || '0', 10);
    let loaded = 0;

    // Stream the body, track progress
    const reader = resp.body.getReader();
    const chunks = [];
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      if (total) setProgress((loaded / total) * 100);
      setStatus(`Downloading resources… ${total ? Math.round(loaded/total*100)+'%' : Math.round(loaded/1048576)+'MB'}`, 'busy');
    }

    setProgress(100);
    setStatus('Unpacking resources…', 'busy');

    const blob = new Blob(chunks);
    const arrayBuffer = await blob.arrayBuffer();

    // Send raw zip bytes to the game iframe for extraction into WASM FS
    game.contentWindow.postMessage({type: 'import-resources-zip', buffer: arrayBuffer}, location.origin, [arrayBuffer]);
    await markCached();
  } catch (err) {
    setProgress(100);
    setStatus(`Auto-download failed: ${err.message}. Use "Load game resources" to load manually.`, 'busy');
    welcome.classList.remove('hidden');
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
    req.onupgradeneeded = e => e.target.result.createObjectStore('meta');
    req.onsuccess = e => res(e.target.result);
    req.onerror = rej;
  });
}
