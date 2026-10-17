/**
 * The attention router: decide who a message is worth waking.
 *
 * This is the whole point of the plugin. Every existing multi-agent chat spends
 * its budget at delivery time — wake everyone, then let each member discover the
 * message was not for them. Routing moves that decision *before* the wake, so an
 * irrelevant message costs zero turns instead of N.
 *
 * The router is deliberately a pure function over (group, message, members):
 * no clock, no I/O, no model. That keeps it testable, makes "zero wake" a
 * property you can assert rather than hope for, and leaves the optional
 * model-based classifier as a separate, swappable stage.
 *
 * @module dsh-attention-group/router
 */

// `singleLine` lives in sink.js because flattening "a value into one line of
// text" is one job and deserves one implementation (digest.js uses it too).
// `sink.js` imports only node builtins, so this adds no cycle.
import { singleLine } from './sink.js'

/** Wake reasons, strongest first. */
export const REASON = {
  /** The message names this member. */
  mention: 'mention',
  /** A subscription keyword in the member's list appears in the text. */
  keyword: 'keyword',
  /** No rule matched, but the group is configured to wake everyone anyway. */
  broadcast: 'broadcast',
  // NOTE: there used to be an `admin: 'admin'` reason here, documented as "no rule
  // matched, but this member is the group's built-in administrator". Nothing ever
  // produced it — an admin is woken by `mention`, by a keyword, or by `summary`,
  // never by an admin-specific rule, because the router has no such rule. A dead
  // enum is worse than no enum: it reads as a capability. Found by adversarial
  // audit B-13 (2026-10-16).
  /**
   * R9: this member was explicitly asked to summarise a time range. Not produced
   * by the router — it is a direct assignment, so it bypasses relevance matching
   * while still respecting the room's wake switch.
   */
  summary: 'summary',
}

/** Group routing modes, in increasing cost. */
export const ROUTE_MODE = {
  /** Rules only. No match means nobody is woken. This is the default. */
  rules: 'rules',
  /** Rules, then a cheap model classifies the grey zone. Off unless enabled. */
  classify: 'classify',
  /** Rules, then fall back to waking every member. The old group-chat behaviour. */
  broadcast: 'broadcast',
}

/**
 * Extract `@name` tokens from message text.
 *
 * A name must sit on its own: the character before `@` must not be a letter,
 * digit, underscore or `@`, and the character after the name must not be a
 * letter, digit, underscore or `-`. That is what keeps `foo@bar` (an address)
 * from reading as a mention, and `@room-admin` from also registering `room`.
 *
 * ⚠️ The boundaries are written with Unicode property escapes, NOT `\w`.
 * `\w` is `[A-Za-z0-9_]`, so for a room holding both `小明` and `小明明` the
 * pattern `@小明(?![\w-])` matched `@小明明` — the trailing `明` is not a `\w`
 * character, so the lookahead was satisfied. Measured 2026-10-16 with two live
 * sessions: **both were woken by a message that named only one of them**, which
 * breaks this plugin's entire reason to exist. `\p{L}` counts CJK characters as
 * letters, so the same message now reaches exactly the person named.
 *
 * @param {string} text - message text.
 * @param {string[]} names - candidate member names, any order.
 * @returns {string[]} the mentioned names, each once, in the order they appear.
 */
export function extractMentions(text, names) {
  if (typeof text !== 'string' || text.length === 0) return []
  const ordered = [...names].sort((a, b) => b.length - a.length)
  const found = []
  for (const name of ordered) {
    if (typeof name !== 'string' || name.length === 0) continue
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    // `\p{L}`/`\p{N}` need the `u` flag; `_` is listed separately because it is
    // a word character that is neither a letter nor a number.
    const pattern = new RegExp(`(^|[^\\p{L}\\p{N}_@])@${escaped}(?![\\p{L}\\p{N}_-])`, 'u')
    if (pattern.test(text) && !found.includes(name)) found.push(name)
  }
  return found
}

/**
 * Whether a member's subscription matches the message text.
 *
 * Matching is case-insensitive substring for plain terms. A term may also be
 * written `/regex/flags` to opt into a pattern, which is parsed defensively: a
 * malformed pattern is treated as a literal string rather than throwing inside a
 * delivery path.
 *
 * @param {string[]} keywords - the member's subscription terms.
 * @param {string} text - message text.
 * @returns {string|undefined} the term that matched, if any.
 */
export function matchKeywords(keywords, text) {
  if (!Array.isArray(keywords) || typeof text !== 'string' || text.length === 0) return undefined
  const haystack = text.toLowerCase()
  for (const raw of keywords) {
    if (typeof raw !== 'string' || raw.length === 0) continue
    const regexForm = /^\/(.+)\/([a-z]*)$/u.exec(raw)
    if (regexForm !== null) {
      try {
        if (new RegExp(regexForm[1], regexForm[2].replace('g', '')).test(text)) return raw
        // A compiling pattern that simply did not match is a real answer.
        continue
      } catch {
        // Not a compilable pattern: fall through to the literal test rather
        // than dropping the term. A subscription the user typed must never be
        // silently inert.
      }
    }
    if (haystack.includes(raw.toLowerCase())) return raw
  }
  return undefined
}

/**
 * Choose the members one message should wake.
 *
 * @param {object} input - routing input.
 * @param {object} input.group - group record (`members`, `routeMode`).
 * @param {object} input.message - `{ fromName, text, mentions }`.
 * @param {string} [input.excludeMemberId] - the sender, never woken by its own message.
 * @returns {{ recipients: {memberId: string, name: string, reason: string, detail?: string}[], silent: boolean, mode: string }}
 */
