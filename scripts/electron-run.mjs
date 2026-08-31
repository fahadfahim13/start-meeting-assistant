/**
 * Launch the app for a harness, and PROVE it actually ran.
 *
 * MeetFroge holds a single-instance lock (`app.requestSingleInstanceLock()`).
 * A second launch therefore quits immediately **with exit code 0** — so a stray
 * instance left behind by an earlier harness makes every subsequent run report
 * success while doing nothing at all. That is not hypothetical: three
 * consecutive `MEETFROGE_SMOKE=1` runs "passed" this way and a schema migration
 * silently never applied (MISTAKES.md M-030).
 *
 * So: kill strays first, and assert on a FRESH artefact rather than on the exit
 * code. Every harness in this folder should go through here.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'

export const ROOT = path.resolve(import.meta.dirname, '..')
export const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')

/** Kill leftover app processes so the single-instance lock is free. */
export function killStrays() {
  for (const image of ['electron.exe', 'llama-server.exe']) {
    spawnSync('taskkill', ['/F', '/IM', image, '/T'], { shell: false, stdio: 'ignore' })
  }
}

/**
 * Run the app once and require `expectFile` to be newly written.
 *
 * @returns {{ ok: boolean, status: number|null, reason: string|null }}
 */
export function runApp({ env = {}, expectFile, timeoutMs = 15 * 60_000 } = {}) {
  killStrays()
  if (expectFile) rmSync(expectFile, { force: true })

  const startedAt = Date.now()
  const res = spawnSync(ELECTRON, ['.'], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: 'ignore',
    timeout: timeoutMs,
  })

  if (!expectFile) return { ok: res.status === 0, status: res.status, reason: null }

  if (!existsSync(expectFile)) {
    return {
      ok: false,
      status: res.status,
      // The exit code is deliberately reported as untrustworthy here.
      reason: `${path.basename(expectFile)} was not written (exit ${res.status}). A stray instance holding the single-instance lock exits 0 without booting — check for leftover electron.exe.`,
    }
  }
  if (statSync(expectFile).mtimeMs < startedAt) {
    return {
      ok: false,
      status: res.status,
      reason: `${path.basename(expectFile)} is stale — the app did not run this time (exit ${res.status}).`,
    }
  }
  return { ok: true, status: res.status, reason: null }
}
