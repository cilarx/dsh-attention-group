/**
 * dsh-attention-group — the panel's 「拉人」 picker: which sessions could be
 * invited, and how a person can tell them apart.
 *
 * WHY THIS EXISTS (2026-10-17, user request): inviting an agent into a room used
 * to mean typing or pasting a 36-character session id into the panel. Sessions
 * are not named by their owner — most are auto-titled — and this machine already
 * has sessions whose titles differ by one character. From an id alone a person
 * cannot tell two of them apart, so they copy ids out of the session list one at
 * a time. This module answers one question — "which sessions are there, with
 * what title, in what workspace, and when did each last do anything" — so the
 * panel can offer a list instead of a blank box.
 *
 * ⚠️ THE DATA HERE IS FOREIGN. Everything else in this plugin reads its OWN
 * ledger under `$DSH_HOME/attention-group`; this reads the deployment's session
 * catalogue through DSH's services. So every field is treated as untrusted and
 * DEFAULTED rather than passed through: one malformed session record may cost
 * that one row, never the whole list.
 *
 * ── HOW THE TITLE IS OBTAINED, AND WHY THIS FILE HAS BEEN WRONG TWICE ───────
 *
 * Three shapes were tried on a live 0.2.1-rc.2 deployment on 2026-10-17, and only
 * the third one works:
 *
 *  1. Rows from `sessionQuery.listSessions()` + titles from
 *     `sessionProjectionCache.cachedSnapshot(header, ['title'])`. The CALL is
 *     right (proved by extracting the package from `app.asar`); it was then
 *     "fixed" into a three-argument call after reading the STALE 0.1.5 copy in
 *     `~/.dsh/profiles/node_modules`, which silently broke every title.
 *
 *  2. Rows from `sessionController.list()` — the call the sidebar makes, but its
 *     host service returns `{ items: SessionSummary[] }` (NOT an array) and
 *     filters rows through `remoteAccess.allows`; reading it as an array yields
 *     zero rows.
 *
 *  3. THIS FILE: rows from `sessionQuery.listSessions()` (a plain listing), and
 *     titles from the projection cache with **signature adaptation** — 0.2.1's
 *     `(meta, keys?)` vs the older `(meta, inheritedEventCount, keys?)`. If the
 *     cache serves no titles at all, it falls back to folding them out of the
 *     session logs (`readTitleSnapshots`) for the visible page only, which is
 *     expensive (the 40 most recent logs total 67 MB) and therefore a last resort
 *     that is REPORTED, never silent.
 *
 * ⇒ The durable rule: a contract must be read from the DSH that is actually
 * running (`app.asar` / Inspect), and the test double must model that version.
 * Both earlier mistakes passed every unit test.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: it never wakes, resumes, or opens a
 * transcript on the normal path. A picker must not start a turn (that is this
 * plugin's entire promise).
 *
 * DEGRADATION IS STATED, NEVER IMPLIED (the project's c7 rule):
 *  - no session catalogue service -> `{ok:false, error}` naming what is missing;
 *  - cache titles unavailable      -> titles folded from logs (reported), or
 *                                     `titlesStatus: 'unavailable: …'`;
 *  - no sessions directory         -> every row's time is absent and `timeSource`
 *                                     is `unavailable` with a reason;
 *  - a malformed record            -> skipped, and `skipped` counts it.
 *
 * @module dsh-attention-group/sessions
 */

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * How many sessions one picker payload may carry.
 *
 * Not a cost ceiling — the whole lookup is one session listing plus zero-I/O
 * projection reads — but a reading ceiling: a list that starts scrolling past
 * forty rows is worse than typing an id, and the payload always reports the TRUE
 * total, so the panel can say how much it is not showing instead of pretending
 * this is everything.
 */
export const MAX_CANDIDATES = 40

/**
 * How many log folds the last-resort title path may perform in one call.
 *
 * Only reached when the projection cache serves nothing at all, and then it is
 * capped so a broken cache cannot turn one click into an unbounded disk read.
 */
const MAX_LOG_FOLDS = 40

/** Session logs live at `<DSH_HOME>/sessions/<workspace>/<sessionId>/session.*`. */
const SESSIONS_DIR = 'sessions'

/** A message that is never the literal word "undefined". */
function errorMessage(error) {
  if (error instanceof Error && typeof error.message === 'string' && error.message.length > 0) return error.message
  const text = String(error)
  return text.length > 0 ? text : 'unknown error'
}

