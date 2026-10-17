/**
 * The 「拉人」 picker against YOUR real data — no DSH restart needed.
 *
 * WHY THIS EXISTS. The picker's whole point is that a row can be recognised by
 * its title. Whether the titles are actually readable on a given machine has two
 * independent answers:
 *
 *   1. does the code call the projection cache correctly, and
 *   2. does this machine's cache actually hold titles?
 *
 * Question 1 is unit-tested (`test/sessions.test.js`), but a unit test can only
 * prove the code matches the CONTRACT THE TEST BELIEVES. It cannot prove the
 * contract itself — and on 2026-10-17 that exact gap nearly shipped a broken
 * feature: the runtime's Service inspect catalog showed
 * `cachedSnapshot(meta, keys?)`, while the shipped implementation is
 * `cachedSnapshot(meta, inheritedEventCount, keys?)` and THROWS when an unseeded
 * session is passed the wrong cut. Every test was green; every title would have
 * been missing. Question 2 cannot be answered by any test at all.
 *
 * This script answers both, against the user's real files, without starting or
 * restarting DSH: it reads the real session directories, the real
 * `session_projcache` records and the real workspace registry, re-implements the
 * two DSH services as faithfully as their shipped source allows, and then runs
 * the plugin's own `listSessionCandidates()` over them.
 *
 * WHAT IT PROVES: the real titles come back (and match the cache byte for byte),
 * the real activity times come from the real logs, the workspace labels resolve.
 * WHAT IT DOES NOT PROVE: the live Cordis wiring (`ctx.get('…')` returning those
 * services). That needs a restarted DSH — but after this script passes, the only
 * remaining unknown is one property lookup.
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
    // A broken record is exactly what the service also ignores; it will show up
    // as an untitled row below, not as a crash.
  }
}
console.log(`\n== real data ==`)
console.log(`  projection cache: ${cacheRecords.size} record(s)`)

// ---------------------------------------------------------------------------
// 2. a faithful stand-in for `sessionProjectionCache` (title unit only)
//
// Copied from the shipped implementation (`dsh-session-projection-cache`):
// identityOf() and its throw, the identity comparison, and viewCheckpoint's
// `row.ver !== stateVersion` filter for the `title` unit (stateVersion 1).
// ---------------------------------------------------------------------------
function identityOf(header, inheritedEventCount) {
  const cut = Number(inheritedEventCount)
  if (!header.isSeeded && cut !== 0) {
    throw new Error('unseeded projection-cache identity inherited event count must be 0')
  }
  return {
    formatVersion: header.version,
    createdAt: header.createdAt,
    ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
    isSeeded: header.isSeeded,
    inheritedEventCount: cut,
  }
}
const sameScalar = (a, b) => (a === undefined ? b === undefined : String(a) === String(b))
const sessionProjectionCache = {
  cachedSnapshot(header, inheritedEventCount, keys) {
    const expected = identityOf(header, inheritedEventCount)
    const record = cacheRecords.get(header.id)
    if (record === undefined) return undefined
    const stored = record.identity
    if (stored.formatVersion !== expected.formatVersion) return undefined
    if (!sameScalar(stored.createdAt, expected.createdAt)) return undefined
    if (!sameScalar(stored.cwd, expected.cwd)) return undefined
    if (stored.isSeeded !== expected.isSeeded) return undefined
    if (Number(stored.inheritedEventCount ?? 0) !== expected.inheritedEventCount) return undefined
    const row = record.rows?.title
    if (row === undefined || row.ver !== 1) return undefined
    if (keys !== undefined && !keys.includes('title')) return undefined
    if (typeof row.val !== 'string' || row.val.trim().length === 0) return undefined
    return { asOfSeq: row.seq, values: { title: row.val } }
  },
  cachedPredecessorTitle(header, inheritedEventCount) {
    identityOf(header, inheritedEventCount) // the real one validates the same way
    return undefined // these checkpoints are current, not predecessors
  },
}

// ---------------------------------------------------------------------------
// 3. a faithful stand-in for `sessionQuery.listSessions()`
//
// The real one lists the session directories and returns each stored header. A
// header carries (version, id, createdAt, cwd, isSeeded, …); the cache's identity
// block is exactly those fields, which is why it can stand in for them here.
// ---------------------------------------------------------------------------
const sessionsRoot = join(home, 'sessions')
const records = []
const seededIds = new Set()
if (existsSync(sessionsRoot)) {
  for (const bucket of readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!bucket.isDirectory()) continue
    for (const entry of readdirSync(join(sessionsRoot, bucket.name), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const identity = cacheRecords.get(entry.name)?.identity
      if (identity?.isSeeded === true) seededIds.add(entry.name)
      records.push({
        header: {
          version: identity?.formatVersion ?? 4,
          id: entry.name,
          createdAt: identity?.createdAt ?? 0,
          ...(identity?.cwd === undefined ? {} : { cwd: identity.cwd }),
          isSeeded: identity?.isSeeded === true,
        },
        live: false,
        persisted: true,
      })
    }
  }
}
console.log(`  session dirs:     ${records.length}`)
console.log(`  forked sessions:  ${seededIds.size}`)

// ---------------------------------------------------------------------------
// 4. the real workspace registry
// ---------------------------------------------------------------------------
const workspaceFile = join(home, 'storages', 'workspace.json')
const workspaces = []
if (existsSync(workspaceFile)) {
  const registry = JSON.parse(readFileSync(workspaceFile, 'utf8'))
  for (const [id, row] of Object.entries(registry?.tables?.workspaces ?? {})) {
    workspaces.push({ id, title: row.title, path: row.path, sessionIds: Array.isArray(row.sessionIds) ? row.sessionIds : [] })
  }
}
console.log(`  workspaces:       ${workspaces.length}`)

const ctx = {
  get(name) {
    if (name === 'sessionQuery') return { async listSessions() { return records } }
    if (name === 'sessionProjectionCache') return sessionProjectionCache
    if (name === 'workspaceRegistry') return { list: () => workspaces }
    return undefined
  },
}

// ---------------------------------------------------------------------------
// 5. run the plugin's own function over the real data
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
  if (payload.timeSource !== 'session-log-mtime') fail(`the activity times are missing: ${payload.timeError ?? 'no reason given'}`)

  console.log('\n  the rows the picker would draw:')
  for (const row of payload.sessions.slice(0, 12)) {
    const minutes = row.lastUsedAt === '' ? null : Math.round((Date.now() - Date.parse(row.lastUsedAt)) / 60000)
    const when = minutes === null ? '时间未知' : minutes < 60 ? `${minutes} 分钟前` : `${Math.round(minutes / 60)} 小时前`
    console.log(
      `    ${(row.title || '（无标题会话）').slice(0, 34).padEnd(36)} | ${(row.workspace || '工作区未知').padEnd(9)} | ${when.padEnd(11)} | ${row.id.slice(0, 26)}`,
    )
  }

  // -------------------------------------------------------------------------
  // 6. cross-check EVERY row against the real cache record
  // -------------------------------------------------------------------------
  let matched = 0
  let invented = 0
  let shouldHaveTitle = 0
  for (const row of payload.sessions) {
    const record = cacheRecords.get(row.id)
    const cached = typeof record?.rows?.title?.val === 'string' ? record.rows.title.val.trim() : ''
    if (row.title === '') {
      // A forked session's own checkpoint cannot be matched by a listing: the
      // inherited cut lives outside the header, and the shipped listing path has
      // exactly the same gap (it also passes 0). Its title is genuinely not
      // reachable from here, so this is expected, not a bug.
      if (cached.length > 0 && record.rows.title.ver === 1 && record.identity.isSeeded !== true) shouldHaveTitle += 1
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
  console.log(`  untitled rows whose cache has a title:   ${shouldHaveTitle} (forked sessions are excluded on purpose)`)
  console.log(`  rows with a real activity time:          ${payload.sessions.filter((row) => row.lastUsedAt !== '').length} / ${payload.sessions.length}`)
  console.log(`  rows with a workspace label:             ${payload.sessions.filter((row) => row.workspace !== '').length} / ${payload.sessions.length}`)
  // A session living outside every registered workspace is honestly labelled by
  // its directory name in the panel, so no label is not a failure.
  const unscanned = sessionLogTimes(home)
  if (unscanned.scanned !== true) fail(`the session-log scan failed: ${unscanned.error}`)
  if (invented !== 0) fail('a row would show a title the cache does not hold')
  if (shouldHaveTitle !== 0) fail('a row that has a cache title is shown untitled')
  if (matched === 0) fail('no title resolved at all — the cache contract is being called wrongly')
  if (payload.shown > MAX_CANDIDATES) fail(`the cap ${MAX_CANDIDATES} was exceeded`)
}

console.log('')
if (failed === 0) {
  console.log('PASS — titles, activity times and workspaces on this machine all come from real data')
  process.exit(0)
}
console.log(`FAIL — ${failed} problem(s) above`)
process.exit(1)
