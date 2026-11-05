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
    if (window.parent !== window) {
      window.parent.postMessage({type: 'noggd-status', text, state, ...extra}, window.location.origin);
    }
  };

  const waitForFs = async () => {
    if (typeof FS === 'undefined' || typeof IDBFS === 'undefined') {
      throw new Error('Browser storage did not initialize. Reload this page and retry.');
    }
  };

  let syncInProgress = false;
  const syncFs = () => {
    if (syncInProgress) return Promise.resolve();
    syncInProgress = true;
    return new Promise((resolve, reject) => {
      FS.syncfs(false, err => {
        syncInProgress = false;
        if (err) reject(err);
        else resolve();
      });
    });
  };

  const validRelativePath = path => path.split(/[\\/]+/).filter(Boolean).every(part => part !== '.' && part !== '..');

  function checkGameReady() {
    const root = '/axmolPersistPath/GeometryDash/Resources';
    const required = [
      `${root}/game_bg_01_001-hd.png`,
      `${root}/GJ_LaunchSheet-hd.png`,
      `${root}/icons/player_01-hd.png`
    ];
    const exists = required.every(path => {
      try { return FS.analyzePath(path).exists; } catch { return false; }
    });
    if (exists) {
      Module.ccall('opengd_web_resources_ready', null, [], []);
      postStatus('Game ready.', 'ready', {gameReady: true});
      return true;
    }
    return false;
  }

  let localImportInProgress = false;

  Module.postRun = Module.postRun || [];
  Module.postRun.push(() => {
    if (!checkGameReady()) {
      if (window.parent !== window) {
        window.parent.postMessage({type: 'noggd-ready-for-resources'}, window.location.origin);
      }
      postStatus('Game runtime ready. Fetching resources…', 'busy');
    }

    setInterval(() => {
      if (localImportInProgress || syncInProgress) return;
      syncFs().catch(err => console.warn('[nogGD] periodic sync:', err));
    }, 5000);
  });

  // Central directory ZIP parser
  function parseZip(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const len = bytes.length;

    let eocd = -1;
    for (let i = len - 22; i >= Math.max(0, len - 65558); i--) {
      if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd === -1) return [];

    const totalEntries = view.getUint16(eocd + 10, true);
    let cdPos = view.getUint32(eocd + 16, true);

    const entries = [];
    for (let e = 0; e < totalEntries; e++) {
      if (view.getUint32(cdPos, true) !== 0x02014b50) break;
      const method     = view.getUint16(cdPos + 10, true);
      const compSz     = view.getUint32(cdPos + 20, true);
      const uncompSz   = view.getUint32(cdPos + 24, true);
      const fnLen      = view.getUint16(cdPos + 28, true);
      const extraLen   = view.getUint16(cdPos + 30, true);
      const commentLen = view.getUint16(cdPos + 32, true);
      const lhOffset   = view.getUint32(cdPos + 42, true);
      const name       = new TextDecoder().decode(bytes.subarray(cdPos + 46, cdPos + 46 + fnLen));
      cdPos += 46 + fnLen + extraLen + commentLen;

      const isDir = name.endsWith('/') || name.endsWith('\\');
      if (isDir || compSz === 0) continue;

      const lfFnLen    = view.getUint16(lhOffset + 26, true);
      const lfExtraLen = view.getUint16(lhOffset + 28, true);
      const dataStart  = lhOffset + 30 + lfFnLen + lfExtraLen;
      const compData   = bytes.slice(dataStart, dataStart + compSz);

      entries.push({name, method, compData, uncompSz});
    }
    return entries;
  }

  async function decompressDeflate(raw, uncompSz) {
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
    return out;
  }

  async function importResourcesZipAsync(buffer) {
    await waitForFs();
    if (localImportInProgress) throw new Error('Wait for the current import to finish.');
    localImportInProgress = true;
    try {
      const root = '/axmolPersistPath/GeometryDash/Resources';
      const createdDirs = new Set();
      createdDirs.add(root);
      FS.mkdirTree(root);

      const bytes = new Uint8Array(buffer);
      const entries = parseZip(bytes);
      postStatus(`Unpacking ${entries.length.toLocaleString()} files…`, 'busy');

      let written = 0;
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const parts = entry.name.replace(/\\/g, '/').split('/').filter(Boolean);
        const idx = parts.findIndex(p => p.toLowerCase() === 'resources');
        const tail = idx >= 0 ? parts.slice(idx + 1) : parts;
        const relPath = tail.join('/');
        if (!relPath || !validRelativePath(relPath)) continue;
        if (/-uhd\./i.test(relPath)) continue;

        let data;
        if (entry.method === 0) {
          data = entry.compData;
        } else if (entry.method === 8) {
          try {
            data = await decompressDeflate(entry.compData, entry.uncompSz);
          } catch (err) {
            console.error('[nogGD] deflate failed for', relPath, err);
            continue;
          }
        } else {
          continue;
        }

        if (relPath.toLowerCase().endsWith('chatfont-hd.fnt')) {
          const text = new TextDecoder().decode(data).replace(/[ \t]+letter=.*$/gm, '');
          data = new TextEncoder().encode(text);
        }

        const target = `${root}/${relPath}`;
        const parentDir = target.slice(0, target.lastIndexOf('/'));
        if (!createdDirs.has(parentDir)) {
          FS.mkdirTree(parentDir);
          createdDirs.add(parentDir);
        }

        FS.writeFile(target, data);
        written++;

        if (written % 200 === 0 || i === entries.length - 1) {
          const pct = Math.round((i / entries.length) * 100);
          postStatus(`Writing files… ${pct}% (${written}/${entries.length})`, 'busy');
        }
      }

      await syncFs();
      checkGameReady();
    } finally {
      localImportInProgress = false;
    }
  }

  async function importResources(files) {
    await waitForFs();
    if (localImportInProgress) throw new Error('Wait for the current local import to finish.');
    localImportInProgress = true;
    try {
      const root = '/axmolPersistPath/GeometryDash/Resources';
      const createdDirs = new Set();
      createdDirs.add(root);
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
        const parentDir = target.slice(0, target.lastIndexOf('/'));
        if (!createdDirs.has(parentDir)) {
          FS.mkdirTree(parentDir);
          createdDirs.add(parentDir);
        }

        let contents = new Uint8Array(await file.arrayBuffer());
        if (path.toLowerCase().endsWith('chatfont-hd.fnt')) {
          const fontText = new TextDecoder().decode(contents);
          if (fontText.startsWith('info face')) {
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

      await syncFs();
      checkGameReady();
    } finally {
      localImportInProgress = false;
    }
  }

  async function decodeSaveXml(buffer) {
    const bytes = new Uint8Array(buffer);
    const unxor = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) unxor[i] = bytes[i] ^ 11;
    const ascii = new TextDecoder('ascii').decode(unxor).replace(/[\r\n\t ]+/g, '').replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(ascii);
    const compressed = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) compressed[i] = raw.charCodeAt(i);
    const stream = new DecompressionStream('gzip');
    const writer = stream.writable.getWriter();
    writer.write(compressed);
    writer.close();
    return await new Response(stream.readable).text();
  }

  function valuesFromSaveXml(xmlText) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlText, 'application/xml');
    const levels = [];
    const rootDict = doc.querySelector('plist > dict');
    if (!rootDict) return levels;
    const children = Array.from(rootDict.children);
    let llKey = null;
    for (let i = 0; i < children.length; i++) {
      if (children[i].tagName === 'k' && children[i].textContent === 'LLM_01') {
        llKey = children[i + 1];
        break;
      }
    }
    const targetDict = llKey && llKey.tagName === 'dict' ? llKey : rootDict;
    for (const dict of targetDict.querySelectorAll(':scope > dict')) {
      const fields = new Map();
      const nodeChildren = Array.from(dict.children);
      for (let i = 0; i < nodeChildren.length; i += 2) {
        const key = nodeChildren[i]?.textContent;
        const value = nodeChildren[i + 1];
        if (!key || !value) continue;
        if (['string', 'integer', 'real'].includes(value.tagName)) fields.set(key, value.textContent || '');
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

  window.addEventListener('message', async event => {
    if (event.origin !== window.location.origin || event.source !== window.parent) return;
    const message = event.data || {};
    try {
      if (message.type === 'import-resources') await importResources(message.files || []);
      if (message.type === 'import-level-files') await importLevelFiles(message.files || []);
      if (message.type === 'import-resources-zip') await importResourcesZipAsync(message.buffer);
      if (message.type === 'trigger-cached-resources') {
        await waitForFs();
        checkGameReady();
      }
    } catch (error) {
      postStatus(error && error.message ? error.message : String(error), 'busy');
    }
  });
})();