export function route(input) {
  const group = input.group ?? {}
  const members = Array.isArray(group.members) ? group.members : []
  const mode = typeof group.routeMode === 'string' ? group.routeMode : ROUTE_MODE.rules
  const text = typeof input.message?.text === 'string' ? input.message.text : ''
  const exclude = input.excludeMemberId

  const eligible = members.filter((member) => member?.id !== exclude)
  const mentioned = new Set(
    Array.isArray(input.message?.mentions) && input.message.mentions.length > 0
      ? input.message.mentions
      : extractMentions(text, eligible.map((member) => member.name).filter(Boolean)),
  )

  const recipients = []
  const matched = new Set()

  for (const member of eligible) {
    if (mentioned.has(member.name)) {
      recipients.push({ memberId: member.id, name: member.name, reason: REASON.mention })
      matched.add(member.id)
    }
  }

  for (const member of eligible) {
    if (matched.has(member.id)) continue
    const hit = matchKeywords(member.subscribe, text)
    if (hit !== undefined) {
      recipients.push({ memberId: member.id, name: member.name, reason: REASON.keyword, detail: hit })
      matched.add(member.id)
    }
  }

  if (mode === ROUTE_MODE.broadcast) {
    for (const member of eligible) {
      if (matched.has(member.id)) continue
      recipients.push({ memberId: member.id, name: member.name, reason: REASON.broadcast })
      matched.add(member.id)
    }
  }

  if (mode === ROUTE_MODE.classify) {
    // The classifier is the one stage that costs a model call, and the router
    // stays pure: it reports the grey zone instead of deciding it. Waking the
    // grey zone here would silently turn `classify` into `broadcast`, which is
    // the exact behaviour this plugin exists to avoid.
    const grey = eligible
      .filter((member) => !matched.has(member.id))
      .map((member) => ({ memberId: member.id, name: member.name }))
    return { recipients, silent: recipients.length === 0, mode, greyZone: grey }
  }

  return { recipients, silent: recipients.length === 0, mode }
}

/**
 * Build the message a woken member actually receives.
 *
 * The member is told three things it cannot infer: that this came from a group
 * rather than its human, that replying is optional, and how to keep a
 * not-relevant reply cheap. Without the last part, "decide if you care" costs
 * the same as "answer" — the instruction must name the one-line exit.
 *
 * @param {object} input - render input.
 * @param {object} input.group - group record.
 * @param {object} input.message - message record.
 * @param {string} input.reason - why this member was woken.
 * @param {string} [input.detail] - route detail (matched keyword, etc).
 * @param {number} [input.unread] - messages since this member last read the group.
 * @param {boolean} [input.selfReflect] - include the minimal-reply instruction.
 * @returns {string} the delivered text.
 */
export function renderWakeMessage(input) {
  const { group, message, reason } = input
  const lines = []
  const why =
    reason === REASON.mention
      ? '你是被 @ 点名的'
      : reason === REASON.keyword
        ? `命中你的订阅词 ${JSON.stringify(singleLine(input.detail))}`
        : reason === REASON.broadcast
          ? '本群配置为全量唤醒'
          : '路由把它判给了你'
  // ⚠️ This line is a MESSAGE SENT TO ANOTHER AGENT, which makes a forged line
  // here worse than a forged line in a tool result: a room title or a member
  // name containing a newline could append what reads as an instruction from the
  // plugin. Fields are flattened; `message.text` below is NOT, because a
  // multi-line message body is the message. Adversarial audit B-11's family.
  lines.push(
    `[群聊·${singleLine(group.title ?? group.id, 80)}] "${singleLine(message.fromName, 80)}" 发了一条消息（${why}）：`,
  )
  if (typeof input.unread === 'number' && input.unread > 1) {
    lines.push(`（你上次查看后有 ${input.unread} 条新消息，这里是触发你的那条；完整历史用 attention_history 读。）`)
  }

  // ⚠️ THE CHARTER WAS NEVER ACTUALLY SENT.
  //
  // `attention_group_create`'s own description promises "Room charter shown to
  // every member when it is woken". The panel let you edit it. The ledger stored
  // it. And this function — the ONLY thing that actually speaks to a woken member
  // — never read it. So the one piece of text that tells an agent what the room is
  // FOR and how to behave never reached the agent it was written for. Reported by
  // the user on 2026-10-17: "each AI entering should know what this group is for".
  //
  // NOT flattened: paragraph breaks are part of what a purpose statement says, and
  // a charter read as one run-on line loses the point. It IS length-capped, since
  // it is replayed to a model on every wake.
  const charter = typeof group.charter === 'string' ? group.charter.trim() : ''
  if (charter.length > 0) {
    const MAX_CHARTER = 2000
    lines.push('')
    lines.push('【这个群是干什么的 / 群规】')
    lines.push(charter.length > MAX_CHARTER ? `${charter.slice(0, MAX_CHARTER)} …（群规过长，此处截断）` : charter)
  }

  lines.push('')
  lines.push(message.text)
  lines.push('')
  if (input.selfReflect !== false) {
    lines.push('请先判断这条消息是否需要你发言：')
    lines.push('- 不需要 → 只回一行「与我无关」并立刻结束，不要展开、不要调用工具。')
    lines.push('- 需要 → 正常回答。你的回复会进入群聊记录，其他成员也能看到。')
  }
  return lines.join('\n')
}
