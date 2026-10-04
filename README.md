# dsh-plugin-rewind

[English](README.en.md) · [架构与实现笔记](docs/ARCHITECTURE.md) · Apache-2.0

DeepSeek Harness 插件：**对话回退**、**工作区代码回滚**，以及一张**无 emoji 的可视化检查点树图**。

每一轮对话结束时，插件为工作区建立一次内容寻址快照；树图上每个节点就是一个可回退的检查点。用户可以在树图上任选一个节点，把**对话**回退到那一轮之前、把**文件**回滚到那一刻，或者两者一起。

---

## 能力

| 能力 | 说明 |
| --- | --- |
| 自动检查点 | 每轮对话结束（`turn/end`）后自动为**该对话涉及的所有工作区**建立快照；会话开始时额外建立「初始状态」。快照带内容寻址去重，未改动的文件不重复存储。 |
| 对话回退（新分支） | 复用产品自带的 `sessions.fork` 分叉能力：派生一个只包含该检查点之前历史的新会话并切换过去，当前会话完整保留为旁支。**聊天窗口会真正回退**。 |
| 对话回退（就地遗忘） | 在当前会话内追加一次 surface 替换事件：模型不再看到被回退的内容，日志仍然完整保留，树图把它画成「已废弃分支」。聊天记录里已显示过的文字不会消失。 |
| 工作区回滚 | 把文件恢复到检查点状态：改写已修改的文件、恢复被删除的文件、删除此后新建的文件；**每个工作区分别还原并汇总**。执行前自动建立「回滚前备份」，可以再回滚回去。 |
| 状态归因 | 树图区分「本插件回退过」「被对话压缩折叠」「被系统提示更新替换」「被其它生产者替换」「仅对话无文件快照」，不会把别人的动作算成自己的，也不会把自己的算成别人的。 |
| 可视化树图 | 按 git log 的思路排：最左是「第 N 轮」gutter，往右是每个分支一条竖轨与接点圆点，检查点是**通栏卡片**（左侧 3px 色条编码类型，第一行轮次/类型 + 状态徽标，第二行提问摘要 + 快照规模）。选中只有一种信号：卡片描边 + 淡色填充。全部图形为 SVG 路径，**没有任何 emoji**。 |
| 模型工具 | 注册一个 `rewind` 工具，让代理自己列出检查点并在用户明确要求时执行回退。 |
| 双语文案 | 中文 / English；文案由插件自己绑定 locale 命名空间，不依赖外壳注入的 `t`。 |

---

## 界面位置

插件注册四个产品自带的 slot（前三个是可见界面），不做任何 DOM 注入：

| Slot | 作用 |
| --- | --- |
| `sidebar.footer.action` | 侧栏底部「对话回退」按钮，点击打开抽屉。 |
| `shell.overlay` | 全窗口抽屉面板（产品声明的浮层座位，`pointer-events` 由产品约定）。 |
| `settings.section` | 设置页「对话回退」，侧栏折叠时依然可达。 |
| `conversation.session.header.actions` | 只用于读取当前会话 id 的隐形探针（渲染 `null`），让面板在外壳的会话列表尚未绑定时也能定位会话。 |

面板左侧是树图，右侧是所选检查点的详情（轮次、类型、快照规模、覆盖的工作区、该轮提问、将要改动的文件清单）与操作按钮；任何回退操作都会先弹确认框，逐条列出会发生什么。树图的读法：**左侧行首 = 轮次，每一列 = 一个分支（列头是分支标题与检查点数），节点第一行 = 轮次/类型，第二行 = 该轮提问摘要**，虚线与灰字表示已离开当前分支。

会话 id 的获取是三层兜底：`ctx.get('sessions').list` 快照 → 隐形探针记录的 `sessionId` → 都不行时由 host 自动挑选最近活跃的会话（面板会显示「已自动选择最近活跃的会话」）。

---

## 两种对话回退模式的取舍

DSH 的会话日志是**只追加**的：`seq` 连续、事件被深冻结、持久层明确拒绝重写（`dsh-session-persistence` 的 "Flushed events are never rewritten"）。因此「回退」有两种实现路径：

