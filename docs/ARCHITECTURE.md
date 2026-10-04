# 架构与实现笔记

这份文档记录插件为什么这样做，以及实现过程中**用真实运行环境验证出来的**几个关键事实。它也是给未来维护者的地图：所有结论都标注了出处。

---

## 1. 会话模型：日志 + surface

DSH 的会话是**只追加**的事件日志（`seq` 连续、事件深冻结、持久层拒绝重写），模型可见历史是日志之上的一个**有序投影**，称为 surface：

- 每个"会产生消息"的事件都带 `surfaceOp` 标记：`'append'`（追加到 surface 尾部）或 `{ op: 'replace', start(Seq), end(Seq) }`（用自己替换 surface 上的一段区间）；
- 不带 `surfaceOp` 的事件（`turn/start`、`assistant/chunk`、`tool/call`、`request/header`、各种标记）不进入 surface；
- `deriveEventMessage(event)` 是**逐节点投影规则**：`user/message` → 该消息；`assistant/message` / `system/message` / `developer/message` → 内容为空数组时返回 `null`（"保留 surface 位置但不注入消息"）；`tool/result` → 该消息；其它 → `null`。

`dsh-session` 的类型注释明确写着 replace 的用途是 "Used by compaction; **any surface-replacing producer may use it**"。这就是本插件"就地遗忘"的合法性来源：追加一个**空内容**的替代节点，日志一个字节不删，模型可见历史在该轮之前截断。

### 两个大版本，两套方言

运行中的 DSH 与 profile 解析到的 DSH **可能不是同一个版本**——作者的机器上，桌面应用从 `app.asar` 加载 `dsh-session` **0.2.0-rc.2**，而 profile 的 `node_modules` 联接指向 **0.1.0-rc.7**。插件在宿主进程里运行，拿到的是 0.2.x 的对象，因此不能只照着一份类型定义写。

| 差异 | 0.1.0-rc.7 | 0.2.0-rc.2（实测运行） | 插件处理 |
| --- | --- | --- | --- |
| 读事件日志 | `session.events` getter | `session.snapshotEvents()` | `readSessionEvents()` 逐个探测，读不到就抛 `session-unreadable`（附对象键名） |
| replace 区间字段 | `start` / `end` | `startSeq` / `endSeq`（且 key 数量必须恰好 3） | `surfaceReplaceOp()` 按 `typeof session.snapshotEvents` 选方言 |
| 可作替代节点的事件 | `user/message \| assistant/message \| tool/result` | 另含 `system/message`、`developer/message`；**禁止** `assistant/message` 携带 `sourceEventSeqs` | `surfaceIntents()` 给两套完整意图（0.2.x 用空内容 `system/message` + `sourceEventSeqs` 覆盖被遮蔽节点；0.1.x 用空内容 `assistant/message`），失败则换另一套重试；`append` 在写入前校验，重试不会重复追加 |
| fork 前缀 | `header.seedLength` | `session.inheritedEventCount`（header 出现 `seedLength` 会被拒绝） | `inheritedEventCountOf()`，并归一化成 overview 的 `inheritedEvents` |
| header | `version: 0` | `version: 4`，要求 `isSeeded` 布尔 | 插件只读 header，不构造会话 |
| `assistant/message` | 可带 `sourceEventSeqs` | 禁止；并要求 `turn`/`step` 与 `data.stream` 数组等结算字段 | 不依赖该字段；测试夹具按版本补齐 |

**踩过的坑（都有回归测试）**：

1. 空内容 `assistant/message` 做替代节点时，必须带**带 id 的消息**与 `source.kind:'model'` 的 source（含非空 provider/model）。会话的**重放校验**要求每个 `assistant/message` 如此；随手写的 `{ role:'assistant', content: [] }` 追加时能过、重启后磁盘加载直接抛错。
2. 0.2.x 上 `assistant/message` 根本无法当替代生产者：校验要求 `sourceEventSeqs` 覆盖每个被遮蔽节点，又禁止 `assistant/message` 携带它。空内容 `system/message`（`role:'system'`、`source.kind:'system-prompt'`）两者都满足。
3. 替代节点会被**重放校验**（`Session.create`/`fromRestore` 的 seed 路径）重新检查，所以"能在当前进程追加"不等于"日志能重新加载"。测试里专门有一项把回退后的日志重新 seed 一遍。

---

## 2. surface 折叠与归因

插件需要回答"某个节点的消失是**谁**造成的"，因为面板要显示不同文案。做法是按日志顺序自己折叠 surface（`foldSessionSurface`）：

