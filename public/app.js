const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const NOTE_CLIENT_ID = (() => {
  const current = sessionStorage.getItem('note:client-id');
  if (current) return current;
  const created = window.crypto?.randomUUID
    ? window.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  sessionStorage.setItem('note:client-id', created);
  return created;
})();

const els = {
  noteList: $('#noteList'),
  noteCount: $('#noteCount'),
  searchInput: $('#searchInput'),
  newBtn: $('#newBtn'),
  newFolderBtn: $('#newFolderBtn'),
  folderList: $('#folderList'),
  currentFolderLabel: $('#currentFolderLabel'),
  folderSelect: $('#folderSelect'),
  lockBtn: $('#lockBtn'),
  removeLockBtn: $('#removeLockBtn'),
  lockedOverlay: $('#lockedOverlay'),
  unlockOverlayBtn: $('#unlockOverlayBtn'),
  titleInput: $('#titleInput'),
  editor: $('#editor'),
  richEditor: $('#richEditor'),
  saveState: $('#saveState'),
  editorArea: $('#editorArea'),
  previewFrame: $('#previewFrame'),
  editTab: $('#editTab'),
  previewTab: $('#previewTab'),
  splitTab: $('#splitTab'),
  typeButtons: $$('.type-switch button[data-type]'),
  convertFormatBtn: $('#convertFormatBtn'),
  docTypeHint: $('#docTypeHint'),
  imageBtn: $('#imageBtn'),
  toolH2: $('#toolH2'),
  toolBold: $('#toolBold'),
  toolItalic: $('#toolItalic'),
  toolQuote: $('#toolQuote'),
  toolCode: $('#toolCode'),
  toolLink: $('#toolLink'),
  imageInput: $('#imageInput'),
  dropHint: $('#dropHint'),
  deleteBtn: $('#deleteBtn'),
  passwordDialog: $('#passwordDialog'),
  passwordDialogTitle: $('#passwordDialogTitle'),
  passwordDialogText: $('#passwordDialogText'),
  passwordInput: $('#passwordInput'),
  passwordConfirmInput: $('#passwordConfirmInput'),
  cancelPasswordBtn: $('#cancelPasswordBtn'),
  confirmPasswordBtn: $('#confirmPasswordBtn'),
  deleteDialog: $('#deleteDialog'),
  cancelDeleteBtn: $('#cancelDeleteBtn'),
  confirmDeleteBtn: $('#confirmDeleteBtn'),
  openPreviewBtn: $('#openPreviewBtn'),
  exportBtn: $('#exportBtn'),
  exportMenu: $('#exportMenu'),
  imageInspector: $('#imageInspector'),
  imageSizeInput: $('#imageSizeInput'),
  imageSizeValue: $('#imageSizeValue'),
  imageAlignButtons: $$('[data-image-align]'),
  imageResetBtn: $('#imageResetBtn'),
  imageInspectorClose: $('#imageInspectorClose'),
  toast: $('#toast')
};

const state = {
  notes: [],
  activeId: null,
  type: 'rich',
  view: localStorage.getItem('note:view') || 'edit',
  dirty: false,
  saveTimer: null,
  previewTimer: null,
  previewHtml: '',
  exportHtml: '',
  selectedImage: null,
  richRange: null,
  realtime: null,
  realtimeRefreshTimer: null,
  deferredRemote: null,
  changeSeq: 0,
  conversionBusy: false,
  folders: [],
  activeFolderId: null,
  noteLocked: false,
  noteUnlocked: false,
  unlockTokens: {},
  passwordDialogResolve: null,
  passwordDialogMode: 'unlock',
  lockConflictDraft: null,
  noteScrollPositions: {},
  previewScrollTop: 0,
  atomicDeleteTarget: null,
  atomicDeleteTimer: null,
  atomicDeletePerforming: false,
  richHistory: {
    noteId: null,
    undo: [],
    redo: [],
    current: null,
    timer: null,
    applying: false
  }
};

els.previewFrame.addEventListener('load', () => {
  if (!state.activeId) return;
  const saved = state.noteScrollPositions[state.activeId];
  const top = saved?.preview ?? state.previewScrollTop ?? 0;
  try {
    els.previewFrame.contentWindow?.postMessage({
      source: 'note-parent',
      type: 'restore-scroll',
      top
    }, '*');
  } catch {}
});

const starterRich = `
<h1>欢迎使用 Note</h1>
<p>这是普通的<strong>所见即所得</strong>编辑模式。你可以像普通文档一样直接输入、选择文字并排版。</p>
<h2>支持的内容</h2>
<ul>
  <li>标题、粗体、斜体、链接</li>
  <li>代码块</li>
  <li>粘贴 / 拖入图片</li>
  <li>点击图片后调整大小和左 / 中 / 右位置</li>
  <li>Ctrl+Z 撤销，Ctrl+Y 重做</li>
</ul>
<blockquote>Markdown 和 HTML 源码模式仍然保留，可按不同笔记自由选择。</blockquote>
`;

