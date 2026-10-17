/**
 * The 「拉人」 picker's catalogue: `src/sessions.js`.
 *
 * WHY THESE TESTS EXIST (2026-10-17, user request): inviting an agent used to mean
 * pasting a session id. The picker that replaced it is only useful if the rows it
 * shows are TRUE — a title from the wrong session, a workspace label that belongs
 * to another room, or an activity time invented from nothing would make choosing
 * by eye WORSE than copying an id, because the mistake is invisible.
 *
 * ⚠️ AND WHY THE DOUBLES MATTER MORE THAN USUAL: this picker shipped TWICE on
 * 2026-10-17 with every test green and no usable titles on the real machine — once
 * because the code called the projection cache with a signature taken from a
 * STALE DSH copy, once because the double had been written to match the code's
 * belief instead of the running runtime. The doubles below therefore model the
 * live 0.2.1-rc.2 contract (`cachedSnapshot(meta, keys?)`) AND the older
 * three-parameter shape separately, so the module's signature adaptation is
 * really exercised rather than assumed.
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
 * A `ctx` with a session catalogue, a projection cache and a workspace registry.
 *
 * @param {object[]} catalog - `{id, title, cwd, origin, isSeeded, mtime, live}`.
 * @param {object} [extra]
 *   - `workspaces`: workspace records for the registry;
 *   - `listError`: make `listSessions` throw;
 *   - `cacheArity`: 2 (live 0.2.1) or 3 (older tree) — the stub declares its
 *     parameters accordingly so `cachedTitle`'s adaptation is really exercised;
 *   - `cacheTitles`: `false` makes the cache serve nothing (exercises the fold);
 *   - `cacheThrows`: make every cache call throw;
 *   - `foldTitles`: map used by the log-fold fallback;
 *   - `foldThrows`: make the fold fail;
 *   - `noCache`, `noQuery`: drop a service entirely.
 * @returns {object} Cordis-context stand-in plus call counters.
 */