```
nodes = []
for event of events:
  op = event.surfaceOp
  if op === undefined: continue
  if op === 'append':  nodes.push(event.seq); continue
  {start, end} = 读区间(op)
  from = nodes.indexOf(start); to = nodes.indexOf(end)
  if from === -1 or to === -1 or from > to: continue     # 容忍异常日志
  记录 { seq, start, end, shadowed: nodes[from..to], kind: classify(event) }
  nodes = nodes[..from] + [event.seq] + nodes[to+1..]     # 关键：保留区间之后的节点
```

**曾经的 bug**：早期实现写成 `nodes = nodes[..from] + [event.seq]`，把区间之后的节点**全部截断**。尾部替换（compaction 那种）恰好不受影响，所以测试全绿；但**中途替换**（外壳的 in-history 系统提示更新就是）会让折叠结果与真实 surface 分叉，后续替换再也找不到区间而被静默跳过。在真实日志上表现为：surface 只剩 247 个节点，而带 `append` 标记的事件有 748 个。修复后两者完全一致（748 = 748），并且这一条被固化成 `live-forensics` 的自检输出。

归因规则（`classifyReplacement`）**只认自己铸造的 id**：

| kind | 判据 | 面板文案 |
| --- | --- | --- |
| `rewind` | `message.id` 以 `rewind-` 开头且内容为空 | 已回退 |
| `compaction` | `user/message` 且 `source.plugin === 'compact'` | 已压缩 |
| `prompt` | `system/message` / `developer/message` | 提示已更新 |
| `other` | 其它生产者 | 已被替换 |

一开始按"空内容 `system/message` 就是我的标记"来判断，结果把外壳的**系统提示更新**误报成"你回退过"（0.2.x 把系统提示以 `system/message` 投递进历史，更新时就替换那个节点）。现在唯一可信的标记是插件自己写入的 `rewind-` id 前缀。

另外：**没有人类提问的轮次**（goal 续轮、steer）不能作为回退目标——`turn.hasPrompt === false` 时不计入 `abandoned`，也不能 fork，否则面板会显示"已经被回退过"这种错误解释。

---

## 3. 检查点与多工作区

一个对话可能涉及多个目录：会话自己的 `cwd`、fork 祖先/后代的 `cwd`、以及这些会话在 workspace 注册表里挂着的 workspace 路径（会话在项目子目录里打开时，它仍属于那个项目）。`resolveRoots()` 取这些集合的并集，只保留真实存在的目录，并对**每个根**各写一份清单：

```
manifests/<sessionId>/<cpId>.json      第一个根
manifests/<sessionId>/<cpId>~<n>.json  其余根
index/<sessionId>.json                 检查点索引（含 roots 列表与 fork 父会话）
```

清单记录：`files[]`（rel、sha256、size、mtimeMs、mode、restorable）、`dirs[]`（含空目录）、`symlinks[]`（只记链接目标，不跟随）、`skipped[]`（超限/不可读）。blob 存 `blobs/<aa>/<sha256>`，内容寻址天然去重，读取时校验哈希。

**增量哈希复用**：把上一个检查点的清单按根建索引，若某文件的 `size` 与 `mtimeMs` 都没变，直接复用旧哈希——未改动的文件只花一次 `stat`。实测第二次快照 `hashed=0, reused=23, walkMs=4`。

**还原顺序**（一次遍历即可安全完成）：先建目录（浅→深），再写/覆盖文件（校验 blob 哈希、按需恢复 mode），接着重建符号链接，最后删除检查点里不存在的文件与目录（深→浅）。排除规则（`.git`/`node_modules`/缓存目录/大体积后缀）在两个方向上一致，因此不会误删被排除的内容。

**安全网**：每次工作区回滚前自动建立且只保留一个「回滚前备份」检查点（`afterTurn + 0.5`，在树图上落在两行之间），因此回滚本身可撤销。

---

## 4. 浏览器半

一个手写 bundle，没有构建步骤：

```js
window.__ModuleLoader__.load({ id: 'dsh-plugin-rewind', factory: (require) => { … } })
```

- `id` 必须等于包的模块 id（名），`factory` 必须**同步**，副作用（含注入 CSS）都发生在 factory 内。
- `require` 能解析平台种子表（`react`、`react-dom/client` 等），因此 `React.createElement` 可用。
- 导出 `apply(ctx)` / `inject`（Cordis 服务名）。注册的座位：
  - `sidebar.footer.action` —— 触发器；
  - `shell.overlay` —— 全窗口抽屉（产品声明的浮层座位）；
  - `settings.section` —— 设置页，侧栏折叠时依然可达；
  - `conversation.session.header.actions` —— 只渲染 `null` 的隐形探针，用来读取当前会话 id。
