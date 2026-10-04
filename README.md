# Dsh-Code-Revert

[English](README.en.md) · [架构与实现笔记](docs/ARCHITECTURE.md) · Apache-2.0

DeepSeek Harness 插件：**对话回退**、**工作区代码回滚**，以及一张**可视化检查点树图**。

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
| 长列表折叠 | 从第二行起**每 10 条切一个块，整块折叠**（块内不足 10 条不折）；**第一行「起始」永不折叠**，它是整条时间线的锚点。例：21 条 → 折叠 2 个块共 **20 条**，只留第一行。每个块在列表中**原位**占一行标题（「第 1 – 10 轮 · 10 条（整体折叠）」），**+/− 按钮在该行右端**。行按连续槽位排布，折叠后上方不留白，同一轮的两个检查点也不会重叠。10 条以内完全不折叠。 |
| 回退代码 + 重新提问（一个动作） | 金色按钮现在是**「回退代码并重新提问」**：先把工作区文件回滚到该检查点，再让模型遗忘该轮之后的对话，然后按你改写的提问继续——三者是一件事，不会出现"回了对话却没回代码"。检查点没有文件快照时自动退化为"只回退对话"。 |
| 空闲回退不发内部指令 | 空闲时点击回退**不会**把"请调用 rewind 工具…"这类内部指令发进对话：面板先自己回滚工作区文件，再向宿主**登记**这次对话回退（`scheduleRewind`），宿主在**下一轮的第一个 step**里写入日志（格式唯一允许的时机，且早于该 step 的请求装配）——对话里只会出现你自己写的提问。 |
| 空闲时也能回退重问 | 面板在对话空闲时无法安全写入会话日志（回退标记必须落在一段打开的 turn/step 里），所以这两个动作**改为交给代理执行**：面板把「检查点 id + 你改写的提问」组成一条消息放进输入框并发送，代理在自己那一轮里用 rewind 工具完成回退，再按改写后的提问继续。按钮文案同时变为「让代理回退并重新提问」，不冒充面板直接改写。 |
| 会话日志安全闸 | 回退标记**必须落在一段打开的 turn/step 里**（这是会话日志格式的硬性要求）：插件在写入**之前**按加载器的规则复演一遍，不安全就**拒绝写入**并说明原因，而不是留下一个重启后打不开的会话。用户发起的「就地遗忘」因此被禁用（面板直接置灰并给出原因），「新分支回退」与工作区回滚不受影响。另外附带 `tools/repair-session-log.mjs`：扫描 `~/.dsh/sessions` 下所有日志，找出并（`--apply`）修复历史上被写坏的会话，修复前自动在日志旁留一份备份。 |
| 代理忙碌时排队 | 点确认时如果代理正在跑工具调用，回退不会失败也不会静默——它会**排队**，面板上显示「已排队：本轮结束后自动回退」（可一键取消），这一轮结束时自动执行；「改完再问」排队的场景会在回退落地后自动把改写后的提问发出去。 |
| 回退后的分叉 | 就地回退会让「模型可见历史」分叉：被折叠的那几轮在原轨道上变成**灰色虚线死支**，而回退点右侧**新开一条轨道**，用一条曲线从回退点直接连到新那一轮的节点——曲线不会与死支的竖线重叠，因此一眼看得出"从哪一刀切开的"。 |
| 可视化树图 | 按 git log 的思路排：最左是「第 N 轮」gutter，往右是每个分支一条竖轨与接点圆点，检查点是**通栏卡片**（左侧 3px 色条编码类型，第一行轮次/类型 + 状态徽标，第二行提问摘要 + 快照规模）。选中只有一种信号：卡片描边 + 淡色填充。全部图形为 SVG 路径，**没有任何 emoji**。 |
| 改完再问 | 详情里的「该轮提问」是可直接编辑的输入框，配一个**金色**的「回退并重新提问」按钮（面板里唯一的金色控件，紧凑尺寸、不拉满整栏）：它会先撤销**这一轮**（模型不再看到它），再把你改写的提问放进输入框并发送成新的一轮。回退目标是该轮之上那一行检查点，因此**最新一轮也能改完重问**。发送走产品给会话座位的公开 `inputActions`（`setDraft` / `submit`），不碰任何私有接口。 |
| 模型工具 | 注册一个 `rewind` 工具，让代理自己列出检查点并在用户明确要求时执行回退。 |
| 排队会重试 | 排队的回退**不会被"下一轮已经开始"丢掉**：宿主持有请求并按 1.5s 重试（最多约一分钟），直到代理空闲才执行；超时会明确报错。宿主还会记录**调用方的前端构建号**与最近的状态变更调用，`status` 可直接读出——"到底哪个前端在说话、它发了什么"因此可查。 |
| 详情浮在时间线上 | 检查点详情是**浮层**（绝对定位、带阴影、覆盖在时间线右侧），不占布局列：选中某一行时时间线**不会重新排布或重新测量**，也不会出现"预留的空列"。 |
| 折叠块仍可回退 | 折叠块标题上有一个 **「回退到此」** 按钮（在 +/− 左侧），点击即选中**该块最后一个检查点**并打开详情：折叠只是隐藏行，**不会隐藏回退能力**；标题本身点击仍然只做展开/收起。 |
| 行内不放 token | token 计数只出现**一次**，就在右栏 KB 右边（行内的重复显示已移除）。 |
| 行内只放 token、右栏放全部 | 提示词行后面跟**token 计数**（`↑5.2k ↓9.2k token`，固定宽度后缀，永不被挤掉），右侧栏在 KB 后给**完整摘要**（`36 文件 · 758.7 KB · ↑5.2k ↓9.2k token · 20 工具 · 1m20s`）。右栏宽度上限为卡片的一半并自动省略，长提问再也不会把标题挤成「轮…」。 |
| 每轮用量写在行里 | 每个检查点行的**右侧栏**在文件数/KB 之后直接跟这一轮的用量：`36 文件 · 758.7 KB · ↑5.2k ↓9.2k token · 20 工具 · 1m20s`（↑ 输入 / ↓ 输出）（输入→输出、工具调用数、耗时），来自 `assistant/message.usage` 的逐轮累加；右侧详情再展开输入/输出/缓存读/合计/步数/工具调用/耗时/模型。该轮没有用量数据就不显示，不编造。 |
| 面板左右对称 | 行卡片列**相对画布居中**：卡片左边距 = 卡片右边距，任何面板宽度都成立（1400/1000/900/700/500 全部实测相等）。窄面板时同一规则改为收窄卡片，因为左侧必须给导轨让位。 |
| 落地即收工 | 回退成功后面板**自动关闭**（文件已回滚、对话已按新提问继续，用户要看的是聊天与代码）。失败或排队时面板保持打开，错误留在按钮旁。另外**工作区回滚由面板直接执行**（不需要打开的轮次，因此立即生效），只有对话的遮蔽标记才委托给代理。 |
| 操作留痕 | 底栏保留最后一次确认操作的记录（例如 `apply(conversation=inplace) → 回退对话（就地遗忘）: 2 轮对话`），失败红色、排队黄色。"点了没反应"因此变成可以截图核对的事实。 |
| 版本自检 | 面板底栏显示 `v版本+构建号`；如果前端构建号与宿主上报的不一致（只刷新了页面没重启应用，或反之），页头会出现「宿主版本较旧 · 请重启应用」。这样"改了还是不行"能立刻分辨是代码问题还是加载问题。 |
| 跟随切换 | 切换工作区 / 会话窗口后面板**自动切到当前会话**：订阅会话列表与工作区注册表的变化，并且每 1.2s 重读一次当前会话、每 3s 刷新一次概览（窗口不可见时跳过），切换后立即清空选中项、详情与待确认操作。 |
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
test/                  离线测试套件（435 项断言）
```

```powershell
node test/run.mjs
```

测试直接加载真实的 `@deepseek-ai/dsh-session` 与 profile 里的 React：

| 探针 | 断言数 | 覆盖 |
| --- | --- | --- |
| `workspace.probe.mjs` | 24 | 快照 / 增量哈希复用 / diff / 干跑 / 回滚 / 幂等 / 二进制 / 去重 / 超限 / 符号链接 |
| `engine.probe.mjs` | 99 | 检查点、回退预览、surface 回退、工作区回滚、安全备份、历史回填、回填升级、分叉分支、**多工作区覆盖**、**压缩归因**、无会话 id 自动挑选、GC |
| `session-rewind.probe.mjs` | 28 | 对真实 `dsh-session` 的 surface 替换、独立 `foldSurface` 复核、**以及回退后日志仍能通过重放校验加载** |
| `version-compat.probe.mjs` | 40 | 两代 `dsh-session` API 方言（日志读取、区间字段、替代节点类型、fork 前缀、方言误判的兜底重试、不可读对象的可诊断报错） |
| `client.probe.mjs` | 162 | 模块包装契约、require 表、树布局数学（行=轮次/列=分支/分叉锚点）、真实 `react-dom/server` 渲染、动作门控、**全量 emoji 扫描** |
| `host-mount.probe.mjs` | 48 | 插件挂载清单、真实 HTTP 往返、RPC 契约（405/415/403、确认门）、模型工具调用、turn 边界自动快照 |
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
