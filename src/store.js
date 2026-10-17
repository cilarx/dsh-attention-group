/**
 * Filesystem primitives for the group ledger and the message log.
 *
 * Two shapes, chosen for what each one has to survive:
 *   - the ledger is small and rewritten often -> atomic replace (write temp,
 *     fsync, rename) so a crash never leaves a half-written room list;
 *   - the message log is append-only and unbounded -> JSONL, one record per
 *     line, appended with the file handle closed again so a process kill
 *     cannot lose an already-acknowledged message.
 *
 * @module dsh-attention-group/store
 */

import { mkdirSync, readFileSync, writeFileSync, renameSync, openSync, writeSync, closeSync, fsyncSync, existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Ledger schema version. Bumped only on an incompatible layout change. */
export const LEDGER_VERSION = 1

/**
 * Resolve this plugin's data root. `DSH_HOME` is honoured so a test or a second
 * deployment can point at a throwaway directory; otherwise it sits beside the
 * other DSH state under the user's home.
 *
 * @param {NodeJS.ProcessEnv} [env] - environment to read.
 * @returns {string} absolute data root.
 */
export function resolveDataRoot(env = process.env) {
  const home = typeof env.DSH_HOME === 'string' && env.DSH_HOME.length > 0 ? env.DSH_HOME : join(homedir(), '.dsh')
  return join(home, 'attention-group')
}

/** An empty ledger. */
export function emptyLedger() {
  return { version: LEDGER_VERSION, groups: [] }
}

/** A one-line reason from a thrown value, never the string "undefined". */
function errorMessage(error) {
  if (error === null || error === undefined) return 'unknown error'
  const message = typeof error.message === 'string' ? error.message : String(error)
  return message.length > 0 ? message : String(error)
}

/**
 * Coerce one ledger room into the shape every consumer is allowed to assume.
 *
 * `readLedger` validated that `groups` is an array and said nothing about the
 * rooms inside it. One room without a `members` array was therefore enough to
 * make **six** tools throw `TypeError: Cannot read properties of undefined` —
 * there was no single place where a room became trustworthy, so every consumer
 * re-derived that trust and every consumer could get it wrong. This is that
 * place.
 *
 * The room is repaired rather than dropped: silently losing someone's room
 * because one field is malformed would be a worse answer than showing it with a
 * note attached, which is what the `problems` list is for.
 *
 * @param {unknown} raw - one entry of `groups`.
 * @returns {{ group: object, problems: string[] }}
 */
function normalizeGroup(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { group: { id: '', title: '(unreadable room)', members: [] }, problems: ['the entry is not an object'] }
  }
  const problems = []
  const id = typeof raw.id === 'string' ? raw.id : ''
  if (id.length === 0) problems.push('id is missing')
  // An id that had to be rewritten to be a safe file name means the transcript
  // is not where a hand-editor would expect. Say so instead of moving data
  // silently.
  if (id.length > 0 && fileNameFor(id) !== id) problems.push('id is not usable as a file name')
  const title = typeof raw.title === 'string' && raw.title.length > 0 ? raw.title : id
  if (typeof raw.title !== 'string') problems.push('title is not a string')

  let members = raw.members
  if (!Array.isArray(members)) {
    problems.push('members is not an array')
    members = []
  }
  const usable = members.filter((member) => member !== null && typeof member === 'object' && !Array.isArray(member))
  if (usable.length !== members.length) problems.push('some members are not objects')

  let links = raw.links
  if (links !== undefined && !Array.isArray(links)) {
    problems.push('links is not an array')
    links = []
  }

  return {
    group: { ...raw, id, title, members: usable, ...(links === undefined ? {} : { links }) },
    problems,
  }
}

/**
 * Read the ledger, tolerant of a missing or corrupt file.
 *
 * A corrupt ledger is never silently discarded: it is renamed aside so the
 * groups can be recovered by hand, and an empty ledger is returned so the
 * plugin still boots. Losing a chat surface is better than blocking DSH.
 *
 * ⚠️ "The file is there and I could not read it" is reported as `unreadable`,
 * NOT as an empty ledger. Those two used to be the same return value, and the
 * cost was real: an I/O failure (a lock held by a backup tool, a permissions
 * problem) made the panel announce "you have no rooms" while `groups.json` sat
 * on disk completely intact. A reader cannot tell an empty room from a room it
 * failed to open unless the two are distinguishable here, and the panel has no
 * way to ask a second time.
 *
 * @param {string} root - data root.
 * @returns {{ ledger: object, unreadable?: true, error?: string, recoveredFrom?: string }}
 */
export function readLedger(root) {
  const file = join(root, 'groups.json')
  if (!existsSync(file)) return { ledger: emptyLedger() }
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    return { ledger: emptyLedger(), unreadable: true, error: errorMessage(error) }
  }
  try {
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.groups)) throw new Error('shape')
    const groups = []
    const repairs = []
    for (const raw of parsed.groups) {
      const { group, problems } = normalizeGroup(raw)
      groups.push(group)
      if (problems.length > 0) repairs.push({ id: group.id, problems })
    }
    return { ledger: { version: LEDGER_VERSION, groups }, ...(repairs.length === 0 ? {} : { repairs }) }
  } catch {
    const aside = `${file}.corrupt-${Date.now()}`
    try { renameSync(file, aside) } catch { /* keep booting regardless */ }
    return { ledger: emptyLedger(), recoveredFrom: aside }
  }
}

