/**
 * R7 — conclusions sink into ordinary files.
 *
 * WHY A PLAIN FILE AND NOT A PLUGIN. The requirement is 「结论沉淀到公共文件」, and
 * the hard constraint on this project is that it must work on a bare DSH. A sink
 * that needs another plugin installed is not a sink, it is a dependency. So the
 * sink is markdown on disk: readable by a human, diffable, greppable, and still
 * there after this plugin is uninstalled.
 *
 * THE OPTIONAL MEMORY INTEGRATION IS NOT PROGRAMMATIC, ON PURPOSE.
 * `dsh-expedition-memory` is a TOOL provider, not a Cordis service — queried
 * 2026-10-16 through the runtime's own Service catalogue and it is not there. So
 * this plugin cannot ask "is task memory installed?" without guessing at another
 * package's internals, and calling another plugin's tools by name would be a
 * hidden dependency. Instead a group carries a `sinkMemory` toggle: when it is
 * on, the conclusion's own output tells the CALLING agent to also record it in
 * task memory if its deployment has one. On a bare DSH that sentence is simply
 * never acted on. Soft integration, zero coupling, nothing to guess.
 *
 * Node's `fs` is used directly rather than the `ctx.fs` service, for the same
 * reason `store.js` does: the ledger already writes this way, the paths here are
 * ones the human chose in the panel, and a half-understood FsTarget API is a
 * worse risk than a documented direct write.
 *
 * @module dsh-attention-group/sink
 */

import { mkdirSync, existsSync, openSync, writeSync, closeSync, statSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

/** A human-readable local timestamp. ISO strings are for machines, not people. */
export function stamp(at) {
  const date = at instanceof Date ? at : new Date(at)
  if (Number.isNaN(date.getTime())) return String(at)
  const pad = (value) => String(value).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  )
}

/** Where a group's files land when the group names no folder of its own. */
export function defaultSinkDir(root) {
  return join(root, 'sink')
}

/**
 * The folder a group sinks into.
 *
 * An absolute `sinkDir` is honoured as given — the human picked it. A relative
 * one is resolved against the plugin's own data root, so a bare deployment never
 * has to know where that root is.
 */
export function groupSinkDir(root, group) {
  const named = typeof group?.sinkDir === 'string' ? group.sinkDir.trim() : ''
  if (named.length === 0) return defaultSinkDir(root)
  return isAbsolute(named) ? named : resolve(root, named)
}

/** The one file a group's conclusions accumulate in, newest last. */
export function conclusionFile(root, group) {
  return join(groupSinkDir(root, group), `${group.id}.conclusions.md`)
}

/** Create the parent folder and append text. Mirrors `store.js`'s write style. */
function appendText(file, text) {
  mkdirSync(dirname(file), { recursive: true })
  const fd = openSync(file, 'a')
  try {
    writeSync(fd, text)
  } finally {
    closeSync(fd)
  }
}

/**
 * One data-derived value as ONE line of text.
 *
 * Every renderer in this module writes lines whose SHAPE is the format
 * (`- **time** · author · text`, `## #seq · time · name`). A value carrying a
 * newline would not be a long line — it would be EXTRA LINES, and a reader
 * cannot tell those from lines the plugin wrote itself. So anything meant to be
 * a field is flattened here, once, for every renderer: `digest.js` imports this
 * rather than growing a second copy that can drift.
 *
 * @param {unknown} value - any data-derived value.
 * @param {number} [maxLength] - 0 means "no cap beyond being one line".
 * @returns {string} a single, whitespace-collapsed line.
 */
export function singleLine(value, maxLength = 0) {
  const text = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  return maxLength > 0 && text.length > maxLength ? text.slice(0, maxLength) : text
}

/**
 * Names to try, best first, for a file that must be created fresh.
 *
 * This is a NAME GENERATOR, not a decision. "This name is free" cannot be
 * decided by looking, because between the look and the write another process can
 * take the name: measured on 2026-10-16, two processes exporting to one path
 * were handed the same name **19 times out of 120 calls**, and the later write
 * replaced the earlier one's bytes. So the write path creates EXCLUSIVELY and
 * walks this list; the list never ends, because falling back to a plain
 * overwriting write is the one outcome that must stay impossible.
 *
 * @param {string} wanted - the path the human asked for.
 * @returns {Generator<string>} candidate paths, in preference order.
 */
