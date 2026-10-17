/**
 * R9 — "summarise what this room talked about today".
 *
 * Two halves, deliberately separate:
 *
 *  1. A DIGEST is built here, with no model involved. It is counts, a range, who
 *     spoke how often, which conclusions were sunk, and the messages themselves.
 *     That alone answers "总结一下今天这个群里都交流了什么" for a human at zero
 *     cost — and it is what the panel shows.
 *  2. The digest can be HANDED to a member (normally the room's own admin) and
 *     that member writes the prose. That path costs exactly one wake-up, and it
 *     goes through the same gate as every other wake-up in this plugin.
 *
 * Why the digest is built here rather than let the woken member read history
 * itself: attention is the resource this plugin exists to spend carefully, and
 * making a woken session call `attention_history` first spends a second turn
 * reading what the sender could have summarised for free.
 *
 * The text is bounded as a WHOLE. A digest is a tool result, and a tool result is
 * replayed into every later request of the session that asked for it (c4), so the
 * cost compounds: "one line per message" only bounds the size if every OTHER line
 * is bounded too. The speaker list was not, and 300 speakers turned one digest
 * into 488 lines (measured 2026-10-16). So the document is assembled against
 * `MAX_DIGEST_LINES`, and whatever is left out is COUNTED OUT LOUD — a projection
 * that silently drops lines reads as "that is all there was".
 *
 * @module dsh-attention-group/digest
 */

import { singleLine } from './sink.js'

/**
 * Hard cap on a digest's own line count.
 *
 * The caller's `limit` bounds the MESSAGES; this bounds the DOCUMENT, which is
 * what actually reaches the model. Kept equal to the plugin's render budget so a
 * digest can never be the tool result that blows it.
 */
export const MAX_DIGEST_LINES = 200

/** Local midnight → next local midnight, as ISO instants. */
export function localDayRange(now = new Date()) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0)
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0)
  return { since: start.toISOString(), until: end.toISOString() }
}

/** The previous 24 hours, as ISO instants. */
export function lastDayRange(now = new Date()) {
  return { since: new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(), until: '' }
}

/**
 * Turn a convenience `range` word, or explicit instants, into a real range.
 *
 * `range` exists because the request that started this requirement was phrased
 * as a word — "总结一下今天这个群里都交流了什么" — and a word should not need a
 * timestamp to work. Explicit `since`/`until` always win over the word.
 *
 * @param {object} input - `{range, since, until, now}`.
 * @returns {{since: string, until: string}} ISO instants; `''` means unbounded.
 */
export function resolveRange({ range, since, until, now } = {}) {
  const at = now === undefined ? new Date() : now
  const explicitSince = typeof since === 'string' ? since : ''
  const explicitUntil = typeof until === 'string' ? until : ''
  if (explicitSince.length > 0 || explicitUntil.length > 0) return { since: explicitSince, until: explicitUntil }
  if (range === 'today') return localDayRange(at)
  if (range === '24h') return lastDayRange(at)
  return { since: '', until: '' }
}

/** A short local timestamp for the digest's own lines. */
function clock(iso) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const pad = (value) => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * Build the digest.
 *
 * Every line is either produced by this function or flattened from data by
 * `singleLine`, so a member name cannot add lines of its own; and the finished
 * document is fitted to `MAX_DIGEST_LINES`, with every omission stated.
 *
 * @param {object} input - `{group, messages, since, until, now, limit}`.
 *   `messages` is already filtered to the range by the caller.
 * @returns {object} `{text, total, shown, omitted, authors, conclusions, from, to}`.
 */
