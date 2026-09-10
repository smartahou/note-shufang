(() => {
  if (window.__NOTE_WEB_CLIPPER_LOADED__) return;
  window.__NOTE_WEB_CLIPPER_LOADED__ = true;

  const $ = (sel, root = document) => root.querySelector(sel);
  const pageInfo = () => ({ pageTitle: document.title || location.hostname, pageUrl: location.href });
  let lastSelectionClip = null;
  let lastSelectionAt = 0;
  let compatEnabled = false;
  let compatObserver = null;
  let lastChooserOpenAt = 0;

  function readyRoot() {
    return document.documentElement || document.body || document;
  }

  function toast(message, bad = false) {
    document.getElementById('noteclip-toast')?.remove();
    const el = document.createElement('div');
    el.id = 'noteclip-toast';
    el.className = `noteclip-toast${bad ? ' is-bad' : ''}`;
    el.textContent = message;
    readyRoot().appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 180); }, 2100);
  }

  async function bg(message) {
    const result = await chrome.runtime.sendMessage(message);
    if (!result?.ok) throw new Error(result?.error || '操作失败');
    return result.data ?? result;
  }

  function closeModal() { document.getElementById('noteclip-overlay')?.remove(); }

  function folderNameMap(folders = []) {
    const map = new Map([['', '根目录']]);
    for (const folder of folders) map.set(folder.id, folder.name);
    return map;
  }

  function normalizeClipText(value) {
    return String(value || '')
      .replace(/\r\n?/g, '\n')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  const CLIP_BLOCK_TAGS = new Set([
    'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DIV', 'DL', 'DT', 'DD',
    'FIGCAPTION', 'FIGURE', 'FOOTER', 'HEADER', 'H1', 'H2', 'H3', 'H4',
    'H5', 'H6', 'LI', 'MAIN', 'NAV', 'P', 'PRE', 'SECTION', 'TR'
  ]);
  const CLIP_SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS']);
  const MAX_CLIP_IMAGES = 12;

  function emptyClip() {
    return { quote: '', parts: [], images: [] };
  }

  function clipHasContent(clip) {
    return !!(clip && (String(clip.quote || '').trim() || (Array.isArray(clip.images) && clip.images.length)));
  }

  function appendClipText(parts, value) {
    const text = String(value || '');
    if (!text) return;
    const last = parts[parts.length - 1];
    if (last?.type === 'text') last.text += text;
    else parts.push({ type: 'text', text });
  }

  function appendClipBreak(parts) {
    appendClipText(parts, '\n');
  }

  function normalizePartText(value) {
    return String(value || '')
      .replace(/\r\n?/g, '\n')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/\n{3,}/g, '\n\n');
  }

  function resolveImageSource(img) {
    if (!img) return '';
    const candidates = [
      img.currentSrc,
      img.getAttribute?.('src'),
      img.getAttribute?.('data-src'),
      img.getAttribute?.('data-original'),
      img.getAttribute?.('data-lazy-src'),
      img.getAttribute?.('data-url')
    ];
    for (const raw of candidates) {
      const value = String(raw || '').trim();
      if (!value) continue;
      if (/^(?:data:image\/|blob:)/i.test(value)) return value;
      try {
        const url = new URL(value, img.ownerDocument?.baseURI || document.baseURI);
        if (/^https?:$/i.test(url.protocol)) return url.href;
      } catch {}
    }
    return '';
  }

  function rangeOriginalImages(range) {
    try {
      const ancestor = range.commonAncestorContainer?.nodeType === Node.ELEMENT_NODE
        ? range.commonAncestorContainer
        : range.commonAncestorContainer?.parentElement;
      if (!ancestor) return [];
      const candidates = [];
      if (ancestor.matches?.('img')) candidates.push(ancestor);
      candidates.push(...(ancestor.querySelectorAll?.('img') || []));
      return candidates.filter(img => {
        try { return range.intersectsNode(img); } catch { return false; }
      });
    } catch {
      return [];
    }
  }

  function imageDescriptor(img, index) {
    const src = resolveImageSource(img);
    if (!src) return null;
    const width = Math.max(0, Math.round(Number(img?.naturalWidth || img?.width || 0)));
    const height = Math.max(0, Math.round(Number(img?.naturalHeight || img?.height || 0)));
    if ((width && width < 2) || (height && height < 2)) return null;
    return {
      key: `img-${index}`,
      src,
      alt: String(img?.getAttribute?.('alt') || img?.getAttribute?.('title') || '').replace(/\s+/g, ' ').trim().slice(0, 500),
      width,
      height
    };
  }

  function rangeToClip(range) {
    if (!range || range.collapsed) return emptyClip();
    const parts = [];
    const images = [];
    const originals = rangeOriginalImages(range);
    let originalImageIndex = 0;

    let fragment;
    try { fragment = range.cloneContents(); } catch {
      const quote = normalizeClipText(range.toString?.() || '');
      return quote ? { quote, parts: [{ type: 'text', text: quote }], images: [] } : emptyClip();
    }

    function walk(node) {
      if (!node) return;
      if (node.nodeType === Node.TEXT_NODE) {
        appendClipText(parts, node.nodeValue || '');
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;

      if (node.nodeType === Node.ELEMENT_NODE) {
        const tag = String(node.tagName || '').toUpperCase();
        if (CLIP_SKIP_TAGS.has(tag)) return;
        if (tag === 'BR') {
          appendClipBreak(parts);
          return;
        }
        if (tag === 'IMG') {
          if (images.length >= MAX_CLIP_IMAGES) return;
          const original = originals[originalImageIndex++] || node;
          const meta = imageDescriptor(original, images.length) || imageDescriptor(node, images.length);
          if (!meta) return;
          images.push(meta);
          parts.push({ type: 'image', key: meta.key });
          return;
        }
        if (CLIP_BLOCK_TAGS.has(tag)) appendClipBreak(parts);
        for (const child of node.childNodes || []) walk(child);
        if (tag === 'TD' || tag === 'TH') appendClipText(parts, '\t');
        if (CLIP_BLOCK_TAGS.has(tag)) appendClipBreak(parts);
        return;
      }

      for (const child of node.childNodes || []) walk(child);
    }

    walk(fragment);

    const normalizedParts = [];
    for (const part of parts) {
      if (part.type === 'image') {
        normalizedParts.push(part);
        continue;
      }
      const text = normalizePartText(part.text);
      if (!text) continue;
      const last = normalizedParts[normalizedParts.length - 1];
      if (last?.type === 'text') last.text += text;
      else normalizedParts.push({ type: 'text', text });
    }

    const firstText = normalizedParts.find(part => part.type === 'text');
    const lastText = [...normalizedParts].reverse().find(part => part.type === 'text');
    if (firstText) firstText.text = firstText.text.replace(/^\s+/, '');
    if (lastText) lastText.text = lastText.text.replace(/\s+$/, '');

    const cleanedParts = normalizedParts.filter(part => part.type === 'image' || String(part.text || '').length);
    const quote = normalizeClipText(cleanedParts.filter(part => part.type === 'text').map(part => part.text).join(''));
    return { quote, parts: cleanedParts, images };
  }

  function selectionClipFromInput() {
    const el = document.activeElement;
    if (!el || !/^(INPUT|TEXTAREA)$/.test(el.tagName || '')) return emptyClip();
    if (typeof el.selectionStart !== 'number' || typeof el.selectionEnd !== 'number' || el.selectionEnd <= el.selectionStart) return emptyClip();
    const quote = normalizeClipText(String(el.value || '').slice(el.selectionStart, el.selectionEnd));
    return quote ? { quote, parts: [{ type: 'text', text: quote }], images: [] } : emptyClip();
  }

  function selectionClipFromRoot(root) {
    try {
      const sel = root?.getSelection?.();
      if (!sel || !sel.rangeCount) return emptyClip();
      const clips = [];
      for (let i = 0; i < sel.rangeCount; i += 1) {
        const clip = rangeToClip(sel.getRangeAt(i));
        if (clipHasContent(clip)) clips.push(clip);
      }
      if (!clips.length) return emptyClip();

      const combined = emptyClip();
      for (const clip of clips) {
        if (combined.parts.length && clip.parts.length) appendClipBreak(combined.parts);
        const keyMap = new Map();
        for (const image of clip.images) {
          if (combined.images.length >= MAX_CLIP_IMAGES) break;
          const key = `img-${combined.images.length}`;
          keyMap.set(image.key, key);
          combined.images.push({ ...image, key });
        }
        for (const part of clip.parts) {
          if (part.type === 'image') {
            const key = keyMap.get(part.key);
            if (key) combined.parts.push({ type: 'image', key });
          } else {
            appendClipText(combined.parts, part.text);
          }
        }
      }
      combined.quote = normalizeClipText(combined.parts.filter(part => part.type === 'text').map(part => part.text).join(''));
      return combined;
    } catch {}
    return emptyClip();
  }

  function selectionClipFromOpenShadowRoots(root = document) {
    try {
      for (const el of root.querySelectorAll?.('*') || []) {
        if (!el.shadowRoot) continue;
        const direct = selectionClipFromRoot(el.shadowRoot);
        if (clipHasContent(direct)) return direct;
        const nested = selectionClipFromOpenShadowRoots(el.shadowRoot);
        if (clipHasContent(nested)) return nested;
      }
    } catch {}
    return emptyClip();
  }

  function liveSelectionClip() {
    const input = selectionClipFromInput();
    if (clipHasContent(input)) return input;
    const win = selectionClipFromRoot(window);
    if (clipHasContent(win)) return win;
    const doc = selectionClipFromRoot(document);
    if (clipHasContent(doc)) return doc;
    return selectionClipFromOpenShadowRoots(document);
  }

  function currentSelectionClip(useCache = true) {
    const clip = liveSelectionClip();
    if (clipHasContent(clip)) {
      lastSelectionClip = clip;
      lastSelectionAt = Date.now();
      return clip;
    }
    if (useCache && Date.now() - lastSelectionAt < 60000 && clipHasContent(lastSelectionClip)) return lastSelectionClip;
    return emptyClip();
  }

  function currentSelectionText() {
    return currentSelectionClip(true).quote || '';
  }

  function refreshSelectionCache() {
    const clip = liveSelectionClip();
    if (clipHasContent(clip)) {
      lastSelectionClip = clip;
      lastSelectionAt = Date.now();
    }
  }

  // Background shortcuts can query the exact frame that owns the selection.
  globalThis.__NOTECLIP_GET_SELECTION = () => currentSelectionClip(true);

  document.addEventListener('selectionchange', () => setTimeout(refreshSelectionCache, 0), true);
  document.addEventListener('mouseup', () => setTimeout(refreshSelectionCache, 0), true);
  document.addEventListener('keyup', () => setTimeout(refreshSelectionCache, 0), true);

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error || new Error('图片读取失败'));
      reader.readAsDataURL(blob);
    });
  }

  async function materializeBlobImages(payload) {
    if (!Array.isArray(payload?.images) || !payload.images.length) return payload;
    const images = [];
    let totalBytes = 0;
    for (const image of payload.images) {
      let next = { ...image };
      const src = String(image?.src || '').trim();
      if (/^blob:/i.test(src) && totalBytes < 20 * 1024 * 1024) {
        try {
          const response = await fetch(src);
          if (response.ok) {
            const blob = await response.blob();
            if (/^image\//i.test(blob.type || '') && blob.size > 0 && blob.size <= 10 * 1024 * 1024 && totalBytes + blob.size <= 20 * 1024 * 1024) {
              const dataUrl = await blobToDataUrl(blob);
              if (/^data:image\//i.test(dataUrl)) {
                next = { ...next, src: dataUrl };
                totalBytes += blob.size;
              }
            }
          }
        } catch {}
      }
      images.push(next);
    }
    return { ...payload, images };
  }

  async function openChooser(payload) {
    const now = Date.now();
    if (now - lastChooserOpenAt < 450) return;
    lastChooserOpenAt = now;
    closeModal();
    let targets, lastTarget;
    try {
      [targets, lastTarget] = await Promise.all([
        bg({ type: 'note:targets' }),
        bg({ type: 'note:last-target:get' }).catch(() => ({ noteId: '' }))
      ]);
    } catch (error) { toast(error.message, true); return; }

    const folders = targets.folders || [];
    const notes = targets.notes || [];
    const folderNames = folderNameMap(folders);
    const info = pageInfo();
    payload = { ...payload, ...info };
    let selectedNoteId = notes.some(note => note.id === String(lastTarget?.noteId || '')) ? String(lastTarget.noteId) : '';

    const overlay = document.createElement('div');
    overlay.id = 'noteclip-overlay';
    overlay.innerHTML = `
      <div class="noteclip-panel" role="dialog" aria-modal="true">
        <div class="noteclip-head">
          <div><div class="noteclip-title">${payload.kind === 'capture' ? '网页截图 → Note' : '网页文字 → Note'}</div><div class="noteclip-source"></div></div>
          <button class="noteclip-x" title="关闭">×</button>
        </div>
        <div class="noteclip-preview"></div>
        <input class="noteclip-search" placeholder="搜索已有笔记…" autocomplete="off">
        <div class="noteclip-list"></div>
        <div class="noteclip-new">
          <div class="noteclip-new-title">＋ 新建笔记</div>
          <input class="noteclip-new-name" maxlength="160" placeholder="新笔记标题">
          <select class="noteclip-folder"><option value="">根目录</option></select>
        </div>
        <div class="noteclip-foot">
          <div class="noteclip-foot-note"></div>
          <button class="noteclip-save">写入笔记</button>
        </div>
      </div>`;
    readyRoot().appendChild(overlay);
    $('.noteclip-source', overlay).textContent = info.pageTitle;
    const preview = $('.noteclip-preview', overlay);
    if (payload.kind === 'capture') {
      const img = document.createElement('img'); img.src = payload.imageDataUrl; img.alt = '截图预览'; preview.appendChild(img);
    } else {
      const imageMap = new Map((payload.images || []).map(image => [image.key, image]));
      for (const part of payload.parts || []) {
        if (part?.type === 'image') {
          const meta = imageMap.get(part.key);
          if (!meta?.src) continue;
          const img = document.createElement('img');
          img.src = meta.src;
          img.alt = meta.alt || '网页图片';
          img.loading = 'lazy';
          preview.appendChild(img);
          continue;
        }
        if (part?.type === 'text' && part.text) preview.appendChild(document.createTextNode(part.text));
      }
      if (!preview.childNodes.length) preview.textContent = payload.quote || '';
    }
    const nameInput = $('.noteclip-new-name', overlay);
    nameInput.value = `${info.pageTitle} · ${payload.kind === 'capture' ? '网页截图' : '网页摘录'}`.slice(0, 160);
    const folderSelect = $('.noteclip-folder', overlay);
    for (const folder of folders) {
      const opt = document.createElement('option'); opt.value = folder.id; opt.textContent = folder.name; folderSelect.appendChild(opt);
    }
    $('.noteclip-x', overlay).addEventListener('click', closeModal);
    overlay.addEventListener('mousedown', e => { if (e.target === overlay) closeModal(); });
    document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape' && document.getElementById('noteclip-overlay')) { closeModal(); document.removeEventListener('keydown', esc); } });

    const list = $('.noteclip-list', overlay);
    const newBlock = $('.noteclip-new', overlay);
    const footNote = $('.noteclip-foot-note', overlay);
    const saveButton = $('.noteclip-save', overlay);

    function selectedNote() { return notes.find(note => note.id === selectedNoteId) || null; }
    function syncSelectionUi(scroll = false) {
      list.querySelectorAll('.noteclip-note').forEach(row => row.classList.toggle('active', row.dataset.id === selectedNoteId));
      newBlock.classList.toggle('active', !selectedNoteId);
      nameInput.disabled = !!selectedNoteId;
      folderSelect.disabled = !!selectedNoteId;
      const note = selectedNote();
      footNote.textContent = note ? `写入：${note.title || '未命名笔记'}` : `新建：${nameInput.value.trim() || '未命名笔记'}`;
      if (scroll && selectedNoteId) requestAnimationFrame(() => list.querySelector(`.noteclip-note[data-id="${CSS.escape(selectedNoteId)}"]`)?.scrollIntoView({ block: 'nearest' }));
    }
    function setSelection(noteId, scroll = false) {
      selectedNoteId = String(noteId || '');
      syncSelectionUi(scroll);
    }
    function renderNotes(filter = '') {
      list.textContent = '';
      const q = filter.trim().toLowerCase();
      const filtered = notes.filter(n => !q || String(n.title || '').toLowerCase().includes(q));
      if (!filtered.length) {
        const empty = document.createElement('div'); empty.className = 'noteclip-empty'; empty.textContent = '没有匹配的已有笔记'; list.appendChild(empty); syncSelectionUi(); return;
      }
      for (const note of filtered.slice(0, 80)) {
        const row = document.createElement('button'); row.className = 'noteclip-note'; row.dataset.id = note.id;
        const title = document.createElement('span'); title.className = 'noteclip-note-name'; title.textContent = note.title || '未命名笔记';
        const folder = document.createElement('span'); folder.className = 'noteclip-note-folder'; folder.textContent = folderNames.get(note.folderId || '') || '根目录';
        row.append(title, folder);
        row.addEventListener('click', () => setSelection(note.id));
        row.addEventListener('dblclick', () => saveCurrent(note.id));
        list.appendChild(row);
      }
      syncSelectionUi();
    }
    renderNotes();
    syncSelectionUi(true);
    $('.noteclip-search', overlay).addEventListener('input', e => renderNotes(e.target.value));
    newBlock.addEventListener('mousedown', e => { if (!e.target.closest('button')) setSelection(''); });
    nameInput.addEventListener('focus', () => setSelection(''));
    folderSelect.addEventListener('focus', () => setSelection(''));
    nameInput.addEventListener('input', () => syncSelectionUi());

    async function saveCurrent(forceNoteId = null) {
      const noteId = forceNoteId == null ? selectedNoteId : String(forceNoteId || '');
      const buttons = overlay.querySelectorAll('button'); buttons.forEach(b => b.disabled = true);
      try {
        let result;
        if (payload.kind === 'capture') {
          result = await bg({ type: 'note:save-capture', payload: { ...payload, noteId, newTitle: noteId ? '' : nameInput.value.trim(), folderId: noteId ? '' : folderSelect.value } });
        } else {
          const richPayload = await materializeBlobImages(payload);
          result = await bg({ type: 'note:save-excerpt', payload: { ...richPayload, noteId, newTitle: noteId ? '' : nameInput.value.trim(), folderId: noteId ? '' : folderSelect.value } });
        }
        const savedNoteId = String(result?.note?.id || noteId || '');
        if (savedNoteId) await bg({ type: 'note:last-target:set', noteId: savedNoteId }).catch(() => {});
        closeModal(); toast(noteId ? '已追加到笔记' : '已创建笔记');
      } catch (error) {
        buttons.forEach(b => b.disabled = false); toast(error.message, true);
      }
    }
    saveButton.addEventListener('click', () => saveCurrent());
    overlay.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveCurrent(); }
    });
    setTimeout(() => $('.noteclip-search', overlay)?.focus(), 30);
  }

  function cropDataUrl(dataUrl, rect) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => {
        const sx = image.naturalWidth / Math.max(1, window.innerWidth);
        const sy = image.naturalHeight / Math.max(1, window.innerHeight);
        const x = Math.max(0, Math.round(rect.x * sx));
        const y = Math.max(0, Math.round(rect.y * sy));
        const w = Math.max(1, Math.min(image.naturalWidth - x, Math.round(rect.w * sx)));
        const h = Math.max(1, Math.min(image.naturalHeight - y, Math.round(rect.h * sy)));
        const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d'); ctx.drawImage(image, x, y, w, h, 0, 0, w, h);
        resolve(canvas.toDataURL('image/png'));
      };
      image.onerror = () => reject(new Error('截图裁剪失败'));
      image.src = dataUrl;
    });
  }

  function startRegionCapture() {
    closeModal();
    document.getElementById('noteclip-capture-layer')?.remove();
    const layer = document.createElement('div'); layer.id = 'noteclip-capture-layer';
    layer.innerHTML = '<div class="noteclip-capture-tip">拖动框选截图区域 · Esc 取消</div><div class="noteclip-capture-box"></div>';
    readyRoot().appendChild(layer);
    const box = $('.noteclip-capture-box', layer);
    let start = null;
    function move(e) {
      if (!start) return;
      const x = Math.min(start.x, e.clientX), y = Math.min(start.y, e.clientY);
      const w = Math.abs(e.clientX - start.x), h = Math.abs(e.clientY - start.y);
      Object.assign(box.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px`, display: 'block' });
    }
    function cancel() { layer.remove(); document.removeEventListener('keydown', key); }
    function key(e) { if (e.key === 'Escape') cancel(); }
    document.addEventListener('keydown', key);
    layer.addEventListener('mousedown', e => { e.preventDefault(); start = { x: e.clientX, y: e.clientY }; move(e); });
    layer.addEventListener('mousemove', move);
    layer.addEventListener('mouseup', async e => {
      if (!start) return;
      const rect = { x: Math.min(start.x, e.clientX), y: Math.min(start.y, e.clientY), w: Math.abs(e.clientX - start.x), h: Math.abs(e.clientY - start.y) };
      cancel();
      if (rect.w < 12 || rect.h < 12) { toast('截图区域太小', true); return; }
      try {
        await new Promise(r => setTimeout(r, 80));
        const result = await chrome.runtime.sendMessage({ type: 'note:capture-visible' });
        if (!result?.ok) throw new Error(result?.error || '截图失败');
        const imageDataUrl = await cropDataUrl(result.dataUrl, rect);
        await openChooser({ kind: 'capture', imageDataUrl });
      } catch (error) { toast(error.message, true); }
    });
  }

  function compatStop(e) {
    if (!compatEnabled) return;
    e.stopImmediatePropagation();
  }

  function ensureCompatStyle(root = document) {
    try {
      const host = root === document ? (document.head || document.documentElement) : root;
      if (!host || host.querySelector?.('[data-noteclip-compat-style]')) return;
      const style = document.createElement('style');
      style.setAttribute('data-noteclip-compat-style', '1');
      style.textContent = `*{user-select:text!important;-webkit-user-select:text!important;-webkit-touch-callout:default!important}`;
      host.appendChild(style);
    } catch {}
  }

  function applyCompatToShadowRoots(root = document) {
    ensureCompatStyle(root);
    try {
      for (const el of root.querySelectorAll?.('*') || []) {
        if (!el.shadowRoot) continue;
        ensureCompatStyle(el.shadowRoot);
        applyCompatToShadowRoots(el.shadowRoot);
      }
    } catch {}
  }

  function applyCompatToAddedNode(node) {
    if (!node || node.nodeType !== 1) return;
    try {
      if (node.shadowRoot) applyCompatToShadowRoots(node.shadowRoot);
      for (const el of node.querySelectorAll?.('*') || []) if (el.shadowRoot) applyCompatToShadowRoots(el.shadowRoot);
    } catch {}
  }

  function setCompat(enabled, silent = false) {
    compatEnabled = !!enabled;
    if (compatEnabled) {
      const apply = () => applyCompatToShadowRoots(document);
      if (document.documentElement) apply();
      else document.addEventListener('DOMContentLoaded', apply, { once: true });
      window.addEventListener('contextmenu', compatStop, true);
      window.addEventListener('selectstart', compatStop, true);
      window.addEventListener('copy', compatStop, true);
      if (!compatObserver) {
        compatObserver = new MutationObserver(mutations => {
          for (const mutation of mutations) for (const node of mutation.addedNodes || []) applyCompatToAddedNode(node);
        });
        const startObserve = () => { try { compatObserver.observe(document.documentElement || document, { childList: true, subtree: true }); } catch {} };
        if (document.documentElement) startObserve(); else document.addEventListener('DOMContentLoaded', startObserve, { once: true });
      }
    } else {
      window.removeEventListener('contextmenu', compatStop, true);
      window.removeEventListener('selectstart', compatStop, true);
      window.removeEventListener('copy', compatStop, true);
      compatObserver?.disconnect(); compatObserver = null;
      document.querySelectorAll?.('[data-noteclip-compat-style]')?.forEach?.(el => el.remove());
      try {
        for (const el of document.querySelectorAll('*')) el.shadowRoot?.querySelector?.('[data-noteclip-compat-style]')?.remove();
      } catch {}
    }
    if (!silent) toast(compatEnabled ? '兼容选文已开启：可重新选中文字' : '兼容选文已关闭');
  }

  async function clipCurrentSelection() {
    const clip = currentSelectionClip(true);
    if (!clipHasContent(clip)) {
      toast(compatEnabled ? '没有检测到选中文字，请重新框选后再按 Ctrl+Shift+Y' : '请先选中文字；受限网页可在插件中开启“兼容选文”', true);
      return;
    }
    await openChooser({ kind: 'excerpt', ...clip });
  }

  window.addEventListener('keydown', e => {
    if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey) return;
    const key = String(e.key || '').toLowerCase();
    const isY = e.code === 'KeyY' || key === 'y';
    const isS = e.code === 'KeyS' || key === 's';
    if (isY) {
      e.preventDefault(); e.stopImmediatePropagation();
      refreshSelectionCache();
      clipCurrentSelection().catch(error => toast(error.message, true));
    } else if (isS) {
      e.preventDefault(); e.stopImmediatePropagation();
      startRegionCapture();
    }
  }, true);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'noteclip:open-selection') {
      const clip = message.clip && clipHasContent(message.clip)
        ? message.clip
        : { quote: String(message.quote || '').trim(), parts: [{ type: 'text', text: String(message.quote || '').trim() }], images: [] };
      openChooser({ kind: 'excerpt', ...clip });
    }
    if (message?.type === 'noteclip:start-region') startRegionCapture();
    if (message?.type === 'noteclip:error') toast(message.message || '操作失败', true);
    if (message?.type === 'noteclip:get-selection') { sendResponse(currentSelectionClip(true)); return; }
    if (message?.type === 'noteclip:compat:set') { setCompat(!!message.enabled); sendResponse({ enabled: compatEnabled }); return; }
    if (message?.type === 'noteclip:compat:get') { sendResponse({ enabled: compatEnabled }); return; }
  });

  chrome.runtime.sendMessage({ type: 'note:compat:get', host: location.hostname }).then(result => {
    if (result?.ok && result.data?.enabled) setCompat(true, true);
  }).catch(() => {});
})();
