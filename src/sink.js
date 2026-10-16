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
 * A path that does not exist yet.
 *
 * An export must never overwrite what is already there: the destination is a
 * file the human chose, and silently destroying it would be the worst possible
 * behaviour for a feature whose whole purpose is not losing things.
 *
 * @param {string} file - desired path.
 * @returns {string} the desired path, or the first free `-N` variant.
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
    `# ${group.title} · 结论沉淀`,
    '',
    `> 群 id：\`${group.id}\``,
    '> 由 dsh-attention-group 追加写入：每条结论一段，只增不改。',
    '> 这个文件不依赖任何插件，删掉插件它还在。',
    '',
  ].join('\n')
}

/**
 * One conclusion as a markdown list item.
 *
 * Continuation lines are indented so a multi-line conclusion stays one item.
 *
 * @param {object} input - `{at, author, text}`.
 * @returns {string} markdown.
 */
export function renderConclusion({ at, author, text }) {
  const lines = String(text ?? '').split('\n')
  const first = lines[0].trim()
  const head = `- **${stamp(at)}** · ${author} · ${first}`
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
 * Deliberately NOT bounded: this is a file, not a tool result. The bound belongs
 * on the projection the model sees — which is why the tools return a path and a
 * count, never the transcript itself.
 *
 * @param {object} input - `{group, messages, since, until, at}`.
 * @returns {string} markdown.
 */
export function renderTranscript({ group, messages, since, until, at }) {
  const head = [
    `# ${group.title} · 聊天记录导出`,
    '',
    `> 群 id：\`${group.id}\``,
    `> 导出时间：${stamp(at)}`,
    `> 时间范围：${typeof since === 'string' && since.length > 0 ? since : '(开头)'} → ${typeof until === 'string' && until.length > 0 ? until : '(最新)'}`,
    `> 条数：${messages.length}`,
  ]
  const charter = typeof group.charter === 'string' ? group.charter.trim() : ''
  if (charter.length > 0) head.push('', '## 群规', '', charter)
  const body = []
  for (const row of messages) {
    body.push('', `## #${row.seq} · ${stamp(row.at)} · ${row.fromName ?? '?'}`, '', String(row.text ?? ''))
  }
  return `${[...head, ...body].join('\n')}\n`
}

/**
 * Sink one conclusion: append its bullet, creating the file and its header
 * together the first time.
 *
 * @param {object} input - `{root, group, at, author, text}`.
 * @returns {{path: string, bytes: number, created: boolean}} what happened.
 */
export function sinkConclusion({ root, group, at, author, text }) {
  const file = conclusionFile(root, group)
  const created = !existsSync(file)
  const chunk = `${created ? conclusionHeader(group) : ''}${renderConclusion({ at, author, text })}`
  appendText(file, chunk)
  return { path: file, bytes: sizeOf(file), created }
}

/**
 * Write a transcript export. Never overwrites an existing file.
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
  const file = freePath(wanted)
  const text = renderTranscript({ group, messages, since, until, at })
  mkdirSync(dirname(file), { recursive: true })
  const fd = openSync(file, 'w')
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
