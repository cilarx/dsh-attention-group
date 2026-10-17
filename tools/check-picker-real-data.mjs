/**
 * The 「拉人」 picker against YOUR real data — no DSH restart needed.
 *
 * WHY THIS EXISTS. The picker's whole point is that a row can be recognised by a
 * title. Whether that works on a given machine cannot be answered by a unit test:
 * a test can only prove the code matches the contract THE TEST BELIEVES. On
 * 2026-10-17 exactly that gap shipped a picker whose titles were all missing in
 * the live deployment while every test was green — twice, because the first
 * "fix" was built against the wrong DSH version (see below).
 *
 * WHAT IT DOES: it reads the real session directories, the real
 * `session_projcache` records and the real workspace registry, re-implements
 * `sessionController.list()` the way the RUNNING DSH does it — titles from each
 * session's cached `title` projection, `updatedAt` from the cached
 * `sessionListMetadata.lastPromptAt` — and then runs the plugin's own
 * `listSessionCandidates()` over that. Finally it cross-checks every returned row
 * against the cache file: a title may be absent only when the cache has none.
 *
 * ⚠️ VERSION DISCIPLINE (the 2026-10-17 lesson, in full): the packages in
 * `~/.dsh/profiles/node_modules/@deepseek-ai` are a STALE 0.1.5-rc.1 copy — the
 * running 0.2.1-rc.2 host loads its own from `app.asar`. Contracts must be read
 * from there (or from the runtime's Inspect providers), never from the profile
 * tree. This script encodes the 0.2.1 shape, which is what this machine runs.
 *
 * READ-ONLY: nothing is written anywhere.
 *
 * Usage: node tools/check-picker-real-data.mjs
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const sessionsUrl = pathToFileURL(join(import.meta.dirname, '..', 'src', 'sessions.js')).href
const { listSessionCandidates, sessionLogTimes, MAX_CANDIDATES } = await import(sessionsUrl)

let failed = 0
const fail = (message) => {
  failed += 1
  console.log(`  FAIL  ${message}`)
}
const ok = (message) => console.log(`  ok    ${message}`)

// ---------------------------------------------------------------------------
// 1. the real projection-cache records
// ---------------------------------------------------------------------------
const cacheDir = join(home, 'storages', 'session_projcache', 'sessions')
if (!existsSync(cacheDir)) {
  console.log(`no projection cache at ${cacheDir} — nothing to check on this machine`)
  process.exit(0)
}
const cacheRecords = new Map()
for (const name of readdirSync(cacheDir)) {
  if (!name.endsWith('.json')) continue
  try {
    const parsed = JSON.parse(readFileSync(join(cacheDir, name), 'utf8'))
    if (parsed?.record !== undefined) cacheRecords.set(name.slice(0, -5), parsed.record)
  } catch {
    // A broken record is exactly what the service also ignores; it shows up as an
    // untitled row below, not as a crash.
  }
}
console.log(`\n== real data ==`)
console.log(`  projection cache: ${cacheRecords.size} record(s)`)

const sessionsRoot = join(home, 'sessions')
const records = []
if (existsSync(sessionsRoot)) {
  for (const bucket of readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (bucket.isDirectory() !== true) continue
    for (const entry of readdirSync(join(sessionsRoot, bucket.name), { withFileTypes: true })) {
      if (entry.isDirectory() !== true) continue
      const identity = cacheRecords.get(entry.name)?.identity
      records.push({
        header: {
          version: identity?.formatVersion ?? 4,
          id: entry.name,
          createdAt: identity?.createdAt ?? 0,
          isSeeded: identity?.isSeeded === true,
          ...(identity?.cwd === undefined ? {} : { cwd: identity.cwd }),
          ...(identity?.origin === undefined ? {} : { origin: identity.origin }),
        },
        live: false,
        persisted: true,
      })
    }
  }
}
console.log(`  session dirs:      ${records.length}`)

/** The current `title` projection state-schema version (dsh-session-title). */
const TITLE_UNIT_VERSION = 1
/** lifecycleIdentityOf(meta): formatVersion, createdAt, cwd, isSeeded — no cut. */
function lifecycleOf(meta) {
  return {
    formatVersion: meta?.version,
    createdAt: meta?.createdAt,
    ...(meta?.cwd === undefined ? {} : { cwd: meta.cwd }),
    isSeeded: meta?.isSeeded === true,
  }
}
const sameScalar = (a, b) => (a === undefined ? b === undefined : String(a) === String(b))
function cachedTitleOf(meta, keys) {
  const expected = lifecycleOf(meta)
  const record = cacheRecords.get(meta?.id)
  if (record === undefined) return undefined
  const stored = record.identity
  if (stored.formatVersion !== expected.formatVersion) return undefined
  if (!sameScalar(stored.createdAt, expected.createdAt)) return undefined
  if (!sameScalar(stored.cwd, expected.cwd)) return undefined
  if ((stored.isSeeded === true) !== (expected.isSeeded === true)) return undefined
  if (keys !== undefined && !keys.includes('title')) return undefined
  const row = record.rows?.title
  if (row === undefined || row.ver !== TITLE_UNIT_VERSION) return undefined
  if (typeof row.val !== 'string' || row.val.trim().length === 0) return undefined
  return { asOfSeq: row.seq, values: { title: row.val } }
}