**1. 新分支回退（默认，推荐）** — 调用产品自带的 `sessions.fork({ sessionId, atSeq })`，它内部用 `ctx.agents.create({ seed })` 把前缀播种成一个新会话，并继承 `cwd`、`parentSession`、`seedLength`。这是产品「Branch into a new conversation」按钮用的同一条链路，因此投影、缓存、重启恢复、侧栏列表全部自然成立。代价是会话列表里多一个分支。

**2. 就地遗忘（高级）** — 在**同一个会话**里追加一个替代节点：`surfaceOp` 遮蔽某个 surface 区间，节点本身不产生任何模型消息，于是模型可见历史就在该轮之前截断。

`dsh-session` 的契约明确允许这种做法（"Used by compaction; any surface-replacing producer may use it"），日志一个字节都不删。但**哪个事件类型可以当这个替代节点，两个大版本不一样**，插件按会话对象自身的能力探测后择优选择（失败则换另一种重试，`append` 在写入前校验，因此重试不会重复追加）：

| | 0.1.x（如 0.1.0-rc.7） | 0.2.x（本机运行的 0.2.0-rc.2） |
| --- | --- | --- |
| 替代节点类型 | 空内容 `assistant/message` | 空内容 `system/message` |
| 区间字段 | `{ op:'replace', start, end }` | `{ op:'replace', startSeq, endSeq }` |
| `sourceEventSeqs` | 必填，且须覆盖每个被遮蔽的 surface 节点 | 对 `system/message` 同样必填；对 `assistant/message` **禁止**（"assistant/message embeds its source stream"），因此 0.2.x 上 assistant 根本无法作为替代生产者 |
| 空内容投影 | `deriveEventMessage` 返回 `null` | 同样返回 `null` |

两个必须遵守的细节（都有测试覆盖）：

* 替代节点必须携带**带 id 的消息**与合法 source（0.1.x 用 `kind:'model'` 且带 provider/model；0.2.x 的 `system/message` 用 `kind:'system-prompt'`、`role:'system'`）。会话的**重放校验**要求每个 message 事件如此；随手写的 `{ role:'assistant', content: [] }` 追加时能过、重启后从磁盘加载会直接抛错。
* 浏览器的聊天记录只接受**追加来源**的 surface 事件（`isAppendSurfaceEvent`），所以就地遗忘**不会**改变聊天窗口里已经显示的内容 —— 这正是树图把被遮蔽的轮次画成「已废弃分支」的原因，也是确认框里明确写出的警告。

---

## 版本兼容（重要）

运行中的 DSH 与 profile 解析到的 DSH **可能不是同一个版本**：本机桌面应用从 `app.asar` 加载 `@deepseek-ai/dsh-session` **0.2.0-rc.2**，而 profile 的 `node_modules` 联接指向 **0.1.0-rc.7**。插件的 host 半在宿主进程里运行，拿到的是 0.2.x 的会话对象，因此代码对两者都做探测，而不是假定其一：

| 差异 | 0.1.0-rc.7 | 0.2.0-rc.2 | 插件的处理 |
| --- | --- | --- | --- |
| 读取事件日志 | `session.events` getter | `session.snapshotEvents()` | `readSessionEvents()` 逐个探测 |
| surface 替换区间 | `start` / `end` | `startSeq` / `endSeq` | 按 `typeof session.snapshotEvents` 选方言，失败换另一种重试 |
| 替代节点类型 | `assistant/message` | `system/message` | 同上 |
| fork 前缀 | `header.seedLength` | `session.inheritedEventCount`（header 里出现 `seedLength` 会被拒绝） | `inheritedEventCountOf()`，并归一化成 overview 的 `inheritedEvents` |
| header 版本 | `version: 0` | `version: 4`，且要求 `isSeeded` 布尔 | 插件只读 header，不构造会话 |
| `assistant/message` | 可带 `sourceEventSeqs` | 禁止，并要求 `data.stream` 数组等结算字段 | 不依赖该字段 |

探测失败时报的是可诊断的错误（`session-unreadable`，附上对象的键名），`status` 接口也会返回 `diagnostics.sessionApiFlavor`（实测为 `0.2.x`）便于定位。`test/running-session.probe.mjs` 直接用**应用真正加载的那份** `dsh-session` 跑完整流程，包括"回退后的日志仍能重放加载"。

---


## 安装

