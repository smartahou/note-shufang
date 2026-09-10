(() => {
  if (window.__NOTE_WEB_CLIPPER_LOADED__) return;
  window.__NOTE_WEB_CLIPPER_LOADED__ = true;

  const $ = (sel, root = document) => root.querySelector(sel);
  const pageInfo = () => ({ pageTitle: document.title || location.hostname, pageUrl: location.href });
  let lastSelectionText = '';
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

  function selectionFromInput() {
    const el = document.activeElement;
    if (!el || !/^(INPUT|TEXTAREA)$/.test(el.tagName || '')) return '';
    if (typeof el.selectionStart !== 'number' || typeof el.selectionEnd !== 'number' || el.selectionEnd <= el.selectionStart) return '';
    return normalizeClipText(String(el.value || '').slice(el.selectionStart, el.selectionEnd));
  }

  function rangeTextWithBreaks(range) {
    try {
      if (!range || range.collapsed) return '';
      const owner = range.commonAncestorContainer?.ownerDocument || document;
      const mount = owner.body || owner.documentElement;
      if (!mount) return normalizeClipText(range.toString());
      const probe = owner.createElement('div');
      probe.setAttribute('data-noteclip-text-probe', '1');
      probe.style.cssText = 'position:fixed!important;left:-100000px!important;top:0!important;width:1200px!important;max-width:none!important;height:auto!important;opacity:0!important;pointer-events:none!important;z-index:-2147483647!important;overflow:visible!important;';
      probe.appendChild(range.cloneContents());
      mount.appendChild(probe);
      const text = normalizeClipText(probe.innerText || probe.textContent || range.toString());
      probe.remove();
      return text;
    } catch {
      try { return normalizeClipText(range?.toString?.() || ''); } catch { return ''; }
    }
  }

  function selectionFromRoot(root) {
    try {
      const sel = root?.getSelection?.();
      if (!sel || !sel.rangeCount) return normalizeClipText(sel?.toString?.() || '');
      const parts = [];
      for (let i = 0; i < sel.rangeCount; i += 1) {
        const text = rangeTextWithBreaks(sel.getRangeAt(i));
        if (text) parts.push(text);
      }
      return normalizeClipText(parts.join('\n')) || normalizeClipText(sel.toString?.() || '');
    } catch {}
    return '';
  }

  function selectionFromOpenShadowRoots(root = document) {
    let found = '';
    try {
      for (const el of root.querySelectorAll?.('*') || []) {
        if (!el.shadowRoot) continue;
        found = selectionFromRoot(el.shadowRoot) || selectionFromOpenShadowRoots(el.shadowRoot);
        if (found) return found;
      }
    } catch {}
    return '';
  }

  function currentSelectionText() {
    const text = selectionFromInput() || selectionFromRoot(window) || selectionFromRoot(document) || selectionFromOpenShadowRoots(document);
    if (text) { lastSelectionText = text; lastSelectionAt = Date.now(); }
    const cached = Date.now() - lastSelectionAt < 60000 ? lastSelectionText : '';
    return text || cached || '';
  }

  function refreshSelectionCache() {
    const text = selectionFromInput() || selectionFromRoot(window) || selectionFromRoot(document) || selectionFromOpenShadowRoots(document);
    if (text) { lastSelectionText = text; lastSelectionAt = Date.now(); }
  }

  document.addEventListener('selectionchange', () => setTimeout(refreshSelectionCache, 0), true);
  document.addEventListener('mouseup', () => setTimeout(refreshSelectionCache, 0), true);
  document.addEventListener('keyup', () => setTimeout(refreshSelectionCache, 0), true);

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
      preview.textContent = payload.quote;
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
          result = await bg({ type: 'note:save-excerpt', payload: { ...payload, noteId, newTitle: noteId ? '' : nameInput.value.trim(), folderId: noteId ? '' : folderSelect.value } });
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
    const quote = currentSelectionText().trim();
    if (!quote) {
      toast(compatEnabled ? '没有检测到选中文字，请重新框选后再按 Ctrl+Shift+Y' : '请先选中文字；受限网页可在插件中开启“兼容选文”', true);
      return;
    }
    await openChooser({ kind: 'excerpt', quote });
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
    if (message?.type === 'noteclip:open-selection') openChooser({ kind: 'excerpt', quote: String(message.quote || '').trim() });
    if (message?.type === 'noteclip:start-region') startRegionCapture();
    if (message?.type === 'noteclip:error') toast(message.message || '操作失败', true);
    if (message?.type === 'noteclip:get-selection') { sendResponse({ quote: currentSelectionText() }); return; }
    if (message?.type === 'noteclip:compat:set') { setCompat(!!message.enabled); sendResponse({ enabled: compatEnabled }); return; }
    if (message?.type === 'noteclip:compat:get') { sendResponse({ enabled: compatEnabled }); return; }
  });

  chrome.runtime.sendMessage({ type: 'note:compat:get', host: location.hostname }).then(result => {
    if (result?.ok && result.data?.enabled) setCompat(true, true);
  }).catch(() => {});
})();