/**
 * Replace the ledger atomically, and make it durable before the rename.
 *
 * The `fsync` is the part that is easy to leave out and had been: a rename is
 * atomic with respect to the *directory entry*, but the file's *contents* may
 * still be sitting in the page cache. A power loss between the rename and the
 * flush leaves a correctly-named, empty or truncated ledger — the room list
 * silently gone, with nothing to recover from. Adversarial audit B-06
 * (2026-10-16) noticed the module comment promised fsync and the code did not
 * do it.
 *
 * @param {string} root - data root.
 * @param {object} ledger - full ledger value.
 */
export function writeLedger(root, ledger) {
  mkdirSync(root, { recursive: true })
  const file = join(root, 'groups.json')
  const temp = `${file}.tmp-${process.pid}`
  const text = `${JSON.stringify(ledger, null, 2)}\n`
  const fd = openSync(temp, 'w')
  try {
    writeSync(fd, text)
    // Flush the CONTENTS before the rename publishes the name. A failure here is
    // not worth losing the write over — it only means we are no more durable than
    // before — but it must not be reported as success, so the throw is left to
    // the caller and the write still completes.
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temp, file)
}

/** Directory holding one JSONL transcript per group. */
function messagesDir(root) {
  return join(root, 'messages')
}

/**
 * Turn a group id into a file name that cannot leave the messages directory.
 *
 * ⚠️ A group id is an IDENTIFIER, and building a path out of one lets the data
 * choose where the data goes. Adversarial audit A-7 (2026-10-16) put an id of
 * `../../escaped` in the ledger and `attention_send` wrote a transcript to
 * `<DSH_HOME>/escaped.jsonl` — outside the plugin's data root entirely.
 *
 * This is not reachable from a tool call: `slugify` collapses every non-letter
 * and non-digit to `-`, so no title can produce such an id. It IS reachable from
 * a hand-edited `groups.json`, which is exactly why the guard belongs here
 * rather than at the call sites — there are a dozen call sites and one file
 * name.
 *
 * The mapping is the identity for every id this plugin creates (letters, digits
 * and `-` survive untouched, including non-ASCII ones), so existing transcripts
 * keep resolving. It only rewrites ids that could not have been created here.
 *
 * @param {string} groupId - ledger id.
 * @returns {string} a safe file name stem.
 */
function fileNameFor(groupId) {
  const raw = String(groupId)
  const flattened = raw.replace(/[\\/:*?"<>|\u0000-\u001f]/gu, '_')
  // Leading dots are the other way out: `..` is a directory traversal on its own.
  return flattened.replace(/^\.+/u, '_')
}

/** Absolute path of one room's transcript, safe for any id. */
function transcriptFile(root, groupId) {
  return join(messagesDir(root), `${fileNameFor(groupId)}.jsonl`)
}

/**
 * Append one message record to a group transcript.
 *
 * @param {string} root - data root.
 * @param {string} groupId - owning group.
 * @param {object} record - message record (already normalised).
 */
export function appendMessage(root, groupId, record) {
  const dir = messagesDir(root)
  mkdirSync(dir, { recursive: true })
  const line = `${JSON.stringify(record)}\n`
  const fd = openSync(transcriptFile(root, groupId), 'a')
  try {
    writeSync(fd, line)
  } finally {
    closeSync(fd)
  }
}

/**
 * Coerce one parsed JSONL line into a message record, or `undefined` if it is
 * not one.
 *
 * "Unparseable lines are skipped" was only half the promise. A line that parses
 * into `null`, `42`, `[1,2]` or `{}` is dirt too, and keeping it is worse than
 * dropping it: downstream reads `row.seq` / `row.at` off it and throws
 * (`Cannot read properties of null`), and because `undefined` is not lossless
 * JSON the runtime rejects the entire tool result with `ToolOutputError`. One
 * foreign line in a transcript was enough to turn four tools into internal
 * errors.
 *
 * The fields every consumer reads are defaulted here, at the boundary, so no
 * render can ever print the literal string "undefined" for a record that loaded.
 * Note `JSON.parse` can never produce an `undefined` *value* — only an absent
 * key — so defaulting the reads is sufficient.
 *
 * @param {unknown} value - one parsed JSON value.
 * @param {number} fallbackSeq - sequence number to use when the line has none.
 * @returns {object|undefined} a usable record.
 */
function normalizeMessage(value, fallbackSeq) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  // No timestamp means it is not a message. This is the one field worth being
  // strict about, because `inRange` compares it as text and every transcript
  // view is ordered by it.
  if (typeof value.at !== 'string' || value.at.length === 0) return undefined
  return {
    ...value,
    seq: typeof value.seq === 'number' && Number.isFinite(value.seq) ? value.seq : fallbackSeq,
    at: value.at,
    fromId: typeof value.fromId === 'string' ? value.fromId : '',
    fromName: typeof value.fromName === 'string' ? value.fromName : '',
    text: typeof value.text === 'string' ? value.text : '',
    mentions: Array.isArray(value.mentions) ? value.mentions.filter((name) => typeof name === 'string') : [],
  }
}

/**
 * Read a group transcript, newest-last, **and say whether the read worked**.
 *
 * Unparseable lines are skipped rather than thrown: a torn final line from a
 * crash must not make the whole history unreadable. A file that cannot be
 * opened at all is a different matter — see `readMessages` for why.
 *
 * @param {string} root - data root.
 * @param {string} groupId - owning group.
 * @param {{ limit?: number }} [options] - keep only the last `limit` records.
 * @returns {{ records: object[], unreadable?: true, error?: string }}
 */
export function readMessagesWithStatus(root, groupId, options = {}) {
  const file = transcriptFile(root, groupId)
  if (!existsSync(file)) return { records: [] }
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    return { records: [], unreadable: true, error: errorMessage(error) }
  }
  const records = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    let value
    try {
      value = JSON.parse(trimmed)
    } catch {
      continue // torn tail or hand-edited line: skip it, keep the rest
    }
    const record = normalizeMessage(value, records.length + 1)
    if (record !== undefined) records.push(record)
  }
  const limit = options.limit
  if (typeof limit === 'number' && limit >= 0 && records.length > limit) return { records: records.slice(-limit) }
  return { records }
}

