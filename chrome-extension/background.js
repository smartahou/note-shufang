const DEFAULT_NOTE_BASE = 'http://127.0.0.1:3030';

async function getNoteBase() {
  const { noteBase } = await chrome.storage.local.get('noteBase');
  return String(noteBase || DEFAULT_NOTE_BASE).replace(/\/+$/, '');
}

async function setNoteBase(value) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch { throw new Error('Note 地址无效'); }
  if (!/^https?:$/.test(url.protocol)) throw new Error('Note 地址只支持 http/https');
  const base = url.origin;
  await chrome.storage.local.set({ noteBase: base });
  return base;
}

async function getLastTargetNoteId() {
  const { lastTargetNoteId } = await chrome.storage.local.get('lastTargetNoteId');
  return String(lastTargetNoteId || '');
}

async function setLastTargetNoteId(noteId) {
  const value = String(noteId || '').trim();
  if (value) await chrome.storage.local.set({ lastTargetNoteId: value });
  else await chrome.storage.local.remove('lastTargetNoteId');
  return value;
}

function normalizeHost(value) {
  let host = String(value || '').trim().toLowerCase();
  if (!host) return '';
  try { host = new URL(/^https?:\/\//i.test(host) ? host : `https://${host}`).hostname.toLowerCase(); } catch {}
  return host;
}

async function getCompatHosts() {
  const { compatHosts } = await chrome.storage.local.get('compatHosts');
  return compatHosts && typeof compatHosts === 'object' && !Array.isArray(compatHosts) ? compatHosts : {};
}

async function getCompatEnabled(host) {
  host = normalizeHost(host);
  if (!host) return false;
  const hosts = await getCompatHosts();
  return !!hosts[host];
}

async function setCompatEnabled(host, enabled) {
  host = normalizeHost(host);
  if (!host) throw new Error('无法确定当前网站');
  const hosts = await getCompatHosts();
  if (enabled) hosts[host] = true;
  else delete hosts[host];
  await chrome.storage.local.set({ compatHosts: hosts });
  return !!enabled;
}

async function noteFetch(path, options = {}) {
  const base = await getNoteBase();
  let response;
  try {
    response = await fetch(`${base}${path}`, options);
  } catch {
    throw new Error('无法连接 Note，请先运行 node note');
  }
  let data = null;
  try { data = await response.json(); } catch {}
  if (!response.ok) throw new Error(data?.error || `Note 请求失败 (${response.status})`);
  return data;
}

async function ensureInjected(tabId) {
  try { await chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] }); } catch {}
  try { await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }); } catch {}
}

async function activeWebTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https?:/i.test(tab.url || '')) throw new Error('当前页面不支持网页摘录');
  return tab;
}

async function getTabSelection(tab) {
  await ensureInjected(tab.id);
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'noteclip:get-selection' });
    const quote = String(response?.quote || '').trim();
    if (quote) return quote;
  } catch {}

  // Fallback: inspect every accessible frame. This also makes the shortcut work
  // when the selected text lives inside an iframe.
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: () => {
        const normalize = value => String(value || '')
          .replace(/\r\n?/g, '\n')
          .replace(/\u00a0/g, ' ')
          .replace(/[ \t]+\n/g, '\n')
          .replace(/\n[ \t]+/g, '\n')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
        const active = document.activeElement;
        if (active && /^(INPUT|TEXTAREA)$/.test(active.tagName || '') && typeof active.selectionStart === 'number' && active.selectionEnd > active.selectionStart) {
          return normalize(String(active.value || '').slice(active.selectionStart, active.selectionEnd));
        }
        const sel = window.getSelection?.();
        if (!sel || !sel.rangeCount) return '';
        const parts = [];
        for (let i = 0; i < sel.rangeCount; i += 1) {
          const range = sel.getRangeAt(i);
          if (range.collapsed) continue;
          try {
            const probe = document.createElement('div');
            probe.style.cssText = 'position:fixed!important;left:-100000px!important;top:0!important;width:1200px!important;opacity:0!important;pointer-events:none!important;z-index:-2147483647!important;';
            probe.appendChild(range.cloneContents());
            (document.body || document.documentElement).appendChild(probe);
            parts.push(normalize(probe.innerText || probe.textContent || range.toString()));
            probe.remove();
          } catch {
            parts.push(normalize(range.toString()));
          }
        }
        return normalize(parts.filter(Boolean).join('\n')) || normalize(sel.toString?.() || '');
      }
    });
    const quotes = (results || []).map(item => String(item?.result || '').trim()).filter(Boolean);
    if (quotes.length) return quotes.sort((a, b) => b.length - a.length)[0];
  } catch {}
  return '';
}

async function openSelectionChooser(tab, selectionText = '') {
  await ensureInjected(tab.id);
  let quote = String(selectionText || '').trim();
  if (!quote) quote = await getTabSelection(tab);
  if (!quote) {
    const host = (() => { try { return new URL(tab.url).hostname; } catch { return ''; } })();
    const compat = await getCompatEnabled(host);
    throw new Error(compat ? '没有检测到选中文字，请重新框选后再试' : '请先选中文字；若网站限制选中，可开启“兼容选文”');
  }
  await chrome.tabs.sendMessage(tab.id, { type: 'noteclip:open-selection', quote });
}

