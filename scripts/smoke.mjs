// Boots the built app in smoke mode, then asserts on the file it writes.
// M-004: Electron prints nothing to a parent shell on Windows — exit codes and
// files are the only trustworthy signals.
import { spawnSync } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const smokeFile = path.join(root, 'out', 'smoke.json')

rmSync(smokeFile, { force: true })

// The real exe, not the .cmd shim: spawning .cmd with shell:false throws
// EINVAL on current Node (the shell-injection CVE fix), and shell:true is
// banned here by invariant. Same lesson family as MISTAKES.md M-004.
const r = spawnSync(path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'), ['.'], {
  cwd: root,
  shell: false,
  env: { ...process.env, MEETFROGE_SMOKE: '1' },
  timeout: 60_000,
})

let result
try {
  result = JSON.parse(readFileSync(smokeFile, 'utf8'))
} catch {
  console.error(`SMOKE FAIL: app exited ${r.status} without writing ${smokeFile}`)
  process.exit(1)
}

console.log(JSON.stringify(result, null, 2))
if (result.ok) {
  console.log('\nSMOKE PASS')
  process.exit(0)
}
console.error('\nSMOKE FAIL')
process.exit(1)