**前置条件**：一个 DSH profile（`desktop` / `web` / …），以及 PATH 上的 `dsh` 命令。没有别的依赖——host 半零运行时依赖，浏览器半是手写 bundle，直接由本包提供。

### 方式一：插件管理命令（推荐）

```powershell
git clone https://github.com/joker123-wpx/Deepseek-Harness-Code-revert.git
dsh plugin --profile desktop add <克隆下来的目录绝对路径>
```

`dsh plugin add` 会在 profile 内转发给 pnpm，再把 `dsh.profile.bundles` 与实际安装结果对齐。因为本包声明了 `dsh.bundle`，它会自动加入层栈。

### 方式二：手工安装（等价）

1. 把本包放到 profile 能解析到的位置：
   `<DSH_HOME>\profiles\<profile>\node_modules\dsh-plugin-rewind`（复制，或建立指向本目录的目录联接）。
2. 修改 profile 清单 `<DSH_HOME>\profiles\<profile>\package.json`：

```json
{
  "dependencies": {
    "dsh-plugin-rewind": "file:/绝对路径/Deepseek-Harness-Code-revert"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-plugin-rewind"
      ]
    }
  }
}
```

包内的 `cordis.patch.yml` 负责插入那一行挂载，不需要手工编辑。

### 生效方式

**重启应用。** bundle 层栈在进程启动时组合，Web 界面的 `hmr` 行在 `dsh-web-app` 补丁中被显式禁用，因此新增插件不会热加载。

重启之后，再改 `lib/client.js` **不需要重启**：模块宿主对每个请求都从磁盘读取 bundle，并返回 `cache-control: no-cache`，刷新页面即可。

### 安装自检

- 侧栏底部出现「对话回退」按钮；设置页出现「对话回退」一节。两处打开同一个面板。
- 代理的工具列表出现 `rewind`。
- `POST http://127.0.0.1:<port>/dsh-rewind/rpc`，body `{"method":"status"}`，返回 `{"ok":true,…}`，其中 `diagnostics.sessionApiFlavor` 会告诉你当前运行的是哪一代会话 API（本机实测为 `0.2.x`）。

### 卸载

从 profile 的 `dependencies` 与 `dsh.profile.bundles` 中移除并重启；如需一并清除快照，删除 `<DSH_HOME>\rewind\v1`。

---

## 存储布局

全部状态在一个目录下，默认 `<DSH_HOME>/rewind/v1`：

```
blobs/<aa>/<sha256>                  文件字节，内容寻址，天然去重
manifests/<sessionId>/<cpId>.json    第一个工作区的清单
manifests/<sessionId>/<cpId>~<n>.json 其余工作区的清单（一个检查点覆盖多个工作区）
index/<sessionId>.json               该会话的检查点索引（含每个工作区的清单引用、fork 父会话）
trash/<cpId>/...                     回滚时删除文件的暂存区（可选）
```

* 清单里记录 `dirs`（含空目录）、`symlinks`（只记录链接目标，不跟随）、以及超过大小上限的文件（标记为不可恢复，回滚时如实报告而不是写坏数据）。
* 默认排除 `.git`/`.hg`/`.svn`/`.jj`/`.sl`、`node_modules`、各种构建与缓存目录、以及 `.log`/`.zip`/`.exe` 等后缀；均可通过配置覆盖。
* 单文件上限 8 MiB、单次快照总量 512 MiB、文件数 40000 —— 任一超限都会标记 `truncated` 并在界面上如实呈现。

---

## 配置

`cordis.patch.yml` 的那一行可以带 `config`：

```yaml
- insert:
    - id: rewind
      name: 'dsh-plugin-rewind'
      config:
        autoSnapshot: true          # 关闭后只保留手动检查点
        safetyCheckpoint: true      # 回滚前是否自动备份
        registerTool: true          # 是否注册 rewind 模型工具
        announceToAgent: true       # 是否向代理播报插件能力
        retainCheckpoints: 200      # 每个会话保留的检查点数量
        maxBlobBytes: 8388608
        maxTotalBytes: 536870912
        maxFiles: 40000
        excludeDirs: []
        excludeSuffixes: []
        trashOnRollback: false      # true 时删除的文件移入 trash/ 而不是直接删除
        storeRoot: null             # 覆盖存储根目录
```

---

## 明确的边界

