/**
 * The 「拉人」 picker's catalogue: `src/sessions.js`.
 *
 * WHY THESE TESTS EXIST (2026-10-17, user request): inviting an agent used to mean
 * pasting a session id. The picker that replaced it is only useful if the rows it
 * shows are TRUE — a title from the wrong session, a workspace label that belongs
 * to another room, or an activity time invented from nothing would make choosing
 * by eye WORSE than copying an id, because the mistake is invisible.
 *
 * ⚠️ AND WHY THE STUBS MATTER MORE THAN USUAL: on 2026-10-17 this picker shipped a
 * version whose titles were ALL missing in the user's live deployment, while
 * every test here stayed green — because the test double had been written to
 * match a signature the code believed rather than the one the running runtime
 * actually has. The lesson is baked in below: the double now reproduces the LIVE
 * contract (`sessionController.list()` → `projections.values.title`), and the
 * projection cache is a TRAP that throws if the code ever reaches for it directly
 * again.
 *
 * Run: node --test test/sessions.test.js
 * (requires: pwsh -File tools/sync-plugin.ps1)
 */

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { moduleUrl } from './support/entry.mjs'

const { sessionLogTimes, sortSessionCandidates, listSessionCandidates, MAX_CANDIDATES } = await import(
  moduleUrl('sessions.js')
)

const homes = []
after(() => {
  for (const dir of homes) rmSync(dir, { recursive: true, force: true })
})

/** A throwaway DSH home. */
function newHome() {
  const home = mkdtempSync(join(tmpdir(), 'attention-sessions-'))
  homes.push(home)
  return home
}

/**
 * Plant one session log, with a chosen modification time.
 *
 * @param {string} home - fake DSH home.
 * @param {string} bucket - the encoded-workspace directory name.
 * @param {string} id - session id.
 * @param {number} at - epoch ms, the log's mtime.
 * @returns {string} the session directory.
 */
function plantSession(home, bucket, id, at) {
  const dir = join(home, 'sessions', bucket, id)
  mkdirSync(dir, { recursive: true })
  const log = join(dir, 'session.v4.jsonl.zstd')
  writeFileSync(log, 'log')
  utimesSync(log, new Date(at), new Date(at))
  return dir
}

/**
 * A `ctx` matching the LIVE runtime's services.
 *
 * `sessionController.list()` is the primary source — the same call the Web GUI
 * sidebar makes, whose `SessionSummary.projections.values.title` is the cached
 * title. `sessionQuery.listSessions()` is the fallback for a deployment without a
 * session controller (rows only, no titles).
 *
 * @param {object[]} catalog - `{id, title, cwd, updatedAt, createdAt, live, origin, isSeeded}`.
 * @param {object} [extra] - `{workspaces, listError, noController, noQuery}`.
 * @returns {object} Cordis-context stand-in.
 */
function fakeCtx(catalog, extra = {}) {
  const calls = { cache: 0, titleSnapshots: 0, list: 0 }
  const ctx = {
    calls,
    get(name) {
      if (name === 'sessionProjectionCache') {
        // TRAP: reaching for this means hand-rolling a version-specific signature
        // again. See the file header.
        return {
          cachedSnapshot() {
            calls.cache += 1
            throw new Error('the picker must not call the projection cache directly')
          },
          cachedPredecessorTitle() {
            calls.cache += 1
            throw new Error('the picker must not call the projection cache directly')
          },
        }
      }
      if (name === 'sessionController' && extra.noController !== true) {
        return {
          async list() {
            calls.list += 1
            if (extra.listError !== undefined) throw new Error(extra.listError)
            return catalog.map((row) => ({
              sessionId: row.id,
              updatedAt: row.updatedAt ?? 0,
              running: row.live === true,
              blank: false,
              agentAvailable: row.live === true,
              ...(row.origin === undefined ? {} : { origin: row.origin }),
              ...(row.cwd === undefined ? {} : { cwd: row.cwd }),
              ...(typeof row.title === 'string' && row.title.length > 0
                ? { projections: { kind: 'cached', asOfSeq: 1, values: { title: row.title } } }
                : {}),
            }))
          },
        }
      }
      if (name === 'sessionQuery' && extra.noQuery !== true) {
        return {
          async listSessions() {
            if (extra.listError !== undefined) throw new Error(extra.listError)
            return catalog.map((row) => ({
              header: {
                version: 4,
                id: row.id,
                createdAt: row.createdAt ?? 0,
                isSeeded: row.isSeeded === true,
                ...(row.cwd === undefined ? {} : { cwd: row.cwd }),
                ...(row.origin === undefined ? {} : { origin: row.origin }),
              },
              live: row.live === true,
              persisted: true,
            }))
          },
          async readTitleSnapshots() {
            // Folding a title out of a full session log is the expensive path this
            // module must never take (measured: 67 MB for the 40 newest logs).
            calls.titleSnapshots += 1
            throw new Error('the picker must not fold titles out of session logs')
          },
        }
      }
      if (name === 'workspaceRegistry' && Array.isArray(extra.workspaces)) {
        return { list: () => extra.workspaces }
      }
      return undefined
    },
  }
  return ctx
}