- **文案**：不使用插槽注入的 `t`（它绑定的是外壳为该座位注册的命名空间，实测不含本插件的 key，会直接渲染出 `panel.title` 这样的 id），而是 `ctx.get('locale').bind('rewind')` + 自带字典兜底。
- **会话 id 三层兜底**：`ctx.get('sessions').list` 快照 → 隐形探针记录的 `sessionId` → 都不行时让 host 自动挑选最近活跃的会话（面板显示「已自动选择最近活跃的会话」）。

### 树图的坐标与视觉

- 行 = 轮次（`afterTurn`），列 = 分支（DFS 前序分配，fork 总在父列右侧）；左侧 gutter 标出「第 N 轮」。
- 每个分支画一条**连续竖轨**（rail），节点通过**短横线**接到轨上，接点是一个**圆点**（双层：外圈 + 实心芯）。分支头是一个圆角 chip。
- 节点是卡片：左侧 3px 色条表示类型（含快照=绿、仅对话=蓝、备份=黄、已离开分支=灰），第一行轮次/类型，第二行提问摘要，右上角状态徽标。
- **SVG 文本不会换行也不会裁剪**，所以标签一律按像素测量截断（`fitText`：CJK/全角/emoji 记 1em，拉丁记 0.56em，超出回退到能容纳省略号的位置），并为右上角徽标预留宽度。
- 浮层抽屉整体避开窗口标题栏（`padding-top: var(--rw-titlebar-height, 44px)` 作用在 layer 上，backdrop 仍满屏），并且页头与页脚都放了一份操作按钮、`Esc` 也能关闭——因为无边框窗口的标题栏条带会吞掉落在其中的点击。

---

## 5. 传输与安全

浏览器半没有 `host.call`（那是动态插件的求值器闭包），因此走**同源 HTTP**：

- host 半 `ctx.webServer.register({ kind: 'exact', path: '/dsh-rewind/rpc', handler })`；
- 信封 `{ ok: true, value }` / `{ ok: false, error: { code, message } }`；
- 方法：`status`、`overview`、`snapshot`、`plan`、`apply`、`remove`、`gc`；
- 防护：loopback-only 围栏（socket 地址为准，从不信任 `X-Forwarded-For`，同时校验 `Host`/`Origin`/`sec-fetch-site`）、只接受 POST + `application/json`、请求体上限 1 MiB、`apply`/`gc` 必须显式 `confirm: true`。

存储写入走 `node:fs/promises` 而不是 `ctx.fs`：`ctx.fs` 没有删除/建目录/哈希原语，而且它的写入受部署沙箱限制——回滚需要能删目录，只能自己来。这是有意的取舍，README 的"边界"一节里写明。

---

## 6. 测试策略

7 个探针 + 2 个诊断工具，共 254 条断言；原则是**对着真实实现测，不写 mock 版协议**：

| 探针 | 关键点 |
| --- | --- |
| `workspace` | 快照/diff/干跑/还原/幂等/二进制/去重/超限/符号链接 |
| `engine` | 检查点生命周期、回退预览、多工作区覆盖、压缩归因、回填与升级、fork 分支、自动挑选会话、GC |
| `session-rewind` | 对真实 `dsh-session` 做 surface 替换、独立 `foldSurface` 复核、**回退后的日志能重新 seed 加载** |
| `version-compat` | 两代方言（真实模块 + 双份会话替身）、方言误判的兜底重试、不可读对象报错 |
| `client` | 模块包装契约、树布局数学、真实 `react-dom/server` 渲染、动作门控、**全量 emoji 扫描** |
| `host-mount` | 挂载清单、真实 HTTP 往返、RPC 契约（405/415/403/确认门）、模型工具、turn 边界自动快照 |
| `running-session` | 用 `app.asar` 里那份 `dsh-session`（0.2.0-rc.2）跑通全流程 |
| `live-forensics`（工具） | 解码真实存储日志、复算 surface 并自检节点数一致、把树图渲染成独立 HTML 供人眼确认 |

`live-forensics` 的自检（`surface 节点数 == 带 append 标记的事件数`）就是第 2 节那个折叠 bug 的固化回归——它不需要启动应用，也不需要构造替身。