async function api(url, options = {}) {
  const { headers: customHeaders = {}, ...rest } = options;
  const headers = {
    'X-Note-Client-Id': NOTE_CLIENT_ID,
    ...customHeaders
  };

  if (!(options.body instanceof FormData) && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(url, {
    ...rest,
    headers
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${response.status}`);
  }

  if (response.status === 204) return null;
  return response.json();
}

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function escapeRegExp(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatTime(iso) {
  const date = new Date(iso);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();

  return sameDay
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString([], { month: 'numeric', day: 'numeric' });
}

function typeBadge(type) {
  if (type === 'html') return 'HTML';
  if (type === 'rich') return 'RICH';
  if (type === 'locked') return 'LOCK';
  return 'MD';
}

function currentUnlockToken(noteId = state.activeId) {
  return noteId ? String(state.unlockTokens[noteId] || '') : '';
}

function unlockHeaders(noteId = state.activeId) {
  const token = currentUnlockToken(noteId);
  return token ? { 'X-Note-Unlock-Token': token } : {};
}

function folderName(folderId) {
  if (!folderId) return '根目录';
  return state.folders.find(folder => folder.id === folderId)?.name || '根目录';
}

function renderFolders() {
  if (!els.folderList) return;
  const rootActive = !state.activeFolderId;
  const rootCount = Number(state.rootNoteCount || 0);
  const rows = [`
    <div class="folder-item ${rootActive ? 'active' : ''}" data-folder-id="root">
      <span class="folder-icon">⌂</span>
      <span class="folder-name">根目录</span>
      <span class="folder-count">${rootCount}</span>
    </div>
  `];

  for (const folder of state.folders) {
    rows.push(`
      <div class="folder-item ${state.activeFolderId === folder.id ? 'active' : ''}" data-folder-id="${escapeHtml(folder.id)}">
        <span class="folder-icon">▱</span>
        <span class="folder-name" title="${escapeHtml(folder.name)}">${escapeHtml(folder.name)}</span>
        <span class="folder-count">${Number(folder.noteCount || 0)}</span>
        <span class="folder-actions">
          <button class="folder-action" data-folder-action="rename" title="重命名">✎</button>
          <button class="folder-action" data-folder-action="delete" title="删除目录">×</button>
        </span>
      </div>
    `);
  }
  els.folderList.innerHTML = rows.join('');
  els.currentFolderLabel.textContent = folderName(state.activeFolderId);
}

function renderFolderSelect(folderId = null) {
  if (!els.folderSelect) return;
  els.folderSelect.innerHTML = [
    '<option value="root">根目录</option>',
    ...state.folders.map(folder => `<option value="${escapeHtml(folder.id)}">${escapeHtml(folder.name)}</option>`)
  ].join('');
  els.folderSelect.value = folderId || 'root';
}

async function loadFolders() {
  const data = await api('/api/folders');
  state.folders = Array.isArray(data?.folders) ? data.folders : [];
  state.rootNoteCount = Number(data?.rootCount || 0);
  if (state.activeFolderId && !state.folders.some(folder => folder.id === state.activeFolderId)) {
    state.activeFolderId = null;
  }
  renderFolders();
  renderFolderSelect(state.notes.find(note => note.id === state.activeId)?.folderId || null);
}

async function setActiveFolder(folderId) {
  if (state.dirty) await saveNow();
  state.activeFolderId = folderId && folderId !== 'root' ? folderId : null;
  state.activeId = null;
  state.noteLocked = false;
  state.noteUnlocked = false;
  renderFolders();
  await loadNotes(els.searchInput.value);
  if (state.notes[0]) await selectNote(state.notes[0].id, { force: true });
  else clearEditor();
}

function setLockedUi({ locked = false, unlocked = false, folderId = null } = {}) {
  state.noteLocked = Boolean(locked);
  state.noteUnlocked = Boolean(locked && unlocked);
  const inaccessible = state.noteLocked && !state.noteUnlocked;

  els.lockedOverlay.hidden = !inaccessible;
  els.titleInput.disabled = inaccessible;
  els.editor.disabled = inaccessible;
  els.richEditor.setAttribute('contenteditable', inaccessible ? 'false' : 'true');
  els.folderSelect.disabled = !state.activeId || inaccessible;
  els.deleteBtn.disabled = inaccessible;
  els.exportBtn.disabled = inaccessible;
  els.convertFormatBtn.disabled = inaccessible;
  els.typeButtons.forEach(button => { button.disabled = inaccessible; });
  $$('.tools button').forEach(button => { button.disabled = inaccessible; });

  if (!state.activeId) {
    els.lockBtn.disabled = true;
    els.lockBtn.textContent = '上锁';
    els.lockBtn.classList.remove('locked');
    els.removeLockBtn.hidden = true;
  } else if (!state.noteLocked) {
    els.lockBtn.disabled = false;
    els.lockBtn.textContent = '上锁';
    els.lockBtn.classList.remove('locked');
    els.removeLockBtn.hidden = true;
  } else if (!state.noteUnlocked) {
    els.lockBtn.disabled = false;
    els.lockBtn.textContent = '解锁';
    els.lockBtn.classList.add('locked');
    els.removeLockBtn.hidden = true;
  } else {
    els.lockBtn.disabled = false;
    els.lockBtn.textContent = '立即锁定';
    els.lockBtn.classList.add('locked');
    els.removeLockBtn.hidden = false;
  }

  renderFolderSelect(folderId);
}

function requestPassword(mode = 'unlock') {
  state.passwordDialogMode = mode;
  els.passwordInput.value = '';
  els.passwordConfirmInput.value = '';
  const isLock = mode === 'lock';
  els.passwordConfirmInput.hidden = !isLock;
  els.passwordDialogTitle.textContent = isLock ? '给笔记加锁' : '输入密码解锁';
  els.passwordDialogText.textContent = isLock
    ? '标题、正文和本地图片都会加密保存。密码不会写入数据文件，忘记后无法恢复。'
    : '解锁只在当前运行会话有效，重新打开后仍需输入密码。';
  els.passwordDialog.showModal();
  setTimeout(() => els.passwordInput.focus(), 30);
  return new Promise(resolve => { state.passwordDialogResolve = resolve; });
}

function toast(text) {
  els.toast.textContent = text;
  els.toast.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => els.toast.classList.remove('show'), 1900);
}

function getContent() {
  if (state.type !== 'rich') return els.editor.value;

  // “待删除摘录”只是编辑器中的临时视觉状态，绝不能写入笔记正文。
  if (state.atomicDeleteTarget?.isConnected) {
    const clone = els.richEditor.cloneNode(true);
    clone.querySelectorAll('.__note-delete-armed').forEach(node => {
      node.classList.remove('__note-delete-armed');
      if (!node.className) node.removeAttribute('class');
    });
    return clone.innerHTML;
  }

  return els.richEditor.innerHTML;
}

function lockBookCaptureMetadata(root = els.richEditor) {
  if (!root?.querySelectorAll) return;

  // 摘录（文字与截图）是一个业务整体。整个容器都必须不可编辑，
  // 不能只锁来源栏，否则 Chrome 会允许光标进入正文，并在删除时
  // 把“正文 / 来源”当成两个不同的编辑边界处理。
  root.querySelectorAll('.note-book-excerpt, figure.note-book-capture').forEach(capture => {
    capture.setAttribute('contenteditable', 'false');
    capture.setAttribute('data-note-atomic', '1');
  });

  root.querySelectorAll('.note-book-source').forEach(source => {
    source.setAttribute('contenteditable', 'false');
    source.setAttribute('data-note-readonly', '1');

    source.querySelectorAll('a').forEach(link => {
      link.setAttribute('contenteditable', 'false');
    });
  });
}

const RICH_HISTORY_MAX_ENTRIES = 60;
const RICH_HISTORY_MAX_HTML_CHARS = 8_000_000;
const RICH_HISTORY_COALESCE_MS = 520;

function cleanRichHtmlForHistory() {
  const clone = els.richEditor.cloneNode(true);
  clone.querySelectorAll('.__note-delete-armed').forEach(node => {
    node.classList.remove('__note-delete-armed');
    if (!node.className) node.removeAttribute('class');
  });
  clone.querySelectorAll('.__note-selected').forEach(node => {
    node.classList.remove('__note-selected');
    if (!node.className) node.removeAttribute('class');
  });
  return clone.innerHTML;
}

function richNodePath(node) {
  if (!node) return null;
  if (node === els.richEditor) return [];
  if (!els.richEditor.contains(node)) return null;

  const path = [];
  let current = node;
  while (current && current !== els.richEditor) {
    const parent = current.parentNode;
    if (!parent) return null;
    const index = Array.prototype.indexOf.call(parent.childNodes, current);
    if (index < 0) return null;
    path.unshift(index);
    current = parent;
  }
  return current === els.richEditor ? path : null;
}

function richNodeFromPath(path) {
  if (!Array.isArray(path)) return null;
  let node = els.richEditor;
  for (const rawIndex of path) {
    const index = Number(rawIndex);
    if (!Number.isInteger(index) || index < 0 || index >= node.childNodes.length) return null;
    node = node.childNodes[index];
  }
  return node;
}

function clampNodeOffset(node, offset) {
  const max = node?.nodeType === Node.TEXT_NODE
    ? (node.nodeValue || '').length
    : (node?.childNodes?.length || 0);
  return Math.max(0, Math.min(Number(offset) || 0, max));
}

function captureRichSelectionBookmark() {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return null;
  const range = selection.getRangeAt(0);
  const startPath = richNodePath(range.startContainer);
  const endPath = richNodePath(range.endContainer);
  if (!startPath || !endPath) return null;

  return {
    startPath,
    startOffset: range.startOffset,
    endPath,
    endOffset: range.endOffset
  };
}

function restoreRichSelectionBookmark(bookmark) {
  if (!bookmark) return false;
  const startNode = richNodeFromPath(bookmark.startPath);
  const endNode = richNodeFromPath(bookmark.endPath);
  if (!startNode || !endNode) return false;

  try {
    const range = document.createRange();
    range.setStart(startNode, clampNodeOffset(startNode, bookmark.startOffset));
    range.setEnd(endNode, clampNodeOffset(endNode, bookmark.endOffset));
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    state.richRange = range.cloneRange();
    return true;
  } catch {
    return false;
  }
}

function captureRichHistorySnapshot() {
  return {
    html: cleanRichHtmlForHistory(),
    selection: captureRichSelectionBookmark(),
    scrollTop: els.richEditor.scrollTop || 0
  };
}

function trimRichHistoryStack(stack) {
  while (stack.length > RICH_HISTORY_MAX_ENTRIES) stack.shift();
  let total = stack.reduce((sum, item) => sum + String(item?.html || '').length, 0);
  while (stack.length > 1 && total > RICH_HISTORY_MAX_HTML_CHARS) {
    const removed = stack.shift();
    total -= String(removed?.html || '').length;
  }
}

function resetRichHistory() {
  const history = state.richHistory;
  clearTimeout(history.timer);
  history.timer = null;
  history.noteId = state.type === 'rich' ? state.activeId : null;
  history.undo = [];
  history.redo = [];
  history.current = state.type === 'rich' ? captureRichHistorySnapshot() : null;
  history.applying = false;
}

function ensureRichHistory() {
  const history = state.richHistory;
  if (state.type !== 'rich' || !state.activeId) return false;
  if (history.noteId !== state.activeId || !history.current) resetRichHistory();
  return Boolean(history.current);
}

function refreshRichHistoryPosition() {
  if (!ensureRichHistory() || state.richHistory.applying) return;
  const snapshot = captureRichHistorySnapshot();
  if (snapshot.html !== state.richHistory.current.html) return;
  state.richHistory.current.selection = snapshot.selection;
  state.richHistory.current.scrollTop = snapshot.scrollTop;
}

function commitRichHistoryNow({ clearRedo = true } = {}) {
  if (!ensureRichHistory() || state.richHistory.applying) return false;

  const history = state.richHistory;
  clearTimeout(history.timer);
  history.timer = null;

  const next = captureRichHistorySnapshot();
  if (next.html === history.current.html) {
    history.current.selection = next.selection;
    history.current.scrollTop = next.scrollTop;
    return false;
  }

  history.undo.push(history.current);
  trimRichHistoryStack(history.undo);
  history.current = next;
  if (clearRedo) history.redo = [];
  return true;
}

function scheduleRichHistoryCommit() {
  if (!ensureRichHistory() || state.richHistory.applying) return;
  clearTimeout(state.richHistory.timer);
  state.richHistory.timer = setTimeout(() => {
    commitRichHistoryNow();
  }, RICH_HISTORY_COALESCE_MS);
}

function appendExternalCaptureToHistoryHtml(html = '', markup = '') {
  const holder = document.createElement('div');
  holder.innerHTML = String(html || '');
  const currentHtml = holder.innerHTML;
  const hasContent = Boolean(currentHtml.trim());
  const spacer = '<p data-note-spacer="capture"><br></p>';
  const before = hasContent && !endsWithBlankParagraph(currentHtml) ? spacer : '';
  holder.insertAdjacentHTML('beforeend', `${before}${markup}${spacer}`);
  lockBookCaptureMetadata(holder);
  return holder.innerHTML;
}

function rebaseRichHistoryWithExternalAppend(markup = '') {
  if (!markup || !ensureRichHistory() || state.richHistory.applying) return;
  const history = state.richHistory;
  clearTimeout(history.timer);
  history.timer = null;

  const rebase = snapshot => snapshot
    ? { ...snapshot, html: appendExternalCaptureToHistoryHtml(snapshot.html, markup) }
    : snapshot;

  history.undo = history.undo.map(rebase);
  history.redo = history.redo.map(rebase);
  history.current = rebase(history.current);
  trimRichHistoryStack(history.undo);
  trimRichHistoryStack(history.redo);

  // Use the live DOM as the authoritative current snapshot. Appending at the end keeps
  // existing selection paths stable, while this avoids parser-normalization drift.
  const live = captureRichHistorySnapshot();
  history.current = live;
}

function applyRichHistorySnapshot(snapshot) {
  if (!snapshot || state.type !== 'rich' || !state.activeId) return false;
  const history = state.richHistory;
  history.applying = true;
  clearAtomicDeleteArm();
  hideImageInspector();

  try {
    els.richEditor.innerHTML = snapshot.html;
    lockBookCaptureMetadata();
    try { els.richEditor.focus({ preventScroll: true }); } catch { els.richEditor.focus(); }
    if (!restoreRichSelectionBookmark(snapshot.selection)) {
      const range = document.createRange();
      range.selectNodeContents(els.richEditor);
      range.collapse(false);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      state.richRange = range.cloneRange();
    }
    els.richEditor.scrollTop = snapshot.scrollTop || 0;
    updateRichToolbarState();
    markDirty();
    requestAnimationFrame(() => {
      if (state.activeId === history.noteId && state.type === 'rich') {
        els.richEditor.scrollTop = snapshot.scrollTop || 0;
      }
    });
    return true;
  } finally {
    history.applying = false;
  }
}

function undoRichHistory() {
  if (!ensureRichHistory()) return false;
  // Flush any still-coalescing keystrokes first, so Ctrl+Z always targets the latest visible state.
  commitRichHistoryNow();
  const history = state.richHistory;
  const previous = history.undo.pop();
  if (!previous) return false;

  history.redo.push(history.current);
  trimRichHistoryStack(history.redo);
  history.current = previous;
  return applyRichHistorySnapshot(previous);
}

function redoRichHistory() {
  if (!ensureRichHistory()) return false;
  // If the DOM changed after an undo, that new edit becomes a branch and invalidates redo.
  commitRichHistoryNow();
  const history = state.richHistory;
  const next = history.redo.pop();
  if (!next) return false;

  history.undo.push(history.current);
  trimRichHistoryStack(history.undo);
  history.current = next;
  return applyRichHistorySnapshot(next);
}

function richHistoryShortcutContext() {
  const active = document.activeElement;
  if (active === els.richEditor || els.richEditor.contains(active)) return true;

  // A programmatic atomic-block removal can briefly report BODY as active in Chromium.
  // Only accept that fallback while the live Selection still belongs to the rich editor,
  // so Ctrl+Z elsewhere in the app never steals focus/history from another control.
  if (active === document.body || active === document.documentElement) {
    const selection = window.getSelection();
    if (!selection?.rangeCount) return false;
    const range = selection.getRangeAt(0);
    return range.commonAncestorContainer === els.richEditor || els.richEditor.contains(range.commonAncestorContainer);
  }

  return false;
}

function setContent(content = '') {
  clearAtomicDeleteArm();

  if (state.type === 'rich') {
    els.richEditor.innerHTML = content;
    lockBookCaptureMetadata();
  } else {
    els.editor.value = content;
  }
  resetRichHistory();
}

function focusEditor({ preventScroll = false } = {}) {
  const activeEditor = state.type === 'rich' ? els.richEditor : els.editor;
  try {
    activeEditor.focus({ preventScroll });
  } catch {
    activeEditor.focus();
  }
}

function rememberDocumentScroll(noteId = state.activeId) {
  if (!noteId) return;
  state.noteScrollPositions[noteId] = {
    rich: els.richEditor.scrollTop || 0,
    source: els.editor.scrollTop || 0,
    preview: state.previewScrollTop || 0
  };
}

function restoreDocumentScroll(noteId = state.activeId, { fallbackTop = 0 } = {}) {
  const saved = noteId ? state.noteScrollPositions[noteId] : null;
  const richTop = saved?.rich ?? fallbackTop;
  const sourceTop = saved?.source ?? fallbackTop;
  const previewTop = saved?.preview ?? fallbackTop;

  const apply = () => {
    els.richEditor.scrollTop = richTop;
    els.editor.scrollTop = sourceTop;
    state.previewScrollTop = previewTop;
    try {
      els.previewFrame.contentWindow?.postMessage({
        source: 'note-parent',
        type: 'restore-scroll',
        top: previewTop
      }, '*');
    } catch {}
  };

  apply();
  requestAnimationFrame(() => {
    apply();
    requestAnimationFrame(apply);
  });
}

function renderList() {
  els.noteCount.textContent = state.notes.length;

  if (!state.notes.length) {
    els.noteList.innerHTML = `<div class="empty">当前目录还没有笔记</div>`;
    return;
  }

  els.noteList.innerHTML = state.notes.map(note => `
    <article class="note-item ${note.locked ? 'locked-note' : ''} ${note.id === state.activeId ? 'active' : ''}" data-id="${note.id}">
      <div class="note-title">${escapeHtml(note.title)}</div>
      <div class="note-summary">${escapeHtml(note.summary || '空白笔记')}</div>
      <div class="note-meta">
        <span>${formatTime(note.updatedAt)}</span>
        <span class="type-badge">${typeBadge(note.type)}</span>
      </div>
    </article>
  `).join('');
}

async function loadNotes(q = '') {
  const folder = state.activeFolderId || 'root';
  state.notes = await api(`/api/notes?q=${encodeURIComponent(q)}&folder=${encodeURIComponent(folder)}`);
  renderList();
}

function endsWithBlankParagraph(html = '') {
  return /<p(?:\s[^>]*)?>\s*(?:<br\s*\/?\s*>)?\s*<\/p>\s*$/i.test(String(html || ''));
}

function appendCaptureMarkupToCurrent(markup = '', { markAsDirty = true, refreshPreview = true } = {}) {
  if (!markup) return;
  const spacer = '<p data-note-spacer="capture"><br></p>';

  if (state.type === 'rich') {
    // External captures are remote synchronization, not a local Ctrl+Z step.
    // First seal any local typing, then adopt the appended DOM as the new baseline.
    commitRichHistoryNow();
    const currentHtml = els.richEditor.innerHTML;
    const hasContent = Boolean(currentHtml.trim());
    const before = hasContent && !endsWithBlankParagraph(currentHtml) ? spacer : '';
    els.richEditor.insertAdjacentHTML('beforeend', `${before}${markup}${spacer}`);
    lockBookCaptureMetadata();
    rebaseRichHistoryWithExternalAppend(markup);
  } else {
    const content = getContent();

    if (state.type === 'html' && /<\/body\s*>/i.test(content)) {
      setContent(content.replace(/<\/body\s*>/i, (closingTag, offset) => {
        const beforeBodyEnd = content.slice(0, offset);
        const before = beforeBodyEnd.trim() && !endsWithBlankParagraph(beforeBodyEnd) ? spacer : '';
        return `${before}${markup}${spacer}${closingTag}`;
      }));
    } else {
      const before = content.trim() && !endsWithBlankParagraph(content) ? spacer : '';
      setContent(`${content}${before}${markup}${spacer}`);
    }
  }

  if (markAsDirty) markDirty();
  if (refreshPreview) renderPreview();
}

async function applyRemoteActiveNote(note) {
  if (!note || note.id !== state.activeId) return;

  rememberDocumentScroll(note.id);
  const editorScrollTop = state.type === 'rich'
    ? els.richEditor.scrollTop
    : els.editor.scrollTop;
  const titleHadFocus = document.activeElement === els.titleInput;
  const editorHadFocus = document.activeElement === els.richEditor || document.activeElement === els.editor;
  const hasContent = Object.prototype.hasOwnProperty.call(note, 'content');

  if (note.locked && !hasContent) {
    delete state.unlockTokens[note.id];
    state.type = 'rich';
    els.titleInput.value = '已加锁笔记';
    updateTypeUI();
    setContent('');
    setLockedUi({ locked: true, unlocked: false, folderId: note.folderId });
    state.dirty = false;
    state.deferredRemote = null;
    els.saveState.textContent = '已锁定';
    els.saveState.classList.remove('saving');
    hideImageInspector();
    renderList();
    await renderPreview();
    return;
  }

  state.type = ['rich', 'markdown', 'html'].includes(note.type) ? note.type : 'rich';
  els.titleInput.value = note.title;
  updateTypeUI();
  setContent(note.content || '');
  setLockedUi({ locked: Boolean(note.locked), unlocked: Boolean(note.locked), folderId: note.folderId });
  hideImageInspector();
  state.dirty = false;
  state.deferredRemote = null;
  els.saveState.textContent = '已同步';
  els.saveState.classList.remove('saving');
  renderList();
  await renderPreview();

  const activeEditor = state.type === 'rich' ? els.richEditor : els.editor;
  if (titleHadFocus) {
    try { els.titleInput.focus({ preventScroll: true }); } catch { els.titleInput.focus(); }
  } else if (editorHadFocus) {
    try { activeEditor.focus({ preventScroll: true }); } catch { activeEditor.focus(); }
  }

  // focus/contenteditable layout can change scroll after the DOM replacement.
  // Restore after focus, and again on the following frames.
  if (state.noteScrollPositions[note.id]) {
    if (state.type === 'rich') state.noteScrollPositions[note.id].rich = editorScrollTop;
    else state.noteScrollPositions[note.id].source = editorScrollTop;
  }
  restoreDocumentScroll(note.id, { fallbackTop: editorScrollTop });
}

async function handleRealtimeNoteEvent(data) {
  if (!data || !data.noteId || data.sourceClientId === NOTE_CLIENT_ID) return;

  clearTimeout(state.realtimeRefreshTimer);
  state.realtimeRefreshTimer = setTimeout(() => {
    loadFolders()
      .then(() => loadNotes(els.searchInput.value))
      .catch(() => {});
  }, 45);

  if (data.action === 'deleted' && data.noteId === state.activeId) {
    if (state.dirty) {
      state.deferredRemote = data;
      els.saveState.textContent = '外部已删除';
      toast('这篇笔记已在其他窗口删除；当前未保存内容仍保留');
      return;
    }

    state.activeId = null;
    await loadNotes(els.searchInput.value);
    if (state.notes[0]) await selectNote(state.notes[0].id);
    else clearEditor();
    toast('笔记列表已自动同步');
    return;
  }

  if (data.noteId !== state.activeId) return;

  // 书房 / Chrome 的摘录本质都是“只向正文末尾追加一段”。
  // 对当前已经打开的笔记直接做增量 DOM 追加，不重新 setContent() 整篇正文，
  // 这样不会破坏当前光标、选区和滚动位置。
  const appendActions = ['shufang-capture', 'shufang-excerpt', 'chrome-capture', 'chrome-excerpt'];
  if (appendActions.includes(data.action) && data.contentAppend) {
    rememberDocumentScroll(state.activeId);
    appendCaptureMarkupToCurrent(data.contentAppend, {
      markAsDirty: state.dirty,
      refreshPreview: true
    });

    if (!state.dirty) {
      state.dirty = false;
      state.deferredRemote = null;
      els.saveState.textContent = '已同步';
      els.saveState.classList.remove('saving');
    }

    if (data.note) {
      const index = state.notes.findIndex(item => item.id === data.noteId);
      if (index >= 0) state.notes[index] = { ...state.notes[index], ...data.note };
      state.notes.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      renderList();
    }

    restoreDocumentScroll(state.activeId);
    const fromChrome = data.source === 'chrome';
    const isExcerpt = /excerpt$/.test(data.action);
    toast(fromChrome
      ? (isExcerpt ? '网页文字摘录已实时加入当前笔记' : '网页截图已实时加入当前笔记')
      : (isExcerpt ? '书房摘录已实时加入当前笔记' : '书房截图已实时加入当前笔记'));
    return;
  }

  if (state.dirty && data.action === 'locked') {
    clearTimeout(state.saveTimer);
    state.lockConflictDraft = {
      noteId: state.activeId,
      title: els.titleInput.value || '未命名笔记',
      type: state.type,
      content: getContent()
    };
    delete state.unlockTokens[state.activeId];
    setLockedUi({ locked: true, unlocked: false, folderId: els.folderSelect.value === 'root' ? null : els.folderSelect.value });
    els.saveState.textContent = '外部已加锁 · 修改待解锁保存';
    toast('其他窗口已给这篇笔记上锁；你尚未保存的内容已暂存在当前页面内存中');
    return;
  }

  if (state.dirty) {
    state.deferredRemote = data;
    els.saveState.textContent = '有外部更新';
    toast('其他窗口更新了当前笔记；本地输入保存后将继续同步');
    return;
  }

  try {
    const note = await api(`/api/notes/${encodeURIComponent(data.noteId)}`, { headers: unlockHeaders(data.noteId) });
    await applyRemoteActiveNote(note);
    if (data.source === 'shufang') toast('书房内容已实时同步');
    if (data.source === 'chrome') toast('网页摘录已实时同步');
  } catch (error) {
    if (!/404/.test(String(error.message))) console.warn('Realtime refresh failed:', error);
  }
}

function connectRealtime() {
  if (!window.EventSource || state.realtime) return;

  const stream = new EventSource(`/api/events?clientId=${encodeURIComponent(NOTE_CLIENT_ID)}`);
  state.realtime = stream;

  stream.addEventListener('note', event => {
    try {
      handleRealtimeNoteEvent(JSON.parse(event.data));
    } catch (error) {
      console.warn('Realtime event error:', error);
    }
  });

  stream.addEventListener('folder', () => {
    loadFolders()
      .then(() => loadNotes(els.searchInput.value))
      .catch(() => {});
  });

  stream.onerror = () => {
    // EventSource 会自动重连；这里不弹错误，避免服务刚启动/切换时打扰编辑。
  };
}

function updateTypeUI() {
  const rich = state.type === 'rich';

  els.typeButtons.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.type === state.type);
  });

  els.richEditor.hidden = !rich;
  els.editor.hidden = rich;

  if (state.type === 'rich') {
    els.docTypeHint.textContent = '所见即所得 · Ctrl+Z 撤销 / Ctrl+Y 重做';
  } else if (state.type === 'html') {
    els.docTypeHint.textContent = 'HTML 源码将在沙箱 iframe 中运行';
  } else {
    els.docTypeHint.textContent = '支持 Markdown + HTML 片段';
  }

  els.editor.placeholder = state.type === 'html'
    ? '<!doctype html>\n<html>\n  ...\n</html>'
    : '# 从这里开始写…';

  if (els.convertFormatBtn) {
    const toMarkdown = state.type !== 'markdown';
    els.convertFormatBtn.textContent = toMarkdown ? '转为 Markdown' : '转为富文本';
    els.convertFormatBtn.title = toMarkdown
      ? '显式转换为 Markdown；复杂 HTML 样式会以原始 HTML 片段保留'
      : '将 Markdown 渲染为 HTML，并切换到富文本编辑';
    els.convertFormatBtn.disabled = !state.activeId || state.conversionBusy || (state.noteLocked && !state.noteUnlocked);
  }

  if (state.type !== 'rich') {
    resetRichToolbarState();
  }
}

function isHtmlFamily(type) {
  return type === 'rich' || type === 'html';
}

async function convertType(targetType) {
  if (!['rich', 'markdown', 'html'].includes(targetType)) return;
  if (targetType === state.type) return;

  const oldType = state.type;

  // 富文本和 HTML 都以 HTML 为底层内容，二者可直接切换。
  if (isHtmlFamily(oldType) && isHtmlFamily(targetType)) {
    const content = getContent();
    state.type = targetType;
    updateTypeUI();
    setContent(content);
    hideImageInspector();
    updateRichToolbarState();
    markDirty();
    renderPreview();
    focusEditor();
    return;
  }

  // Markdown 与 HTML 家族之间存在有损映射，不在“类型切换”时偷偷转换。
  toast('Markdown 与富文本/HTML 请使用“转为…”按钮显式转换');
}

function markdownEscapeText(value = '') {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/([*_\[\]])/g, '\\$1');
}

function markdownInlineCode(value = '') {
  const text = String(value).replace(/\r\n?/g, '\n');
  const runs = text.match(/`+/g) || [];
  const ticks = '`'.repeat(Math.max(1, ...runs.map(run => run.length + 1)));
  const needsPad = /^`|`$|^\s|\s$/.test(text);
  return `${ticks}${needsPad ? ' ' : ''}${text}${needsPad ? ' ' : ''}${ticks}`;
}

function meaningfulHtmlAttributes(element) {
  if (!element?.attributes) return [];
  return [...element.attributes].filter(attr => {
    const name = attr.name.toLowerCase();
    if (name === 'contenteditable' && attr.value === 'true') return false;
    return true;
  });
}

function shouldPreserveHtmlElement(element) {
  const tag = element.tagName?.toLowerCase();
  if (!tag) return false;

  if (element.matches?.(
    'figure, table, iframe, video, audio, canvas, svg, form, details, summary, object, embed, ' +
    '.note-book-excerpt, .note-book-source, .note-image-block'
  )) return true;

  if (['script', 'style', 'link', 'meta', 'noscript', 'template', 'math'].includes(tag)) return true;

  // Markdown 无法表达多数 HTML 属性。只对少数可无损映射的属性放行；
  // 其余节点保留原始 HTML，避免转换把样式、书房来源或业务元数据弄丢。
  const attrs = meaningfulHtmlAttributes(element);
  const allowed = {
    a: new Set(['href', 'title']),
    img: new Set(['src', 'alt', 'title']),
    ol: new Set(['start']),
    li: new Set(['value'])
  }[tag] || new Set();

  return attrs.some(attr => !allowed.has(attr.name.toLowerCase()));
}

function normalizeMarkdownBlocks(value = '') {
  return String(value)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function htmlElementToMarkdown(element, context) {
  if (shouldPreserveHtmlElement(element)) {
    context.preserved += 1;
    return `\n\n${element.outerHTML}\n\n`;
  }

  const tag = element.tagName.toLowerCase();
  const children = () => [...element.childNodes]
    .map(node => htmlNodeToMarkdown(node, context))
    .join('');

  if (/^h[1-6]$/.test(tag)) {
    const level = Number(tag.slice(1));
    return `\n\n${'#'.repeat(level)} ${normalizeMarkdownBlocks(children())}\n\n`;
  }

  if (tag === 'p') return `\n\n${normalizeMarkdownBlocks(children())}\n\n`;
  if (tag === 'div' || tag === 'section' || tag === 'article' || tag === 'header' || tag === 'footer' || tag === 'main') {
    return `\n\n${normalizeMarkdownBlocks(children())}\n\n`;
  }
  if (tag === 'br') return '  \n';
  if (tag === 'hr') return '\n\n---\n\n';
  if (tag === 'strong' || tag === 'b') return `**${children()}**`;
  if (tag === 'em' || tag === 'i') return `*${children()}*`;
  if (tag === 's' || tag === 'del' || tag === 'strike') return `~~${children()}~~`;

  if (tag === 'code' && element.parentElement?.tagName?.toLowerCase() !== 'pre') {
    return markdownInlineCode(element.textContent || '');
  }

  if (tag === 'pre') {
    const code = element.querySelector(':scope > code');
    const raw = (code || element).textContent || '';
    const className = code?.className || '';
    const language = /(?:^|\s)language-([^\s]+)/.exec(className)?.[1] || '';
    const maxTicks = Math.max(2, ...(raw.match(/`+/g) || []).map(run => run.length));
    const fence = '`'.repeat(maxTicks + 1);
    return `\n\n${fence}${language}\n${raw.replace(/\n+$/, '')}\n${fence}\n\n`;
  }

  if (tag === 'blockquote') {
    const inner = normalizeMarkdownBlocks(children());
    const quoted = inner.split('\n').map(line => line ? `> ${line}` : '>').join('\n');
    return `\n\n${quoted}\n\n`;
  }

  if (tag === 'a') {
    const label = normalizeMarkdownBlocks(children()) || element.getAttribute('href') || '';
    const href = element.getAttribute('href') || '';
    if (!href) return label;
    const title = element.getAttribute('title');
    const safeHref = href.replace(/\)/g, '\\)');
    return `[${label}](${safeHref}${title ? ` "${title.replace(/"/g, '\\"')}"` : ''})`;
  }

  if (tag === 'img') {
    const attrs = meaningfulHtmlAttributes(element);
    const nonMdAttrs = attrs.filter(attr => !['src', 'alt', 'title'].includes(attr.name.toLowerCase()));
    if (nonMdAttrs.length) {
      context.preserved += 1;
      return element.outerHTML;
    }
    const src = element.getAttribute('src') || '';
    const alt = (element.getAttribute('alt') || '').replace(/\]/g, '\\]');
    const title = element.getAttribute('title');
    return `![${alt}](${src}${title ? ` "${title.replace(/"/g, '\\"')}"` : ''})`;
  }

  if (tag === 'ul' || tag === 'ol') {
    return htmlListToMarkdown(element, context, tag === 'ol', 0);
  }

  if (tag === 'li') return children();

  if (tag === 'span' || tag === 'small' || tag === 'label') return children();

  if (tag === 'u' || tag === 'mark' || tag === 'sub' || tag === 'sup' || tag === 'kbd') {
    context.preserved += 1;
    return element.outerHTML;
  }

  const attrs = meaningfulHtmlAttributes(element);
  if (attrs.length) {
    context.preserved += 1;
    return element.outerHTML;
  }

  return children();
}

