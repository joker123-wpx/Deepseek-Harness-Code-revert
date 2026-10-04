/**
 * Test entry point: runs every probe in its own child process and aggregates
 * the result.
 *
 * The probes import the real `@deepseek-ai/dsh-session` implementation and the
 * profile's React, so the rollback engine and the browser half are both checked
 * against the code the running harness actually uses. Point `DSH_MODULES` at a
 * different `node_modules` to test against another install.
 *
 * Run: node test/run.mjs
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const here = fileURLToPath(new URL('.', import.meta.url))
const probes = [
  ['workspace', 'workspace.probe.mjs'],
  ['checkpoints + rollback engine', 'engine.probe.mjs'],
  ['conversation rewind + replay', 'session-rewind.probe.mjs'],
  ['dsh-session version compatibility', 'version-compat.probe.mjs'],
  ['browser half + tree rendering', 'client.probe.mjs'],
  ['host mount + RPC round trip', 'host-mount.probe.mjs'],
]

// The strongest check available: the plugin's session helpers driven against
// the `dsh-session` copy the RUNNING desktop app loads out of app.asar. Plain
// Node cannot read an asar path, so it only runs under the bundled Electron
// binary in Node mode, and only when that binary is discoverable.
const desktopNode = process.env.DSH_DESKTOP_NODE_EXECUTABLE

/** Run one probe, streaming its output. */
function run(file, executable = process.execPath) {
  return new Promise((resolve) => {
    const needsShell = /\.(cmd|bat)$/i.test(executable)
    const child = spawn(needsShell ? `"${executable}"` : executable, [join(here, file)], {
      stdio: 'inherit',
      env: process.env,
      shell: needsShell,
    })
    child.on('exit', (code) => resolve(code ?? 1))
    child.on('error', (error) => {
      console.log(`cannot start ${executable}: ${String(error)}`)
      resolve(1)
    })
  })
}

let failed = 0
for (const [title, file] of probes) {
  console.log(`\n${'='.repeat(72)}\n${title}  (${file})\n${'='.repeat(72)}`)
  const code = await run(file)
  if (code !== 0) failed += 1
}

if (desktopNode !== undefined && desktopNode !== '') {
  console.log(`\n${'='.repeat(72)}\nagainst the running app's session module  (running-session.probe.mjs)\n${'='.repeat(72)}`)
  const nodeCmd = process.env.DSH_DESKTOP_NODE_CMD
    ?? 'D:\\Deepseek-Harness\\resources\\runtime\\bin\\node.cmd'
  const code = await run('running-session.probe.mjs', nodeCmd)
  if (code !== 0) failed += 1
} else {
  console.log('\nSKIP  running-session.probe.mjs — set DSH_DESKTOP_NODE_EXECUTABLE to the Electron binary to enable it')
}

console.log(`\n${'='.repeat(72)}`)
if (failed === 0) {
  console.log(`all probes passed`)
} else {
  console.log(`${failed} probe(s) failed`)
  process.exitCode = 1
}