const HOUR = 60 * 60 * 1000

/**
 * Compare two epoch-millisecond values within a millisecond of clock/FS rounding.
 *
 * A filesystem stores an mtime at its own resolution, so `utimesSync(t)` followed
 * by `statSync().mtimeMs` is not always exactly `t`. Asserting exact equality
 * tests the filesystem, not this module; asserting closeness tests what matters —
 * that the right file's time was read.
 */
function assertNear(actual, expected, label) {
  assert.equal(typeof actual, 'number', `${label}: expected a timestamp, got ${typeof actual}`)
  assert.ok(Math.abs(actual - expected) <= 2, `${label}: expected ~${expected}, got ${actual}`)
}

// ---------------------------------------------------------------------------
// the log scan (fallback time source)
// ---------------------------------------------------------------------------

test('the log mtime of each session is found, across workspace buckets', () => {
  const home = newHome()
  const now = Date.now()
  plantSession(home, '--C-Users-yanmenjiao-DSH--', 'session-aaaa', now - 3 * HOUR)
  plantSession(home, '--J-work--', 'bbbb-cccc', now - 1 * HOUR)
  const scanned = sessionLogTimes(home)
  assert.equal(scanned.scanned, true)
  assert.equal(scanned.error, undefined)
  assert.equal(scanned.times.size, 2)
  assertNear(scanned.times.get('session-aaaa'), now - 3 * HOUR, 'session-aaaa')
  assertNear(scanned.times.get('bbbb-cccc'), now - 1 * HOUR, 'bbbb-cccc')
})

test('a missing sessions directory is reported as unavailable, never as "no sessions"', () => {
  // c7: the list can still be served (sessions come from the runtime), but every
  // row's time must then be absent — and the payload must say why.
  const scanned = sessionLogTimes(newHome())
  assert.equal(scanned.scanned, false)
  assert.equal(typeof scanned.error, 'string')
  assert.match(scanned.error, /sessions/u)
  assert.equal(scanned.times.size, 0)
})

test('a stray file in the sessions root costs nothing but itself', () => {
  // The scan walks directories; one non-directory entry must not abort it. A
  // thrown scan would take every row's time with it.
  const home = newHome()
  const now = Date.now()
  mkdirSync(join(home, 'sessions'), { recursive: true })
  writeFileSync(join(home, 'sessions', 'stray.txt'), 'not a bucket')
  plantSession(home, '--J-work--', 'session-aaaa', now - 1000)
  const scanned = sessionLogTimes(home)
  assert.equal(scanned.scanned, true)
  assert.equal(scanned.times.size, 1)
  assertNear(scanned.times.get('session-aaaa'), now - 1000, 'session-aaaa')
})

test('the session log decides the time, not a bigger file beside it', () => {
  // A session directory can hold more than the log. Reporting the newest file in
  // the directory would report activity that was never session activity.
  const home = newHome()
  const now = Date.now()
  const dir = plantSession(home, '--J-work--', 'session-aaaa', now - 5 * HOUR)
  const decoy = join(dir, 'attachment-copy.bin')
  writeFileSync(decoy, 'x')
  utimesSync(decoy, new Date(now), new Date(now))
  const scanned = sessionLogTimes(home)
  assertNear(scanned.times.get('session-aaaa'), now - 5 * HOUR, 'the log mtime must win')
})

// ---------------------------------------------------------------------------
// ordering
// ---------------------------------------------------------------------------

test('candidates are ordered by last activity, then live, then id', () => {
  const ordered = sortSessionCandidates([
    { id: 'stale', lastUsedMs: 1000 },
    { id: 'fresh', lastUsedMs: 9000 },
    { id: 'never-used-but-live', lastUsedMs: undefined, live: true },
    { id: 'never-used', lastUsedMs: undefined },
  ])
  assert.deepEqual(
    ordered.map((row) => row.id),
    ['fresh', 'stale', 'never-used-but-live', 'never-used'],
    'a session with a time always beats one without; among equals the live one wins',
  )
  // Two sessions with the same activity must not swap places between renders:
  // the tie-break is deterministic.
  const a = sortSessionCandidates([
    { id: 'zzz', lastUsedMs: 1 },
    { id: 'aaa', lastUsedMs: 1 },
  ])
  assert.deepEqual(
    a.map((row) => row.id),
    ['aaa', 'zzz'],
  )
})