/**
 * Is this directory entry a directory?
 *
 * ⚠️ `readdirSync(…, { withFileTypes: true })` yields `Dirent` objects whose
 * `isDirectory` is a METHOD, not a boolean field. A first version of this file
 * tested `entry.isDirectory !== true`, which is true for every entry — so the
 * scan found nothing and the picker silently showed no activity time at all.
 * Hence the explicit shape check.
 *
 * @param {object} entry - a Dirent, or a plain stand-in.
 * @returns {boolean} true when the entry is a directory.
 */
function entryIsDirectory(entry) {
  if (typeof entry?.isDirectory === 'function') return entry.isDirectory() === true
  return entry?.isDirectory === true
}

/** As {@link entryIsDirectory}, for files. */
function entryIsFile(entry) {
  if (typeof entry?.isFile === 'function') return entry.isFile() === true
  return entry?.isFile === true
}

/**
 * When each session log was last written.
 *
 * This is the picker's activity time: the runtime's own per-session last-activity
 * figure lives on `sessionController.list()`, whose host shape is `{ items }`;
 * taking it from the log mtime keeps the picker on ONE cheap source and still
 * answers the question a person is actually asking ("which of these did anything
 * recently").
 *
 * Read-only and best-effort by design: a deployment that keeps sessions
 * elsewhere simply gets `scanned:false` with a reason, and the picker still
 * lists sessions (with no times) rather than failing.
 *
 * @param {string} dshHome - the DSH home (`$DSH_HOME`), not this plugin's dir.
 * @returns {{times: Map<string, number>, scanned: boolean, error?: string}}
 */
export function sessionLogTimes(dshHome) {
  const times = new Map()
  if (typeof dshHome !== 'string' || dshHome.length === 0) {
    return { times, scanned: false, error: 'the DSH home directory is unknown' }
  }
  const root = join(dshHome, SESSIONS_DIR)
  let buckets
  try {
    buckets = readdirSync(root, { withFileTypes: true })
  } catch (error) {
    return { times, scanned: false, error: `${root} cannot be read: ${errorMessage(error)}` }
  }
  for (const bucket of Array.isArray(buckets) ? buckets : []) {
    if (!entryIsDirectory(bucket)) continue
    const bucketDir = join(root, bucket.name)
    let entries
    try {
      entries = readdirSync(bucketDir, { withFileTypes: true })
    } catch {
      // One unreadable workspace bucket costs its own sessions, not the scan.
      continue
    }
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (!entryIsDirectory(entry)) continue
      const newest = newestFileTime(join(bucketDir, entry.name))
      if (newest !== undefined) times.set(String(entry.name), newest)
    }
  }
  return { times, scanned: true }
}

/**
 * The newest mtime of any file directly inside one session directory, or
 * `undefined`.
 *
 * The session directory's OWN mtime only changes when a file is created or
 * removed, so a long-running session that appends events would look untouched
 * from yesterday. The log file's mtime is the fact we want, so files are stat'd.
 *
 * @param {string} dir - one session directory.
 * @returns {number|undefined} epoch milliseconds.
 */
function newestFileTime(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return undefined
  }
  let newest
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entryIsFile(entry)) continue
    // Cheap pre-filter: session state files are all `session.*`. Anything else in
    // there (a stray attachment copy) is not activity worth reporting.
    if (!String(entry.name).startsWith('session.')) continue
    try {
      const info = statSync(join(dir, entry.name))
      if (Number.isFinite(info.mtimeMs) && (newest === undefined || info.mtimeMs > newest)) newest = info.mtimeMs
    } catch {
      // Vanished between listing and stat: not this session's problem.
    }
  }
  return newest
}

/**
 * A title as the payload should carry it, or `''` when the runtime reported none.
 *
 * A display budget, not a data cut: a cached title can legitimately be a few
 * hundred characters (a fallback title is the opening prompt's first line), and
 * forty of those would bloat a payload the panel draws on one line. The full
 * title stays in the session log.
 *
 * @param {unknown} value - whatever the source returned.
 * @returns {string} the title, or ''.
 */
function titleOf(value) {
  if (typeof value !== 'string') return ''
  const text = value.trim()
  if (text.length === 0) return ''
  return text.length > 120 ? `${text.slice(0, 120)}…` : text
}

