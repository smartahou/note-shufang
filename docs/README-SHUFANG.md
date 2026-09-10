# 书房 v0.5.5 · 内置阅读器

## v0.5.5：EPUB 注释浮层

- EPUB 中常见的脚注/尾注链接不再优先跳到注释正文，而是在当前阅读位置上方打开注释浮层。
- 支持 EPUB3 的 `epub:type=noteref / footnote / endnote`、ARIA `doc-noteref / doc-footnote`，以及常见 `fn/note` 命名与数字上标注释链接。
- 同章注释和位于独立 `notes.xhtml` 等资源中的跨文件注释都可读取；跨文件注释不要求该文件出现在 spine 中。
- 注释浮层保持当前正文滚动位置不动；点击空白处、右上角 × 或 Esc 关闭。
- 注释内容使用纯文本安全展示，不执行 EPUB 内脚本；纸张/浅色/深色主题会同步到注释浮层。
- 普通章节内链、目录链接仍按原逻辑跳转，不会把所有锚点都误判为注释。
- v0.5.4 的章末继续下滑进入下一章逻辑保持不变。

本版重新设计阅读链路，目标是：**阅读器故障不得影响书房主程序**，并且不依赖浏览器自带 PDF/EPUB 查看能力。

## 架构

### PDF

- 浏览器不解析 PDF。
- 主程序也不直接解析 PDF。
- `shufang-pdf-worker.js` 是独立 Node 子进程，使用 `pdfjs-dist + @napi-rs/canvas` 渲染页面。
- 页面 PNG 按 `SHA-256 / 页码 / 宽度` 缓存在：

  `~/.shufang/reader-cache/pdf/`

- 即使某个损坏 PDF 让 PDF.js 或 Canvas 子进程异常退出，书房 Web 服务仍继续运行。
- 阅读器一次只显示当前页，并预取前后页；不会一次渲染几百页。

### EPUB

- 不再使用浏览器 `epub.js`。
- 不再使用浏览器 `JSZip`。
- Node 用现有 `adm-zip + fast-xml-parser` 读取 `container.xml / OPF / spine / TOC`。
- EPUB 章节、CSS、图片、字体仍按 EPUB 内部目录结构从 localhost 提供给 iframe。
- EPUB 内脚本默认被 CSP 禁止，降低打开来源复杂电子书时的风险。

### TXT / Markdown

- 通过 localhost 流式读取文件，并实时显示读取百分比/MB 数。
- 读取结束后识别 UTF-8 / UTF-16LE，并回退 GB18030。
- 不再无反馈地等待完整大文件。

## 阅读进度

进度仍保存在：

`~/.shufang/library.db`

并以 SHA-256 绑定，所以重命名、移动目录不会丢进度。

- PDF：`pdf:页码`
- EPUB：`epub:书脊序号:章节内滚动比例`
- TXT/MD：`scroll:像素`

每次翻页/滚动会延迟保存；每 10 秒兜底保存；返回书房、切后台、关闭页面时再次保存。

## 封面维护

封面仍在 Web App 启动之后后台低速维护；PDF 封面也改用隔离 worker 渲染，因此封面维护不会因为 PDF.js 异常击穿书房主进程。

## 安装

v0.5.3 移除了 `epubjs`、`jszip` 这两个浏览器阅读依赖。覆盖文件后建议执行一次：

```bat
npm install
```

然后：

```bat
node shufang G:\books
```

请完整保留压缩包中的 `shufang-pdf-worker.js`，不要只复制 `书房` 单文件。


## v0.5.3：目录移动缓存与连续 PDF

- SHA-256 仍然是最终文件身份，但路径改变后，程序必须先知道“这个新路径就是旧文件”。
- v0.5.3 为 `locations` 记录文件系统身份 `dev + ino`。同一磁盘/同一文件系统内仅改名或移动目录时，下一次扫描可直接沿用原 SHA-256，不再重新读取整本文件。
- 第一次运行 v0.5.3 会给现有缓存补文件系统身份；已命中的原路径不会因此重新计算 SHA。跨磁盘复制、真正修改过内容、或系统无法提供稳定文件身份时，仍会重新计算 SHA-256，这是为了保证准确性。
- PDF 改为连续滚动：接近视口的页面才按需渲染，滚动到底部自然加载下一页；阅读进度按当前可见页更新。
- PDF 宽度支持 35%～160%，设置会保存在本机；“适宽”恢复 100%。


## v0.5.3 PDF 连续阅读稳定性修复

- 撤销 v0.5.1“一次创建整本 PDF 全部页面占位 + IntersectionObserver”的方案。
- 回到 v0.5.0 已验证的单页渲染核心，仅在接近底部时增量追加下一页。
- DOM 最多保留约 12 个近期页面，避免几百页 PDF 一次进入页面树。
- 35%～160% 阅读宽度继续保留；调整宽度时只重建当前阅读窗口。
- 页面跳转、上一页/下一页仍可用；滚动位置变化继续写入 SHA-256 对应的阅读进度。
- EPUB/TXT 阅读实现与 v0.5.0 保持不变。


## v0.5.3 EPUB 稳定性修复

- 阅读器启动数据改为 Base64 JSON，不再把书名/路径直接插入可执行 JavaScript；特殊字符不会造成整个阅读器 `SyntaxError`。
- EPUB 的 HTML/XHTML 在 Node 端先移除 `<script>`、事件属性、iframe/object/embed 与 `javascript:` URL，再送入阅读 iframe。
- 移除 iframe 的脚本 sandbox 依赖，改由“服务端净化 + 严格 CSP(script-src none)”双层限制；避免旧 EPUB 或浏览器扩展在 about:blank sandbox 中产生误导性的脚本报错。
- PDF、TXT、移动目录复用 SHA 的逻辑不改。
