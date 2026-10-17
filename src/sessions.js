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
 * catalogue through DSH's own services. So every field is treated as untrusted
 * and DEFAULTED rather than passed through: one malformed session record may
 * cost that one row, never the whole list. A picker that throws is worse than no
 * picker, because the panel then has nothing to show and the human is back to
 * copying ids.
 *
 * ⚠️⚠️ WHY IT GOES THROUGH `sessionController.list()` AND NOT THROUGH THE
 * PROJECTION CACHE DIRECTLY (learned in front of the user, 2026-10-17, twice):
 *
 *   `sessionController.list()` is DSH's OWN "give me every session, with its
 *   cached title" call. It is what the Web GUI's sidebar reads. The title arrives
 *   as `summary.projections.values.title`, already resolved by the shipped code.
 *
 *   Calling `sessionProjectionCache.cachedSnapshot(header, …)` directly means
 *   committing to that method's EXACT signature — and that signature DIFFERS
 *   between the versions on this machine: `cachedSnapshot(meta, keys?)` in the
 *   running 0.2.1-rc.2 (extracted from `app.asar`), but
 *   `cachedSnapshot(meta, inheritedEventCount, keys?)` in the older 0.1.5-rc.1
 *   tree that still sits in `~/.dsh/profiles/node_modules`. Guessing wrong does
 *   not fail loudly: the keys land in the wrong slot, `new Set(0)` throws for
 *   every unseeded session, and the picker silently loses every title while all
 *   tests stay green — which is exactly what happened. Going through the shipped
 *   list call delegates that signature to the code that owns it, so the picker
 *   keeps working across DSH versions without this module tracking them.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: it never wakes, resumes, or reads a
 * transcript. A picker must not start a turn (that is this plugin's entire
 * promise), and reading somebody's conversation is not needed to list it.
 *
 * DEGRADATION IS STATED, NEVER IMPLIED (the project's c7 rule):
 *  - neither service         -> `{ok:false, error}` naming what is missing;
 *  - no sessionController    -> rows still list (via `sessionQuery`), but titles
 *                               are reported unavailable, because the only cheap
 *                               title source is that cached list;
 *  - no sessions directory   -> times come from the runtime's own `updatedAt`;
 *  - a malformed record      -> skipped, and `skipped` counts it.
 *
 * @module dsh-attention-group/sessions
 */

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * How many sessions one picker payload may carry.
 *
 * Not a cost ceiling — the whole lookup is one session listing plus in-memory
 * projection reads — but a reading ceiling: a list that starts scrolling past
 * forty rows is worse than typing an id, and the payload always reports the TRUE
 * total, so the panel can say how much it is not showing instead of pretending
 * this is everything.
 */
export const MAX_CANDIDATES = 40

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
 * When each session log was last written — a FALLBACK for the runtime's own
 * `updatedAt`.
 *
 * Why a fallback and not the primary source: `sessionController.list()` already
 * reports each session's last activity (the greater of its creation and its last
 * prompt), which is the figure the sidebar orders by. Only when the runtime
 * cannot report one (or cannot be asked at all) does the log's mtime fill in: it
 * IS the last time anything happened in that session.
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
 * A display budget, not a data cut: the runtime's cached title can legitimately be
 * a few hundred characters (a fallback title is the opening prompt's first line),
 * and forty of those would bloat a payload the panel draws on one line. The full
 * title stays in the session log.
 *
 * @param {unknown} value - `summary.projections.values.title`, whatever it is.
 * @returns {string} the title, or ''.
 */
function titleOf(value) {
  if (typeof value !== 'string') return ''
  const text = value.trim()
  if (text.length === 0) return ''
  return text.length > 120 ? `${text.slice(0, 120)}…` : text
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
 * One row from a `sessionController.list()` summary.
 *
 * @param {object} summary - `SessionSummary` from the runtime.
 * @param {object} workspaces - result of {@link workspaceIndex}.
 * @returns {object|undefined} a row, or `undefined` when the summary has no id.
 */
function rowFromSummary(summary, workspaces) {
  const id = typeof summary?.sessionId === 'string' ? summary.sessionId : ''
  if (id.length === 0) return undefined
  const cwd = typeof summary?.cwd === 'string' ? summary.cwd : ''
  const workspace =
    workspaces.bySession.get(id) ?? (cwd.length > 0 ? workspaces.byPath.get(normalizePath(cwd)) : undefined)
  return {
    id,
    title: titleOf(summary?.projections?.values?.title),
    // The runtime's own last-activity figure: max(createdAt, lastPromptAt).
    lastUsedMs: Number.isFinite(summary?.updatedAt) && summary.updatedAt > 0 ? summary.updatedAt : undefined,
    live: summary?.running === true,
    // A subagent's own session is a real session and can be invited, but it is
    // not one a person picks by title, so it is marked rather than hidden.
    subagent: summary?.origin === 'subagent',
    cwd,
    workspace: typeof workspace === 'string' ? workspace : '',
  }
}

/**
 * The picker's payload: which sessions could be invited into a room.
 *
 * @param {object} options
 *   - `ctx`: Cordis context (only `get` is used, and only optionally);
 *   - `dshHome`: the DSH home, for session-log mtimes (fallback times only);
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
  const controller = typeof ctx?.get === 'function' ? ctx.get('sessionController') : undefined
  const query = typeof ctx?.get === 'function' ? ctx.get('sessionQuery') : undefined

  const workspaces = workspaceIndex(ctx)
  const scanned = sessionLogTimes(dshHome)
  const rows = []
  let skipped = 0
  let titleStatus = 'ok'
  let timeSource = 'session-controller.updatedAt'
  let usedController = false

  if (typeof controller?.list === 'function') {
    usedController = true
    // PRIMARY: the runtime's own session list, which is what the Web GUI's
    // sidebar reads. Titles arrive already resolved (see the module comment).
    let summaries
    try {
      summaries = await controller.list(new AbortController().signal)
    } catch (error) {
      return { ok: false, error: `cannot list sessions: ${errorMessage(error)}` }
    }
    const list = Array.isArray(summaries) ? summaries : []
    for (const summary of list) {
      const row = rowFromSummary(summary, workspaces)
      if (row === undefined) skipped += 1
      else rows.push(row)
    }
  } else if (typeof query?.listSessions === 'function') {
    // FALLBACK: no session controller in this composition. Rows are still
    // available; titles are not, because the only cheap title source is that
    // cached list. Say so instead of showing a screen of ids as names.
    let records
    try {
      records = await query.listSessions()
    } catch (error) {
      return { ok: false, error: `cannot list sessions: ${errorMessage(error)}` }
    }
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
      rows.push({
        id,
        title: '',
        lastUsedMs: undefined,
        live: record?.live === true,
        subagent: header?.origin === 'subagent',
        cwd,
        workspace: typeof workspace === 'string' ? workspace : '',
      })
    }
    titleStatus =
      'unavailable: this deployment has no sessionController, so its cached session titles cannot be read without loading every session log'
    timeSource = 'session-log-mtime'
  } else {
    // A picker with no catalogue is not an empty catalogue: say which capability
    // is missing, because "nothing to pick" and "cannot ask" are different facts
    // and only one of them is the user's fault.
    return {
      ok: false,
      error:
        'this deployment has no sessionController.list (and no sessionQuery), so the panel cannot list sessions; paste a session id instead',
    }
  }

  // Fill in any missing time from the session logs. The runtime's own figure wins
  // because it is the one the sidebar's order is based on; the log mtime is the
  // honest fallback when the runtime reports none.
  let fromLog = 0
  for (const row of rows) {
    if (row.lastUsedMs !== undefined) continue
    const fromScan = scanned.times.get(row.id)
    if (fromScan === undefined) continue
    row.lastUsedMs = fromScan
    fromLog += 1
  }
  // "mixed" only means something when there WERE runtime times to mix with.
  if (fromLog > 0 && rows.length > 0 && usedController) timeSource = 'mixed: sessionController.updatedAt + session-log-mtime'
  if (rows.every((row) => row.lastUsedMs === undefined)) {
    // No time from anywhere. Say that, instead of letting every row promise a
    // 「最后活动」 that was never read.
    timeSource = 'unavailable'
  }

  const ordered = sortSessionCandidates(rows)
  const page = ordered.slice(0, max)
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
    // Where the activity times came from, and whether that source existed at all.
    timeSource,
    ...(timeSource !== 'unavailable' || scanned.error === undefined ? {} : { timeDetail: scanned.error }),
    titlesStatus: titleStatus,
    // How many rows will show 「无标题会话」 — a healthy absence, not a failure.
    untitled,
    workspacesStatus: workspaces.status,
  }
}