function htmlListToMarkdown(list, context, ordered, depth = 0) {
  const lines = [];
  const items = [...list.children].filter(child => child.tagName?.toLowerCase() === 'li');
  const orderedStart = ordered ? Math.max(1, Number(list.getAttribute('start') || 1) || 1) : 1;

  items.forEach((item, index) => {
    const nestedLists = [...item.children].filter(child => ['ul', 'ol'].includes(child.tagName.toLowerCase()));
    const clone = item.cloneNode(true);
    [...clone.children].forEach(child => {
      if (['ul', 'ol'].includes(child.tagName.toLowerCase())) child.remove();
    });

    const body = normalizeMarkdownBlocks([...clone.childNodes]
      .map(node => htmlNodeToMarkdown(node, context))
      .join(''))
      .replace(/\n+/g, ' ');

    const explicitValue = Number(item.getAttribute('value'));
    const number = Number.isFinite(explicitValue) && explicitValue > 0 ? explicitValue : orderedStart + index;
    const prefix = ordered ? `${number}. ` : '- ';
    const indent = '  '.repeat(depth);
    lines.push(`${indent}${prefix}${body}`.trimEnd());

    nestedLists.forEach(nested => {
      const nestedText = htmlListToMarkdown(
        nested,
        context,
        nested.tagName.toLowerCase() === 'ol',
        depth + 1
      ).trim();
      if (nestedText) lines.push(nestedText);
    });
  });

  return `\n\n${lines.join('\n')}\n\n`;
}

function htmlNodeToMarkdown(node, context) {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = String(node.nodeValue || '').replace(/\u00a0/g, ' ');
    if (!text.trim()) return /\n/.test(text) ? ' ' : text;
    return markdownEscapeText(text.replace(/[\t\r\n ]+/g, ' '));
  }

  if (node.nodeType === Node.COMMENT_NODE) {
    context.preserved += 1;
    return `\n\n<!--${node.nodeValue || ''}-->\n\n`;
  }

  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  return htmlElementToMarkdown(node, context);
}

function htmlToMarkdownDocument(html = '') {
  const doc = new DOMParser().parseFromString(String(html), 'text/html');
  const context = { preserved: 0 };

  const preservedHead = [...doc.head.children]
    .filter(element => ['style', 'script', 'link'].includes(element.tagName.toLowerCase()))
    .map(element => {
      context.preserved += 1;
      return element.outerHTML;
    })
    .join('\n\n');

  const body = [...doc.body.childNodes]
    .map(node => htmlNodeToMarkdown(node, context))
    .join('');

  return {
    markdown: normalizeMarkdownBlocks([preservedHead, body].filter(Boolean).join('\n\n')),
    preservedCount: context.preserved
  };
}

async function convertCurrentFormat() {
  if (!state.activeId || state.conversionBusy) return;

  state.conversionBusy = true;
  updateTypeUI();

  try {
    if (state.type === 'markdown') {
      const content = getContent();
      const result = await api('/api/render', {
        method: 'POST',
        body: JSON.stringify({ type: 'markdown', content })
      });

      state.type = 'rich';
      updateTypeUI();
      setContent(result.html);
      hideImageInspector();
      updateRichToolbarState();
      markDirty();
      renderPreview();
      focusEditor();
      toast('已转换为富文本');
      return;
    }

    const { markdown, preservedCount } = htmlToMarkdownDocument(getContent());
    state.type = 'markdown';
    updateTypeUI();
    setContent(markdown);
    hideImageInspector();
    updateRichToolbarState();
    markDirty();
    renderPreview();
    focusEditor();

    toast(preservedCount
      ? `已转为 Markdown；${preservedCount} 处复杂 HTML 已原样保留`
      : '已转换为 Markdown');
  } finally {
    state.conversionBusy = false;
    updateTypeUI();
  }
}

function scrollPreviewToTop() {
  try {
    els.previewFrame.contentWindow?.postMessage({
      source: 'note-parent',
      type: 'scroll-top'
    }, '*');
  } catch {}
}

function resetDocumentScroll() {
  els.editor.scrollTop = 0;
  els.editor.scrollLeft = 0;

  els.richEditor.scrollTop = 0;
  els.richEditor.scrollLeft = 0;

  scrollPreviewToTop();

  // contenteditable can re-layout one frame after innerHTML changes.
  requestAnimationFrame(() => {
    els.editor.scrollTop = 0;
    els.richEditor.scrollTop = 0;
    scrollPreviewToTop();

    requestAnimationFrame(() => {
      els.editor.scrollTop = 0;
      els.richEditor.scrollTop = 0;
      scrollPreviewToTop();
    });
  });
}

function setView(view) {
  if (!['edit', 'preview', 'split'].includes(view)) view = 'edit';

  state.view = view;
  localStorage.setItem('note:view', view);
  els.editorArea.className = `editor-area ${view}-view`;

  [els.editTab, els.previewTab, els.splitTab].forEach(btn => btn.classList.remove('active'));
  ({ edit: els.editTab, preview: els.previewTab, split: els.splitTab })[view]
    .classList.add('active');

  if (view !== 'edit') renderPreview();
}

function hideImageInspector() {
  state.selectedImage = null;
  els.imageInspector.hidden = true;
  setToolActive(els.imageBtn, false);

  els.richEditor
    .querySelectorAll('figure.note-image-block.__note-selected')
    .forEach(el => el.classList.remove('__note-selected'));
}

function clearEditor() {
  state.activeId = null;
  state.type = 'rich';
  state.noteLocked = false;
  state.noteUnlocked = false;
  els.titleInput.value = '';
  updateTypeUI();
  setContent('');
  setLockedUi({ locked: false, unlocked: false, folderId: null });
  hideImageInspector();
  renderList();
  resetDocumentScroll();
  renderPreview();
}

async function selectNote(id, { force = false } = {}) {
  if (state.activeId === id && !force) return;
  const previousId = state.activeId;
  if (previousId) rememberDocumentScroll(previousId);
  if (state.dirty) await saveNow();

  const note = await api(`/api/notes/${encodeURIComponent(id)}`, {
    headers: unlockHeaders(id)
  });

  state.activeId = note.id;
  const hasContent = Object.prototype.hasOwnProperty.call(note, 'content');

  if (note.locked && !hasContent) {
    delete state.unlockTokens[note.id];
    state.type = 'rich';
    els.titleInput.value = '已加锁笔记';
    updateTypeUI();
    setContent('');
    resetRichToolbarState();
    state.dirty = false;
    els.saveState.textContent = '已锁定';
    els.saveState.classList.remove('saving');
    setLockedUi({ locked: true, unlocked: false, folderId: note.folderId });
    hideImageInspector();
    renderList();
    resetDocumentScroll();
    await renderPreview();
    return;
  }

  state.type = ['rich', 'markdown', 'html'].includes(note.type)
    ? note.type
    : 'rich';

  els.titleInput.value = note.title;
  updateTypeUI();
  setContent(note.content || '');
  resetRichToolbarState();
  setLockedUi({ locked: Boolean(note.locked), unlocked: Boolean(note.locked), folderId: note.folderId });

  state.dirty = false;
  els.saveState.textContent = note.locked ? '已解锁 · 加密保存' : '已保存';
  els.saveState.classList.remove('saving');

  hideImageInspector();
  renderList();
  await renderPreview();
  restoreDocumentScroll(note.id);
  focusEditor({ preventScroll: true });
  restoreDocumentScroll(note.id);
}

async function createNote({
  title = '未命名笔记',
  type = 'rich',
  content = '',
  folderId = state.activeFolderId
} = {}) {
  if (state.dirty) await saveNow();

  const note = await api('/api/notes', {
    method: 'POST',
    body: JSON.stringify({ title, type, content, folderId })
  });

  await loadFolders();
  await loadNotes(els.searchInput.value);
  await selectNote(note.id, { force: true });
  return note;
}

function markDirty() {
  if (state.type === 'rich' && !state.richHistory.applying) scheduleRichHistoryCommit();
  state.changeSeq += 1;
  state.dirty = true;
  els.saveState.textContent = '正在保存…';
  els.saveState.classList.add('saving');

  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(saveNow, 650);

  clearTimeout(state.previewTimer);
  state.previewTimer = setTimeout(renderPreview, 180);
}

function markDirtyWithoutPreview() {
  if (state.type === 'rich' && !state.richHistory.applying) scheduleRichHistoryCommit();
  state.changeSeq += 1;
  state.dirty = true;
  els.saveState.textContent = '正在保存…';
  els.saveState.classList.add('saving');

  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(saveNow, 650);
}