function* candidatePaths(wanted) {
  const stem = wanted.endsWith('.md') ? wanted.slice(0, -3) : wanted
  yield wanted
  for (let index = 2; index < 1000; index += 1) yield `${stem}-${index}.md`
  // 999 numbered variants all taken is not "hopeless", it is a busy folder.
  for (let round = 0; ; round += 1) yield `${stem}-${Date.now()}-${round}.md`
}

/**
 * Create a file that did not exist, exclusively, at the first free name.
 *
 * `openSync(path, 'wx')` asks the filesystem to create-or-fail **in one atomic
 * step**, so "an export never overwrites" stops depending on timing. `EEXIST`
 * means that exact name was taken between our attempt and theirs — the race this
 * loop exists to lose safely — so the next name is tried.
 *
 * @param {string} wanted - the path the human asked for.
 * @returns {{fd: number, path: string}} an open descriptor for a brand-new file.
 */
function createExclusive(wanted) {
  mkdirSync(dirname(wanted), { recursive: true })
  for (const candidate of candidatePaths(wanted)) {
    try {
      return { fd: openSync(candidate, 'wx'), path: candidate }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }
  }
  // Unreachable: candidatePaths never ends, so the loop only exits by returning.
  throw new Error(`no free name for ${wanted}: refusing to overwrite an existing file`)
}

/**
 * A name that looks free right now — **ADVISORY ONLY**.
 *
 * Kept for callers that want to display or probe a name. The write path does NOT
 * use this: a check is not a reservation, and the answer can be stale by the time
 * anyone writes. Writing uses `createExclusive`, which cannot overwrite.
 *
 * @param {string} file - desired path.
 * @returns {string} the first candidate that does not exist at this instant.
 */
export function freePath(file) {
  if (!existsSync(file)) return file
  const stem = file.endsWith('.md') ? file.slice(0, -3) : file
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${stem}-${index}.md`
    if (!existsSync(candidate)) return candidate
  }
  return `${stem}-${Date.now()}.md`
}

/** Bytes on disk right now, or 0 when the file does not exist yet. */
export function sizeOf(file) {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}

/** How many conclusions have been sunk so far. */
export function countBullets(file) {
  try {
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('- ')).length
  } catch {
    return 0
  }
}

/**
 * The header written once, when a group's conclusion file is created.
 *
 * @param {object} group - group record.
 * @returns {string} markdown.
 */
export function conclusionHeader(group) {
  return [
    `# ${singleLine(group.title, 120)} · 结论沉淀`,
    '',
    `> 群 id：\`${singleLine(group.id, 80)}\``,
    '> 由 dsh-attention-group 追加写入：每条结论一段，只增不改。',
    '> 这个文件不依赖任何插件，删掉插件它还在。',
    '',
  ].join('\n')
}

/**
 * One conclusion as a markdown list item.
 *
 * Continuation lines are indented so a multi-line conclusion stays one item.
 * The conclusion TEXT is deliberately multi-line (that is the feature); the
 * fields around it are single-line by construction, so a newline in an author
 * name cannot forge a second conclusion.
 *
 * @param {object} input - `{at, author, text}`.
 * @returns {string} markdown.
 */
export function renderConclusion({ at, author, text }) {
  const lines = String(text ?? '').split('\n')
  const first = lines[0].trim()
  const head = `- **${singleLine(stamp(at))}** · ${singleLine(author, 80) || '?'} · ${first}`
  const rest = lines
    .slice(1)
    .map((line) => `  ${line}`)
    .join('\n')
  return rest.length === 0 ? `${head}\n` : `${head}\n${rest}\n`
}

/** Is this message inside `[since, until]`? ISO-8601 UTC strings compare as text. */
export function inRange(row, since, until) {
  if (typeof since === 'string' && since.length > 0 && !(row.at > since)) return false
  if (typeof until === 'string' && until.length > 0 && !(row.at <= until)) return false
  return true
}