// ---------------------------------------------------------------------------
// the live path: sessionController.list()
// ---------------------------------------------------------------------------

test('no session service at all is an explained refusal, not an empty list', async () => {
  const payload = await listSessionCandidates({ ctx: { get: () => undefined }, dshHome: newHome() })
  assert.equal(payload.ok, false)
  assert.match(payload.error, /sessionController/u)
  assert.match(payload.error, /paste a session id/iu)
  assert.equal(payload.sessions, undefined, 'a refusal must not also carry an empty list')
})

test('a throwing session list is reported with the host reason', async () => {
  const payload = await listSessionCandidates({
    ctx: fakeCtx([], { listError: 'persistence unavailable' }),
    dshHome: newHome(),
  })
  assert.equal(payload.ok, false)
  assert.match(payload.error, /persistence unavailable/u)
})

test('each row carries title, workspace, cwd and last activity', async () => {
  const home = newHome()
  const now = Date.now()
  // A log on disk whose mtime DISAGREES with the runtime's figure: the runtime's
  // updatedAt must win, because that is the number the sidebar orders by.
  plantSession(home, '--J-work--', 'session-aaaa', now - 9 * HOUR)
  const ctx = fakeCtx(
    [
      { id: 'session-aaaa', title: '插件工程协调', cwd: 'J:\\work', updatedAt: now - 2 * HOUR, live: true },
      { id: 'session-bbbb', title: '测试群', cwd: 'C:\\Users\\yanmenjiao\\.dsh\\bot-workspace', updatedAt: now - 30 * HOUR },
    ],
    {
      workspaces: [
        { title: 'DSH默认', path: 'J:\\work', sessionIds: ['session-aaaa'] },
        { title: 'DS Bot', path: 'C:\\Users\\yanmenjiao\\.dsh\\bot-workspace', sessionIds: ['session-bbbb'] },
      ],
    },
  )
  const payload = await listSessionCandidates({ ctx, dshHome: home })
  assert.equal(payload.ok, true)
  assert.equal(payload.total, 2)
  assert.equal(payload.shown, 2)
  assert.equal(payload.workspacesStatus, 'ok')
  assert.equal(payload.titlesStatus, 'ok')
  assert.equal(payload.untitled, 0)
  assert.equal(payload.timeSource, 'session-controller.updatedAt')

  const first = payload.sessions[0]
  assert.equal(first.id, 'session-aaaa', 'the session with the newest activity sorts first')
  assert.equal(first.title, '插件工程协调')
  assert.equal(first.workspace, 'DSH默认')
  assert.equal(first.cwd, 'J:\\work')
  assert.equal(first.lastUsedAt, new Date(now - 2 * HOUR).toISOString(), "the runtime's updatedAt wins over the log mtime")
  assert.equal(first.live, true)
  assert.equal(first.subagent, false)

  const second = payload.sessions[1]
  assert.equal(second.workspace, 'DS Bot', 'a workspace is matched by its session account as well as by path')
  // Room membership is the caller's business (index.js marks it), so the
  // catalogue must not pretend to know it.
  assert.equal('member' in first, false)
})

test('titles come from the runtime list only — no cache call, no log fold', async () => {
  // This is the assertion that would have caught the 2026-10-17 regression: the
  // picker must not reach into `sessionProjectionCache` (whose signature differs
  // between DSH versions) and must not fold titles out of session logs (67 MB for
  // the 40 newest). Both doubles throw if touched.
  const ctx = fakeCtx([{ id: 'session-aaaa', title: '有标题', updatedAt: 5 }])
  const payload = await listSessionCandidates({ ctx, dshHome: newHome() })
  assert.equal(payload.ok, true)
  assert.deepEqual(ctx.calls, { cache: 0, titleSnapshots: 0, list: 1 })
  assert.equal(payload.sessions[0].title, '有标题')
})

test('a session with no title is reported as having none — never as its id in disguise', async () => {
  const ctx = fakeCtx([
    { id: 'session-aaaa', title: '有标题', updatedAt: 2 },
    { id: 'session-bbbb', updatedAt: 1, origin: 'subagent' },
  ])
  const payload = await listSessionCandidates({ ctx, dshHome: newHome() })
  assert.equal(payload.ok, true)
  assert.equal(payload.sessions[1].title, '')
  assert.equal(payload.sessions[1].workspace, '')
  assert.equal(payload.sessions[1].cwd, '')
  assert.equal(payload.sessions[1].subagent, true)
  // A session that simply has no cached title is NOT a failure: nothing is
  // broken, so the status stays ok and the untitled count carries the fact.
  assert.equal(payload.titlesStatus, 'ok')
  assert.equal(payload.untitled, 1)
})

