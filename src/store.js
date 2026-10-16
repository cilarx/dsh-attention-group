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

import { mkdirSync, readFileSync, writeFileSync, renameSync, openSync, writeSync, closeSync, existsSync, readdirSync } from 'node:fs'
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

/**
 * Read the ledger, tolerant of a missing or corrupt file.
 *
 * A corrupt ledger is never silently discarded: it is renamed aside so the
 * groups can be recovered by hand, and an empty ledger is returned so the
 * plugin still boots. Losing a chat surface is better than blocking DSH.
 *
 * @param {string} root - data root.
 * @returns {{ ledger: object, recoveredFrom?: string }}
 */
export function readLedger(root) {
  const file = join(root, 'groups.json')
  if (!existsSync(file)) return { ledger: emptyLedger() }
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return { ledger: emptyLedger() }
  }
  try {
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.groups)) throw new Error('shape')
    return { ledger: { version: LEDGER_VERSION, groups: parsed.groups } }
  } catch {
    const aside = `${file}.corrupt-${Date.now()}`
    try { renameSync(file, aside) } catch { /* keep booting regardless */ }
    return { ledger: emptyLedger(), recoveredFrom: aside }
  }
}

/**
 * Replace the ledger atomically.
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
  const fd = openSync(join(dir, `${groupId}.jsonl`), 'a')
  try {
    writeSync(fd, line)
  } finally {
    closeSync(fd)
  }
}

/**
 * Read a group transcript, newest-last.
 *
 * Unparseable lines are skipped rather than thrown: a torn final line from a
 * crash must not make the whole history unreadable.
 *
 * @param {string} root - data root.
 * @param {string} groupId - owning group.
 * @param {{ limit?: number }} [options] - keep only the last `limit` records.
 * @returns {object[]} message records.
 */
export function readMessages(root, groupId, options = {}) {
  const file = join(messagesDir(root), `${groupId}.jsonl`)
  if (!existsSync(file)) return []
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const records = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      records.push(JSON.parse(trimmed))
    } catch {
      // torn tail or hand-edited line: skip it, keep the rest
    }
  }
  const limit = options.limit
  if (typeof limit === 'number' && limit >= 0 && records.length > limit) return records.slice(-limit)
  return records
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
 * Read the wake-up audit log, newest-last.
 *
 * @param {string} root - data root.
 * @param {{ limit?: number }} [options] - keep only the last `limit` records.
 * @returns {object[]} delivery records.
 */
export function readDeliveries(root, options = {}) {
  const file = join(messagesDir(root), 'deliveries.jsonl')
  if (!existsSync(file)) return []
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const records = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      records.push(JSON.parse(trimmed))
    } catch {
      // torn tail: skip
    }
  }
  const limit = options.limit
  if (typeof limit === 'number' && limit > 0 && records.length > limit) return records.slice(-limit)
  return records
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
