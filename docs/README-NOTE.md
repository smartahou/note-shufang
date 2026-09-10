# Note

一个本地运行的 Markdown / HTML 笔记 Web App。

## 启动

```bash
npm install
node note
```

默认打开：

```text
http://127.0.0.1:3030
```

## 功能

- 长内容独立滚动：笔记列表、富文本、Markdown/HTML 源码、预览区均可独立纵向滚动
- 顶部标题栏与工具栏保持固定，不随正文滚动

- 深色极客 UI：阅读优先的深灰工作台、高对比工具栏、低饱和绿色状态色

- 新增 / 修改 / 删除笔记
- 关键词搜索与自动保存
- **富文本（所见即所得）编辑模式**
- Markdown 源码编辑模式
- HTML 源码编辑模式
- 富文本支持标题、粗体、斜体、引用、链接、代码块
- 工具栏会跟随光标/选区实时显示当前格式状态
- H2、引用、代码块、链接等再次点击可取消当前格式
- 引用块末尾按 Enter 自动退出引用；Shift+Enter 可在引用内部换行
- Ctrl/Cmd + Z 撤销
- Ctrl/Cmd + X 剪切文本、富文本和图片到系统剪贴板
- Ctrl/Cmd + C 复制文本和图片
- Ctrl + Y / Cmd + Shift + Z 重做
- 粘贴或拖入图片
- 图片复制 / 剪切到其他应用时，本地图片会尽量转为可移植内容，而不是只保留 localhost 地址
- 图片剪切 / 复制后再次粘贴会保留宽度和对齐位置
- 富文本中直接点击图片即可调整 20%–100% 宽度和左 / 中 / 右对齐
- Markdown / HTML 中可在预览侧调整图片大小与位置
- 拖入 `.html` / `.htm` 文件，自动保存成 HTML 笔记
- HTML 沙箱 iframe 预览
- 编辑 / 预览 / 分栏三种视图
- 导出 HTML
- 导出 PDF
- Ctrl/Cmd + S 保存
- Ctrl/Cmd + N 新建
- Ctrl/Cmd + K 搜索


## 数据安全与升级

从 v12 开始，**程序文件与用户数据彻底分离**。以后可以直接覆盖整个 `note-web` 程序目录，笔记不会被新版压缩包覆盖。

默认数据目录：

### Windows

```text
%LOCALAPPDATA%\Note
```

通常类似：

```text
C:\Users\你的用户名\AppData\Local\Note
```

其中：

```text
data\notes.json    笔记数据
uploads\           图片
backups\           自动备份
```

### macOS

```text
~/Library/Application Support/Note
```

### Linux

```text
~/.local/share/note
```

也可以自定义：

```bash
NOTE_DATA_DIR="D:\MyNoteData" node note
```

### 旧版迁移

首次运行 v12 时，如果检测到旧程序目录中的：

```text
data/notes.json
uploads/
```

且新的持久数据目录还没有笔记，会自动迁移过去。

### 自动备份

每次写入笔记前，程序会自动备份当前 `notes.json`，默认保留最近 **30 份**：

```text
backups/notes-*.json
```

所以今后即使误操作或数据文件损坏，也比之前容易恢复。

> 注意：如果旧版 `data/notes.json` 已经在覆盖更新时被替换成空文件，那么 v12 无法凭空恢复已经被覆盖的内容。可以检查系统文件历史、备份软件、云盘版本历史或编辑器/解压工具是否保留旧文件。


## 配置

修改端口：

```bash
PORT=8080 node note
```

Windows PowerShell：

```powershell
$env:PORT=8080; node note
```

允许局域网访问：

```bash
HOST=0.0.0.0 node note
```

不自动打开浏览器：

```bash
NOTE_NO_OPEN=1 node note
```

## 安全说明

HTML 预览通过 `iframe sandbox` 隔离运行。应用用于本机个人笔记；若将服务暴露到公网，请自行增加认证、CSRF 防护、上传策略、访问控制和更严格的 HTML 安全策略。



## v1.2 数据策略（当前）

旧 v13 的“扫描多份历史数据并合并”策略已经停用。当前规则：

- `data/notes.json` 是唯一活动数据库；
- `backups/` 只用于人工查看/冷备份，不参与启动恢复；
- 不扫描相邻旧工程，不扫描旧 `data/notes.json`，不自动合并历史快照；
- 首次升级到 v1.2 时，旧 backup/recovery 状态会移入 `quarantine/`；
- 当前库里的 `（恢复副本）`、重复 ID、完全重复记录会被清理；
- 清理前原始数据库会放入 quarantine，但程序永远不会自动读取；
- 保存过程中只允许使用 `notes.json.previous` 做一次事务级崩溃恢复，不做任何内容合并。

这套规则的目标是：**当前数据库是什么，启动后就是什么；删除就是删除，不允许旧历史数据自动“复活”。**