test('an absurdly long cached title is bounded for display, and marked as cut', async () => {
  const long = '长'.repeat(400)
  const payload = await listSessionCandidates({
    ctx: fakeCtx([{ id: 'session-aaaa', title: long, updatedAt: 1 }]),
    dshHome: newHome(),
  })
  assert.equal(payload.sessions[0].title.length, 121, '120 characters plus the ellipsis')
  assert.ok(payload.sessions[0].title.endsWith('…'))
})

test('a session with no activity time falls back to its log mtime, and says the source is mixed', async () => {
  const home = newHome()
  const now = Date.now()
  plantSession(home, '--J-work--', 'session-bbbb', now - 3 * HOUR)
  const ctx = fakeCtx([
    { id: 'session-aaaa', title: '有时效', updatedAt: now - HOUR },
    { id: 'session-bbbb', title: '只有日志', updatedAt: 0 },
  ])
  const payload = await listSessionCandidates({ ctx, dshHome: home })
  assert.equal(payload.ok, true)
  assert.equal(payload.timeSource, 'mixed: sessionController.updatedAt + session-log-mtime')
  const second = payload.sessions.find((row) => row.id === 'session-bbbb')
  assertNear(Date.parse(second.lastUsedAt), now - 3 * HOUR, 'lastUsedAt from the log')
})

test('a session with no time anywhere is reported as unknown, not as a guess', async () => {
  const payload = await listSessionCandidates({
    ctx: fakeCtx([{ id: 'session-aaaa', title: '无时间', updatedAt: 0 }]),
    dshHome: newHome(),
  })
  assert.equal(payload.ok, true)
  assert.equal(payload.timeSource, 'unavailable')
  assert.equal(payload.sessions[0].lastUsedAt, '')
  assert.equal(typeof payload.timeDetail, 'string', 'and the reason travels with it')
})

test('a malformed summary costs one row, and the count says so', async () => {
  const ctx = fakeCtx([
    { id: 'session-aaaa', title: '好的', updatedAt: 2 },
    { id: '', title: '没有 id 的记录', updatedAt: 1 },
  ])
  const payload = await listSessionCandidates({ ctx, dshHome: newHome() })
  assert.equal(payload.ok, true)
  assert.equal(payload.sessions.length, 1)
  assert.equal(payload.skipped, 1)
})

test('the default ceiling is applied, and the real total is reported', async () => {
  const catalog = Array.from({ length: MAX_CANDIDATES + 7 }, (_, index) => ({ id: `session-${index}`, updatedAt: index }))
  const payload = await listSessionCandidates({ ctx: fakeCtx(catalog), dshHome: newHome() })
  assert.equal(payload.shown, MAX_CANDIDATES)
  assert.equal(payload.total, MAX_CANDIDATES + 7)
  assert.equal(payload.sessions.length, MAX_CANDIDATES)
})

test('a deployment without workspaceRegistry still labels the rows, from cwd', async () => {
  const payload = await listSessionCandidates({
    ctx: fakeCtx([{ id: 'session-dddd', cwd: 'C:\\Users\\yanmenjiao\\.dsh\\bot-workspace', updatedAt: 1 }]),
    dshHome: newHome(),
  })
  assert.equal(payload.workspacesStatus, 'unavailable')
  assert.equal(payload.sessions[0].workspace, '', 'the registry label is absent')
  assert.equal(payload.sessions[0].cwd, 'C:\\Users\\yanmenjiao\\.dsh\\bot-workspace', 'but the path still travels')
})

// ---------------------------------------------------------------------------
// the fallback path: no sessionController in this composition
// ---------------------------------------------------------------------------

test('without a sessionController the rows still list, and the missing titles are stated', async () => {
  const home = newHome()
  const now = Date.now()
  plantSession(home, '--J-work--', 'session-aaaa', now - 2 * HOUR)
  const ctx = fakeCtx([{ id: 'session-aaaa', title: '运行时不能报标题', cwd: 'J:\\work', createdAt: now - 2 * HOUR }], {
    noController: true,
  })
  const payload = await listSessionCandidates({ ctx, dshHome: home })
  assert.equal(payload.ok, true)
  assert.equal(payload.sessions.length, 1)
  assert.equal(payload.sessions[0].id, 'session-aaaa')
  assert.equal(payload.sessions[0].title, '', 'no title is invented from the id')
  assert.match(payload.titlesStatus, /^unavailable: /u)
  assert.match(payload.titlesStatus, /sessionController/u, 'and the missing capability is named')
  assert.equal(payload.untitled, 1)
  assert.equal(payload.timeSource, 'session-log-mtime')
  assertNear(Date.parse(payload.sessions[0].lastUsedAt), now - 2 * HOUR, 'the log supplies the time here')
  assert.deepEqual(ctx.calls, { cache: 0, titleSnapshots: 0, list: 0 }, 'still no cache call and no log fold')
})