function applySecureAttachmentUrls(serverContent = '') {
  if (!state.noteLocked || !state.noteUnlocked) return;
  const text = String(serverContent || '');
  const map = new Map();
  const re = /\/api\/notes\/[^/]+\/attachments\/([^?"'\s)>]+)\?token=[^"'\s)>]+/g;
  let match;
  while ((match = re.exec(text))) {
    let name = match[1];
    try { name = decodeURIComponent(name); } catch {}
    map.set(name, match[0]);
  }
  if (!map.size) return;

  if (state.type === 'rich') {
    els.richEditor.querySelectorAll('img[src]').forEach(image => {
      const raw = image.getAttribute('src') || '';
      let pathname = raw;
      try { pathname = new URL(raw, location.href).pathname; } catch {}
      const m = pathname.match(/^\/uploads\/([^?#]+)/);
      if (!m) return;
      let name = m[1];
      try { name = decodeURIComponent(name); } catch {}
      if (map.has(name)) image.setAttribute('src', map.get(name));
    });
  } else if (els.editor.value !== text) {
    const start = els.editor.selectionStart;
    const end = els.editor.selectionEnd;
    els.editor.value = text;
    const max = text.length;
    try { els.editor.setSelectionRange(Math.min(start, max), Math.min(end, max)); } catch {}
  }
}

async function saveNow() {
  clearTimeout(state.saveTimer);
  if (!state.dirty) return;
  if (state.noteLocked && !state.noteUnlocked) return;

  const saveSeq = state.changeSeq;
  const payload = {
    title: els.titleInput.value || '未命名笔记',
    type: state.type,
    content: getContent(),
    folderId: state.activeFolderId
  };

  if (!state.activeId) {
    try {
      const note = await api('/api/notes', {
        method: 'POST',
        body: JSON.stringify(payload)
      });

      state.activeId = note.id;
      state.dirty = state.changeSeq !== saveSeq;
      els.saveState.textContent = state.dirty ? '正在保存…' : '已保存';
      els.saveState.classList.toggle('saving', state.dirty);
      await loadFolders();
      await loadNotes(els.searchInput.value);
      if (state.dirty) {
        clearTimeout(state.saveTimer);
        state.saveTimer = setTimeout(saveNow, 120);
      }
      return;
    } catch (error) {
      els.saveState.textContent = '保存失败';
      toast(error.message);
      return;
    }
  }

  try {
    const note = await api(`/api/notes/${state.activeId}`, {
      method: 'PUT',
      headers: unlockHeaders(state.activeId),
      body: JSON.stringify(payload)
    });

    if (note.locked) applySecureAttachmentUrls(note.content || '');

    state.dirty = state.changeSeq !== saveSeq;
    els.saveState.textContent = state.dirty
      ? '正在保存…'
      : (state.noteLocked ? '已解锁 · 加密保存' : '已保存');
    els.saveState.classList.toggle('saving', state.dirty);

    const index = state.notes.findIndex(item => item.id === note.id);

    if (index >= 0) {
      if (note.locked) {
        state.notes[index] = {
          ...state.notes[index],
          updatedAt: note.updatedAt,
          folderId: note.folderId || null,
          locked: true,
          title: '已加锁笔记',
          summary: '需要密码访问',
          type: 'locked'
        };
      } else {
        const { content, ...meta } = note;
        state.notes[index] = meta;
      }
      state.notes.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      renderList();
    } else {
      await loadNotes(els.searchInput.value);
    }

    if (state.dirty) {
      clearTimeout(state.saveTimer);
      state.saveTimer = setTimeout(saveNow, 120);
    }

    if (state.deferredRemote && !state.dirty) {
      state.deferredRemote = null;
      const latest = await api(`/api/notes/${encodeURIComponent(state.activeId)}`, {
        headers: unlockHeaders(state.activeId)
      }).catch(() => null);
      if (latest && !state.dirty) await applyRemoteActiveNote(latest);
    }
  } catch (error) {
    if (/上锁|密码/.test(String(error.message))) {
      delete state.unlockTokens[state.activeId];
      setLockedUi({ locked: true, unlocked: false, folderId: els.folderSelect.value === 'root' ? null : els.folderSelect.value });
      els.titleInput.value = '已加锁笔记';
      setContent('');
    }
    els.saveState.textContent = '保存失败';
    toast(error.message);
  }
}

const previewCss = `
  :root { color-scheme: dark; }

  * { box-sizing: border-box; }

  html {
    width: 100%;
    min-height: 100%;
    overflow-x: hidden;
    overflow-y: auto;
    overscroll-behavior: contain;
    scrollbar-gutter: stable;
    background: #1d2228;
  }

  body {
    width: 100%;
    min-height: 100%;
    max-width: 820px;
    margin: 0 auto;
    padding: 56px 48px 100px;
    color: #e7ebee;
    font: 16px/1.84 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI",
      "PingFang SC", "Microsoft YaHei", sans-serif;
    overflow-wrap: break-word;
  }

  ::selection {
    background: rgba(127,225,188,.22);
  }

  * {
    scrollbar-width: thin;
    scrollbar-color: rgba(190,202,211,.30) transparent;
  }

  *::-webkit-scrollbar {
    width: 10px;
    height: 10px;
  }

  *::-webkit-scrollbar-track {
    background: transparent;
  }

  *::-webkit-scrollbar-thumb {
    background: rgba(190,202,211,.24);
    border: 2px solid transparent;
    background-clip: padding-box;
    border-radius: 999px;
  }

  *::-webkit-scrollbar-thumb:hover {
    background: rgba(190,202,211,.38);
    border: 2px solid transparent;
    background-clip: padding-box;
  }

  h1,h2,h3,h4 {
    color: #f6f8f9;
    line-height: 1.25;
    letter-spacing: -.025em;
    margin: 1.65em 0 .65em;
  }

  h1 {
    font-size: 2.05em;
    margin-top: .3em;
  }

  h2 {
    font-size: 1.48em;
    padding-bottom: .38em;
    border-bottom: 1px solid rgba(235,241,245,.11);
  }

  h3 { font-size: 1.18em; }

  p { margin: 1em 0; }

  a {
    color: #91ddff;
    text-decoration-thickness: 1px;
    text-underline-offset: 3px;
  }

  blockquote {
    margin: 1.3em 0;
    padding: .2em 1.1em;
    border-left: 2px solid rgba(127,225,188,.72);
    color: #c7cfd5;
    background: rgba(127,225,188,.06);
    border-radius: 0 8px 8px 0;
  }

  img {
    max-width: 100%;
    height: auto;
    border-radius: 10px;
    border: 1px solid rgba(235,241,245,.10);
    box-shadow: 0 12px 30px rgba(0,0,0,.16);
  }

  pre {
    overflow: auto;
    padding: 17px 18px;
    border: 1px solid rgba(235,241,245,.11);
    border-radius: 10px;
    background: #171c21;
    color: #dce3e7;
    font: 13px/1.75 "SFMono-Regular", Consolas, monospace;
    white-space: pre-wrap;
  }

  code:not(pre code) {
    padding: 2px 5px;
    border-radius: 5px;
    background: rgba(255,255,255,.075);
    color: #b3ecd7;
    font-size: .88em;
  }

  table {
    border-collapse: collapse;
    width: 100%;
  }

  th,td {
    border: 1px solid rgba(235,241,245,.11);
    padding: 8px 10px;
    text-align: left;
  }

  th {
    color: #f0f3f5;
    background: rgba(255,255,255,.035);
  }

  hr {
    border: 0;
    border-top: 1px solid rgba(235,241,245,.11);
    margin: 2em 0;
  }

  figure.note-image-block {
    position: relative;
    display: flex;
    width: 100%;
    margin: .82em 0;
    padding: 0;
  }

  figure.note-image-block[data-note-align="left"] { justify-content: flex-start; }
  figure.note-image-block[data-note-align="center"] { justify-content: center; }
  figure.note-image-block[data-note-align="right"] { justify-content: flex-end; }

  figure.note-image-block img {
    width: var(--note-image-width, 70%);
    max-width: 100%;
    height: auto;
    margin: 0;
    cursor: pointer;
  }

  figure.note-book-capture {
    flex-direction: column;
    align-items: flex-start;
    gap: 7px;
    margin-top: .72em;
    margin-bottom: .72em;
  }

  figure.note-book-capture[data-note-align="left"] { align-items: flex-start; }
  figure.note-book-capture[data-note-align="center"] { align-items: center; }
  figure.note-book-capture[data-note-align="right"] { align-items: flex-end; }

  .note-book-source {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
    margin: 0;
    padding: 8px 10px;
    border: 1px solid rgba(235,241,245,.10);
    border-radius: 8px;
    background: rgba(255,255,255,.035);
    color: #98a3ad;
    font: 11px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;
  }

  figure.note-book-capture .note-book-source { width: var(--note-image-width, 82%); }
  .note-book-excerpt { margin: 1.1em 0; }
  .note-book-excerpt-text { margin: 0 0 9px; }
  .note-web-excerpt-image { display: block; margin: 10px 0; line-height: 0; }
  .note-web-excerpt-image img {
    display: block;
    max-width: min(100%, 920px);
    max-height: 70vh;
    width: auto;
    height: auto;
    object-fit: contain;
    border-radius: 6px;
  }
  :is(figure.note-book-capture, .note-book-excerpt) + p:has(> br:only-child),
  p:has(> br:only-child):has(+ :is(figure.note-book-capture, .note-book-excerpt)) {
    min-height: 0;
    margin: .12em 0;
    line-height: .35;
  }

  .note-book-source-meta { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .note-book-source-link { flex: 0 0 auto; color: #9dc0f7 !important; font-weight: 650; text-decoration: none !important; }
  .note-book-source-link:hover { text-decoration: underline !important; text-underline-offset: 3px; }

  @media print {
    :root { color-scheme: light; }

    html,
    body {
      background: white !important;
      color: #222 !important;
    }

    body {
      max-width: none;
      padding: 0;
    }

    h1,h2,h3,h4 {
      color: #111 !important;
    }

    blockquote {
      color: #444 !important;
      background: #f5f7f6 !important;
      border-left-color: #719f8d !important;
    }

    pre {
      color: #222 !important;
      background: #f5f5f5 !important;
      border-color: #ddd !important;
    }

    code:not(pre code) {
      color: #333 !important;
      background: #f0f0f0 !important;
    }

    a {
      color: inherit;
      text-decoration: none;
    }
  }
`;

const previewBridgeCss = `
  figure.note-image-block.__note-selected img {
    outline: 3px solid rgba(46,101,79,.28);
    outline-offset: 4px;
  }
`;

const previewBridgeScript = `
(() => {
  const send = (payload) => parent.postMessage({ source: 'note-preview', ...payload }, '*');

  function clearSelection() {
    document.querySelectorAll('figure.note-image-block.__note-selected')
      .forEach(el => el.classList.remove('__note-selected'));
  }

  let scrollRaf = 0;
  window.addEventListener('scroll', () => {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0;
      send({ type: 'scroll-position', top: window.scrollY || 0 });
    });
  }, { passive: true });

  document.addEventListener('click', (event) => {
    const sourceLink = event.target.closest('a[data-shufang-open]');
    if (sourceLink) return;

    const image = event.target.closest('figure.note-image-block img');

    if (!image) {
      clearSelection();
      send({ type: 'image-clear' });
      return;
    }

    const figure = image.closest('figure.note-image-block');
    const id = figure?.dataset.noteImageId;
    if (!id) return;

    event.preventDefault();
    event.stopPropagation();

    clearSelection();
    figure.classList.add('__note-selected');

    send({
      type: 'image-select',
      id,
      width: Number(figure.dataset.noteWidth || 70),
      align: figure.dataset.noteAlign || 'left'
    });
  }, true);

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.source !== 'note-parent') return;

    if (data.type === 'scroll-top') {
      window.scrollTo(0, 0);
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
      return;
    }

    if (data.type === 'restore-scroll') {
      const top = Math.max(0, Number(data.top) || 0);
      requestAnimationFrame(() => window.scrollTo(0, top));
      return;
    }

    if (data.type !== 'image-update') return;

    const figure = [...document.querySelectorAll('figure.note-image-block')]
      .find(el => el.dataset.noteImageId === data.id);
    if (!figure) return;

    figure.dataset.noteWidth = String(data.width);
    figure.dataset.noteAlign = data.align;
    figure.style.setProperty('--note-image-width', data.width + '%');
  });
})();
`;

function wrapPreview(inner) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${previewCss}</style>
</head>
<body>${inner}</body>
</html>`;
}

function injectBeforeClose(html, snippet) {
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, `${snippet}</body>`);
  if (/<\/html>/i.test(html)) return html.replace(/<\/html>/i, `${snippet}</html>`);
  return `${html}${snippet}`;
}

function decoratePreviewDocument(html) {
  return injectBeforeClose(
    html,
    `<style>${previewBridgeCss}</style><script>${previewBridgeScript}<\/script>`
  );
}

function prepareHtmlDocument(html) {
  if (/<!doctype\s+html/i.test(html) || /<html[\s>]/i.test(html)) return html;
  return wrapPreview(html);
}

async function renderPreview() {
  try {
    const result = await api('/api/render', {
      method: 'POST',
      body: JSON.stringify({ type: state.type, content: getContent() })
    });

    state.exportHtml = ['html', 'rich'].includes(state.type)
      ? prepareHtmlDocument(result.html)
      : wrapPreview(result.html);

    state.previewHtml = decoratePreviewDocument(state.exportHtml);
    els.previewFrame.srcdoc = state.previewHtml;
  } catch (error) {
    state.exportHtml = wrapPreview(`<pre>${escapeHtml(error.message)}</pre>`);
    state.previewHtml = decoratePreviewDocument(state.exportHtml);
    els.previewFrame.srcdoc = state.previewHtml;
  }
}

function insertText(before, after = '', fallback = '') {
  const el = els.editor;
  const start = el.selectionStart;
  const end = el.selectionEnd;
  const selected = el.value.slice(start, end) || fallback;

  el.setRangeText(before + selected + after, start, end, 'end');
  el.focus();
  markDirty();
}

function saveRichSelection() {
  if (state.type !== 'rich') return;

  const selection = window.getSelection();
  if (!selection?.rangeCount) return;

  const range = selection.getRangeAt(0);
  if (els.richEditor.contains(range.commonAncestorContainer)) {
    state.richRange = range.cloneRange();
  }
}

function restoreRichSelection() {
  if (state.type !== 'rich' || !state.richRange) return false;

  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(state.richRange);
  return true;
}

function execRich(command, value = null) {
  commitRichHistoryNow();
  els.richEditor.focus();
  restoreRichSelection();
  document.execCommand(command, false, value);
  saveRichSelection();
  updateRichToolbarState();
  markDirty();
}

function insertRichHtml(html) {
  commitRichHistoryNow();
  els.richEditor.focus();
  restoreRichSelection();

  if (!document.execCommand('insertHTML', false, html)) {
    const selection = window.getSelection();

    if (selection?.rangeCount) {
      const range = selection.getRangeAt(0);
      range.deleteContents();
      range.insertNode(range.createContextualFragment(html));
      range.collapse(false);
    } else {
      els.richEditor.insertAdjacentHTML('beforeend', html);
    }
  }

  lockBookCaptureMetadata();
  saveRichSelection();
  markDirty();
}

function runRichTool(action) {
  if (action === 'undo') {
    undoRichHistory();
    return;
  }
  if (action === 'redo') {
    redoRichHistory();
    return;
  }
  if (['h2', 'quote', 'link', 'code'].includes(action)) commitRichHistoryNow();
  if (action === 'h2') {
    els.richEditor.focus();
    restoreRichSelection();

    const inH2 = Boolean(richAncestor('h2'));
    document.execCommand('formatBlock', false, inH2 ? 'p' : 'h2');

    saveRichSelection();
    updateRichToolbarState();
    markDirty();
    return;
  }
  if (action === 'bold') {
    execRich('bold');
    updateRichToolbarState();
    return;
  }
  if (action === 'italic') {
    execRich('italic');
    updateRichToolbarState();
    return;
  }
  if (action === 'quote') {
    els.richEditor.focus();
    restoreRichSelection();

    const quote = richAncestor('blockquote');
    document.execCommand('formatBlock', false, quote ? 'p' : 'blockquote');

    saveRichSelection();
    updateRichToolbarState();
    markDirty();
    return;
  }
  if (action === 'link') {
    els.richEditor.focus();
    restoreRichSelection();

    if (richAncestor('a')) {
      document.execCommand('unlink');
      saveRichSelection();
      updateRichToolbarState();
      markDirty();
      return;
    }

    saveRichSelection();
    const url = window.prompt('输入链接地址：', 'https://');
    if (!url) {
      updateRichToolbarState();
      return;
    }

    restoreRichSelection();
    document.execCommand('createLink', false, url);
    saveRichSelection();
    updateRichToolbarState();
    markDirty();
    return;
  }

  if (action === 'code') {
    els.richEditor.focus();
    restoreRichSelection();

    const pre = richAncestor('pre');

    if (pre) {
      const paragraph = document.createElement('p');
      paragraph.textContent = pre.textContent || '';
      pre.replaceWith(paragraph);

      placeCaretAtStart(paragraph);
      updateRichToolbarState();
      markDirty();
      return;
    }

    const selection = window.getSelection();
    const text = selection?.toString() || 'const value = 1;';
    insertRichHtml(`<pre><code>${escapeHtml(text)}</code></pre><p><br></p>`);
    updateRichToolbarState();
  }
}

function toggleSourceWrap(before, after, fallback) {
  const el = els.editor;
  let start = el.selectionStart;
  let end = el.selectionEnd;
  const value = el.value;
  let selected = value.slice(start, end);

  if (!selected) selected = fallback;

  const directlyWrapped = selected.startsWith(before) && selected.endsWith(after) && selected.length >= before.length + after.length;
  const surroundingWrapped =
    start >= before.length &&
    value.slice(start - before.length, start) === before &&
    value.slice(end, end + after.length) === after;

  if (directlyWrapped) {
    const unwrapped = selected.slice(before.length, selected.length - after.length);
    el.setRangeText(unwrapped, start, end, 'select');
  } else if (surroundingWrapped) {
    const unwrapped = value.slice(start, end);
    el.setRangeText(unwrapped, start - before.length, end + after.length, 'select');
    el.selectionStart = start - before.length;
    el.selectionEnd = end - before.length;
  } else {
    el.setRangeText(before + selected + after, start, end, 'select');
    el.selectionStart = start + before.length;
    el.selectionEnd = start + before.length + selected.length;
  }

  el.focus();
  markDirty();
}

function toggleMarkdownLinePrefix(prefix, fallback) {
  const el = els.editor;
  const value = el.value;
  let start = el.selectionStart;
  let end = el.selectionEnd;

  if (start === end && !value) {
    el.setRangeText(`${prefix}${fallback}`, start, end, 'end');
    el.focus();
    markDirty();
    return;
  }

  const lineStart = value.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
  const nextBreak = value.indexOf('\n', end);
  const lineEnd = nextBreak === -1 ? value.length : nextBreak;
  const block = value.slice(lineStart, lineEnd);
  const lines = block.split('\n');
  const nonBlank = lines.filter(line => line.trim());
  const remove = nonBlank.length > 0 && nonBlank.every(line => line.startsWith(prefix));
  const updated = lines.map(line => {
    if (!line.trim()) return line;
    return remove ? line.slice(prefix.length) : `${prefix}${line}`;
  }).join('\n');

  el.setRangeText(updated, lineStart, lineEnd, 'select');
  el.focus();
  markDirty();
}

function runSourceTool(action) {
  if (action === 'undo' || action === 'redo') {
    els.editor.focus();
    toast(action === 'undo' ? 'Ctrl+Z：撤销' : 'Ctrl+Y：重做');
    return;
  }

  if (state.type === 'html') {
    const htmlToggleTools = {
      h2: ['<h2>', '</h2>', '标题'],
      bold: ['<strong>', '</strong>', '加粗文字'],
      italic: ['<em>', '</em>', '斜体文字'],
      quote: ['<blockquote>', '</blockquote>', '引用文字']
    };

    if (htmlToggleTools[action]) {
      const [before, after, fallback] = htmlToggleTools[action];
      toggleSourceWrap(before, after, fallback);
      return;
    }

    const htmlTools = {
      code: ['<pre><code>', '</code></pre>', 'const value = 1;'],
      link: ['<a href="https://">', '</a>', '链接文字']
    };
    const [before, after, fallback] = htmlTools[action];
    insertText(before, after, fallback);
    return;
  }

  if (action === 'h2') {
    toggleMarkdownLinePrefix('## ', '标题');
    return;
  }

  if (action === 'quote') {
    toggleMarkdownLinePrefix('> ', '引用文字');
    return;
  }

  if (action === 'bold') {
    toggleSourceWrap('**', '**', '加粗文字');
    return;
  }

  if (action === 'italic') {
    toggleSourceWrap('*', '*', '斜体文字');
    return;
  }

  const markdownTools = {
    code: ['```js\n', '\n```', 'const value = 1;'],
    link: ['[', '](https://)', '链接文字']
  };
  const [before, after, fallback] = markdownTools[action];
  insertText(before, after, fallback);
}

function runTool(action) {
  state.type === 'rich' ? runRichTool(action) : runSourceTool(action);
}

function makeImageId() {
  if (window.crypto?.randomUUID) return `img-${window.crypto.randomUUID()}`;
  return `img-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function imageMarkup({ id, src, alt, width = 70, align = 'left', source = null }) {
  const safeSrc = escapeHtml(src || '');
  const safeAlt = escapeHtml(alt || '');

  if (source?.hash) {
    const page = Math.max(1, Math.floor(Number(source.page) || 1));
    const totalPages = Math.max(0, Math.floor(Number(source.totalPages) || 0));
    const crop = String(source.crop || '');
    const origin = String(source.origin || 'http://127.0.0.1:39271');
    const title = String(source.title || '未命名书籍');
    const relativePath = String(source.relativePath || '');
    const mode = source.mode === 'crop' ? 'crop' : 'page';
    const params = new URLSearchParams({ page: String(page), from: 'note' });
    if (crop) params.set('crop', crop);
    const href = `${origin}/reader/${encodeURIComponent(source.hash)}?${params.toString()}`;
    const pageLabel = totalPages ? `第 ${page} / ${totalPages} 页` : `第 ${page} 页`;
    const modeLabel = mode === 'crop' ? '框选截图' : '整页截图';

    return `<figure class="note-image-block note-book-capture" contenteditable="false" data-note-atomic="1" data-note-image-id="${id}" data-note-width="${width}" data-note-align="${align}" style="--note-image-width:${width}%" data-shufang-hash="${escapeHtml(source.hash)}" data-shufang-page="${page}" data-shufang-total-pages="${totalPages}" data-shufang-title="${escapeHtml(title)}" data-shufang-relative-path="${escapeHtml(relativePath)}" data-shufang-crop="${escapeHtml(crop)}" data-shufang-origin="${escapeHtml(origin)}" data-shufang-mode="${mode}"><img src="${safeSrc}" alt="${safeAlt}"><figcaption class="note-book-source" contenteditable="false" data-note-readonly="1"><span class="note-book-source-meta">${escapeHtml(title)} · ${pageLabel} · ${modeLabel}</span><a class="note-book-source-link" href="${escapeHtml(href)}" target="_blank" rel="noreferrer" data-shufang-open="1" contenteditable="false">打开原书 ↗</a></figcaption></figure>`;
  }

  return `<figure class="note-image-block" data-note-image-id="${id}" data-note-width="${width}" data-note-align="${align}" style="--note-image-width:${width}%"><img src="${safeSrc}" alt="${safeAlt}"></figure>`;
}


function dataUrlToFile(dataUrl, filename = 'pasted-image.png') {
  const [header, encoded] = String(dataUrl).split(',');
  const mime = header?.match(/data:([^;]+)/i)?.[1] || 'image/png';
  const binary = atob(encoded || '');
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  const extMap = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp'
  };

  const ext = extMap[mime] || '.png';
  const cleanName = filename.replace(/\.[^.]+$/, '') || 'pasted-image';

  return new File(
    [bytes],
    `${cleanName}${ext}`,
    { type: mime }
  );
}

async function uploadImageFileOnly(file) {
  const form = new FormData();
  form.append('image', file);

  if (state.activeId && state.noteLocked && state.noteUnlocked) {
    return api(`/api/notes/${encodeURIComponent(state.activeId)}/upload`, {
      method: 'POST',
      headers: unlockHeaders(state.activeId),
      body: form
    });
  }

  return api('/api/upload', {
    method: 'POST',
    body: form
  });
}

function parseNoteImageBlocksFromHtml(html) {
  if (!html || !html.includes('note-image-block')) return [];

  const doc = new DOMParser().parseFromString(html, 'text/html');

  return [...doc.querySelectorAll('figure.note-image-block')].map(figure => {
    const image = figure.querySelector('img');
    if (!image) return null;

    const rawWidth =
      figure.dataset.noteWidth ||
      figure.style.getPropertyValue('--note-image-width') ||
      '70';

    const width = Math.max(
      20,
      Math.min(100, parseInt(String(rawWidth).replace('%', ''), 10) || 70)
    );

    const align = ['left', 'center', 'right'].includes(figure.dataset.noteAlign)
      ? figure.dataset.noteAlign
      : 'left';

    const source = figure.dataset.shufangHash ? {
      hash: figure.dataset.shufangHash,
      page: Number(figure.dataset.shufangPage || 1),
      totalPages: Number(figure.dataset.shufangTotalPages || 0),
      title: figure.dataset.shufangTitle || '',
      relativePath: figure.dataset.shufangRelativePath || '',
      crop: figure.dataset.shufangCrop || '',
      origin: figure.dataset.shufangOrigin || 'http://127.0.0.1:39271',
      mode: figure.dataset.shufangMode === 'crop' ? 'crop' : 'page'
    } : null;

    return {
      src: image.getAttribute('src') || '',
      alt: image.getAttribute('alt') || '',
      width,
      align,
      source
    };
  }).filter(Boolean);
}

async function rebuildClipboardImageBlock(block) {
  let src = block.src;

  // 剪贴板中的本地图片会被我们转换成 data URL。
  // 再粘回 Note 时重新上传为正常 uploads 文件，避免把大段 base64 写进 notes.json。
  if (src.startsWith('data:image/')) {
    const file = dataUrlToFile(
      src,
      block.alt || 'pasted-image.png'
    );

    const result = await uploadImageFileOnly(file);
    src = new URL(result.url, location.href).href;
  } else {
    try {
      const url = new URL(src, location.href);

      // 加锁笔记的附件 URL 带临时 token，不能原样复制到另一处。
      // 重新读取图片并走当前笔记自己的上传流程，避免留下过期 token。
      if (
        url.origin === location.origin &&
        /^\/api\/notes\/[^/]+\/attachments\//.test(url.pathname)
      ) {
        const response = await fetch(url.href, { cache: 'no-store' });
        if (!response.ok) throw new Error('原加密图片已失效，请先解锁原笔记');
        const blob = await response.blob();
        const filename = decodeURIComponent(url.pathname.split('/').pop() || block.alt || 'pasted-image.png');
        const file = new File([blob], filename, { type: blob.type || 'image/png' });
        const result = await uploadImageFileOnly(file);
        src = new URL(result.url, location.href).href;
      // 如果仍然是当前 Note 的普通本地图片地址，直接复用。
      } else if (
        url.origin === location.origin &&
        url.pathname.startsWith('/uploads/')
      ) {
        src = url.href;
      }
    } catch {}
  }

  return imageMarkup({
    id: makeImageId(),
    src,
    alt: block.alt,
    width: block.width,
    align: block.align,
    source: block.source || null
  });
}

async function pasteNoteImageBlocksFromClipboard(event) {
  const html = event.clipboardData?.getData('text/html') || '';
  const blocks = parseNoteImageBlocksFromHtml(html);

  if (!blocks.length) return false;

  event.preventDefault();

  try {
    const rebuilt = [];

    for (const block of blocks) {
      rebuilt.push(await rebuildClipboardImageBlock(block));
    }

    if (state.type === 'rich') {
      saveRichSelection();
      insertRichHtml(rebuilt.join('<p><br></p>') + '<p><br></p>');
    } else {
      insertText(rebuilt.join('\n\n'), '', '');
    }

    toast('图片已粘贴，并保留原来的大小和位置');
    return true;
  } catch (error) {
    console.error(error);
    toast(`粘贴图片失败：${error.message}`);
    return false;
  }
}

async function uploadImage(file) {
  const result = await uploadImageFileOnly(file);
  const absolute = new URL(result.url, location.href).href;

  const markup = imageMarkup({
    id: makeImageId(),
    src: absolute,
    alt: file.name,
    width: 70,
    align: 'left'
  });

  if (state.type === 'rich') {
    insertRichHtml(markup + '<p><br></p>');
    toast('图片已插入；点击图片可调整大小和位置');
  } else {
    insertText(markup, '', '');
    toast('图片已插入；点击右侧预览图片可调整大小和位置');
  }
}

async function importHtmlFile(file) {
  const html = await file.text();
  const title = file.name.replace(/\.html?$/i, '') || 'HTML 页面';

  const note = await createNote({ title, type: 'html', content: html });
  toast(`已导入 ${file.name}`);
  await selectNote(note.id);
}

function showImageInspector(image) {
  state.selectedImage = {
    id: image.id,
    width: Number(image.width || 70),
    align: image.align || 'left',
    source: image.source || 'preview'
  };

  els.imageInspector.hidden = false;
  setToolActive(
    els.imageBtn,
    state.type === 'rich' && state.selectedImage.source === 'rich'
  );
  els.imageSizeInput.value = String(state.selectedImage.width);
  els.imageSizeValue.value = `${state.selectedImage.width}%`;

  els.imageAlignButtons.forEach(btn => {
    btn.classList.toggle(
      'active',
      btn.dataset.imageAlign === state.selectedImage.align
    );
  });
}

function updateRichImage(id, width, align) {
  const figure = [...els.richEditor.querySelectorAll('figure.note-image-block')]
    .find(el => el.dataset.noteImageId === id);

  if (!figure) return false;

  figure.dataset.noteWidth = String(width);
  figure.dataset.noteAlign = align;
  figure.style.setProperty('--note-image-width', `${width}%`);
  figure.classList.add('__note-selected');

  markDirtyWithoutPreview();
  return true;
}

function updateSourceImage(id, width, align) {
  const regex = new RegExp(
    `<figure\\b[^>]*data-note-image-id=["']${escapeRegExp(id)}["'][^>]*>`,
    'i'
  );

  if (!regex.test(els.editor.value)) return false;

  els.editor.value = els.editor.value.replace(regex, openingTag => {
    let next = openingTag;
    const setAttr = (name, value) => {
      const attr = new RegExp(`\\s${escapeRegExp(name)}=["'][^"']*["']`, 'i');
      if (attr.test(next)) next = next.replace(attr, ` ${name}="${value}"`);
      else next = next.replace(/>$/, ` ${name}="${value}">`);
    };

    setAttr('data-note-width', String(width));
    setAttr('data-note-align', align);

    const styleMatch = next.match(/\sstyle=["']([^"']*)["']/i);
    let style = styleMatch ? styleMatch[1] : '';
    if (/--note-image-width\s*:/i.test(style)) {
      style = style.replace(/--note-image-width\s*:\s*[^;]+;?/i, `--note-image-width:${width}%;`);
    } else {
      style = `${style}${style && !style.trim().endsWith(';') ? ';' : ''}--note-image-width:${width}%;`;
    }
    setAttr('style', style);
    return next;
  });

  markDirtyWithoutPreview();
  return true;
}

function updateImage(id, width, align) {
  const safeWidth = Math.max(20, Math.min(100, Number(width) || 70));
  const safeAlign = ['left', 'center', 'right'].includes(align) ? align : 'left';

  const found = state.type === 'rich'
    ? updateRichImage(id, safeWidth, safeAlign)
    : updateSourceImage(id, safeWidth, safeAlign);

  if (!found) {
    toast('没有在正文中找到这张图片');
    return false;
  }

  state.selectedImage = {
    id,
    width: safeWidth,
    align: safeAlign,
    source: state.type === 'rich' ? 'rich' : 'preview'
  };

  els.imageSizeInput.value = String(safeWidth);
  els.imageSizeValue.value = `${safeWidth}%`;

  els.imageAlignButtons.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.imageAlign === safeAlign);
  });

  els.previewFrame.contentWindow?.postMessage({
    source: 'note-parent',
    type: 'image-update',
    id,
    width: safeWidth,
    align: safeAlign
  }, '*');

  return true;
}


async function blobToPngBlob(blob) {
  if (blob.type === 'image/png') return blob;

  try {
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');

    canvas.width = bitmap.width;
    canvas.height = bitmap.height;

    const context = canvas.getContext('2d');
    context.drawImage(bitmap, 0, 0);

    bitmap.close?.();

    return await new Promise((resolve, reject) => {
      canvas.toBlob(
        result => result ? resolve(result) : reject(new Error('图片转换失败')),
        'image/png'
      );
    });
  } catch {
    return null;
  }
}

async function portableClipboardHtml(html) {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = html;

  const images = [...wrapper.querySelectorAll('img[src]')];

  await Promise.all(images.map(async image => {
    try {
      const raw = image.getAttribute('src');
      if (!raw || raw.startsWith('data:') || raw.startsWith('blob:')) return;

      const url = new URL(raw, location.href);

      // Note 本地上传图片在离开当前应用后不能依赖 localhost 地址，
      // 所以复制 / 剪切时转成 data URL。
      const localNoteImage = url.pathname.startsWith('/uploads/') ||
        /\/api\/notes\/[^/]+\/attachments\//.test(url.pathname);
      if (url.origin !== location.origin || !localNoteImage) {
        return;
      }

      const response = await fetch(url.href);
      if (!response.ok) return;

      const dataUrl = await blobToDataURL(await response.blob());
      image.setAttribute('src', dataUrl);
    } catch {}
  }));

  return wrapper.innerHTML;
}

async function writeRichClipboard({
  html,
  text = '',
  imageBlob = null
}) {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
    throw new Error('当前浏览器不支持高级剪贴板');
  }

  const portableHtml = await portableClipboardHtml(html);

  const clipboardPayload = {
    'text/html': new Blob([portableHtml], { type: 'text/html' }),
    'text/plain': new Blob([text || ''], { type: 'text/plain' })
  };

  if (imageBlob) {
    const png = await blobToPngBlob(imageBlob);
    if (png) clipboardPayload['image/png'] = png;
  }

  await navigator.clipboard.write([
    new ClipboardItem(clipboardPayload)
  ]);
}