/**
 * One session's cached title — WITHOUT reading its log.
 *
 * ⚠️ THE ARGUMENT COUNT IS THE WHOLE PROBLEM, and it differs between DSH
 * versions ON THIS MACHINE:
 *   - the running 0.2.1-rc.2 (extracted from `app.asar`) declares
 *     `cachedSnapshot(meta, keys?)` and `cachedPredecessorTitle(meta)`;
 *   - the stale 0.1.5-rc.1 tree in `~/.dsh/profiles/node_modules` declares
 *     `cachedSnapshot(meta, inheritedEventCount, keys?)`.
 * Passing the wrong one does not fail politely: 0.2.1 treats the cut as `keys`
 * and `new Set(0)` throws, so every unseeded session loses its title. Hence the
 * adaptation: the live implementation's declared parameter count is the only
 * honest discriminator available at runtime.
 *
 * The order — own checkpoint first, predecessor second — is copied from the
 * shipped `dsh-api-session-controller` (`projectionsFor`), not invented here.
 *
 * @param {object} cache - the `sessionProjectionCache` service.
 * @param {object} header - the session header (the cache's identity witness).
 * @returns {string} the title, or '' when nothing usable exists.
 */
function cachedTitle(cache, header) {
  if (cache === undefined || cache === null || header === undefined || header === null) return ''
  const arity = typeof cache.cachedSnapshot === 'function' ? cache.cachedSnapshot.length : 0
  const snapshotOf =
    arity >= 3
      ? (meta) => cache.cachedSnapshot(meta, 0, ['title'])
      : arity === 2
        ? (meta) => cache.cachedSnapshot(meta, ['title'])
        : undefined
  const predecessorOf =
    typeof cache.cachedPredecessorTitle === 'function'
      ? cache.cachedPredecessorTitle.length >= 2
        ? (meta) => cache.cachedPredecessorTitle(meta, 0)
        : (meta) => cache.cachedPredecessorTitle(meta)
      : undefined
  // ⚠️ The own checkpoint is tried for SEEDED sessions too. The old 0.1.5 face
  // carried the inherited cut in its identity, so a forked session could never
  // match its own record and only a predecessor title was left; the live 0.2.1
  // identity has no cut, so the own checkpoint DOES match (measured: the one
  // forked session on this machine has a cached title). Guarding on `isSeeded`
  // here cost that session its name for no reason.
  let block
  if (snapshotOf !== undefined) block = snapshotOf(header)
  if (block === undefined && predecessorOf !== undefined) block = predecessorOf(header)
  return titleOf(block?.values?.title)
}

/**
 * Last-resort titles: fold them out of the session logs.
 *
 * `sessionQuery.readTitleSnapshots` loads each session's COMPLETE event log. On
 * this machine the 40 most recent logs total 67 MB (one is 11 MB), so this is far
 * too expensive to be the normal path and is only reached when the projection
 * cache serves no titles at all. Bounded by {@link MAX_LOG_FOLDS} so a broken
 * cache cannot turn one click into an unbounded read.
 *
 * @param {object} query - the `sessionQuery` service.
 * @param {string[]} ids - ids to fold, in display order.
 * @returns {Promise<{titles: Map<string, string>, status: string}>}
 */
async function foldTitlesFromLogs(query, ids) {
  const titles = new Map()
  if (typeof query?.readTitleSnapshots !== 'function') {
    return { titles, status: 'unavailable: this deployment cannot read session titles' }
  }
  const wanted = ids.slice(0, MAX_LOG_FOLDS)
  let results
  try {
    results = await query.readTitleSnapshots(wanted)
  } catch (error) {
    return { titles, status: `unavailable: reading session titles failed: ${errorMessage(error)}` }
  }
  let failed = 0
  for (const row of Array.isArray(results) ? results : []) {
    if (row?.status !== 'fulfilled') {
      failed += 1
      continue
    }
    const id = typeof row?.sessionId === 'string' ? row.sessionId : undefined
    const title = titleOf(row?.value?.title?.title)
    if (id !== undefined && title.length > 0) titles.set(id, title)
  }
  const suffix = failed === 0 ? '' : ` (${failed} unreadable)`
  return { titles, status: `recovered by reading session logs${suffix}` }
}