/**
 * A whole transcript as one markdown document.
 *
 * Deliberately NOT bounded in LINES: this is a file, not a tool result. The bound
 * belongs on the projection the model sees — which is why the tools return a path
 * and a count, never the transcript itself. Message bodies and the charter stay
 * multi-line on purpose; every FIELD around them (title, id, range, author) is
 * flattened, so data cannot add headings of its own.
 *
 * @param {object} input - `{group, messages, since, until, at}`.
 * @returns {string} markdown.
 */
export function renderTranscript({ group, messages, since, until, at }) {
  const rangeStart = singleLine(since, 60) || '(开头)'
  const rangeEnd = singleLine(until, 60) || '(最新)'
  const head = [
    `# ${singleLine(group.title, 120)} · 聊天记录导出`,
    '',
    `> 群 id：\`${singleLine(group.id, 80)}\``,
    `> 导出时间：${singleLine(stamp(at))}`,
    `> 时间范围：${rangeStart} → ${rangeEnd}`,
    `> 条数：${messages.length}`,
  ]
  const charter = typeof group.charter === 'string' ? group.charter.trim() : ''
  if (charter.length > 0) head.push('', '## 群规', '', charter)
  const body = []
  for (const row of messages) {
    const author = singleLine(row.fromName, 80) || '?'
    body.push('', `## #${singleLine(row.seq)} · ${singleLine(stamp(row.at))} · ${author}`, '', String(row.text ?? ''))
  }
  return `${[...head, ...body].join('\n')}\n`
}

/**
 * Sink one conclusion: append its bullet, creating the file and its header
 * together the first time.
 *
 * "First time" is decided by `openSync(..., 'wx')`, not by `existsSync`: two
 * processes concluding at once used to both see "no file yet" and both write the
 * header. Now exactly one of them creates it, and the other appends its bullet.
 *
 * @param {object} input - `{root, group, at, author, text}`.
 * @returns {{path: string, bytes: number, created: boolean}} what happened.
 */
export function sinkConclusion({ root, group, at, author, text }) {
  const file = conclusionFile(root, group)
  const bullet = renderConclusion({ at, author, text })
  mkdirSync(dirname(file), { recursive: true })
  try {
    const fd = openSync(file, 'wx')
    try {
      writeSync(fd, `${conclusionHeader(group)}${bullet}`)
    } finally {
      closeSync(fd)
    }
    return { path: file, bytes: sizeOf(file), created: true }
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
  }
  // The file is already there: the header is already in it, so only the bullet
  // is appended. (A delete landing in this window would leave a headerless file;
  // that needs an outside writer removing the file mid-call — unverified here.)
  appendText(file, bullet)
  return { path: file, bytes: sizeOf(file), created: false }
}

/**
 * Write a transcript export. Never overwrites an existing file.
 *
 * The name is not chosen and then written: the file is created with `O_EXCL` at
 * the first free candidate name, then filled. That is what makes the promise hold
 * between two processes rather than only within one.
 *
 * @param {object} input - `{root, group, messages, since, until, at, path}`.
 * @returns {{path: string, bytes: number, messages: number}} what happened.
 */
export function sinkTranscript({ root, group, messages, since, until, at, path }) {
  const wanted =
    typeof path === 'string' && path.trim().length > 0
      ? isAbsolute(path.trim())
        ? path.trim()
        : join(groupSinkDir(root, group), path.trim())
      : join(groupSinkDir(root, group), `${group.id}-${at.replace(/[:.]/gu, '-')}.md`)
  const text = renderTranscript({ group, messages, since, until, at })
  const { fd, path: file } = createExclusive(wanted)
  try {
    writeSync(fd, text)
  } finally {
    closeSync(fd)
  }
  return { path: file, bytes: sizeOf(file), messages: messages.length }
}

/** Every file a group has sunk, for the panel's own display. */
export function listSunk(root, group) {
  const dir = groupSinkDir(root, group)
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith('.md'))
      .sort()
  } catch {
    return []
  }
}