function selectedRichFigure() {
  if (
    state.type !== 'rich' ||
    !state.selectedImage ||
    state.selectedImage.source !== 'rich'
  ) {
    return null;
  }

  return [...els.richEditor.querySelectorAll('figure.note-image-block')]
    .find(el => el.dataset.noteImageId === state.selectedImage.id) || null;
}

function fallbackNativeCutFigure(figure) {
  const range = document.createRange();
  range.selectNode(figure);

  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);

  const ok = document.execCommand('cut');

  selection.removeAllRanges();

  if (ok) {
    hideImageInspector();
    markDirty();
  }

  return ok;
}

function fallbackNativeCopyFigure(figure) {
  const range = document.createRange();
  range.selectNode(figure);

  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);

  const ok = document.execCommand('copy');

  selection.removeAllRanges();

  return ok;
}

async function clipboardImageBlobFromFigure(figure) {
  const image = figure.querySelector('img[src]');
  if (!image) return null;

  try {
    const url = new URL(image.getAttribute('src'), location.href);
    const response = await fetch(url.href);

    if (!response.ok) return null;
    return await response.blob();
  } catch {
    return null;
  }
}

async function copySelectedRichImage() {
  const figure = selectedRichFigure();
  if (!figure) return false;

  try {
    const image = figure.querySelector('img');
    const imageBlob = await clipboardImageBlobFromFigure(figure);

    await writeRichClipboard({
      html: figure.outerHTML,
      text: image?.alt || '',
      imageBlob
    });

    toast('图片已复制到剪贴板');
    return true;
  } catch (error) {
    console.warn('Advanced image copy failed:', error);

    if (fallbackNativeCopyFigure(figure)) {
      toast('图片已复制');
      return true;
    }

    toast('复制图片失败');
    return false;
  }
}

