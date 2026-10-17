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
 * catalogue through the public `sessionQuery` service, plus one filesystem fact
 * the catalogue does not expose (when each session log was last written). So
 * every field is treated as untrusted and DEFAULTED rather than passed through:
 * one malformed session record may cost that one row, never the whole list. A
 * picker that throws is worse than no picker, because the panel then has nothing
 * to show and the human is back to copying ids.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: it never wakes, resumes, or reads a
 * transcript. A picker must not start a turn (that is this plugin's entire
 * promise), and reading somebody's conversation is not needed to list it.
 *
 * DEGRADATION IS STATED, NEVER IMPLIED (see the project's c7 rule):
 *  - no `sessionQuery` service  -> `{ok:false, error}` naming the missing service;
 *  - no sessions directory      -> the list still lists, but `timeSource` says
 *                                  `unavailable` and every row has no time;
 *  - titles that cannot be read -> `titlesStatus` says so, rows fall back to id;
 *  - a malformed session record -> that record is skipped, `skipped` counts it.
 *
 * @module dsh-attention-group/sessions
 */

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * How many sessions one picker payload may carry.
 *
 * Not a cost ceiling — the whole lookup is a session listing plus zero-I/O
 * projection-cache reads — but a reading ceiling: a list that starts scrolling
 * past forty rows is worse than typing an id, and the payload always reports the
 * TRUE total, so the panel can say how much it is not showing instead of
 * pretending this is everything.
 */
export const MAX_CANDIDATES = 40

/** Session logs are `<DSH_HOME>/sessions/<workspace>/<sessionId>/session.v4.jsonl.zstd`. */
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
 * scan found nothing, the picker silently showed no activity time, and the only
 * reason it was caught is a test that asserted a planted log's mtime comes back
 * (measured 2026-10-17). Hence the explicit shape check here.
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
 * When each session log was last written — the only "last used" signal that
 * exists.
 *
 * Why not ask the runtime: a session header carries `createdAt` but no
 * last-activity instant, and folding the title gives the title's timestamp, not
 * the session's. The log file's mtime IS the last time anything happened in that
 * session, which is exactly what a person means by 「最后一次使用」.
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
 * How long a title may be in this payload.
 *
 * A display budget, not a data cut: the full title stays in the session log, and
 * the row's tooltip always carries the full id. The projection cache's title can
 * legitimately be a few hundred characters (a fallback title is the opening
 * prompt's first line), and forty of those would bloat a payload the panel draws
 * on one line.
 */
const MAX_TITLE_CHARS = 120

/**
 * One session's title, from the projection cache — WITHOUT reading its log.
 *
 * ⚠️ Why not `sessionQuery.readTitleSnapshots` (the obvious API): it folds the
 * title out of the session's complete event log. Measured on this machine
 * 2026-10-17: the 40 most recent session logs total 67 MB, and one of them is 11
 * MB, so asking for forty titles would decompress and replay tens of megabytes
 * on the host's main thread to fill a picker — the whole GUI would stall behind
 * one click. The projection cache exists exactly for this: `cachedSnapshot` is
 * documented as "the zero-I/O listing read", checkpointed at session creation,
 * every `turn/end` and at disposal.
 *
 * ⚠️⚠️ THE SECOND ARGUMENT IS THE INHERITED EVENT COUNT, NOT THE KEYS. The
 * runtime's own Service inspect catalog shows
 * `cachedSnapshot(meta, keys?)` / `cachedPredecessorTitle(meta)` — **that
 * projection is abridged and wrong**. The authoritative declaration
 * (`dsh-session-projection-cache/lib/types/index.d.ts`) and the implementation
 * are:
 *
 *     cachedSnapshot(meta, inheritedEventCount, keys?)
 *     cachedPredecessorTitle(meta, inheritedEventCount)
 *
 * Passing the keys array there does not fail politely: `identityOf()` receives
 * an array as the offset, and for any unseeded session it **throws**
 * `unseeded projection-cache identity inherited event count must be 0`. Every
 * row then loses its title and the payload reports `partial: N of N titles could
 * not be read` — a silently title-less picker on a perfectly healthy deployment.
 * The shipped `dsh-api-session-controller` calls it as
 * `cachedSnapshot(header, SessionLogOffset(0))`; a listing has no inherited cut,
 * and for a seeded (forked) session the cut is what makes the own-checkpoint
 * match fail, which is precisely when the predecessor title is the right answer.
 * So the offset is always `0` here, exactly like the shipped caller.
 *
 * ⚠️ The fallback ORDER is copied from the shipped API
 * (`dsh-api-session-controller`: `projectionsFor`) rather than invented here: a
 * seeded header has no own checkpoint, so its whole projection block is skipped
 * and only a predecessor checkpoint's title may be used. Being "smarter" than the
 * code that owns the format is how a display column starts showing another
 * session's title.
 *
 * ⚠️ A FORKED session's title is genuinely out of reach from a listing, and that
 * is the shipped behaviour too: its checkpoint is bound to an inherited cut that
 * a `SessionHeader` does not carry, and the listing has no cut to offer, so
 * `cachedSnapshot(header, 0)` cannot match it. Such a row shows as 「无标题会话」.
 * On this machine (2026-10-17) that is 1 of 107 sessions — measured with
 * `tools/check-picker-real-data.mjs`.
 *
 * @param {object} cache - the `sessionProjectionCache` service.
 * @param {object} header - the session header (identity witness for the cache).
 * @returns {string|undefined} the title, or `undefined` when nothing usable exists.
 */
function cachedTitle(cache, header) {
  if (header === undefined || header === null) return undefined
  // A listing holds no inherited cut; 0 is what the shipped caller passes. The
  // cache itself rejects a non-zero cut for an unseeded session, so this is also
  // the only value that cannot be wrong for one.
  const INHERITED_CUT = 0
  let block
  if (header.isSeeded !== true && typeof cache.cachedSnapshot === 'function') {
    block = cache.cachedSnapshot(header, INHERITED_CUT, ['title'])
  }
  if (block === undefined && typeof cache.cachedPredecessorTitle === 'function') {
    block = cache.cachedPredecessorTitle(header, INHERITED_CUT)
  }
  const value = block?.values?.title
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (text.length === 0) return undefined
  return text.length > MAX_TITLE_CHARS ? `${text.slice(0, MAX_TITLE_CHARS)}…` : text
}

/**
 * Titles for the rows about to be shown, read from the projection cache.
 *
 * Two absences are counted separately because they mean different things to
 * whoever reads the picker: a session with NO CACHED TITLE YET (nothing is
 * broken — a brand-new session has no checkpoint) and a title lookup that THREW
 * (something is). Collapsing them would make the panel either alarm the human
 * about a healthy session or stay quiet about a real failure.
 *
 * @param {object} ctx - Cordis context.
 * @param {object[]} rows - candidate rows, each carrying its `header`.
 * @returns {{titles: Map<string, string>, status: string, untitled: number}}
 */
function projectionTitles(ctx, rows) {
  const titles = new Map()
  if (rows.length === 0) return { titles, status: 'ok', untitled: 0 }
  const cache = typeof ctx?.get === 'function' ? ctx.get('sessionProjectionCache') : undefined
  if (cache === undefined || cache === null) {
    // The list is still useful without titles (the panel shows the workspace, the
    // time and the id in a tooltip), but the REASON must travel with it.
    return {
      titles,
      status: 'unavailable: this deployment has no sessionProjectionCache, so titles cannot be read without loading every session log',
      untitled: rows.length,
    }
  }
  let threw = 0
  for (const row of rows) {
    try {
      const title = cachedTitle(cache, row.header)
      if (title !== undefined) titles.set(row.id, title)
    } catch {
      // One bad cache record costs its own title, never the list.
      threw += 1
    }
  }
  return {
    titles,
    status: threw === 0 ? 'ok' : `partial: ${threw} of ${rows.length} title(s) could not be read from the projection cache`,
    untitled: rows.length - titles.size,
  }
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
 * Order candidates newest-activity first, then by creation, then live-first.
 *
 * Exported because it is the one piece of this module with no I/O, and the order
 * IS the feature: the session a person wants is almost always one of the ones
 * that moved recently.
 *
 * @param {object[]} rows - candidates carrying `lastUsedMs`, `createdAt`, `live`.
 * @returns {object[]} a new sorted array.
 */
export function sortSessionCandidates(rows) {
  const list = Array.isArray(rows) ? [...rows] : []
  return list.sort((left, right) => {
    const leftUsed = typeof left?.lastUsedMs === 'number' ? left.lastUsedMs : -Infinity
    const rightUsed = typeof right?.lastUsedMs === 'number' ? right.lastUsedMs : -Infinity
    if (leftUsed !== rightUsed) return rightUsed > leftUsed ? 1 : -1
    // A session that is ALIVE right now and has no log yet (or whose log we could
    // not stat) still deserves the top of the list.
    const leftLive = left?.live === true ? 1 : 0
    const rightLive = right?.live === true ? 1 : 0
    if (leftLive !== rightLive) return rightLive - leftLive
    const leftCreated = typeof left?.createdAt === 'number' ? left.createdAt : -Infinity
    const rightCreated = typeof right?.createdAt === 'number' ? right.createdAt : -Infinity
    if (leftCreated !== rightCreated) return rightCreated > leftCreated ? 1 : -1
    // Stable tie-break, so an unchanged machine produces an unchanged list.
    return String(left?.id ?? '').localeCompare(String(right?.id ?? ''))
  })
}

/**
 * The picker's payload: which sessions could be invited into a room.
 *
 * @param {object} options
 *   - `ctx`: Cordis context (only `get` is used, and only optionally);
 *   - `dshHome`: the DSH home, for the session-log mtimes;
 *   - `max`: ceiling on returned rows (defaults to MAX_CANDIDATES).
 * @returns {Promise<object>} `{ok:true, sessions, total, shown, max, …}` or
 *   `{ok:false, error}` when the deployment cannot list sessions at all.
 *
 * ⚠️ Room membership is NOT decided here. Which sessions are already in a room
 * is this plugin's own ledger fact, and mixing it in would make the cache in
 * `index.js` (which exists because titles are expensive) answer for one room
 * what was computed for another.
 */
export async function listSessionCandidates(options = {}) {
  const { ctx, dshHome } = options
  const max = Number.isFinite(options.max) && options.max > 0 ? Math.floor(options.max) : MAX_CANDIDATES
  const query = typeof ctx?.get === 'function' ? ctx.get('sessionQuery') : undefined
  if (query === undefined || query === null || typeof query.listSessions !== 'function') {
    // A picker with no catalogue is not an empty catalogue: say which capability
    // is missing, because "nothing to pick" and "cannot ask" are different facts
    // and only one of them is the user's fault.
    return {
      ok: false,
      error:
        'this deployment has no sessionQuery service, so the panel cannot list sessions; paste a session id instead',
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
  let skipped = 0
  for (const record of Array.isArray(records) ? records : []) {
    const header = record?.header
    const id = typeof header?.id === 'string' ? header.id : ''
    if (id.length === 0) {
      skipped += 1
      continue
    }
    const cwd = typeof header?.cwd === 'string' ? header.cwd : ''
    const createdAt = Number.isFinite(header?.createdAt) ? header.createdAt : undefined
    const lastUsedMs = scanned.times.get(id)
    const workspace =
      workspaces.bySession.get(id) ?? (cwd.length > 0 ? workspaces.byPath.get(normalizePath(cwd)) : undefined)
    rows.push({
      id,
      // The raw header is kept only until the title lookup: the projection cache
      // identifies a session's record by its lifecycle (format version, creation
      // instant, cwd, seeded flag), so it needs the real header, not our row.
      header,
      createdAt,
      lastUsedMs,
      live: record?.live === true,
      // A subagent's own session is a real session and can be invited, but it is
      // not one a person picks by title, so it is marked rather than hidden.
      subagent: header?.origin === 'subagent',
      preset: typeof header?.agentPreset === 'string' ? header.agentPreset : '',
      cwd,
      workspace: typeof workspace === 'string' ? workspace : '',
    })
  }

  const ordered = sortSessionCandidates(rows)
  const page = ordered.slice(0, max)
  // Titles are looked up only for the rows that survive the cap. The lookup is a
  // zero-I/O read of a projection cache, so this is about not doing work nobody
  // will see, not about avoiding a log read (see `cachedTitle` for why that
  // matters).
  const titles = projectionTitles(ctx, page)

  return {
    ok: true,
    sessions: page.map((row) => ({
      id: row.id,
      // An absent title is reported as an absent title, never as an id dressed up
      // as a name: the panel decides how to say 「没有标题」.
      title: titles.titles.get(row.id) ?? '',
      workspace: row.workspace,
      // `cwd` travels separately so the panel can show where a session actually
      // lives when no workspace record names it.
      cwd: row.cwd,
      lastUsedAt: row.lastUsedMs === undefined ? '' : new Date(row.lastUsedMs).toISOString(),
      live: row.live,
      subagent: row.subagent,
      preset: row.preset,
    })),
    total: ordered.length,
    shown: page.length,
    max,
    skipped,
    // "When was this last used" has a source or it does not. The panel prints
    // 时间未知 for a missing time; it must never invent one.
    timeSource: scanned.scanned ? 'session-log-mtime' : 'unavailable',
    ...(scanned.error === undefined ? {} : { timeError: scanned.error }),
    titlesStatus: titles.status,
    // How many rows will show 「无标题会话」 — a healthy absence, not a failure.
    untitled: titles.untitled,
    workspacesStatus: workspaces.status,
  }
}