// ---------------------------------------------------------------------------
// 3. the real workspace registry
// ---------------------------------------------------------------------------
const workspaceFile = join(home, 'storages', 'workspace.json')
const workspaces = []
if (existsSync(workspaceFile)) {
  const registry = JSON.parse(readFileSync(workspaceFile, 'utf8'))
  for (const [id, row] of Object.entries(registry?.tables?.workspaces ?? {})) {
    workspaces.push({ id, title: row.title, path: row.path, sessionIds: Array.isArray(row.sessionIds) ? row.sessionIds : [] })
  }
}
console.log(`  workspaces:        ${workspaces.length}`)

const ctx = {
  get(name) {
    if (name === 'sessionQuery') {
      return {
        async listSessions() {
          return records
        },
        async readTitleSnapshots() {
          throw new Error('the expensive fold path must not run while the cache works')
        },
      }
    }
    if (name === 'sessionProjectionCache') {
      return {
        // Declared with TWO parameters: the live 0.2.1 arity, which the module
        // uses to decide the call shape.
        cachedSnapshot(meta, keys) {
          return cachedTitleOf(meta, keys)
        },
        cachedPredecessorTitle(meta) {
          lifetimeGuard(meta)
          return undefined
        },
      }
    }
    if (name === 'workspaceRegistry') return { list: () => workspaces }
    return undefined
  },
}

/** The real predecessor read validates its own lifecycle too. */
function lifetimeGuard(meta) {
  return lifecycleOf(meta)
}
// ---------------------------------------------------------------------------
// 4. run the plugin's own function over the real data
// ---------------------------------------------------------------------------
console.log(`\n== the picker's own code on that data ==`)
const started = performance.now()
const payload = await listSessionCandidates({ ctx, dshHome: home })
const elapsed = performance.now() - started

if (payload.ok !== true) {
  fail(`listSessionCandidates refused: ${payload.error}`)
} else {
  ok(`listed ${payload.shown} / ${payload.total} session(s) in ${elapsed.toFixed(1)} ms (cap ${payload.max}, the panel says how many it hides)`)
  ok(`titlesStatus "${payload.titlesStatus}"`)
  ok(`timeSource "${payload.timeSource}"`)
  if (payload.titlesStatus !== 'ok') fail(`the titles are not fully readable: ${payload.titlesStatus}`)
  if (payload.timeSource !== 'session-log-mtime') {
    fail(`the activity times did not come from the session logs: ${payload.timeSource}`)
  }

  console.log('\n  the rows the picker would draw:')
  for (const row of payload.sessions.slice(0, 12)) {
    const minutes = row.lastUsedAt === '' ? null : Math.round((Date.now() - Date.parse(row.lastUsedAt)) / 60000)
    const when = minutes === null ? '时间未知' : minutes < 60 ? `${minutes} 分钟前` : `${Math.round(minutes / 60)} 小时前`
    console.log(
      `    ${(row.title || '（无标题会话）').slice(0, 34).padEnd(36)} | ${(row.workspace || '工作区未知').padEnd(9)} | ${when.padEnd(11)} | ${row.id.slice(0, 26)}`,
    )
  }

  // -------------------------------------------------------------------------
  // 5. cross-check EVERY row against the real cache record
  // -------------------------------------------------------------------------
  let matched = 0
  let invented = 0
  let shouldHaveTitle = 0
  for (const row of payload.sessions) {
    const cached = typeof cacheRecords.get(row.id)?.rows?.title?.val === 'string' ? cacheRecords.get(row.id).rows.title.val.trim() : ''
    if (row.title === '') {
      if (cached.length > 0) shouldHaveTitle += 1
      continue
    }
    const expected = cached.length > 120 ? `${cached.slice(0, 120)}…` : cached
    if (cached.length > 0 && row.title === expected) matched += 1
    else {
      invented += 1
      console.log(`    !! ${row.id}: shown "${row.title.slice(0, 50)}" but cache holds "${cached.slice(0, 50)}"`)
    }
  }
  console.log(`\n  titles matching the cache byte for byte: ${matched}`)
  console.log(`  titles a row would have to invent:       ${invented}`)
  console.log(`  untitled rows whose cache has a title:   ${shouldHaveTitle}`)
  console.log(`  rows with a real activity time:          ${payload.sessions.filter((row) => row.lastUsedAt !== '').length} / ${payload.sessions.length}`)
  console.log(`  rows with a workspace label:             ${payload.sessions.filter((row) => row.workspace !== '').length} / ${payload.sessions.length}`)
  const scanned = sessionLogTimes(home)
  if (scanned.scanned !== true) fail(`the session-log scan failed: ${scanned.error}`)
  if (invented !== 0) fail('a row would show a title the cache does not hold')
  if (shouldHaveTitle !== 0) fail('a row that has a cache title is shown untitled')
  if (matched === 0) fail('no title resolved at all — the whole point of the picker is missing')
  if (payload.shown > MAX_CANDIDATES) fail(`the cap ${MAX_CANDIDATES} was exceeded`)
}

console.log('')
if (failed === 0) {
  console.log('PASS — titles, activity times and workspaces on this machine all come from real data')
  process.exit(0)
}
console.log(`FAIL — ${failed} problem(s) above`)
process.exit(1)
