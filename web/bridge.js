(() => {
  if (typeof window === 'undefined') return;
  document.documentElement.style.cssText = 'width:100%;height:100%;overflow:hidden;background:#080b11';
  document.body.style.cssText = 'width:100%;height:100%;margin:0;overflow:hidden;background:#080b11';
  const gameBorder = document.querySelector('.emscripten_border');
  if (gameBorder) gameBorder.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;margin:0;padding:0;border:0;overflow:hidden;background:#080b11';
  const gameCanvas = document.querySelector('#canvas');
  if (gameCanvas) gameCanvas.style.cssText = 'display:block;width:100%;height:100%;margin:0;padding:0;border:0;background:#080b11';
  const pointerLockToggle = document.querySelector('#pointerLock');
  if (pointerLockToggle) pointerLockToggle.checked = false;
  document.querySelector('#status')?.style.setProperty('display', 'none');
  document.querySelector('#progress')?.style.setProperty('display', 'none');
  document.querySelector('#output')?.style.setProperty('display', 'none');
  document.querySelectorAll('body > .emscripten').forEach(element => element.style.setProperty('display', 'none'));
  window.addEventListener('error', event => {
    console.error('[nogGD runtime]', event.message, event.filename, event.lineno, event.error && event.error.stack);
  }, true);
  const postStatus = (text, state = 'ready', extra = {}) => {
    if (window.parent !== window) window.parent.postMessage({type: 'noggd-status', text, state, ...extra}, window.location.origin);
  };
  const waitForFs = async () => {
    if (typeof FS === 'undefined' || typeof IDBFS === 'undefined') throw new Error('Browser storage did not initialize. Reload this page and retry.');
  };
  let syncPromise = null;
  let localImportInProgress = false;
  const syncFs = () => {
    if (syncPromise) return syncPromise;
    syncPromise = new Promise((resolve, reject) => {
      FS.syncfs(false, error => error ? reject(error) : resolve());
    }).finally(() => { syncPromise = null; });
    return syncPromise;
  };
  const validRelativePath = path => path.split(/[\\/]+/).filter(Boolean).every(part => part !== '.' && part !== '..');

  Module.postRun = Module.postRun || [];
  Module.postRun.push(() => {
    const root = '/axmolPersistPath/GeometryDash/Resources';
    const required = [`${root}/game_bg_01_001-hd.png`, `${root}/GJ_LaunchSheet-hd.png`, `${root}/icons/player_01-hd.png`];
    if (required.every(path => FS.analyzePath(path).exists)) {
      Module.ccall('opengd_web_resources_ready', null, [], []);
      postStatus('Game ready. Your locally stored resources were loaded.', 'ready', {gameReady: true});
    } else {
      // Signal parent to start auto-download
      if (window.parent !== window) window.parent.postMessage({type: 'noggd-ready-for-resources'}, window.location.origin);
      postStatus('Fetching resources…', 'busy');
    }
    setInterval(() => {
      if (localImportInProgress || syncPromise) return;
      syncFs().catch(error => postStatus(`Browser save sync failed: ${error.message || error}`, 'busy'));
    }, 4000);
  });

  async function importResources(files) {
    await waitForFs();
    if (localImportInProgress) throw new Error('Wait for the current local import to finish.');
    localImportInProgress = true;
    try {
    const root = '/axmolPersistPath/GeometryDash/Resources';
    FS.mkdirTree(root);
    const all = Array.from(files);
    let copiedBytes = 0;
    let accepted = 0;
    const totalBytes = all.reduce((sum, file) => /-uhd\./i.test(file.name) ? sum : sum + file.size, 0);
    for (let i = 0; i < all.length; i++) {
      const file = all[i];
      const relative = String(file.webkitRelativePath || file.name || '').replace(/\\/g, '/');
      const parts = relative.split('/').filter(Boolean);
      const resourceIndex = parts.findIndex(part => part.toLowerCase() === 'resources');
      const tail = resourceIndex >= 0 ? parts.slice(resourceIndex + 1) : parts;
      const path = tail.join('/');
      if (!path || !validRelativePath(path)) continue;
      if (/-uhd\./i.test(path)) continue;
      const target = `${root}/${path}`;
      FS.mkdirTree(target.slice(0, target.lastIndexOf('/')));
      let contents = new Uint8Array(await file.arrayBuffer());
      if (path.toLowerCase().endsWith('chatfont-hd.fnt')) {
        const fontText = new TextDecoder().decode(contents);
        if (fontText.startsWith('info face')) {
          // Axmol's BMFont parser uses a fixed 512-byte line buffer. This
          // unused trailing field can exceed it in Geometry Dash's chat font.
          const compatibleFont = fontText.replace(/[ \t]+letter=.*$/gm, '');
          contents = new TextEncoder().encode(compatibleFont);
        }
      }
      FS.writeFile(target, contents);
      copiedBytes += file.size;
      accepted++;
      if (i % 80 === 0 || i === all.length - 1) {
        const progress = totalBytes ? Math.min(100, Math.floor(copiedBytes / totalBytes * 100)) : 0;
        postStatus(`Saving game resources locally… ${progress}% (${accepted.toLocaleString()} files)`, 'busy');
      }
    }
    const required = [
      `${root}/game_bg_01_001-hd.png`,
      `${root}/GJ_LaunchSheet-hd.png`,
      `${root}/GJ_GameSheet03-hd.png`,
      `${root}/icons/player_01-hd.png`
    ];
    if (!required[0] || !FS.analyzePath(required[0]).exists || !FS.analyzePath(required[1]).exists
      || !FS.analyzePath(required[2]).exists || !FS.analyzePath(required[3]).exists) {
      throw new Error('That folder did not contain the Geometry Dash Resources files. Choose the Resources folder itself.');
    }
    await syncFs();
    Module.ccall('opengd_web_resources_ready', null, [], []);
    postStatus('Game resources are ready. HD assets are stored in this browser.', 'ready', {gameReady: true});
    } finally {
      localImportInProgress = false;
    }
  }

  function decodeSaveXml(rawBytes) {
    const bytes = new Uint8Array(rawBytes);
    const direct = new TextDecoder().decode(bytes);
    if (direct.includes('<plist') || direct.includes('<?xml')) return Promise.resolve(direct);
    for (let i = 0; i < bytes.length; i++) bytes[i] ^= 11;
    let encoded = new TextDecoder().decode(bytes).trim().replace(/-/g, '+').replace(/_/g, '/');
    encoded += '='.repeat((4 - encoded.length % 4) % 4);
    const binary = atob(encoded);
    const gzip = Uint8Array.from(binary, character => character.charCodeAt(0));
    return new Response(new Blob([gzip]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
  }

  function valuesFromSaveXml(xmlText) {
    const document = new DOMParser().parseFromString(xmlText, 'application/xml');
    if (document.querySelector('parsererror')) throw new Error('The selected save file is not valid Geometry Dash XML.');
    const levels = [];
    for (const dict of document.querySelectorAll('dict')) {
      const children = Array.from(dict.children);
      const fields = new Map();
      for (let i = 0; i + 1 < children.length; i++) {
        if (children[i].tagName !== 'key') continue;
        const key = children[i].textContent;
        const value = children[++i];
        if (value && ['string', 'integer', 'real'].includes(value.tagName)) fields.set(key, value.textContent || '');
      }
      const levelData = fields.get('k4');
      if (!levelData) continue;
      levels.push({
        name: fields.get('k2') || `Imported level ${levels.length + 1}`,
        description: '',
        levelData,
        length: Number(fields.get('k5') || 0),
        objects: Number(fields.get('k6') || 0)
      });
    }
    return levels;
  }

  async function importLevelFiles(files) {
    if (localImportInProgress) throw new Error('Wait for the current local import to finish.');
    localImportInProgress = true;
    try {
    const levels = [];
    for (const file of Array.from(files)) {
      const name = file.name.replace(/\.(dat|gmd|txt|xml)$/i, '') || 'Imported level';
      if (/\.dat$/i.test(file.name)) {
        const xml = await decodeSaveXml(await file.arrayBuffer());
        levels.push(...valuesFromSaveXml(xml));
      } else if (/\.(gmd|txt)$/i.test(file.name)) {
        const levelData = (await file.text()).trim();
        if (levelData) levels.push({name, levelData, description: ''});
      } else {
        const text = await file.text();
        levels.push(...valuesFromSaveXml(text));
      }
    }
    if (!levels.length) throw new Error('No playable custom levels were found in the selected file.');
    const imported = Module.ccall('opengd_import_local_levels', 'number', ['string'], [JSON.stringify({levels})]);
    if (!imported) throw new Error('The selected levels could not be decoded.');
    await syncFs();
    postStatus(`Imported ${imported} custom level${imported === 1 ? '' : 's'}. Open Saved Levels in game to play them.`, 'ready');
    } finally {
      localImportInProgress = false;
    }
  }

  async function importResourcesZip(buffer) {
    await waitForFs();
    if (localImportInProgress) throw new Error('Wait for the current import to finish.');
    localImportInProgress = true;
    try {
      const root = '/axmolPersistPath/GeometryDash/Resources';
      FS.mkdirTree(root);
      // Use native DecompressionStream + manual ZIP parsing (no deps)
      const bytes = new Uint8Array(buffer);
      const entries = parseZip(bytes);
      let written = 0;
      for (const entry of entries) {
        if (entry.isDir) continue;
        // Strip leading "Resources/" prefix if present
        const parts = entry.name.replace(/\\/g, '/').split('/').filter(Boolean);
        const idx = parts.findIndex(p => p.toLowerCase() === 'resources');
        const tail = idx >= 0 ? parts.slice(idx + 1) : parts;
        const relPath = tail.join('/');
        if (!relPath || !validRelativePath(relPath)) continue;
        if (/-uhd\./i.test(relPath)) continue;
        let data = entry.data;
        if (relPath.toLowerCase().endsWith('chatfont-hd.fnt')) {
          const text = new TextDecoder().decode(data).replace(/[ \t]+letter=.*$/gm, '');
          data = new TextEncoder().encode(text);
        }
        const target = `${root}/${relPath}`;
        FS.mkdirTree(target.slice(0, target.lastIndexOf('/')));
        FS.writeFile(target, data);
        written++;
        if (written % 50 === 0) postStatus(`Unpacking resources… ${written} files written`, 'busy');
      }
      await syncFs();
      Module.ccall('opengd_web_resources_ready', null, [], []);
      postStatus('Resources loaded. Starting game…', 'ready', {gameReady: true});    } finally {
      localImportInProgress = false;
    }
  }

  // Minimal ZIP parser — handles Deflate and Stored methods, no deps
  function parseZip(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const entries = [];
    let i = 0;
    while (i + 4 <= bytes.length) {
      const sig = view.getUint32(i, true);
      if (sig !== 0x04034b50) { i++; continue; }
      const method    = view.getUint16(i + 8, true);
      const compSz    = view.getUint32(i + 18, true);
      const uncompSz  = view.getUint32(i + 22, true);
      const fnLen     = view.getUint16(i + 26, true);
      const extraLen  = view.getUint16(i + 28, true);
      const name      = new TextDecoder().decode(bytes.subarray(i + 30, i + 30 + fnLen));
      const dataStart = i + 30 + fnLen + extraLen;
      const compData  = bytes.subarray(dataStart, dataStart + compSz);
      const isDir     = name.endsWith('/') || name.endsWith('\\');
      let data;
      if (!isDir) {
        if (method === 0) {
          data = compData.slice();
        } else if (method === 8) {
          // Deflate — wrap in gzip envelope and use DecompressionStream sync-ish via TextDecoder trick
          // Build a raw deflate → use pako-free approach: create a minimal ZLIB header
          const zlib = new Uint8Array(compSz + 2);
          zlib[0] = 0x78; zlib[1] = 0x9c;
          zlib.set(compData, 2);
          // Can't use DecompressionStream synchronously; store for async inflate
          data = {deflate: compData, uncompSz};
        } else {
          data = compData.slice(); // unsupported method, store raw
        }
      }
      entries.push({name, isDir, data});
      i = dataStart + compSz;
    }
    return entries;
  }

  // Inflate deflate entries async using DecompressionStream('deflate-raw')
  // ZIP method 8 is raw deflate — directly supported without any wrapper
  async function inflateEntries(entries) {
    for (const e of entries) {
      if (e.isDir || !e.data || !e.data.deflate) continue;
      try {
        const raw = e.data.deflate;
        const ds = new DecompressionStream('deflate-raw');
        const writer = ds.writable.getWriter();
        const reader = ds.readable.getReader();
        writer.write(raw);
        writer.close();
        const chunks = [];
        while (true) {
          const {done, value} = await reader.read();
          if (done) break;
          chunks.push(value);
        }
        const total = chunks.reduce((s, c) => s + c.length, 0);
        const out = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) { out.set(c, off); off += c.length; }
        e.data = out;
      } catch (err) {
        console.error('[nogGD] deflate failed for', e.name, err);
        e.data = null; // skip writing corrupt file
      }
    }
  }

  async function importResourcesZipAsync(buffer) {
    await waitForFs();
    if (localImportInProgress) throw new Error('Wait for the current import to finish.');
    localImportInProgress = true;
    try {
      const root = '/axmolPersistPath/GeometryDash/Resources';
      FS.mkdirTree(root);
      const bytes = new Uint8Array(buffer);
      const entries = parseZip(bytes);
      postStatus(`Unpacking ${entries.length} files…`, 'busy');
      await inflateEntries(entries);
      let written = 0;
      for (const entry of entries) {
        if (entry.isDir || !entry.data) continue;
        const parts = entry.name.replace(/\\/g, '/').split('/').filter(Boolean);
        const idx = parts.findIndex(p => p.toLowerCase() === 'resources');
        const tail = idx >= 0 ? parts.slice(idx + 1) : parts;
        const relPath = tail.join('/');
        if (!relPath || !validRelativePath(relPath)) continue;
        if (/-uhd\./i.test(relPath)) continue;
        let data = entry.data instanceof Uint8Array ? entry.data : new Uint8Array(entry.data);
        if (relPath.toLowerCase().endsWith('chatfont-hd.fnt')) {
          const text = new TextDecoder().decode(data).replace(/[ \t]+letter=.*$/gm, '');
          data = new TextEncoder().encode(text);
        }
        const target = `${root}/${relPath}`;
        FS.mkdirTree(target.slice(0, target.lastIndexOf('/')));
        FS.writeFile(target, data);
        written++;
        if (written % 100 === 0) postStatus(`Unpacking… ${written} / ${entries.length} files`, 'busy');
      }
      await syncFs();
      Module.ccall('opengd_web_resources_ready', null, [], []);
      postStatus('Resources loaded. Starting game…', 'ready', {gameReady: true});    } finally {
      localImportInProgress = false;
    }
  }

  window.addEventListener('message', async event => {
    if (event.origin !== window.location.origin || event.source !== window.parent) return;
    const message = event.data || {};
    try {
      if (message.type === 'import-resources') await importResources(message.files || []);
      if (message.type === 'import-level-files') await importLevelFiles(message.files || []);
      if (message.type === 'import-resources-zip') await importResourcesZipAsync(message.buffer);
      if (message.type === 'trigger-cached-resources') {
        await waitForFs();
        Module.ccall('opengd_web_resources_ready', null, [], []);
        postStatus('Resources loaded from cache. Starting game…', 'ready', {gameReady: true});
      }
    } catch (error) {
      postStatus(error && error.message ? error.message : String(error), 'busy');
    }
  });
})();
