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
 * The text is bounded. A digest is a tool result, and a tool result is replayed
 * into every later request of the session that asked for it (c4), so the caller
 * is told how many messages were left out instead of being handed all of them.
 *
 * @module dsh-attention-group/digest
 */

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
 * @param {object} input - `{group, messages, since, until, now, limit}`.
 *   `messages` is already filtered to the range by the caller.
 * @returns {object} `{text, total, shown, omitted, authors, conclusions, from, to}`.
 */
export function buildDigest({ group, messages, since, until, now, limit } = {}) {
  const at = now === undefined ? new Date() : now
  const cap = typeof limit === 'number' && limit > 0 ? Math.floor(limit) : 50
  const shown = messages.slice(-cap)
  const omitted = messages.length - shown.length

  const counts = new Map()
  for (const row of messages) {
    const name = typeof row.fromName === 'string' && row.fromName.length > 0 ? row.fromName : '?'
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  const authors = [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))

  const conclusions = messages
    .filter((row) => row.kind === 'conclusion')
    .map((row) => ({ at: row.at, author: row.fromName ?? '?', text: row.text ?? '' }))

  const from = messages.length === 0 ? '' : messages[0].at
  const to = messages.length === 0 ? '' : messages[messages.length - 1].at

  const lines = [
    `群：${group.title ?? group.id}（\`${group.id}\`）`,
    `范围：${since.length > 0 ? since : '(开头)'} → ${until.length > 0 ? until : '(最新)'}`,
    `条数：${messages.length}${omitted > 0 ? `（下面只列出最新 ${shown.length} 条，省略 ${omitted} 条）` : ''}`,
  ]
  if (messages.length > 0) lines.push(`时间：${clock(from)} → ${clock(to)}`)
  if (typeof group.charter === 'string' && group.charter.trim().length > 0) {
    lines.push(`群规：${group.charter.trim().replace(/\s+/gu, ' ').slice(0, 120)}`)
  }

  if (authors.length > 0) {
    lines.push('', '发言人：')
    for (const author of authors) lines.push(`- ${author.name}：${author.count} 条`)
  }

  if (conclusions.length > 0) {
    lines.push('', `已沉淀的结论（${conclusions.length} 条）：`)
    for (const row of conclusions) {
      lines.push(`- [${clock(row.at)}] ${row.author}：${String(row.text).replace(/\s+/gu, ' ').slice(0, 160)}`)
    }
  }

  lines.push('', '记录：')
  if (shown.length === 0) {
    lines.push('（这段时间没有消息）')
  } else {
    for (const row of shown) {
      const text = String(row.text ?? '').replace(/\n+/gu, ' ⏎ ')
      const mark = row.kind === 'conclusion' ? '[结论] ' : ''
      lines.push(`#${row.seq} ${clock(row.at)} ${row.fromName ?? '?'}：${mark}${text}`)
    }
  }

  return {
    text: lines.join('\n'),
    total: messages.length,
    shown: shown.length,
    omitted,
    authors,
    conclusions,
    from,
    to,
  }
}