async function cutSelectedRichImage() {
  const figure = selectedRichFigure();
  if (!figure) return false;

  try {
    const image = figure.querySelector('img');
    const imageBlob = await clipboardImageBlobFromFigure(figure);

    await writeRichClipboard({
      html: figure.outerHTML,
      text: image?.alt || '',
      imageBlob
    });

    const next = document.createElement('p');
    next.innerHTML = '<br>';

    figure.replaceWith(next);
    placeCaretAtStart(next);

    hideImageInspector();
    updateRichToolbarState();
    markDirty();

    toast('图片已剪切，可粘贴到其他位置');
    return true;
  } catch (error) {
    console.warn('Advanced image cut failed:', error);

    if (fallbackNativeCutFigure(figure)) {
      toast('图片已剪切');
      return true;
    }

    toast('剪切图片失败');
    return false;
  }
}

function richSelectionSnapshot() {
  if (state.type !== 'rich') return null;

  const selection = window.getSelection();
  if (!selection?.rangeCount) return null;

  const range = selection.getRangeAt(0);

  if (
    range.collapsed ||
    !els.richEditor.contains(range.commonAncestorContainer)
  ) {
    return null;
  }

  const fragment = range.cloneContents();
  const wrapper = document.createElement('div');
  wrapper.appendChild(fragment);

  return {
    range: range.cloneRange(),
    html: wrapper.innerHTML,
    text: range.toString(),
    containsImage: Boolean(wrapper.querySelector('img'))
  };
}

async function cutRichSelectionWithImages(snapshot) {
  try {
    const firstImage = (() => {
      const wrapper = document.createElement('div');
      wrapper.innerHTML = snapshot.html;
      return wrapper.querySelector('img[src]');
    })();

    let imageBlob = null;

    if (firstImage) {
      try {
        const url = new URL(firstImage.getAttribute('src'), location.href);
        const response = await fetch(url.href);
        if (response.ok) imageBlob = await response.blob();
      } catch {}
    }

    await writeRichClipboard({
      html: snapshot.html,
      text: snapshot.text,
      imageBlob
    });

    snapshot.range.deleteContents();

    const paragraph = document.createElement('p');
    paragraph.innerHTML = '<br>';
    snapshot.range.insertNode(paragraph);
    placeCaretAtStart(paragraph);

    hideImageInspector();
    updateRichToolbarState();
    markDirty();

    toast('内容已剪切，可粘贴到其他位置');
    return true;
  } catch (error) {
    console.warn('Advanced rich cut failed:', error);
    return false;
  }
}