/**
 * Workspace titles, keyed both by canonical path and by session id.
 *
 * The sidebar shows a workspace NAME, and for a person choosing between two
 * similarly-titled sessions the workspace is the tie-breaker. `workspaceRegistry`
 * is optional (it is absent on the thinnest deployments), so a missing registry
 * costs the workspace label, never the list.
 *
 * @param {object} ctx - Cordis context.
 * @returns {{byPath: Map<string,string>, bySession: Map<string,string>, status: string}}
 */
function workspaceIndex(ctx) {
  const registry = typeof ctx?.get === 'function' ? ctx.get('workspaceRegistry') : undefined
  const empty = { byPath: new Map(), bySession: new Map(), status: 'unavailable' }
  if (registry === undefined || registry === null || typeof registry.list !== 'function') return empty
  let list
  try {
    list = registry.list()
  } catch (error) {
    return { ...empty, status: `unavailable: ${errorMessage(error)}` }
  }
  const byPath = new Map()
  const bySession = new Map()
  for (const workspace of Array.isArray(list) ? list : []) {
    const title = typeof workspace?.title === 'string' && workspace.title.length > 0 ? workspace.title : ''
    if (title.length === 0) continue
    const path = typeof workspace?.path === 'string' ? workspace.path : ''
    if (path.length > 0) byPath.set(normalizePath(path), title)
    for (const id of Array.isArray(workspace?.sessionIds) ? workspace.sessionIds : []) bySession.set(String(id), title)
  }
  return { byPath, bySession, status: 'ok' }
}

/**
 * A path fit for comparison. Windows paths differ only by case and separator, and
 * the workspace record stores an `fs.realpath` while a session header stores the
 * cwd it was started with.
 *
 * @param {string} value - a path.
 * @returns {string} normalized key.
 */
function normalizePath(value) {
  return String(value).replace(/\\/gu, '/').replace(/\/+$/u, '').toLowerCase()
}

/**
 * Order candidates newest-activity first, then live, then by id.
 *
 * Exported because it is the one piece of this module with no I/O, and the order
 * IS the feature: the session a person wants is almost always one of the ones
 * that moved recently.
 *
 * @param {object[]} rows - candidates carrying `lastUsedMs`, `live`, `id`.
 * @returns {object[]} a new sorted array.
 */
export function sortSessionCandidates(rows) {
  const list = Array.isArray(rows) ? [...rows] : []
  return list.sort((left, right) => {
    const leftUsed = typeof left?.lastUsedMs === 'number' ? left.lastUsedMs : -Infinity
    const rightUsed = typeof right?.lastUsedMs === 'number' ? right.lastUsedMs : -Infinity
    if (leftUsed !== rightUsed) return rightUsed > leftUsed ? 1 : -1
    // A session that is ALIVE right now and has no time still deserves the top.
    const leftLive = left?.live === true ? 1 : 0
    const rightLive = right?.live === true ? 1 : 0
    if (leftLive !== rightLive) return rightLive - leftLive
    // Stable tie-break, so an unchanged machine produces an unchanged list.
    return String(left?.id ?? '').localeCompare(String(right?.id ?? ''))
  })
}

/**
 * The picker's payload: which sessions could be invited into a room.
 *
 * @param {object} options
 *   - `ctx`: Cordis context (only `get` is used, and only optionally);
 *   - `dshHome`: the DSH home, for session-log mtimes;
 *   - `max`: ceiling on returned rows (defaults to MAX_CANDIDATES).
 * @returns {Promise<object>} `{ok:true, sessions, total, shown, max, …}` or
 *   `{ok:false, error}` when the deployment cannot list sessions at all.
 *
 * ⚠️ Room membership is NOT decided here. Which sessions are already in a room
 * is this plugin's own ledger fact, and mixing it in would make the cache in
 * `index.js` (which exists so a five-second poll does not rebuild the list)
 * answer for one room what was computed for another.
 */
