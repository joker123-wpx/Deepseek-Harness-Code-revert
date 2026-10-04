# dsh-plugin-rewind

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin:
**conversation rewind**, **workspace rollback**, and a **checkpoint tree graph** —
no emoji, no DOM injection, no build step.

[中文文档](README.md) · [Architecture notes](docs/ARCHITECTURE.md)

---

## What it does

DSH sessions are append-only and the harness never truncates them. This plugin
adds the missing half: a checkpoint after every turn, and a panel that lets you
go back to any of them.

| Capability | Detail |
| --- | --- |
| Automatic checkpoints | After every `turn/end`, a content-addressed snapshot of **every workspace this conversation belongs to** (its `cwd`, its fork lineage's `cwd`s, and the registered workspaces those sessions are attached to). An extra "initial state" checkpoint is taken at session start. Unchanged files cost one `stat`, not a re-read. |
| Rewind conversation (new branch) | Uses the product's own `sessions.fork`: a child session seeded with the history before the checkpoint is created and opened. The chat really goes back; the current session stays intact as a sibling branch. |
| Rewind conversation (forget in place) | Appends one surface-replacement event to the current session: the model no longer sees the rewound turns, the log keeps every byte, and the tree draws them as an abandoned branch. What the chat window already displayed is unchanged. |
| Roll back workspace files | Restores modified files, recreates deleted ones, removes files created since — per workspace, then aggregated. A "pre-rollback backup" checkpoint is taken first, so the rollback is itself undoable. |
| Attribution | The tree distinguishes *rewound by this plugin*, *folded away by compaction*, *replaced by an in-history system-prompt update*, *replaced by another producer*, and *conversation-only, no file snapshot*. Nothing is blamed on the wrong actor. |
| Folding long timelines | Past ten rows the timeline shows only the newest ten, with one row above them saying how many are folded and expanding them on click; expanding offers "fold the older turns away" in the same spot. Short conversations never fold. |
| Queued while the agent works | Confirming a rewind while the agent is running a tool call neither fails nor goes quiet: the request is **queued**, the panel says so (with a cancel control), and it runs when the turn ends. A queued edit-and-re-ask sends the edited prompt once the rewind lands. |
| Fork after a rewind | An in-place rewind forks the model-visible history: the folded-away turns become a **grey dashed dead branch** on their own rail, and a **new rail opens to the right** of the rewind point, joined by a curve that runs from the rewind point straight to the new turn's node. The curve never overlaps the dead rail, so it is obvious where the cut was made. |
| Tree graph | Git-log style: a turn gutter on the left, then one continuous rail per branch with a junction dot per checkpoint, then a full-width row card (a 3px left stripe encodes the kind; line one is the turn plus a state badge, line two the prompt excerpt plus the snapshot size). Selection carries exactly one signal — the card's accent outline and tint. All artwork is SVG paths; strictly **no emoji**. |
| Edit and re-ask | The turn prompt in the details pane is editable, with a **gold** "rewind and ask again" button (the only gold control in the panel): it undoes *that* turn (the model no longer sees it), then places your edited prompt in the composer and sends it as a new turn. The rewind anchors on the checkpoint above the turn, so even the newest turn can be edited and re-asked. Delivery uses the product's public session-scoped `inputActions` (`setDraft` / `submit`), not a private API. |
| Model tool | A `rewind` tool lets the agent list checkpoints and (only when the user asks) perform a rollback. |
| Follows switches | After a workspace or session switch the panel follows the new conversation on its own: it subscribes to the session list and the workspace registry, re-reads the active session every 1.2s and refreshes the overview every 3s (skipped while the window is hidden), and clears the selection, details and any pending confirmation immediately. |
| Bilingual copy | Chinese / English. The plugin binds its own locale namespace instead of trusting the shell's injected `t`. |

---

## Install

**Requirements** — a DSH profile (`desktop`, `web`, …) and the `dsh` CLI on
`PATH`. Nothing else: the host half has no runtime dependencies, and the browser
half is a hand-written bundle served straight from this package.

### A. With the plugin manager (recommended)

```bash
git clone https://github.com/joker123-wpx/Deepseek-Harness-Code-revert.git
dsh plugin --profile desktop add /absolute/path/to/Deepseek-Harness-Code-revert
```

`dsh plugin add` forwards to pnpm inside the profile, then reconciles
`dsh.profile.bundles` against what is installed. Because this package declares
`dsh.bundle`, it joins the layer stack automatically.

### B. Manually

1. Put the package where the profile resolves packages, i.e.
   `<DSH_HOME>/profiles/<profile>/node_modules/dsh-plugin-rewind`
   (a copy, or a directory junction to your checkout).
2. Add it to the profile manifest `<DSH_HOME>/profiles/<profile>/package.json`:

   ```json
   {
     "dependencies": {
       "dsh-plugin-rewind": "file:/absolute/path/to/Deepseek-Harness-Code-revert"
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

`cordis.patch.yml` inside the package carries the single row that mounts both
halves; you never edit it by hand.

### Activate

**Restart the app.** The bundle layer stack is composed at process start and the
Web shell disables its HMR row, so a new plugin is picked up only on restart.
(After that, edits to `lib/client.js` need no restart: the module host serves the
bundle from disk on every request with `cache-control: no-cache`, so a page
refresh is enough.)

### Verify

* Sidebar footer gains a **对话回退 / Rewind** button; Settings gains a
  **对话回退** page. Both open the same panel.
* The agent's tool list gains `rewind`.
* `POST http://127.0.0.1:<port>/dsh-rewind/rpc` with `{"method":"status"}`
  answers `{"ok":true,…}` and reports `diagnostics.sessionApiFlavor`.

### Uninstall

Remove the dependency from the profile manifest and restart; then delete
`<DSH_HOME>/rewind/v1` if you also want the snapshots gone.

---

## Usage

1. Open the panel from the sidebar button (or Settings → 对话回退).
2. Pick any node in the tree. The right pane shows the turn, the checkpoint kind,
   the snapshot size, the workspaces it covers, that turn's prompt, and the files
   a rollback would touch.
3. Choose an action; a confirmation dialog lists exactly what will change.

| Action | Effect |
| --- | --- |
| 回退对话（新分支） | Fork a child session containing only the history before this checkpoint, and switch to it. |
| 回退对话（就地遗忘） | Append a surface replacement: the model forgets from here on, the transcript and the log keep everything. |
| 回滚工作区文件 | Restore every covered workspace to the checkpoint. A backup checkpoint is taken first. |
| 全部回退 | Both, in that order (files first, then the conversation). |
| 恢复到这次备份 | Offered on a `回滚前备份` node — undoes a rollback. |
| 立即创建检查点 | Manual checkpoint, including all covered workspaces. |

---

## How it works, in one screen

* **Checkpoints** live in `<DSH_HOME>/rewind/v1`: `blobs/<aa>/<sha256>` for file
  bytes, `manifests/<sessionId>/<cpId>.json` (and `<cpId>~<n>.json` for extra
  workspaces) for manifests, `index/<sessionId>.json` for the checkpoint list.
  Manifests record paths, sha256, size, mtime, mode, empty directories and
  symlink targets; oversized files are recorded as *unrestorable* and reported
  rather than written wrongly.
* **Rewind** appends a message-less surface replacement. `dsh-session` documents
  that as a general producer contract ("Used by compaction; any surface-replacing
  producer may use it"), so nothing is ever deleted and an independent fold
  reproduces the result.
* **Two API dialects are supported at once** — see
  [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the table. The desktop app in
  the author's install runs `dsh-session` 0.2.0-rc.2 from `app.asar` while the
  profile resolves 0.1.0-rc.7; the plugin probes the session object and speaks
  whichever dialect it finds, retrying once if it guessed wrong.

### Known limits

* Rollback covers the conversation's workspaces only. `bash`/`pwsh` can write
  anywhere; work outside those roots is out of scope.
* Windows ACLs are not restored (POSIX `mode` is).
* A rollback is refused while a tool call is in flight (`session-busy`); a
  snapshot that overlapped one is marked `degraded`.
* Background shell jobs run outside checkpoint boundaries.

---

## Development

```
lib/index.js         host half: route, turn-boundary hooks, model tool, prompt band
lib/engine.js        engine: checkpoints, overview, plan, apply, multi-root, GC
lib/workspace.js     workspace engine: scan, incremental hashing, diff, restore
lib/conversation.js  session side: turn analysis, surface fold, rewind dialects
lib/store.js         persistence: CAS blobs, manifests, index, trash, GC
lib/rpc.js           transport: one RPC route with a loopback fence
lib/client.js        browser half: three slots, SVG tree, details pane, dialogs
test/                7 offline probes + 2 diagnostics (325 assertions)
```

```bash
node test/run.mjs
```

The probes load the real `@deepseek-ai/dsh-session` and the profile's React. Two
of them are worth knowing about:

```bash
# Drive the plugin against the dsh-session copy the RUNNING app loads (asar):
$env:DSH_DESKTOP_NODE_EXECUTABLE='D:\Deepseek-Harness\DeepSeek Harness.exe'
node test/run.mjs

# Audit the real stored session log, re-fold its surface, and render a
# standalone preview of the panel with real checkpoint data:
node test/live-forensics.mjs [sessionId]
```

`DSH_MODULES` points the probes at another `node_modules` tree.

---

## License

Apache License 2.0 — see [LICENSE](LICENSE).