async function startRegionCapture(tab) {
  await ensureInjected(tab.id);
  await chrome.tabs.sendMessage(tab.id, { type: 'noteclip:start-region' });
}

async function syncCompatToTab(tab, enabled) {
  if (!tab?.id) return;
  await ensureInjected(tab.id);
  try { await chrome.tabs.sendMessage(tab.id, { type: 'noteclip:compat:set', enabled: !!enabled }); } catch {}
}

async function reportToTab(tab, message) {
  if (!tab?.id) return;
  await ensureInjected(tab.id);
  try { await chrome.tabs.sendMessage(tab.id, { type: 'noteclip:error', message }); } catch {}
}

async function runShortcut(command) {
  const tab = await activeWebTab();
  if (command === 'clip-selection') return openSelectionChooser(tab);
  if (command === 'capture-region') return startRegionCapture(tab);
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'noteclip-selection', title: '摘录选中文字到 Note', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'noteclip-capture', title: '框选截图到 Note', contexts: ['page'] });
  });
});

chrome.commands.onCommand.addListener(command => {
  runShortcut(command).catch(async error => {
    try {
      const tab = await activeWebTab();
      await reportToTab(tab, error.message || String(error));
    } catch {}
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  try {
    if (!tab?.id || !/^https?:/i.test(tab.url || '')) return;
    if (info.menuItemId === 'noteclip-selection') await openSelectionChooser(tab, info.selectionText || '');
    if (info.menuItemId === 'noteclip-capture') await startRegionCapture(tab);
  } catch (error) {
    try { await chrome.tabs.sendMessage(tab.id, { type: 'noteclip:error', message: error.message }); } catch {}
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case 'note:get-base':
        return { ok: true, base: await getNoteBase() };
      case 'note:set-base':
        return { ok: true, base: await setNoteBase(message.base) };
      case 'note:status':
        return { ok: true, data: await noteFetch('/api/integrations/chrome/status') };
      case 'note:targets':
        return { ok: true, data: await noteFetch('/api/integrations/chrome/targets') };
      case 'note:last-target:get':
        return { ok: true, data: { noteId: await getLastTargetNoteId() } };
      case 'note:last-target:set':
        return { ok: true, data: { noteId: await setLastTargetNoteId(message.noteId) } };
      case 'note:compat:get': {
        const host = normalizeHost(message.host || sender.tab?.url || '');
        return { ok: true, data: { host, enabled: await getCompatEnabled(host) } };
      }
      case 'note:save-excerpt': {
        const payload = message.payload || {};
        const data = await noteFetch('/api/integrations/chrome/excerpt', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
        });
        return { ok: true, data };
      }
      case 'note:save-capture': {
        const payload = message.payload || {};
        const blob = await (await fetch(payload.imageDataUrl)).blob();
        const form = new FormData();
        form.append('image', blob, `web-${Date.now()}.png`);
        for (const key of ['pageTitle', 'pageUrl', 'noteId', 'newTitle', 'folderId']) {
          if (payload[key] != null) form.append(key, String(payload[key]));
        }
        const data = await noteFetch('/api/integrations/chrome/capture', { method: 'POST', body: form });
        return { ok: true, data };
      }
      case 'note:capture-visible': {
        if (!sender.tab?.windowId) throw new Error('无法确定当前浏览器窗口');
        const dataUrl = await chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: 'png' });
        return { ok: true, dataUrl };
      }
      case 'popup:clip-selection': {
        const tab = await activeWebTab();
        await openSelectionChooser(tab);
        return { ok: true };
      }
      case 'popup:capture-region': {
        const tab = await activeWebTab();
        await startRegionCapture(tab);
        return { ok: true };
      }
      case 'popup:compat-get': {
        const tab = await activeWebTab();
        const host = new URL(tab.url).hostname;
        return { ok: true, data: { host, enabled: await getCompatEnabled(host) } };
      }
      case 'popup:compat-toggle': {
        const tab = await activeWebTab();
        const host = new URL(tab.url).hostname;
        const enabled = !(await getCompatEnabled(host));
        await setCompatEnabled(host, enabled);
        await syncCompatToTab(tab, enabled);
        return { ok: true, data: { host, enabled } };
      }
      case 'popup:shortcut-status': {
        const commands = await chrome.commands.getAll();
        return { ok: true, data: commands.map(item => ({ name: item.name, shortcut: item.shortcut || '' })) };
      }
      case 'popup:open-shortcuts': {
        await chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
        return { ok: true };
      }
      case 'popup:open-note': {
        const base = await getNoteBase();
        await chrome.tabs.create({ url: base });
        return { ok: true };
      }
      default:
        return { ok: false, error: '未知请求' };
    }
  })().then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message || String(error) }));
  return true;
});