export async function listSessionCandidates(options = {}) {
  const { ctx, dshHome } = options
  const max = Number.isFinite(options.max) && options.max > 0 ? Math.floor(options.max) : MAX_CANDIDATES
  const query = typeof ctx?.get === 'function' ? ctx.get('sessionQuery') : undefined
  const cache = typeof ctx?.get === 'function' ? ctx.get('sessionProjectionCache') : undefined
  if (query === undefined || query === null || typeof query.listSessions !== 'function') {
    // A picker with no catalogue is not an empty catalogue: say which capability
    // is missing, because "nothing to pick" and "cannot ask" are different facts
    // and only one of them is the user's fault.
    return {
      ok: false,
      error: 'this deployment has no sessionQuery service, so the panel cannot list sessions; paste a session id instead',
    }
  }

  let records
  try {
    records = await query.listSessions()
  } catch (error) {
    return { ok: false, error: `cannot list sessions: ${errorMessage(error)}` }
  }

  const scanned = sessionLogTimes(dshHome)
  const workspaces = workspaceIndex(ctx)
  const rows = []
  const headers = new Map()
  let skipped = 0
  for (const record of Array.isArray(records) ? records : []) {
    const header = record?.header
    const id = typeof header?.id === 'string' ? header.id : ''
    if (id.length === 0) {
      skipped += 1
      continue
    }
    const cwd = typeof header?.cwd === 'string' ? header.cwd : ''
    const workspace =
      workspaces.bySession.get(id) ?? (cwd.length > 0 ? workspaces.byPath.get(normalizePath(cwd)) : undefined)
    headers.set(id, header)
    rows.push({
      id,
      title: '',
      lastUsedMs: scanned.times.get(id),
      live: record?.live === true,
      // A subagent's own session is a real session and can be invited, but it is
      // not one a person picks by title, so it is marked rather than hidden.
      subagent: header?.origin === 'subagent',
      cwd,
      workspace: typeof workspace === 'string' ? workspace : '',
    })
  }

  const ordered = sortSessionCandidates(rows)
  const page = ordered.slice(0, max)

  // ── titles ────────────────────────────────────────────────────────────────
  // Pass 1: the projection cache, zero I/O, one call per visible row. This is
  // exactly what the Web GUI's own session list does, and it is normally enough.
  let cacheFailures = 0
  let cacheError = ''
  for (const row of page) {
    try {
      row.title = cachedTitle(cache, headers.get(row.id))
    } catch (error) {
      cacheFailures += 1
      if (cacheError.length === 0) cacheError = errorMessage(error)
    }
  }
  let titlesStatus = cacheFailures === 0 ? 'ok' : `partial: ${cacheFailures} of ${page.length} cached title(s) were unreadable`
  if (page.length > 0 && page.every((row) => row.title.length === 0)) {
    // Pass 2 (last resort): the cache served nothing for the whole page, so read
    // the titles out of the session logs. Expensive, bounded, and REPORTED — the
    // panel can then say why a click was slow instead of pretending the sessions
    // are nameless.
    const folded = await foldTitlesFromLogs(query, page.map((row) => row.id))
    for (const row of page) row.title = folded.titles.get(row.id) ?? row.title
    titlesStatus =
      folded.titles.size > 0
        ? `degraded: ${folded.status} because the projection cache served no titles${cacheError.length > 0 ? ` (${cacheError})` : ''}`
        : folded.status
  }

  const untitled = page.filter((row) => row.title.length === 0).length

  return {
    ok: true,
    sessions: page.map((row) => ({
      id: row.id,
      // An absent title is reported as an absent title, never as an id dressed up
      // as a name: the panel decides how to say 「没有标题」.
      title: row.title,
      workspace: row.workspace,
      // `cwd` travels separately so the panel can show where a session actually
      // lives when no workspace record names it.
      cwd: row.cwd,
      lastUsedAt: row.lastUsedMs === undefined ? '' : new Date(row.lastUsedMs).toISOString(),
      live: row.live,
      subagent: row.subagent,
    })),
    total: ordered.length,
    shown: page.length,
    max,
    skipped,
    titleSource: titlesStatus.startsWith('degraded') ? 'session-logs' : 'projection-cache',
    titlesStatus,
    // How many rows will show 「无标题会话」 — a healthy absence, not a failure.
    untitled,
    // Where the activity times came from, and whether that source existed at all.
    // Only claim it is unavailable when NO row has a time: a single undated row
    // already says 「活动时间未知」 on its own line, and a banner for it is noise.
    timeSource: page.length === 0 || page.some((row) => row.lastUsedMs !== undefined) ? 'session-log-mtime' : 'unavailable',
    ...(scanned.error === undefined ? {} : { timeDetail: scanned.error }),
    workspacesStatus: workspaces.status,
  }
}
