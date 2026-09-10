#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createCanvas } = require('@napi-rs/canvas');

let pdfjsPromise = null;
let currentPath = '';
let currentTask = null;
let currentDoc = null;
let queue = Promise.resolve();

function cleanError(error) {
  const parts = [error?.name, error?.message, error?.stack].filter(Boolean).map(String);
  return [...new Set(parts)].join('\n').slice(0, 12000) || String(error || '未知 PDF 错误');
}

function pdfAssetDir(name) {
  const root = path.dirname(require.resolve('pdfjs-dist/package.json'));
  return pathToFileURL(path.resolve(root, name)).href.replace(/\/+$/, '') + '/';
}

async function getPdfJs() {
  if (!pdfjsPromise) pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}

async function destroyCurrent() {
  try { await currentDoc?.destroy?.(); } catch {}
  try { await currentTask?.destroy?.(); } catch {}
  currentDoc = null;
  currentTask = null;
  currentPath = '';
}

async function openDocument(filePath) {
  if (currentDoc && currentPath === filePath) return currentDoc;
  await destroyCurrent();
  const pdfjs = await getPdfJs();
  const common = {
    cMapUrl: pdfAssetDir('cmaps'),
    cMapPacked: true,
    standardFontDataUrl: pdfAssetDir('standard_fonts'),
    wasmUrl: pdfAssetDir('wasm'),
    useSystemFonts: true,
    verbosity: 0,
  };
  let task = pdfjs.getDocument({ ...common, url: filePath });
  try {
    currentDoc = await task.promise;
    currentTask = task;
    currentPath = filePath;
    return currentDoc;
  } catch (firstError) {
    try { await task.destroy?.(); } catch {}
    const bytes = new Uint8Array(await fsp.readFile(filePath));
    task = pdfjs.getDocument({ ...common, data: bytes });
    try {
      currentDoc = await task.promise;
      currentTask = task;
      currentPath = filePath;
      return currentDoc;
    } catch (secondError) {
      try { await task.destroy?.(); } catch {}
      throw secondError || firstError;
    }
  }
}

async function info(filePath) {
  const doc = await openDocument(filePath);
  const pages = Number(doc.numPages || 0);
  if (!pages) throw new Error('PDF 没有可读取的页面');
  const page = await doc.getPage(1);
  try {
    const vp = page.getViewport({ scale: 1 });
    return { pages, width: vp.width, height: vp.height, ratio: vp.height / Math.max(1, vp.width) };
  } finally { try { page.cleanup?.(); } catch {} }
}

async function render(filePath, pageNo, width, target) {
  const doc = await openDocument(filePath);
  const pageNumber = Math.max(1, Math.floor(Number(pageNo) || 1));
  if (pageNumber > doc.numPages) throw new Error(`PDF 页码超出范围：${pageNumber}/${doc.numPages}`);
  const page = await doc.getPage(pageNumber);
  try {
    const base = page.getViewport({ scale: 1 });
    if (!base.width || !base.height) throw new Error('PDF 页面尺寸无效');
    const safeWidth = Math.max(300, Math.min(1800, Math.floor(Number(width) || 1100)));
    const viewport = page.getViewport({ scale: safeWidth / base.width });
    const canvas = createCanvas(Math.max(1, Math.ceil(viewport.width)), Math.max(1, Math.ceil(viewport.height)));
    const context = canvas.getContext('2d');
    const renderTask = page.render({ canvasContext: context, canvas, viewport, background: 'rgb(255,255,255)' });
    await renderTask.promise;
    const png = Buffer.from(canvas.toBuffer('image/png'));
    if (png.length < 100) throw new Error('PDF 页面渲染结果为空');
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    await fsp.writeFile(tmp, png);
    try { await fsp.rename(tmp, target); }
    catch { try { await fsp.rm(tmp, { force: true }); } catch {} }
    return { width: canvas.width, height: canvas.height, bytes: png.length };
  } finally { try { page.cleanup?.(); } catch {} }
}

async function handle(msg) {
  const id = Number(msg?.id);
  if (!id) return;
  try {
    if (!msg.filePath || !fs.existsSync(msg.filePath)) throw new Error('PDF 文件不存在');
    let result;
    if (msg.action === 'info') result = await info(msg.filePath);
    else if (msg.action === 'render') result = await render(msg.filePath, msg.page, msg.width, msg.target);
    else throw new Error('未知 PDF worker 操作');
    process.send?.({ id, ok: true, result });
  } catch (error) {
    process.send?.({ id, ok: false, error: cleanError(error) });
  }
}

process.on('message', msg => { queue = queue.catch(() => {}).then(() => handle(msg)); });
process.on('disconnect', async () => { await destroyCurrent(); process.exit(0); });
process.on('SIGTERM', async () => { await destroyCurrent(); process.exit(0); });
process.on('uncaughtException', error => { try { console.error(cleanError(error)); } finally { process.exit(1); } });
process.on('unhandledRejection', error => { try { console.error(cleanError(error)); } finally { process.exit(1); } });