export function buildDigest({ group, messages, since, until, now, limit } = {}) {
  const at = now === undefined ? new Date() : now
  const cap = typeof limit === 'number' && limit > 0 ? Math.floor(limit) : 50
  const wanted = messages.slice(-cap)

  const counts = new Map()
  for (const row of messages) {
    const name = singleLine(row.fromName) || '?'
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  const authors = [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))

  const conclusions = messages
    .filter((row) => row.kind === 'conclusion')
    .map((row) => ({ at: row.at, author: singleLine(row.fromName) || '?', text: String(row.text ?? '') }))

  const from = messages.length === 0 ? '' : messages[0].at
  const to = messages.length === 0 ? '' : messages[messages.length - 1].at

  const speakerLines = authors.map((author) => `- ${author.name}：${author.count} 条`)
  const conclusionLines = conclusions.map(
    (row) => `- [${singleLine(clock(row.at))}] ${singleLine(row.author, 60)}：${singleLine(row.text, 160)}`,
  )
  // One message is one line. A body may be several lines, so newlines become the
  // visible `⏎` marker — but a bare CR must not survive as a break of its own.
  const recordLines = wanted.map((row) => {
    const text = String(row.text ?? '').replace(/\r\n?/gu, '\n').replace(/\n+/gu, ' ⏎ ')
    const mark = row.kind === 'conclusion' ? '[结论] ' : ''
    const seq = singleLine(row.seq) || '?'
    const speaker = singleLine(row.fromName, 80) || '?'
    return `#${seq} ${singleLine(clock(row.at))} ${speaker}：${mark}${text}`
  })

  const charter = singleLine(group.charter, 120)

  /** The whole document for one trimming state; the header reports that state. */
  const assemble = (dropped) => {
    const keptRecords = recordLines.length - dropped.records
    const omittedMessages = messages.length - keptRecords
    const lines = [
      `群：${singleLine(group.title ?? group.id, 120)}（\`${singleLine(group.id, 80)}\`）`,
      `范围：${singleLine(since, 60) || '(开头)'} → ${singleLine(until, 60) || '(最新)'}`,
      `条数：${messages.length}${omittedMessages > 0 ? `（下面只列出最新 ${keptRecords} 条，省略 ${omittedMessages} 条）` : ''}`,
    ]
    if (messages.length > 0) lines.push(`时间：${singleLine(clock(from))} → ${singleLine(clock(to))}`)
    if (charter.length > 0) lines.push(`群规：${charter}`)

    if (speakerLines.length > 0) {
      const keptSpeakers = speakerLines.length - dropped.speakers
      lines.push('', '发言人：', ...speakerLines.slice(0, keptSpeakers))
      if (dropped.speakers > 0) lines.push(`- （省略 ${dropped.speakers} 位发言人）`)
    }

    if (conclusionLines.length > 0) {
      const keptConclusions = conclusionLines.length - dropped.conclusions
      lines.push('', `已沉淀的结论（${conclusions.length} 条）：`, ...conclusionLines.slice(0, keptConclusions))
      if (dropped.conclusions > 0) lines.push(`- （省略 ${dropped.conclusions} 条结论，记录里仍标着 [结论]）`)
    }

    lines.push('', '记录：')
    if (recordLines.length === 0) {
      lines.push('（这段时间没有消息）')
    } else {
      lines.push(...recordLines.slice(dropped.records))
      if (dropped.records > 0) lines.push(`（省略 ${dropped.records} 条记录；完整记录用 attention_history 读）`)
    }
    return lines
  }

  // Fit the document, degrading in the order a reader can most easily live
  // without: the conclusions list first (every entry is also a record marked
  // [结论]), then the speaker histogram, and only then the records the caller
  // actually asked for. Each step drops enough content lines to also pay for the
  // omission notice it is about to add, so this converges in a pass or two.
  const dropped = { speakers: 0, conclusions: 0, records: 0 }
  let lines = assemble(dropped)
  for (let pass = 0; pass < 6 && lines.length > MAX_DIGEST_LINES; pass += 1) {
    const excess = lines.length - MAX_DIGEST_LINES
    if (conclusionLines.length - dropped.conclusions > 1) {
      dropped.conclusions = Math.min(conclusionLines.length - 1, dropped.conclusions + excess + 1)
    } else if (speakerLines.length - dropped.speakers > 1) {
      dropped.speakers = Math.min(speakerLines.length - 1, dropped.speakers + excess + 1)
    } else if (recordLines.length - dropped.records > 1) {
      dropped.records = Math.min(recordLines.length - 1, dropped.records + excess + 1)
    } else {
      break
    }
    lines = assemble(dropped)
  }

  const shown = recordLines.length - dropped.records
  return {
    text: lines.join('\n'),
    total: messages.length,
    shown,
    omitted: messages.length - shown,
    authors,
    conclusions,
    from,
    to,
  }
}