function fakeCtx(catalog, extra = {}) {
  const calls = { cache: 0, cacheShape: undefined, titleSnapshots: 0, list: 0 }
  const ctx = {
    calls,
    get(name) {
      if (name === 'sessionQuery' && extra.noQuery !== true) {
        return {
          async listSessions() {
            calls.list += 1
            if (extra.listError !== undefined) throw new Error(extra.listError)
            return catalog.map((row) => ({
              header: {
                version: 4,
                id: row.id,
                createdAt: row.mtime ?? 0,
                isSeeded: row.isSeeded === true,
                ...(row.cwd === undefined ? {} : { cwd: row.cwd }),
                ...(row.origin === undefined ? {} : { origin: row.origin }),
              },
              live: row.live === true,
              persisted: true,
            }))
          },
          async readTitleSnapshots(ids) {
            calls.titleSnapshots += 1
            if (extra.foldThrows === true) throw new Error('log fold failed')
            const table = extra.foldTitles ?? {}
            return ids.map((id) => ({
              sessionId: id,
              status: 'fulfilled',
              value: {
                session: { id },
                ...(typeof table[id] === 'string' && table[id].length > 0 ? { title: { title: table[id] } } : {}),
              },
            }))
          },
        }
      }
      if (name === 'sessionProjectionCache' && extra.noCache !== true) {
        const lookup = (meta) => {
          calls.cache += 1
          if (extra.cacheThrows === true) throw new Error('projection cache is not initialized')
          if (extra.cacheTitles === false) return undefined
          const row = catalog.find((candidate) => candidate.id === meta?.id)
          if (row === undefined || typeof row.title !== 'string' || row.title.length === 0) return undefined
          return { asOfSeq: 1, values: { title: row.title } }
        }
        if ((extra.cacheArity ?? 2) >= 3) {
          // The older 0.1.5 shape, declared with THREE parameters so `fn.length`
          // makes the module call it that way.
          return {
            cachedSnapshot(meta, inheritedEventCount, keys) {
              calls.cacheShape = `3:${String(inheritedEventCount)}:${(keys ?? []).join(',')}`
              assert.equal(inheritedEventCount, 0, 'the inherited cut must be 0 for a listing')
              return lookup(meta)
            },
            cachedPredecessorTitle(meta, inheritedEventCount) {
              assert.equal(inheritedEventCount, 0, 'the inherited cut must be 0 for a listing')
              return undefined
            },
          }
        }
        return {
          // The live 0.2.1 shape: (meta, keys?).
          cachedSnapshot(meta, keys) {
            calls.cacheShape = `2:${(keys ?? []).join(',')}`
            return lookup(meta)
          },
          cachedPredecessorTitle(meta) {
            return undefined
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
// the log scan (activity times)
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
  const scanned = sessionLogTimes(newHome())
  assert.equal(scanned.scanned, false)
  assert.equal(typeof scanned.error, 'string')
  assert.match(scanned.error, /sessions/u)
  assert.equal(scanned.times.size, 0)
})

test('a stray file in the sessions root costs nothing but itself', () => {
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
// refusals
// ---------------------------------------------------------------------------

test('no session catalogue at all is an explained refusal, not an empty list', async () => {
  const payload = await listSessionCandidates({ ctx: { get: () => undefined }, dshHome: newHome() })
  assert.equal(payload.ok, false)
  assert.match(payload.error, /sessionQuery/u)
  assert.match(payload.error, /paste a session id/iu)
  assert.equal(payload.sessions, undefined, 'a refusal must not also carry an empty list')
})

test('a throwing session listing is reported with the host reason', async () => {
  const payload = await listSessionCandidates({
    ctx: fakeCtx([], { listError: 'persistence unavailable' }),
    dshHome: newHome(),
  })
  assert.equal(payload.ok, false)
  assert.match(payload.error, /persistence unavailable/u)
})

// ---------------------------------------------------------------------------
// titles through the projection cache (the live 0.2.1 shape)
// ---------------------------------------------------------------------------

test('titles come from the projection cache, and no session log is folded', async () => {
  // ⚠️ This is the assertion that would have caught the 2026-10-17 regression:
  // the cache is the cheap path (zero-I/O), and folding titles out of logs costs
  // 67 MB of decompression for the 40 newest sessions. The fold counter must stay
  // at zero whenever the cache serves titles.
  const home = newHome()
  const now = Date.now()
  plantSession(home, '--J-work--', 'session-aaaa', now - 2 * HOUR)
  plantSession(home, '--J-work--', 'session-bbbb', now - 30 * HOUR)
  const ctx = fakeCtx([
    { id: 'session-aaaa', title: '插件工程协调', cwd: 'J:\\work', mtime: now - 2 * HOUR, live: true },
    { id: 'session-bbbb', title: '测试群', cwd: 'C:\\work-bot', mtime: now - 30 * HOUR },
  ])
  const payload = await listSessionCandidates({ ctx, dshHome: home })
  assert.equal(payload.ok, true)
  assert.equal(payload.titlesStatus, 'ok')
  assert.equal(payload.titleSource, 'projection-cache')
  assert.equal(payload.untitled, 0)
  assert.equal(payload.timeSource, 'session-log-mtime')
  assert.equal(ctx.calls.titleSnapshots, 0, 'no log may be folded')
  assert.equal(ctx.calls.cacheShape, '2:title', 'the live 0.2.1 call is (meta, keys)')

  const first = payload.sessions[0]
  assert.equal(first.id, 'session-aaaa', 'the session with the newest log sorts first')
  assert.equal(first.title, '插件工程协调')
  assert.equal(first.cwd, 'J:\\work')
  assert.equal(first.live, true)
  assert.equal(first.subagent, false)
  assertNear(Date.parse(first.lastUsedAt), now - 2 * HOUR, 'lastUsedAt from the log')
  assert.equal('member' in first, false, "room membership is the caller's business")
})

test('the older three-argument cache shape is called correctly too', async () => {
  // Two DSH versions are installed on some machines (the running one in app.asar,
  // a stale one in the profile tree). The declared parameter count decides which
  // call shape to use; getting it wrong is what killed every title live.
  const home = newHome()
  const now = Date.now()
  plantSession(home, '--J-work--', 'session-aaaa', now - HOUR)
  const ctx = fakeCtx([{ id: 'session-aaaa', title: '旧版缓存', mtime: now - HOUR }], { cacheArity: 3 })
  const payload = await listSessionCandidates({ ctx, dshHome: home })
  assert.equal(payload.sessions[0].title, '旧版缓存')
  assert.equal(ctx.calls.cacheShape, '3:0:title')
})

test('a forked (seeded) session keeps its title: the live identity carries no cut', async () => {
  // On the old cache face a forked session could never match its own checkpoint
  // (the identity carried the inherited cut), so its title was unreachable. On the
  // live 0.2.1 face the identity has no cut, so the own checkpoint matches — and
  // guarding on \`isSeeded\` would have cost exactly that session its name.
  const ctx = fakeCtx([{ id: 'session-ffff', title: '被分叉出来的会话', mtime: 3, isSeeded: true }])
  const payload = await listSessionCandidates({ ctx, dshHome: newHome() })
  assert.equal(payload.sessions[0].title, '被分叉出来的会话')
  assert.equal(payload.untitled, 0)
})

test('a session with no title is reported as having none — never as its id in disguise', async () => {
  const ctx = fakeCtx([
    { id: 'session-aaaa', title: '有标题', mtime: 2 },
    { id: 'session-bbbb', mtime: 1, origin: 'subagent' },
  ])
  const payload = await listSessionCandidates({ ctx, dshHome: newHome() })
  assert.equal(payload.ok, true)
  assert.equal(payload.sessions[1].title, '')
  assert.equal(payload.sessions[1].subagent, true)
  // One untitled row is a healthy absence, not a failure.
  assert.equal(payload.untitled, 1)
})

test('an absurdly long cached title is bounded for display, and marked as cut', async () => {
  const payload = await listSessionCandidates({
    ctx: fakeCtx([{ id: 'session-aaaa', title: '长'.repeat(400), mtime: 1 }]),
    dshHome: newHome(),
  })
  assert.equal(payload.sessions[0].title.length, 121, '120 characters plus the ellipsis')
  assert.ok(payload.sessions[0].title.endsWith('…'))
})

// ---------------------------------------------------------------------------
// the last-resort fold, and its reporting
// ---------------------------------------------------------------------------

test('when the cache serves no titles at all, the logs are folded — and it is reported', async () => {
  const home = newHome()
  const now = Date.now()
  plantSession(home, '--J-work--', 'session-aaaa', now - HOUR)
  const ctx = fakeCtx([{ id: 'session-aaaa', title: '缓存里有', mtime: now - HOUR }], {
    cacheTitles: false,
    foldTitles: { 'session-aaaa': '从日志折出来的' },
  })
  const payload = await listSessionCandidates({ ctx, dshHome: home })
  assert.equal(payload.ok, true)
  assert.equal(payload.sessions[0].title, '从日志折出来的')
  assert.equal(payload.titleSource, 'session-logs')
  assert.match(payload.titlesStatus, /^degraded: /, 'the expensive path is stated, never silent')
  assert.match(payload.titlesStatus, /reading session logs/u)
  assert.equal(ctx.calls.titleSnapshots, 1)
})

test('when the cache throws and the fold fails too, the list still lists and says why', async () => {
  const home = newHome()
  const now = Date.now()
  plantSession(home, '--J-work--', 'session-aaaa', now - HOUR)
  const ctx = fakeCtx([{ id: 'session-aaaa', title: '缓存里有', mtime: now - HOUR }], {
    cacheThrows: true,
    foldThrows: true,
  })
  const payload = await listSessionCandidates({ ctx, dshHome: home })
  assert.equal(payload.ok, true, 'a title failure must not cost the list')
  assert.equal(payload.sessions.length, 1)
  assert.equal(payload.sessions[0].title, '')
  assert.match(payload.titlesStatus, /failure|unavailable|partial/iu, 'the reason is carried')
  assert.equal(payload.untitled, 1)
})

test('a deployment with no projection cache still lists, folding titles as a last resort', async () => {
  const home = newHome()
  const now = Date.now()
  plantSession(home, '--J-work--', 'session-aaaa', now - HOUR)
  const ctx = fakeCtx([{ id: 'session-aaaa', title: '缓存里有', mtime: now - HOUR }], {
    noCache: true,
    foldTitles: { 'session-aaaa': '只有日志能给' },
  })
  const payload = await listSessionCandidates({ ctx, dshHome: home })
  assert.equal(payload.ok, true)
  assert.equal(payload.sessions[0].title, '只有日志能给')
  assert.equal(payload.titleSource, 'session-logs')
})

// ---------------------------------------------------------------------------
// times, malformed records, cap, workspace labels
// ---------------------------------------------------------------------------

test('a session whose log cannot be seen has NO time, and the payload says which source failed', async () => {
  const payload = await listSessionCandidates({
    ctx: fakeCtx([{ id: 'session-aaaa', title: '无时间' }]),
    dshHome: newHome(),
  })
  assert.equal(payload.ok, true)
  assert.equal(payload.sessions[0].lastUsedAt, '')
  assert.equal(payload.timeSource, 'unavailable')
  assert.equal(typeof payload.timeDetail, 'string', 'and the reason travels with it')
})

test('a malformed session record costs one row, and the count says so', async () => {
  const ctx = fakeCtx([
    { id: 'session-aaaa', title: '好的', mtime: 2 },
    { id: '', title: '没有 id 的记录', mtime: 1 },
  ])
  const payload = await listSessionCandidates({ ctx, dshHome: newHome() })
  assert.equal(payload.ok, true)
  assert.equal(payload.sessions.length, 1)
  assert.equal(payload.skipped, 1)
})

test('the default ceiling is applied, and the real total is reported', async () => {
  const catalog = Array.from({ length: MAX_CANDIDATES + 7 }, (_, index) => ({ id: `session-${index}`, mtime: index }))
  const payload = await listSessionCandidates({ ctx: fakeCtx(catalog), dshHome: newHome() })
  assert.equal(payload.shown, MAX_CANDIDATES)
  assert.equal(payload.total, MAX_CANDIDATES + 7)
  assert.equal(payload.sessions.length, MAX_CANDIDATES)
})

test('a workspace is matched by its session account and by its path', async () => {
  const ctx = fakeCtx(
    [
      { id: 'session-aaaa', title: 'A', cwd: 'J:\\work', mtime: 2 },
      { id: 'session-bbbb', title: 'B', cwd: 'C:\\Users\\test\\.dsh\\bot-workspace', mtime: 1 },
      { id: 'session-cccc', title: 'C', cwd: 'D:\\unregistered', mtime: 0 },
    ],
    {
      workspaces: [
        { title: 'DSH默认', path: 'J:\\work', sessionIds: ['session-aaaa'] },
        { title: 'DS Bot', path: 'C:\\Users\\test\\.dsh\\bot-workspace', sessionIds: [] },
      ],
    },
  )
  const payload = await listSessionCandidates({ ctx, dshHome: newHome() })
  const byId = new Map(payload.sessions.map((row) => [row.id, row]))
  assert.equal(byId.get('session-aaaa').workspace, 'DSH默认', 'by session account')
  assert.equal(byId.get('session-bbbb').workspace, 'DS Bot', 'by path, even with an empty account')
  assert.equal(byId.get('session-cccc').workspace, '', 'an unregistered directory has no workspace name')
  assert.equal(byId.get('session-cccc').cwd, 'D:\\unregistered', 'but the path still travels')
})

test('a deployment without workspaceRegistry still lists, and says the labels are unavailable', async () => {
  const payload = await listSessionCandidates({
    ctx: fakeCtx([{ id: 'session-dddd', cwd: 'C:\\Users\\test\\.dsh\\bot-workspace', mtime: 1 }]),
    dshHome: newHome(),
  })
  assert.equal(payload.workspacesStatus, 'unavailable')
  assert.equal(payload.sessions[0].workspace, '')
})