* **回滚只覆盖会话工作区根目录**（`session.header.cwd`）。shell 工具（`bash`/`pwsh`）可以在任意位置写文件，插件按整棵树做快照，因此工作区内的改动都能回滚，但工作区之外的副作用不在范围内。
* **不做 LLM 语义判断**：回滚是文件级精确还原，不合并、不推断。
* **不重写会话文件**：两种对话回退都是追加事件或新建会话，符合持久层的只追加契约。
* **Windows ACL 不还原**：清单记录 POSIX `mode`，Windows 上的安全描述符（ACL）不在此列。
* **正在执行工具调用时拒绝回滚**（返回 `session-busy`），避免和代理的写入竞争；快照若与工具调用重叠会被标记为 `degraded`。
* **后台 shell 任务**（`run_in_background`）在检查点边界之外，插件无法为它划定范围。

---

## 开发与测试

```
lib/index.js           host 半：插件入口、路由、turn 边界钩子、模型工具、提示词段落
lib/engine.js          回滚引擎：检查点、overview、plan、apply、保留与 GC
lib/store.js           持久化：内容寻址 blob、清单、索引、trash、GC
lib/workspace.js       工作区引擎：扫描、增量哈希、diff、restore
lib/conversation.js    会话侧：turn 分析、surface 替换回退
lib/rpc.js             HTTP 传输：单一 RPC 路由 + loopback 防护
lib/client.js          浏览器半：三个 slot、SVG 树图、详情面板、确认框
test/                  离线测试套件（257 项断言）
```

```powershell
node test/run.mjs
```

测试直接加载真实的 `@deepseek-ai/dsh-session` 与 profile 里的 React：

| 探针 | 断言数 | 覆盖 |
| --- | --- | --- |
| `workspace.probe.mjs` | 24 | 快照 / 增量哈希复用 / diff / 干跑 / 回滚 / 幂等 / 二进制 / 去重 / 超限 / 符号链接 |
| `engine.probe.mjs` | 65 | 检查点、回退预览、surface 回退、工作区回滚、安全备份、历史回填、回填升级、分叉分支、**多工作区覆盖**、**压缩归因**、无会话 id 自动挑选、GC |
| `session-rewind.probe.mjs` | 25 | 对真实 `dsh-session` 的 surface 替换、独立 `foldSurface` 复核、**以及回退后日志仍能通过重放校验加载** |
| `version-compat.probe.mjs` | 38 | 两代 `dsh-session` API 方言（日志读取、区间字段、替代节点类型、fork 前缀、方言误判的兜底重试、不可读对象的可诊断报错） |
| `client.probe.mjs` | 57 | 模块包装契约、require 表、树布局数学（行=轮次/列=分支/分叉锚点）、真实 `react-dom/server` 渲染、动作门控、**全量 emoji 扫描** |
| `host-mount.probe.mjs` | 36 | 插件挂载清单、真实 HTTP 往返、RPC 契约（405/415/403、确认门）、模型工具调用、turn 边界自动快照 |
| `running-session.probe.mjs` | 17 | 用**应用真正加载的 `app.asar` 内那份 `dsh-session`** 跑通全流程，含重放加载 |

另有两个诊断/预览工具（不在 `run.mjs` 内）：

```powershell
# 对真实存储的会话日志做表面折叠与归因核查，并用真实检查点渲染一张面板预览
node test/live-forensics.mjs [sessionId]
#   -> preview/panel-preview.html   （可直接用浏览器打开）
```

它会把日志按 zstd 帧解码、复算 surface、打印每条替换的归因，并把树图渲染成独立 HTML 便于人眼确认。

`test/running-session.probe.mjs` 需要 Electron 二进制（普通 Node 读不了 asar 路径），设置环境变量即可纳入 `run.mjs`：

```powershell
$env:DSH_DESKTOP_NODE_EXECUTABLE = 'D:\Deepseek-Harness\DeepSeek Harness.exe'
node test/run.mjs
```

`DSH_MODULES` 可指向另一份 `node_modules` 以对其它安装做验证。

---

## 许可

Apache License 2.0，见 [LICENSE](LICENSE)（随仓库提供的许可证文件）。

本插件不复制、不修改 DSH 自身的代码；它只通过公开的插件契约（profile bundle、slot、会话事件、RPC 路由）与宿主协作。DSH 本身遵循其自有许可。