/**
 * Read a group transcript, newest-last.
 *
 * ⚠️ Returns `[]` both for "this room has no messages" and for "this room's
 * transcript exists but could not be opened". That ambiguity is invisible to a
 * caller that only wants the array, which is exactly why it is dangerous: a
 * reader that renders it as "this room is empty" is lying to the user about
 * their own data. Callers that report to a human must use
 * `readMessagesWithStatus` and surface `unreadable` instead.
 *
 * @param {string} root - data root.
 * @param {string} groupId - owning group.
 * @param {{ limit?: number }} [options] - keep only the last `limit` records.
 * @returns {object[]} message records.
 */
export function readMessages(root, groupId, options = {}) {
  return readMessagesWithStatus(root, groupId, options).records
}

/**
 * Append one delivery attempt to the wake-up audit log.
 *
 * Every wake-up is a real cost in someone else's session, and a delivery that
 * silently does nothing is the hardest failure to diagnose: the sender sees
 * success, the target's log shows nothing, and neither side can tell whether the
 * message was rejected, queued, or never sent. This log is the third witness.
 *
 * Best-effort by design: a failure to audit must never fail a delivery.
 *
 * @param {string} root - data root.
 * @param {object} record - `{groupId, memberId, path, delivered, note}`.
 */
export function appendDelivery(root, record) {
  try {
    const dir = messagesDir(root)
    mkdirSync(dir, { recursive: true })
    const line = `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`
    const fd = openSync(join(dir, 'deliveries.jsonl'), 'a')
    try {
      writeSync(fd, line)
    } finally {
      closeSync(fd)
    }
  } catch {
    // Auditing is not worth failing a delivery over.
  }
}

/**
 * Read the wake-up audit log, newest-last, **and say whether the read worked**.
 *
 * Same rule as the transcript: an unreadable audit log is not an empty audit
 * log, and `attention_probe` reports its length to a human who is trying to
 * work out whether any wake-up ever happened.
 *
 * @param {string} root - data root.
 * @param {{ limit?: number }} [options] - keep only the last `limit` records.
 * @returns {{ records: object[], unreadable?: true, error?: string }}
 */
export function readDeliveriesWithStatus(root, options = {}) {
  const file = join(messagesDir(root), 'deliveries.jsonl')
  if (!existsSync(file)) return { records: [] }
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    return { records: [], unreadable: true, error: errorMessage(error) }
  }
  const records = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    let value
    try {
      value = JSON.parse(trimmed)
    } catch {
      continue // torn tail: skip
    }
    // The audit log is what `attention_probe` shows a human who is trying to work
    // out whether a wake-up ever happened, so a foreign line must not be able to
    // take the diagnostic tool itself down.
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
    records.push({ ...value, at: typeof value.at === 'string' ? value.at : '' })
  }
  const limit = options.limit
  if (typeof limit === 'number' && limit > 0 && records.length > limit) return { records: records.slice(-limit) }
  return { records }
}

/**
 * Read the wake-up audit log, newest-last.
 *
 * @param {string} root - data root.
 * @param {{ limit?: number }} [options] - keep only the last `limit` records.
 * @returns {object[]} delivery records.
 */
export function readDeliveries(root, options = {}) {
  return readDeliveriesWithStatus(root, options).records
}

/**
 * Group ids that currently have a transcript on disk. Used to report a group
 * whose ledger entry was lost but whose messages survived.
 *
 * @param {string} root - data root.
 * @returns {string[]} group ids.
 */
export function transcriptGroupIds(root) {
  const dir = messagesDir(root)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => name.slice(0, -'.jsonl'.length))
}