function filenameSafe(text) {
  return String(text || 'note')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'note';
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function buildPortableHtml({ removeSourceLinks = true } = {}) {
  await renderPreview();

  const doc = new DOMParser().parseFromString(state.exportHtml, 'text/html');

  // 导出结果是脱离书房运行环境的静态文档，“打开原书”没有实际意义。
  // 只从导出的 DOM 副本中移除链接，Note 编辑器里的来源栏仍保留回跳能力。
  if (removeSourceLinks) doc.querySelectorAll('.note-book-source-link').forEach(link => link.remove());

  const images = [...doc.querySelectorAll('img[src]')];

  await Promise.all(images.map(async image => {
    try {
      const raw = image.getAttribute('src');
      if (!raw || raw.startsWith('data:') || raw.startsWith('blob:')) return;

      const url = new URL(raw, location.href);
      const localImage = url.pathname.startsWith('/uploads/') || /\/api\/notes\/[^/]+\/attachments\//.test(url.pathname);
      if (url.origin !== location.origin || !localImage) return;

      const response = await fetch(url.href);
      if (!response.ok) return;

      image.setAttribute('src', await blobToDataURL(await response.blob()));
    } catch {}
  }));

  return '<!doctype html>\n' + doc.documentElement.outerHTML;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

async function exportHtml() {
  if (state.dirty) await saveNow();

  downloadBlob(
    new Blob([await buildPortableHtml()], { type: 'text/html;charset=utf-8' }),
    `${filenameSafe(els.titleInput.value)}.html`
  );

  toast('HTML 已导出');
}

function preparePrintableHtml(html) {
  const doc = new DOMParser().parseFromString(html || '', 'text/html');

  // PDF 导出只需要静态结果，不应该在打印窗口再次执行用户脚本。
  doc.querySelectorAll('script').forEach(node => node.remove());

  // 移除内联事件，避免打印窗口加载时触发交互代码。
  doc.querySelectorAll('*').forEach(element => {
    [...element.attributes].forEach(attribute => {
      if (/^on/i.test(attribute.name)) {
        element.removeAttribute(attribute.name);
      }
    });
  });

  // 强制加入打印友好的样式；保留正文中的原有 CSS。
  const style = doc.createElement('style');
  style.textContent = `
    @page {
      margin: 16mm 15mm 18mm;
    }

    html {
      background: #fff !important;
    }

    body {
      background: #fff !important;
      color: #222 !important;
      max-width: 100% !important;
      min-height: 0 !important;
      padding: 0 !important;
      margin: 0 auto !important;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }

    h1, h2, h3, h4, h5, h6 {
      color: #111 !important;
      break-after: avoid-page;
    }

    p, li, blockquote, pre, table, figure {
      break-inside: avoid-page;
    }

    a {
      color: inherit !important;
    }

    img {
      max-width: 100% !important;
      height: auto !important;
    }

    blockquote {
      color: #444 !important;
      background: #f5f7f6 !important;
      border-left-color: #719f8d !important;
    }

    pre {
      color: #222 !important;
      background: #f5f5f5 !important;
      border-color: #ddd !important;
      white-space: pre-wrap !important;
    }

    code:not(pre code) {
      color: #333 !important;
      background: #f0f0f0 !important;
    }

    .note-book-source {
      display: flex !important;
      align-items: center !important;
      justify-content: space-between !important;
      gap: 12px !important;
      padding: 7px 9px !important;
      border: 1px solid #d9dfe5 !important;
      border-radius: 6px !important;
      background: #f7f8f9 !important;
      color: #68727c !important;
      font: 9.5pt/1.45 ui-monospace,SFMono-Regular,Consolas,monospace !important;
    }
    .note-book-source-link { color: #3f5f88 !important; text-decoration: none !important; }
    figure.note-book-capture { margin: .65em 0 !important; }
    .note-book-excerpt { break-inside: avoid-page; margin: .7em 0 !important; }
    .note-book-excerpt-text { margin-bottom: 8px !important; }
    .note-web-excerpt-image { display: block !important; margin: 8px 0 !important; line-height: 0 !important; }
    .note-web-excerpt-image img {
      display: block !important;
      max-width: 100% !important;
      max-height: none !important;
      width: auto !important;
      height: auto !important;
      object-fit: contain !important;
    }

    @media screen {
      body {
        padding: 32px !important;
      }
    }
  `;

  doc.head.appendChild(style);

  return '<!doctype html>\n' + doc.documentElement.outerHTML;
}

function waitForPrintAssets(printWindow) {
  const documentRef = printWindow.document;
  const images = [...documentRef.images];

  const imagePromises = images.map(image => {
    if (image.complete) return Promise.resolve();

    return new Promise(resolve => {
      const done = () => resolve();
      image.addEventListener('load', done, { once: true });
      image.addEventListener('error', done, { once: true });
      setTimeout(done, 3000);
    });
  });

  const fontPromise = documentRef.fonts?.ready
    ? Promise.race([
        documentRef.fonts.ready,
        new Promise(resolve => setTimeout(resolve, 2000))
      ])
    : Promise.resolve();

  return Promise.all([
    Promise.all(imagePromises),
    fontPromise
  ]);
}

async function exportPdf() {
  // 必须在用户点击导出菜单的同步调用链里先打开窗口，
  // 否则 Chrome 可能把后续 window.open 当成弹窗拦截。
  const printWindow = window.open('', '_blank', 'noopener=false');

  if (!printWindow) {
    toast('浏览器拦截了打印窗口，请允许此网站弹出窗口后重试');
    return;
  }

  try {
    printWindow.document.open();
    printWindow.document.write(`
      <!doctype html>
      <html>
        <head>
          <meta charset="utf-8">
          <title>正在准备 PDF…</title>
          <style>
            html, body {
              margin: 0;
              background: #fff;
              color: #222;
              font-family: -apple-system, BlinkMacSystemFont, "Segoe UI",
                "PingFang SC", "Microsoft YaHei", sans-serif;
            }

            body {
              display: grid;
              min-height: 100vh;
              place-items: center;
            }

            .loading {
              color: #666;
              font-size: 14px;
            }
          </style>
        </head>
        <body>
          <div class="loading">正在准备 PDF…</div>
        </body>
      </html>
    `);
    printWindow.document.close();

    if (state.dirty) await saveNow();

    // HTML 导出的这条链路已经会把 Note 本地图片转换成 data URL，
    // 打印窗口因此不会依赖 localhost/uploads 路径。
    const portableHtml = await buildPortableHtml();
    const printableHtml = preparePrintableHtml(portableHtml);

    printWindow.document.open();
    printWindow.document.write(printableHtml);
    printWindow.document.close();

    printWindow.document.title =
      `${filenameSafe(els.titleInput.value)} - PDF`;

    await waitForPrintAssets(printWindow);

    toast('打印窗口已打开，请选择“保存为 PDF”');

    // 给浏览器一帧完成最终布局。
    setTimeout(() => {
      try {
        printWindow.focus();
        printWindow.print();
      } catch (error) {
        console.error(error);
        toast('无法调起打印，请在新窗口中按 Ctrl+P');
      }
    }, 180);
  } catch (error) {
    console.error(error);

    try {
      printWindow.close();
    } catch {}

    toast(`PDF 导出失败：${error.message}`);
  }
}

// Notes
els.noteList.addEventListener('click', event => {
  const item = event.target.closest('.note-item');
  if (item) selectNote(item.dataset.id);
});

els.newBtn.addEventListener('click', () => {
  createNote({
    title: '未命名笔记',
    type: 'rich',
    content: '<p><br></p>'
  });
});


els.newFolderBtn.addEventListener('click', async () => {
  const name = window.prompt('新建目录名称：', '');
  if (name == null) return;
  const trimmed = name.trim();
  if (!trimmed) return;
  try {
    const folder = await api('/api/folders', {
      method: 'POST',
      body: JSON.stringify({ name: trimmed })
    });
    await loadFolders();
    await setActiveFolder(folder.id);
    toast('目录已创建');
  } catch (error) {
    toast(error.message);
  }
});

els.folderList.addEventListener('click', async event => {
  const item = event.target.closest('.folder-item');
  if (!item) return;
  const folderId = item.dataset.folderId;
  const action = event.target.closest('[data-folder-action]')?.dataset.folderAction;

  if (!action) {
    await setActiveFolder(folderId);
    return;
  }

  event.stopPropagation();
  if (folderId === 'root') return;
  const folder = state.folders.find(value => value.id === folderId);
  if (!folder) return;

  if (action === 'rename') {
    const name = window.prompt('重命名目录：', folder.name);
    if (name == null || !name.trim() || name.trim() === folder.name) return;
    try {
      await api(`/api/folders/${encodeURIComponent(folderId)}`, {
        method: 'PUT',
        body: JSON.stringify({ name: name.trim() })
      });
      await loadFolders();
      renderFolders();
      toast('目录已重命名');
    } catch (error) {
      toast(error.message);
    }
    return;
  }

  if (action === 'delete') {
    if (!window.confirm(`删除目录“${folder.name}”？\n目录中的笔记会移回根目录，不会删除。`)) return;
    try {
      await api(`/api/folders/${encodeURIComponent(folderId)}`, { method: 'DELETE' });
      if (state.activeFolderId === folderId) state.activeFolderId = null;
      await loadFolders();
      await loadNotes(els.searchInput.value);
      if (state.notes[0]) await selectNote(state.notes[0].id, { force: true });
      else clearEditor();
      toast('目录已删除，笔记已移回根目录');
    } catch (error) {
      toast(error.message);
    }
  }
});

els.folderSelect.addEventListener('change', async () => {
  if (!state.activeId) return;
  if (state.dirty) await saveNow();
  const noteId = state.activeId;
  const folderId = els.folderSelect.value === 'root' ? null : els.folderSelect.value;
  try {
    await api(`/api/notes/${encodeURIComponent(noteId)}/folder`, {
      method: 'PATCH',
      headers: unlockHeaders(noteId),
      body: JSON.stringify({ folderId })
    });
    state.activeFolderId = folderId;
    await loadFolders();
    await loadNotes(els.searchInput.value);
    await selectNote(noteId, { force: true });
    toast(`已移动到${folderName(folderId)}`);
  } catch (error) {
    toast(error.message);
  }
});

els.cancelPasswordBtn.addEventListener('click', () => {
  els.passwordDialog.close();
  const resolve = state.passwordDialogResolve;
  state.passwordDialogResolve = null;
  resolve?.(null);
});

function submitPasswordDialog() {
  const password = els.passwordInput.value;
  if (state.passwordDialogMode === 'lock') {
    if (password.length < 4) {
      toast('密码至少需要 4 个字符');
      return;
    }
    if (password !== els.passwordConfirmInput.value) {
      toast('两次输入的密码不一致');
      els.passwordConfirmInput.focus();
      return;
    }
  }
  if (!password) return;
  els.passwordDialog.close();
  const resolve = state.passwordDialogResolve;
  state.passwordDialogResolve = null;
  resolve?.(password);
}

els.confirmPasswordBtn.addEventListener('click', submitPasswordDialog);
els.passwordInput.addEventListener('keydown', event => {
  if (event.key === 'Enter' && state.passwordDialogMode !== 'lock') submitPasswordDialog();
});
els.passwordConfirmInput.addEventListener('keydown', event => {
  if (event.key === 'Enter') submitPasswordDialog();
});
els.passwordDialog.addEventListener('cancel', event => {
  event.preventDefault();
  els.cancelPasswordBtn.click();
});

async function lockCurrentNote() {
  if (!state.activeId || state.noteLocked) return;
  if (state.dirty) await saveNow();
  const password = await requestPassword('lock');
  if (!password) return;
  try {
    await api(`/api/notes/${encodeURIComponent(state.activeId)}/lock`, {
      method: 'POST',
      body: JSON.stringify({ password })
    });
    delete state.unlockTokens[state.activeId];
    state.lockConflictDraft = null;
    await loadFolders();
    await loadNotes(els.searchInput.value);
    await selectNote(state.activeId, { force: true });
    toast('笔记已加密上锁');
  } catch (error) {
    toast(error.message);
  }
}

async function unlockCurrentNote() {
  if (!state.activeId || !state.noteLocked || state.noteUnlocked) return;
  const password = await requestPassword('unlock');
  if (!password) return;
  try {
    const result = await api(`/api/notes/${encodeURIComponent(state.activeId)}/unlock`, {
      method: 'POST',
      body: JSON.stringify({ password })
    });
    state.unlockTokens[state.activeId] = result.token;
    const conflict = state.lockConflictDraft && state.lockConflictDraft.noteId === state.activeId
      ? state.lockConflictDraft
      : null;

    if (conflict) {
      state.type = ['rich', 'markdown', 'html'].includes(conflict.type) ? conflict.type : 'rich';
      els.titleInput.value = conflict.title;
      updateTypeUI();
      setContent(conflict.content || '');
      setLockedUi({ locked: true, unlocked: true, folderId: result.note.folderId });
      state.lockConflictDraft = null;
      state.dirty = true;
      state.changeSeq += 1;
      els.saveState.textContent = '正在加密保存待提交修改…';
      await saveNow();
      toast('已解锁，并将刚才未保存的修改重新加密保存');
    } else {
      await applyRemoteActiveNote(result.note);
      els.saveState.textContent = '已解锁 · 加密保存';
      toast('已解锁；数据仍以加密形式保存');
    }
  } catch (error) {
    toast(error.message);
  }
}

async function relockCurrentNote() {
  if (!state.activeId || !state.noteLocked || !state.noteUnlocked) return;
  if (state.dirty) await saveNow();
  try {
    await api(`/api/notes/${encodeURIComponent(state.activeId)}/relock`, { method: 'POST' });
  } catch {}
  delete state.unlockTokens[state.activeId];
  await selectNote(state.activeId, { force: true });
  toast('笔记已重新锁定');
}

els.lockBtn.addEventListener('click', async () => {
  if (!state.noteLocked) return lockCurrentNote();
  if (!state.noteUnlocked) return unlockCurrentNote();
  return relockCurrentNote();
});

els.unlockOverlayBtn.addEventListener('click', unlockCurrentNote);

els.removeLockBtn.addEventListener('click', async () => {
  if (!state.activeId || !state.noteLocked || !state.noteUnlocked) return;
  if (!window.confirm('解除加密后，这篇笔记将恢复为普通明文存储。确定继续？')) return;
  if (state.dirty) await saveNow();
  try {
    const note = await api(`/api/notes/${encodeURIComponent(state.activeId)}/remove-lock`, {
      method: 'POST',
      headers: unlockHeaders(state.activeId)
    });
    delete state.unlockTokens[state.activeId];
    await loadFolders();
    await loadNotes(els.searchInput.value);
    await applyRemoteActiveNote(note);
    toast('已解除加密');
  } catch (error) {
    toast(error.message);
  }
});

els.titleInput.addEventListener('input', markDirty);
els.editor.addEventListener('input', markDirty);
els.richEditor.addEventListener('input', () => {
  if (!state.atomicDeletePerforming) clearAtomicDeleteArm();
  saveRichSelection();
  updateRichToolbarState();
  markDirty();
});

els.typeButtons.forEach(btn => {
  btn.addEventListener('click', async () => {
    try {
      await convertType(btn.dataset.type);
    } catch (error) {
      toast(`切换模式失败：${error.message}`);
    }
  });
});

els.convertFormatBtn?.addEventListener('click', async () => {
  try {
    await convertCurrentFormat();
  } catch (error) {
    toast(`格式转换失败：${error.message}`);
  }
});

$$('[data-action]').forEach(btn => {
  btn.addEventListener('mousedown', event => {
    if (state.type === 'rich') event.preventDefault();
  });

  btn.addEventListener('click', () => runTool(btn.dataset.action));
});

// Rich selection and history
document.addEventListener('selectionchange', () => {
  if (document.activeElement === els.richEditor) {
    if (state.atomicDeleteTarget && !state.atomicDeletePerforming) {
      const target = atomicCaptureBeforeCaret();
      if (target?.capture !== state.atomicDeleteTarget) clearAtomicDeleteArm();
    }
    saveRichSelection();
    refreshRichHistoryPosition();
    updateRichToolbarState();
  }
});
els.richEditor.addEventListener('pointerdown', () => {
  if (!state.atomicDeletePerforming) clearAtomicDeleteArm();
}, true);

els.richEditor.addEventListener('mouseup', () => {
  saveRichSelection();
  refreshRichHistoryPosition();
  updateRichToolbarState();
});
els.richEditor.addEventListener('keyup', () => {
  saveRichSelection();
  refreshRichHistoryPosition();
  updateRichToolbarState();
});
els.richEditor.addEventListener('focus', () => {
  saveRichSelection();
  refreshRichHistoryPosition();
  updateRichToolbarState();
});

function selectionElement() {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return null;

  const node = selection.anchorNode;
  return node?.nodeType === Node.ELEMENT_NODE
    ? node
    : node?.parentElement || null;
}

function closestRichBlock(selector) {
  const element = selectionElement();
  const block = element?.closest?.(selector);
  return block && els.richEditor.contains(block) ? block : null;
}

function richSelectionElement() {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return null;

  const range = selection.getRangeAt(0);
  const node = range.commonAncestorContainer;

  return node?.nodeType === Node.ELEMENT_NODE
    ? node
    : node?.parentElement || null;
}

function richAncestor(selector) {
  const element = richSelectionElement();
  const target = element?.closest?.(selector);

  return target && els.richEditor.contains(target)
    ? target
    : null;
}

function setToolActive(button, active) {
  if (!button) return;
  button.classList.toggle('active', Boolean(active));
  button.setAttribute('aria-pressed', active ? 'true' : 'false');
}

function resetRichToolbarState() {
  [
    els.toolH2,
    els.toolBold,
    els.toolItalic,
    els.toolQuote,
    els.toolCode,
    els.toolLink,
    els.imageBtn
  ].forEach(button => setToolActive(button, false));
}

function updateRichToolbarState() {
  if (state.type !== 'rich') {
    resetRichToolbarState();
    return;
  }

  const selection = window.getSelection();

  if (!selection?.rangeCount) {
    resetRichToolbarState();
    return;
  }

  const range = selection.getRangeAt(0);
  const insideEditor = els.richEditor.contains(range.commonAncestorContainer);

  if (!insideEditor) {
    // 图片仍可能被选中，保留图片按钮状态。
    [
      els.toolH2,
      els.toolBold,
      els.toolItalic,
      els.toolQuote,
      els.toolCode,
      els.toolLink
    ].forEach(button => setToolActive(button, false));

    setToolActive(
      els.imageBtn,
      Boolean(state.selectedImage && state.selectedImage.source === 'rich')
    );
    return;
  }

  const element = richSelectionElement();

  const inH2 = Boolean(element?.closest?.('h2'));
  const inQuote = Boolean(element?.closest?.('blockquote'));
  const inCode = Boolean(element?.closest?.('pre, code'));
  const inLink = Boolean(element?.closest?.('a'));

  // queryCommandState 对 bold/italic 在浏览器原生编辑历史里最可靠，
  // 同时用 DOM 祖先做兜底。
  let bold = false;
  let italic = false;

  try {
    bold = document.queryCommandState('bold');
    italic = document.queryCommandState('italic');
  } catch {}

  bold = bold || Boolean(element?.closest?.('strong, b'));
  italic = italic || Boolean(element?.closest?.('em, i'));

  setToolActive(els.toolH2, inH2);
  setToolActive(els.toolBold, bold);
  setToolActive(els.toolItalic, italic);
  setToolActive(els.toolQuote, inQuote);
  setToolActive(els.toolCode, inCode);
  setToolActive(els.toolLink, inLink);
  setToolActive(
    els.imageBtn,
    Boolean(state.selectedImage && state.selectedImage.source === 'rich')
  );
}

function caretIsAtEndOf(element) {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return false;

  const current = selection.getRangeAt(0);
  if (!current.collapsed) return false;

  const probe = current.cloneRange();
  probe.selectNodeContents(element);
  probe.setStart(current.endContainer, current.endOffset);

  return probe.toString().replace(/\u200b/g, '').length === 0;
}

function caretIsAtStartOf(element) {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return false;

  const current = selection.getRangeAt(0);
  if (!current.collapsed) return false;

  try {
    const probe = current.cloneRange();
    probe.selectNodeContents(element);
    probe.setEnd(current.startContainer, current.startOffset);
    return probe.toString().replace(/\u200b/g, '').length === 0;
  } catch {
    return false;
  }
}

function isAtomicCaptureBlock(element) {
  return Boolean(element?.matches?.('.note-book-excerpt, figure.note-book-capture'));
}

function topLevelRichChild(node) {
  let current = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;

  while (current && current.parentElement !== els.richEditor) {
    current = current.parentElement;
  }

  return current?.parentElement === els.richEditor ? current : null;
}

function previousElementBeforeRootOffset(offset) {
  const nodes = els.richEditor.childNodes;

  for (let index = Math.min(offset, nodes.length) - 1; index >= 0; index -= 1) {
    const node = nodes[index];
    if (node.nodeType === Node.TEXT_NODE && !node.textContent.trim()) continue;
    return node.nodeType === Node.ELEMENT_NODE ? node : null;
  }

  return null;
}

function atomicCaptureBeforeCaret() {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return null;

  const range = selection.getRangeAt(0);
  if (!range.collapsed || !els.richEditor.contains(range.commonAncestorContainer)) return null;

  // 浏览器有时会把光标直接放在 contenteditable 根节点的两个块之间。
  if (range.startContainer === els.richEditor) {
    const capture = previousElementBeforeRootOffset(range.startOffset);
    return isAtomicCaptureBlock(capture)
      ? { capture, rootOffset: range.startOffset }
      : null;
  }

  // 更常见的情况：光标位于摘录块后面的普通段落开头。
  // 只有光标确实位于当前顶层块的最开头时才接管 Backspace，
  // 避免影响普通正文内部的退格编辑。
  const currentBlock = topLevelRichChild(range.startContainer);
  if (!currentBlock || isAtomicCaptureBlock(currentBlock) || !caretIsAtStartOf(currentBlock)) {
    return null;
  }

  const capture = currentBlock.previousElementSibling;
  return isAtomicCaptureBlock(capture)
    ? { capture, currentBlock }
    : null;
}

function clearAtomicDeleteArm() {
  clearTimeout(state.atomicDeleteTimer);
  state.atomicDeleteTimer = null;

  if (state.atomicDeleteTarget?.classList) {
    state.atomicDeleteTarget.classList.remove('__note-delete-armed');
  }

  state.atomicDeleteTarget = null;
}

function armAtomicCaptureForDeletion(target) {
  clearAtomicDeleteArm();

  target.capture.classList.add('__note-delete-armed');
  state.atomicDeleteTarget = target.capture;
  state.atomicDeleteTimer = setTimeout(() => {
    clearAtomicDeleteArm();
  }, 4200);

  toast('已选中整条摘录 · 再按一次 Backspace 删除 · Esc 取消');
}

function placeCaretAfterAtomicRemoval(target, removedIndex) {
  const scrollTop = els.richEditor.scrollTop;
  try { els.richEditor.focus({ preventScroll: true }); } catch { els.richEditor.focus(); }

  const currentBlock = target?.currentBlock;
  if (currentBlock?.isConnected && currentBlock.parentElement === els.richEditor) {
    placeCaretAtStart(currentBlock);
    els.richEditor.scrollTop = scrollTop;
    return;
  }

  const range = document.createRange();
  range.setStart(els.richEditor, Math.max(0, Math.min(removedIndex, els.richEditor.childNodes.length)));
  range.collapse(true);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  state.richRange = range.cloneRange();
  els.richEditor.scrollTop = scrollTop;
}

function deleteAtomicCapture(target) {
  const capture = target?.capture;
  if (!capture?.isConnected || capture.parentNode !== els.richEditor) {
    clearAtomicDeleteArm();
    return false;
  }

  // Seal pending typing first. The snapshot immediately before removal is now a real
  // application-owned history state, so restoring does not depend on Chromium's native Undo stack.
  commitRichHistoryNow();
  refreshRichHistoryPosition();

  if (state.selectedImage && capture.contains?.(selectedRichFigure())) hideImageInspector();

  clearTimeout(state.atomicDeleteTimer);
  state.atomicDeleteTimer = null;
  capture.classList.remove('__note-delete-armed');
  state.atomicDeleteTarget = null;
  state.atomicDeletePerforming = true;
  const removedIndex = [...els.richEditor.childNodes].indexOf(capture);

  try {
    capture.remove();
    placeCaretAfterAtomicRemoval(target, removedIndex);
    // Structural deletions are committed immediately and never coalesced with later typing.
    commitRichHistoryNow();
    updateRichToolbarState();
    markDirty();
    toast('已删除整条摘录 · Ctrl+Z 可恢复');
    return true;
  } finally {
    state.atomicDeletePerforming = false;
  }
}

function handleAtomicCaptureBackspace() {
  const target = atomicCaptureBeforeCaret();

  if (!target) {
    clearAtomicDeleteArm();
    return false;
  }

  if (state.atomicDeleteTarget === target.capture) {
    return deleteAtomicCapture(target);
  }

  armAtomicCaptureForDeletion(target);
  return true;
}

function placeCaretAtStart(element) {
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(true);

  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);

  state.richRange = range.cloneRange();
}

function exitBlockquote(quote) {
  const paragraph = document.createElement('p');
  paragraph.innerHTML = '<br>';

  quote.insertAdjacentElement('afterend', paragraph);
  placeCaretAtStart(paragraph);

  updateRichToolbarState();
  markDirty();
}

document.addEventListener('keydown', event => {
  if (state.type !== 'rich' || !state.activeId || !richHistoryShortcutContext()) return;
  const modifier = event.ctrlKey || event.metaKey;
  if (!modifier || event.altKey) return;

  const key = event.key.toLowerCase();
  const wantsUndo = key === 'z' && !event.shiftKey;
  const wantsRedo = key === 'y' || (key === 'z' && event.shiftKey);
  if (!wantsUndo && !wantsRedo) return;

  // Rich mode has one owner for history: Note itself. Never fall through to Chromium's
  // independent contenteditable Undo stack, otherwise structural blocks and text diverge.
  event.preventDefault();
  event.stopImmediatePropagation();
  if (wantsUndo) undoRichHistory();
  else redoRichHistory();
}, true);

els.richEditor.addEventListener('keydown', event => {
  const modifier = event.ctrlKey || event.metaKey;
  const shortcutKey = event.key.toLowerCase();

  if (state.atomicDeleteTarget && !state.atomicDeletePerforming) {
    if (event.key === 'Escape') {
      event.preventDefault();
      clearAtomicDeleteArm();
      toast('已取消删除');
      return;
    }

    // 除确认删除键外，任何继续编辑/移动操作都取消“待删除”状态。
    if (event.key !== 'Backspace' && event.key !== 'Delete') {
      clearAtomicDeleteArm();
    }
  }

  if (modifier && !event.altKey) {
    const shortcutAction =
      shortcutKey === 'b' ? 'bold' :
      shortcutKey === 'h' ? 'h2' :
      (shortcutKey === '/' || event.code === 'Slash') ? 'italic' :
      (shortcutKey === "'" || event.code === 'Quote') ? 'quote' :
      null;

    if (shortcutAction) {
      event.preventDefault();
      saveRichSelection();
      runRichTool(shortcutAction);
      return;
    }
  }

  // 自定义选中的图片并不是浏览器原生 DOM Selection，
  // 所以 Ctrl+C / Ctrl+X 需要显式写入系统剪贴板。
  if (
    modifier &&
    !event.altKey &&
    (shortcutKey === 'c' || shortcutKey === 'x') &&
    selectedRichFigure()
  ) {
    event.preventDefault();

    if (shortcutKey === 'c') {
      copySelectedRichImage();
    } else {
      cutSelectedRichImage();
    }

    return;
  }

  // 普通文字让浏览器执行原生剪切；
  // 只有当选区里包含图片时才拦截，以便把本地图片转成可移植内容。
  if (
    modifier &&
    !event.altKey &&
    shortcutKey === 'x'
  ) {
    const snapshot = richSelectionSnapshot();

    if (snapshot?.containsImage) {
      event.preventDefault();

      cutRichSelectionWithImages(snapshot).then(ok => {
        if (!ok) {
          // 高级剪贴板不可用时退回浏览器原生剪切。
          els.richEditor.focus();
          restoreRichSelection();
          document.execCommand('cut');
          markDirty();
        }
      });

      return;
    }
  }

  // 摘录是一个不可编辑的原子业务块：第一次 Backspace 只进入待删除状态，
  // 第二次才精确移除顶层块。不要交给浏览器原生 delete 拆结构；
  // Ctrl+Z / Ctrl+Y 由 Note 统一的富文本历史管理器恢复/重做。
  if (event.key === 'Backspace' && !modifier && handleAtomicCaptureBackspace()) {
    event.preventDefault();
    return;
  }

  if (event.key === 'Delete' && !modifier && state.atomicDeleteTarget) {
    const target = atomicCaptureBeforeCaret();
    if (target?.capture === state.atomicDeleteTarget) {
      event.preventDefault();
      deleteAtomicCapture(target);
      return;
    }
    clearAtomicDeleteArm();
  }

  // 让引用块的行为更像正常笔记编辑器：
  // - 在引用末尾按 Enter：退出引用，进入普通段落
  // - 空引用按 Backspace：也退出引用
  // - Shift+Enter 仍然可以在引用内部换行
  const quote = closestRichBlock('blockquote');

  if (quote && event.key === 'Enter' && !event.shiftKey) {
    if (caretIsAtEndOf(quote)) {
      event.preventDefault();
      exitBlockquote(quote);
      return;
    }
  }

  if (
    quote &&
    event.key === 'Backspace' &&
    !quote.textContent.replace(/\u200b/g, '').trim()
  ) {
    event.preventDefault();

    const paragraph = document.createElement('p');
    paragraph.innerHTML = '<br>';
    quote.replaceWith(paragraph);
    placeCaretAtStart(paragraph);

    updateRichToolbarState();
    markDirty();
    return;
  }

  const mod = modifier;
  if (!mod) return;

  const key = shortcutKey;

  if (key === 'z') {
    event.preventDefault();
    event.shiftKey ? redoRichHistory() : undoRichHistory();
    return;
  }

  if (key === 'y') {
    event.preventDefault();
    redoRichHistory();
    return;
  }

  if (key === 's') {
    event.preventDefault();
    saveNow();
  }
});

// Source editors: Chrome/Edge native Ctrl+Z and Ctrl+Y remain enabled.
els.editor.addEventListener('keydown', event => {
  const modifier = event.ctrlKey || event.metaKey;
  const shortcutKey = event.key.toLowerCase();

  if (modifier && !event.altKey) {
    const shortcutAction =
      shortcutKey === 'b' ? 'bold' :
      shortcutKey === 'h' ? 'h2' :
      (shortcutKey === '/' || event.code === 'Slash') ? 'italic' :
      (shortcutKey === "'" || event.code === 'Quote') ? 'quote' :
      null;

    if (shortcutAction) {
      event.preventDefault();
      runSourceTool(shortcutAction);
      return;
    }
  }

  if (event.key === 'Tab') {
    event.preventDefault();
    insertText('  ');
  }

  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    saveNow();
  }
});

