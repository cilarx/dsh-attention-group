/**
 * The 「拉人」 picker's catalogue: `src/sessions.js`.
 *
 * WHY THESE TESTS EXIST (2026-10-17, user request): inviting an agent used to mean
 * pasting a session id. The picker that replaced it is only useful if the rows it
 * shows are TRUE — a title from the wrong session, a workspace label that belongs
 * to another room, or an activity time invented from nothing would make choosing
 * by eye WORSE than copying an id, because the mistake is invisible.
 *
 * So the assertions are about the three things a person compares (title,
 * workspace, last activity), about the cost ceiling (titles are read for the rows
 * that will be shown, not for every session on the machine), and — the rule this
 * codebase keeps re-learning (c7) — about DEGRADATION BEING STATED: no
 * `sessionQuery`, no sessions directory, unreadable titles and a capped list each
 * have to say what they are, because the alternative is a list that looks complete
 * and is not.
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
 * A `ctx` whose services serve a catalogue.
 *
 * @param {object[]} catalog - `{id, title, cwd, createdAt, live, origin, agentPreset, isSeeded}`.
 * @param {object} [extra] - `{workspaces, listError, titleError, titleThrows, noProjectionCache}`.
 * @returns {object} Cordis-context stand-in.
 */
function fakeCtx(catalog, extra = {}) {
  const asked = []
  const ctx = {
    // Every `sessionQuery.readTitleSnapshots` call is recorded so a test can prove
    // the picker does NOT fold titles out of session logs: on this machine the 40
    // most recent logs total 67 MB, and doing that to draw a picker would stall
    // the GUI behind one click.
    asked,
    get(name) {
      if (name === 'sessionQuery') {
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
                ...(row.agentPreset === undefined ? {} : { agentPreset: row.agentPreset }),
              },
              live: row.live === true,
              persisted: true,
            }))
          },
          async readTitleSnapshots(ids) {
            asked.push([...ids])
            throw new Error('the picker must not fold titles out of session logs')
          },
        }
      }
      if (name === 'sessionProjectionCache') {
        if (extra.noProjectionCache === true) return undefined
        // ⚠️ These stubs mirror the AUTHORITATIVE signature, not the abridged one
        // in the runtime's Service inspect catalog:
        //   cachedSnapshot(meta, inheritedEventCount, keys?)
        //   cachedPredecessorTitle(meta, inheritedEventCount)
        // The real implementation THROWS when an unseeded session is asked with a
        // non-zero cut, so the first version of the picker (which passed the keys
        // array as the second argument) lost every title on a healthy deployment
        // while every test here stayed green. The `assertCut` guard is what makes
        // that mistake fail loudly instead of silently.
        const assertCut = (meta, inheritedEventCount) => {
          if (inheritedEventCount !== 0) {
            throw new Error(
              `unseeded projection-cache identity inherited event count must be 0 (got ${JSON.stringify(inheritedEventCount)})`,
            )
          }
          assert.equal(typeof meta?.version, 'number', 'the cache identifies a lifecycle by the header version')
        }
        return {
          cachedSnapshot(meta, inheritedEventCount, keys) {
            assertCut(meta, inheritedEventCount)
            if (keys !== undefined) assert.deepEqual(keys, ['title'], 'the picker asks the cache for the title only')
            if (extra.titleError !== undefined) throw new Error(extra.titleError)
            const row = catalog.find((candidate) => candidate.id === meta?.id)
            if (row === undefined || typeof row.title !== 'string' || row.title.length === 0) return undefined
            if (extra.titleThrows === true) throw new Error('cache record is corrupt')
            return { asOfSeq: 1, values: { title: row.title } }
          },
          cachedPredecessorTitle(meta, inheritedEventCount) {
            assertCut(meta, inheritedEventCount)
            // Mirrors the shipped API's fallback: only a SEEDED (forked) header has
            // no own checkpoint, so only it may borrow a predecessor's title.
            const row = catalog.find((candidate) => candidate.id === meta?.id)
            if (row === undefined || row.isSeeded !== true) return undefined
            return { asOfSeq: -1, values: { title: `predecessor:${row?.title ?? ''}` } }
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
  // c7: this is the picker's version of 「读取失败渲染成空结果」. The list can still
  // be served (sessions come from the runtime), but every row's time must then be
  // absent — and the payload must say why.
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

test('candidates are ordered by last activity, then live, then creation', () => {
  const ordered = sortSessionCandidates([
    { id: 'stale', lastUsedMs: 1000, createdAt: 9 },
    { id: 'fresh', lastUsedMs: 9000, createdAt: 1 },
    { id: 'never-used-but-live', lastUsedMs: undefined, live: true, createdAt: 2 },
    { id: 'never-used', lastUsedMs: undefined, createdAt: 5 },
  ])
  assert.deepEqual(
    ordered.map((row) => row.id),
    ['fresh', 'stale', 'never-used-but-live', 'never-used'],
    'a session with a time always beats one without; among equals the live one wins',
  )
  // Two sessions created in the same millisecond must not swap places between
  // renders: the tie-break is deterministic.
  const a = sortSessionCandidates([
    { id: 'zzz', lastUsedMs: 1, createdAt: 1 },
    { id: 'aaa', lastUsedMs: 1, createdAt: 1 },
  ])
  assert.deepEqual(
    a.map((row) => row.id),
    ['aaa', 'zzz'],
  )
})

test('no sessionQuery service is an explained refusal, not an empty list', async () => {
  const payload = await listSessionCandidates({ ctx: { get: () => undefined }, dshHome: newHome() })
  assert.equal(payload.ok, false)
  assert.match(payload.error, /sessionQuery/u)
  assert.match(payload.error, /paste a session id/iu)
  assert.equal(payload.sessions, undefined, 'a refusal must not also carry an empty list')
})

test('listSessions throwing is reported with the host reason', async () => {
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
  plantSession(home, '--J-work--', 'session-aaaa', now - 2 * HOUR)
  const ctx = fakeCtx(
    [
      { id: 'session-aaaa', title: '插件工程协调', cwd: 'J:\\work', createdAt: 1, agentPreset: 'default' },
      { id: 'session-bbbb', title: '测试群', cwd: 'C:\\Users\\yanmenjiao\\.dsh\\bot-workspace', createdAt: 2 },
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
  assert.equal(payload.timeSource, 'session-log-mtime')

  const first = payload.sessions[0]
  assert.equal(first.id, 'session-aaaa', 'the session with a real activity time sorts first')
  assert.equal(first.title, '插件工程协调')
  assert.equal(first.workspace, 'DSH默认')
  assert.equal(first.cwd, 'J:\\work')
  assertNear(Date.parse(first.lastUsedAt), now - 2 * HOUR, 'lastUsedAt')
  assert.equal(first.live, false)
  assert.equal(first.subagent, false)
  assert.equal(first.preset, 'default')

  const second = payload.sessions[1]
  assert.equal(second.workspace, 'DS Bot', 'a workspace is matched by its session account as well as by path')
  assert.equal(second.lastUsedAt, '', 'a session with no log on disk has NO time, not a fake one')
  // Room membership is the caller's business (index.js marks it), so the
  // catalogue must not pretend to know it.
  assert.equal('member' in first, false)
})

test('a session with no title is reported as having none — never as its id in disguise', async () => {
  const ctx = fakeCtx([{ id: 'session-cccc', createdAt: 3 }])
  const payload = await listSessionCandidates({ ctx, dshHome: newHome() })
  assert.equal(payload.sessions[0].title, '')
  assert.equal(payload.sessions[0].workspace, '')
  assert.equal(payload.sessions[0].cwd, '')
})

test('titles come from the projection cache — no session log is ever folded', async () => {
  // ⚠️ This is the assertion that keeps the picker from freezing the GUI. The
  // obvious API is `sessionQuery.readTitleSnapshots`, which folds the title out of
  // the session's COMPLETE event log. Measured on this machine 2026-10-17: the 40
  // most recent logs total 67 MB (one is 11 MB), so forty titles that way would
  // decompress and replay tens of megabytes on the host's main thread during one
  // click. The stub below THROWS if the picker calls it at all.
  const catalog = Array.from({ length: 12 }, (_, index) => ({
    id: `session-${String(index).padStart(4, '0')}`,
    title: `会话 ${index}`,
    createdAt: 100 - index,
  }))
  const home = newHome()
  const now = Date.now()
  for (const row of catalog.slice(0, 5)) plantSession(home, '--J-work--', row.id, now - row.createdAt * 1000)
  const ctx = fakeCtx(catalog)
  const payload = await listSessionCandidates({ ctx, dshHome: home, max: 5 })
  assert.equal(payload.shown, 5)
  assert.equal(payload.total, 12, 'the total is the real one, so the panel can say what it is not showing')
  assert.equal(payload.max, 5)
  assert.deepEqual(ctx.asked, [], 'no session log may be folded to draw the picker')
  assert.equal(payload.titlesStatus, 'ok')
  assert.equal(payload.untitled, 0)
  // And the titles that survive are the cached ones, not ids.
  for (const row of payload.sessions) assert.match(row.title, /^会话 \d+$/u)
})

test('a title that needs a predecessor checkpoint still resolves, like the shipped API does', async () => {
  // A seeded (forked) session has no own checkpoint, so the whole projection block
  // is skipped and only a predecessor checkpoint's title may be used. The order is
  // copied from `dsh-api-session-controller`, not invented here.
  const ctx = fakeCtx([{ id: 'session-aaaa', title: '被分叉的会话', createdAt: 1, isSeeded: true }])
  const payload = await listSessionCandidates({ ctx, dshHome: newHome() })
  assert.equal(payload.sessions[0].title, 'predecessor:被分叉的会话')
})

test('the default ceiling is applied, and reported', async () => {
  const catalog = Array.from({ length: MAX_CANDIDATES + 7 }, (_, index) => ({ id: `session-${index}`, createdAt: index }))
  const payload = await listSessionCandidates({ ctx: fakeCtx(catalog), dshHome: newHome() })
  assert.equal(payload.shown, MAX_CANDIDATES)
  assert.equal(payload.total, MAX_CANDIDATES + 7)
  assert.equal(payload.sessions.length, MAX_CANDIDATES)
})

test('a corrupt cache record costs one title, and the payload says how many', async () => {
  const catalog = [
    { id: 'session-aaaa', title: '有标题', createdAt: 2 },
    { id: 'session-bbbb', title: '', createdAt: 1 },
  ]
  const payload = await listSessionCandidates({ ctx: fakeCtx(catalog), dshHome: newHome() })
  assert.equal(payload.ok, true)
  assert.equal(payload.sessions.length, 2)
  // A session that simply has no cached title yet is NOT a failure: nothing is
  // broken, so the status stays ok and the count of untitled rows carries the fact.
  assert.equal(payload.titlesStatus, 'ok')
  assert.equal(payload.untitled, 1)

  const partial = await listSessionCandidates({
    ctx: fakeCtx(catalog, { titleThrows: true }),
    dshHome: newHome(),
  })
  assert.equal(partial.ok, true, 'a title failure must not cost the list')
  assert.match(
    partial.titlesStatus,
    /^partial: 1 of 2/u,
    'the ONE corrupt record is counted as a read failure; the other row simply has no title yet',
  )
  assert.equal(partial.sessions.length, 2)
  assert.equal(partial.untitled, 2)

  const noCache = await listSessionCandidates({
    ctx: fakeCtx(catalog, { noProjectionCache: true }),
    dshHome: newHome(),
  })
  assert.equal(noCache.ok, true, 'a deployment without the cache still lists sessions')
  assert.equal(noCache.sessions.length, 2)
  assert.match(noCache.titlesStatus, /^unavailable: /u)
  assert.match(noCache.titlesStatus, /sessionProjectionCache/u, 'and names the missing service')
  assert.equal(noCache.sessions[0].title, '')
  assert.equal(noCache.untitled, 2)
})

test('a malformed session record costs one row, and the count says so', async () => {
  const ctx = fakeCtx([
    { id: 'session-aaaa', title: '好的', createdAt: 2 },
    { id: '', title: '没有 id 的记录', createdAt: 1 },
  ])
  const payload = await listSessionCandidates({ ctx, dshHome: newHome() })
  assert.equal(payload.ok, true)
  assert.equal(payload.sessions.length, 1)
  assert.equal(payload.skipped, 1)
})

test('a deployment without workspaceRegistry still labels the rows, from cwd', async () => {
  const payload = await listSessionCandidates({
    ctx: fakeCtx([{ id: 'session-dddd', cwd: 'C:\\Users\\yanmenjiao\\.dsh\\bot-workspace', createdAt: 1 }]),
    dshHome: newHome(),
  })
  assert.equal(payload.workspacesStatus, 'unavailable')
  assert.equal(payload.sessions[0].workspace, '', 'the registry label is absent')
  assert.equal(payload.sessions[0].cwd, 'C:\\Users\\yanmenjiao\\.dsh\\bot-workspace', 'but the path still travels')
})