// Images
els.imageBtn.addEventListener('mousedown', () => {
  if (state.type === 'rich') saveRichSelection();
});
els.imageBtn.addEventListener('click', () => els.imageInput.click());

els.imageInput.addEventListener('change', async () => {
  const file = els.imageInput.files?.[0];

  if (file) {
    try {
      await uploadImage(file);
    } catch (error) {
      toast(error.message);
    }
  }

  els.imageInput.value = '';
});

function clipboardImage(event) {
  return [...(event.clipboardData?.files || [])]
    .find(file => file.type.startsWith('image/'));
}

function plainTextToRichHtml(text = '') {
  return escapeHtml(String(text).replace(/\r\n?/g, '\n'))
    .replace(/\n/g, '<br>');
}

function pastePlainTextIntoRichEditor(event) {
  const clipboard = event.clipboardData;
  if (!clipboard) return false;

  // 富文本编辑器不接受外部 HTML 样式。
  // 网页 / Word / 微信等通常同时提供 text/html 和 text/plain；
  // 这里只取纯文本，避免 font-size / font-family / color / line-height
  // 等 Note 本身无法编辑的样式混入笔记。
  const text = clipboard.getData('text/plain');
  const hasText = [...clipboard.types].includes('text/plain');
  if (!hasText) return false;

  event.preventDefault();
  saveRichSelection();
  insertRichHtml(plainTextToRichHtml(text));
  return true;
}

els.editor.addEventListener('paste', async event => {
  // 优先识别 Note 自己复制/剪切的图片结构，
  // 这样宽度、对齐等状态不会被重置。
  if (await pasteNoteImageBlocksFromClipboard(event)) return;

  const image = clipboardImage(event);
  if (!image) return;

  event.preventDefault();

  try {
    await uploadImage(image);
  } catch (error) {
    toast(error.message);
  }
});

els.richEditor.addEventListener('paste', async event => {
  // Note 内部图片剪切/复制后粘贴时，先恢复图片编辑元数据。
  if (await pasteNoteImageBlocksFromClipboard(event)) return;

  const image = clipboardImage(event);
  if (image) {
    event.preventDefault();
    saveRichSelection();

    try {
      await uploadImage(image);
    } catch (error) {
      toast(error.message);
    }
    return;
  }

  // 普通文字一律按纯文本粘贴：保留文字和换行，不继承来源字号、
  // 字体、颜色、行高、背景色等外部富文本样式。
  pastePlainTextIntoRichEditor(event);
});

els.richEditor.addEventListener('beforeinput', event => {
  // Browser menu / IME can request history without a keydown. Rich mode still has one
  // history owner, so route those requests through the same application-level manager.
  if (event.inputType === 'historyUndo') {
    event.preventDefault();
    undoRichHistory();
    return;
  }
  if (event.inputType === 'historyRedo') {
    event.preventDefault();
    redoRichHistory();
    return;
  }

  const selection = window.getSelection();
  const node = selection?.anchorNode;
  const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
  const atomic = element?.closest?.('.note-book-excerpt[data-note-atomic="1"], figure.note-book-capture[data-note-atomic="1"]');
  if (atomic || element?.closest?.('.note-book-source[data-note-readonly="1"]')) {
    event.preventDefault();
    return;
  }

});

const bookSourceObserver = new MutationObserver(mutations => {
  if (mutations.some(mutation => mutation.type === 'childList' && mutation.addedNodes.length)) {
    lockBookCaptureMetadata();
  }
});
bookSourceObserver.observe(els.richEditor, { childList: true, subtree: true });

function openShufangSource({ hash, page = null, crop = '', chapter = null, start = null, end = null, progress = null }) {
  if (!/^[a-f0-9]{64}$/i.test(String(hash || ''))) {
    toast('书籍关联信息无效');
    return;
  }
  const params = new URLSearchParams();
  if (page != null) params.set('page', String(Math.max(1, Number(page) || 1)));
  if (crop) params.set('crop', String(crop));
  if (chapter != null && Number(chapter) >= 0) params.set('chapter', String(Math.floor(Number(chapter))));
  if (start != null && Number(start) >= 0) params.set('start', String(Math.floor(Number(start))));
  if (end != null && Number(end) >= 0) params.set('end', String(Math.floor(Number(end))));
  if (progress != null && Number.isFinite(Number(progress))) params.set('progress', String(Math.max(0, Math.min(1, Number(progress)))));
  window.open(`/api/integrations/shufang/open/${encodeURIComponent(hash)}?${params.toString()}`, '_blank', 'noopener');
}

els.richEditor.addEventListener('click', event => {
  const sourceLink = event.target.closest('a[data-shufang-open]');
  if (sourceLink) {
    const figure = sourceLink.closest('figure.note-book-capture');
    const excerpt = sourceLink.closest('.note-book-excerpt');
    if (figure?.dataset.shufangHash) {
      event.preventDefault();
      openShufangSource({
        hash: figure.dataset.shufangHash,
        page: Number(figure.dataset.shufangPage || 1),
        crop: figure.dataset.shufangCrop || ''
      });
      return;
    }
    if (excerpt?.dataset.shufangHash) {
      event.preventDefault();
      openShufangSource({
        hash: excerpt.dataset.shufangHash,
        chapter: Number(excerpt.dataset.shufangChapter ?? -1),
        start: Number(excerpt.dataset.shufangStart ?? -1),
        end: Number(excerpt.dataset.shufangEnd ?? -1),
        progress: Number(excerpt.dataset.shufangProgress ?? 0)
      });
      return;
    }
  }

  const image = event.target.closest('figure.note-image-block img');

  if (!image) {
    hideImageInspector();
    return;
  }

  const figure = image.closest('figure.note-image-block');
  const id = figure?.dataset.noteImageId;
  if (!id) return;

  event.preventDefault();

  els.richEditor
    .querySelectorAll('figure.note-image-block.__note-selected')
    .forEach(el => el.classList.remove('__note-selected'));

  figure.classList.add('__note-selected');

  showImageInspector({
    id,
    width: Number(figure.dataset.noteWidth || 70),
    align: figure.dataset.noteAlign || 'left',
    source: 'rich'
  });
});

window.addEventListener('message', event => {
  if (event.source !== els.previewFrame.contentWindow) return;

  const data = event.data;
  if (!data || data.source !== 'note-preview') return;

  if (data.type === 'scroll-position') {
    state.previewScrollTop = Math.max(0, Number(data.top) || 0);
    if (state.activeId) {
      const saved = state.noteScrollPositions[state.activeId] || { rich: 0, source: 0, preview: 0 };
      saved.preview = state.previewScrollTop;
      state.noteScrollPositions[state.activeId] = saved;
    }
    return;
  }

  if (data.type === 'shufang-open') {
    openShufangSource({ hash: data.hash, page: data.page, crop: data.crop });
    return;
  }

  if (data.type === 'image-select') {
    showImageInspector({
      id: data.id,
      width: Number(data.width || 70),
      align: data.align || 'left',
      source: 'preview'
    });
  }

  if (data.type === 'image-clear') hideImageInspector();
});

els.imageSizeInput.addEventListener('input', () => {
  if (!state.selectedImage) return;

  updateImage(
    state.selectedImage.id,
    Number(els.imageSizeInput.value),
    state.selectedImage.align
  );
});
els.imageSizeInput.addEventListener('change', renderPreview);

els.imageAlignButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    if (!state.selectedImage) return;

    updateImage(
      state.selectedImage.id,
      state.selectedImage.width,
      btn.dataset.imageAlign
    );
  });
});

els.imageResetBtn.addEventListener('click', () => {
  if (!state.selectedImage) return;

  updateImage(
    state.selectedImage.id,
    100,
    state.selectedImage.align
  );
});
els.imageInspectorClose.addEventListener('click', hideImageInspector);

// Drag/drop
let dragDepth = 0;

document.addEventListener('dragenter', event => {
  const hasFile = [...(event.dataTransfer?.items || [])]
    .some(item => item.kind === 'file');

  if (!hasFile) return;

  dragDepth += 1;
  els.dropHint.classList.add('show');
});

document.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) els.dropHint.classList.remove('show');
});

document.addEventListener('dragover', event => event.preventDefault());

document.addEventListener('drop', async event => {
  event.preventDefault();

  dragDepth = 0;
  els.dropHint.classList.remove('show');

  const files = [...(event.dataTransfer?.files || [])];

  const html = files.find(file =>
    /\.html?$/i.test(file.name) || file.type === 'text/html'
  );

  const image = files.find(file => file.type.startsWith('image/'));

  try {
    if (html) {
      await importHtmlFile(html);
    } else if (image) {
      if (state.type === 'rich') saveRichSelection();
      await uploadImage(image);
    } else {
      toast('可拖入 HTML 或图片文件');
    }
  } catch (error) {
    toast(error.message);
  }
});

// Clipboard shortcuts can still act on a selected rich image even if
// focus moved from the editor to the image inspector.
document.addEventListener('keydown', event => {
  const modifier = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();

  if (
    state.type !== 'rich' ||
    !modifier ||
    event.altKey ||
    !['c', 'x'].includes(key) ||
    !selectedRichFigure()
  ) {
    return;
  }

  // If the event originated inside the rich editor, its own handler manages it.
  if (els.richEditor.contains(event.target)) return;

  event.preventDefault();

  if (key === 'c') {
    copySelectedRichImage();
  } else {
    cutSelectedRichImage();
  }
});

// Search / shortcuts
els.searchInput.addEventListener('input', () => {
  clearTimeout(els.searchInput.timer);
  els.searchInput.timer = setTimeout(() => loadNotes(els.searchInput.value), 180);
});

document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    els.searchInput.focus();
    els.searchInput.select();
  }

  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') {
    event.preventDefault();
    els.newBtn.click();
  }
});

// View
els.editTab.addEventListener('click', () => setView('edit'));
els.previewTab.addEventListener('click', () => setView('preview'));
els.splitTab.addEventListener('click', () => setView('split'));

// Delete
els.deleteBtn.addEventListener('click', () => {
  if (!state.activeId) return;
  els.deleteDialog.showModal();
});
els.cancelDeleteBtn.addEventListener('click', () => els.deleteDialog.close());

els.confirmDeleteBtn.addEventListener('click', async () => {
  if (!state.activeId) return;
  if (state.dirty) await saveNow();

  await api(`/api/notes/${state.activeId}`, { method: 'DELETE', headers: unlockHeaders(state.activeId) });
  els.deleteDialog.close();

  state.activeId = null;
  state.dirty = false;

  await loadFolders();
  await loadNotes(els.searchInput.value);

  if (state.notes[0]) await selectNote(state.notes[0].id);
  else clearEditor();

  toast('笔记已删除');
});

// Preview / export
els.openPreviewBtn.addEventListener('click', async () => {
  try {
    const portable = await buildPortableHtml({ removeSourceLinks: false });
    const blob = new Blob([portable], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank', 'noopener,noreferrer');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (error) {
    toast(error.message);
  }
});

els.exportBtn.addEventListener('click', event => {
  event.stopPropagation();
  els.exportMenu.hidden = !els.exportMenu.hidden;
});

els.exportMenu.addEventListener('click', async event => {
  const button = event.target.closest('[data-export]');
  if (!button) return;

  els.exportMenu.hidden = true;

  try {
    if (button.dataset.export === 'html') await exportHtml();
    if (button.dataset.export === 'pdf') await exportPdf();
  } catch (error) {
    console.error(error);
    toast(`导出失败：${error.message}`);
  }
});

document.addEventListener('click', event => {
  if (!event.target.closest('.export-wrap')) els.exportMenu.hidden = true;
});

window.addEventListener('beforeunload', event => {
  if (!state.dirty) return;
  event.preventDefault();
  event.returnValue = '';
});

async function init() {
  setView(state.view);
  updateTypeUI();
  await loadFolders();

  const requestedId = new URLSearchParams(location.search).get('note');
  if (requestedId) {
    const requestedMeta = await api(`/api/notes/${encodeURIComponent(requestedId)}`).catch(() => null);
    if (requestedMeta) state.activeFolderId = requestedMeta.folderId || null;
  }

  renderFolders();
  await loadNotes();

  if (requestedId && state.notes.some(note => note.id === requestedId)) {
    await selectNote(requestedId);
  } else if (state.notes.length) {
    await selectNote(state.notes[0].id);
  } else {
    const totalCount = Number(state.rootNoteCount || 0) + state.folders.reduce((sum, folder) => sum + Number(folder.noteCount || 0), 0);
    if (totalCount === 0) {
      await createNote({
        title: '欢迎使用 Note',
        type: 'rich',
        content: starterRich
      });
    } else {
      clearEditor();
    }
  }

  connectRealtime();
}

init().catch(error => {
  console.error(error);
  toast(error.message);
});
