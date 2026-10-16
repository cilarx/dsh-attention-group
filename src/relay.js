/**
 * R10 — liaisons between rooms.
 *
 * A liaison is a DIRECTED link: "when something happens in this room, carry it
 * into that room". It lives on the sending room (`group.links`), so the direction
 * is not a convention anyone has to remember.
 *
 * THE WHOLE DESIGN PROBLEM IS LOOPS. Two rooms that both relay everything to
 * each other produce an infinite echo — the exact opposite of what this plugin
 * exists for. So a forwarded message carries its own history:
 *
 *     relay: { fromGroup, fromSeq, linkId, trail: ['A', 'B'], hops: 2 }
 *
 * `trail` is every room the message has already passed through, and a link
 * refuses to carry a message into a room that is already in it. That single rule
 * kills A→B→A, and `maxHops` kills the long way round (A→B→C→D→…). Both are
 * checked HERE, in a pure function, so "can this loop?" is answerable by a unit
 * test instead of by watching two rooms for an afternoon.
 *
 * The default mode is `conclusion`, not `all`. A liaison that carries every
 * message is a firehose; a liaison that carries decisions is the feature. `all`
 * is available, and available loudly.
 *
 * @module dsh-attention-group/relay
 */

import { matchKeywords, ROUTE_MODE } from './router.js'

/** What a link is willing to carry. In increasing noise. */
export const RELAY_MODE = {
  /** Only messages explicitly sunk as conclusions (R7). The default. */
  conclusion: 'conclusion',
  /** Only messages whose text matches one of the link's keywords. */
  keyword: 'keyword',
  /** Only messages that @-mention one of the names in the link's watch list. */
  mention: 'mention',
  /** Everything. A firehose; use deliberately. */
  all: 'all',
}

/** How many rooms a message may pass through before links stop carrying it. */
export const DEFAULT_MAX_HOPS = 3

/** Every mode the panel is allowed to offer. */
export const RELAY_MODES = [
  { value: RELAY_MODE.conclusion, label: '只传结论', hint: '只有被明确沉淀为「结论」的消息才转发。默认，最安静。' },
  { value: RELAY_MODE.keyword, label: '按关键词', hint: '正文命中下面任一关键词才转发。支持 /正则/ 写法。' },
  { value: RELAY_MODE.mention, label: '按点名', hint: '消息 @ 了下面名单里的人（且本群有这个人）才转发。' },
  { value: RELAY_MODE.all, label: '全部转发', hint: '这个群每说一句都转发过去。会产生大量唤醒，慎用。' },
]

/**
 * A fresh link.
 *
 * @param {object} input - `{to, mode, keywords, enabled, wake, maxHops, note}`.
 * @returns {object} link record.
 */
export function newLink(input = {}) {
  const to = String(input.to ?? '').trim()
  return {
    id: `link-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    to,
    mode: typeof input.mode === 'string' && input.mode.length > 0 ? input.mode : RELAY_MODE.conclusion,
    keywords: Array.isArray(input.keywords) ? input.keywords.filter((term) => typeof term === 'string' && term.trim().length > 0) : [],
    // Forwarding is a second, independent decision from speaking: a link carries
    // the message either way, and only wakes the target's members if told to.
    wake: input.wake === true,
    enabled: input.enabled !== false,
    maxHops: typeof input.maxHops === 'number' && input.maxHops > 0 ? Math.floor(input.maxHops) : DEFAULT_MAX_HOPS,
    createdAt: new Date().toISOString(),
    ...(typeof input.note === 'string' && input.note.trim().length > 0 ? { note: input.note.trim() } : {}),
  }
}

/** Rooms a message has already been through, oldest first. */
export function trailOf(record) {
  const relay = record?.relay
  return relay !== undefined && Array.isArray(relay.trail) ? relay.trail.filter((id) => typeof id === 'string') : []
}

/**
 * Should this link carry this message into `targetId`?
 *
 * Pure, total, and it always explains itself: every refusal names the guard that
 * refused. "Nothing was forwarded" with no reason is how an afternoon gets spent
 * on the wrong problem (c7 ②).
 *
 * @param {object} input - `{link, from, record, targetId, targetMemberNames}`.
 * @returns {{relay: boolean, reason: string}} the verdict.
 */
export function shouldRelay({ link, from, record, targetId, targetMemberNames } = {}) {
  if (link === undefined || link === null) return { relay: false, reason: 'no such link' }
  if (link.enabled === false) return { relay: false, reason: 'the link is switched off' }
  if (targetId === undefined || targetId === from?.id) return { relay: false, reason: 'a room cannot relay to itself' }

  // Loop guard 1: the target has already seen this message.
  const trail = trailOf(record)
  if (trail.includes(targetId)) return { relay: false, reason: `loop refused: ${targetId} is already in the trail (${trail.join(' → ')})` }

  // Loop guard 2: it came from the target.
  if (record?.relay?.fromGroup === targetId) return { relay: false, reason: `loop refused: this message came from ${targetId}` }

  // Loop guard 3: it has travelled far enough.
  const maxHops = typeof link.maxHops === 'number' && link.maxHops > 0 ? link.maxHops : DEFAULT_MAX_HOPS
  if (trail.length >= maxHops) return { relay: false, reason: `hop limit reached (${trail.length} >= ${maxHops})` }

  const mode = typeof link.mode === 'string' ? link.mode : RELAY_MODE.conclusion
  if (mode === RELAY_MODE.all) return { relay: true, reason: 'mode=全部转发' }

  if (mode === RELAY_MODE.conclusion) {
    return record?.kind === 'conclusion'
      ? { relay: true, reason: 'it is a conclusion' }
      : { relay: false, reason: 'not a conclusion (mode=只传结论)' }
  }

  if (mode === RELAY_MODE.mention) {
    const watch = Array.isArray(link.keywords) ? link.keywords : []
    if (watch.length === 0) return { relay: false, reason: 'mode=按点名 but no names are watched' }
    const names = Array.isArray(targetMemberNames) ? targetMemberNames : []
    const mentioned = (Array.isArray(record?.mentions) ? record.mentions : []).filter((name) => watch.includes(name))
    if (mentioned.length === 0) return { relay: false, reason: `nobody on the watch list was mentioned (${watch.join(', ')})` }
    // A mention of someone who is not in the target room would arrive as a name
    // nobody there answers to; say so rather than forwarding a dead mention.
    const present = mentioned.filter((name) => names.includes(name))
    if (present.length === 0) {
      return { relay: false, reason: `mentioned ${mentioned.join(', ')}, but the target room has nobody by that name` }
    }
    return { relay: true, reason: `it mentions ${present.join(', ')}` }
  }

  if (mode === RELAY_MODE.keyword) {
    const terms = Array.isArray(link.keywords) ? link.keywords : []
    if (terms.length === 0) return { relay: false, reason: 'mode=按关键词 but no keywords are set' }
    // `matchKeywords` returns the single term that matched, or undefined — not a
    // list. Reading it as a list threw inside a delivery path the first time this
    // ran, which is exactly why it is being read from the source and not guessed.
    const hit = matchKeywords(terms, String(record?.text ?? ''))
    return hit !== undefined
      ? { relay: true, reason: `it matched ${hit}` }
      : { relay: false, reason: 'no keyword matched' }
  }

  return { relay: false, reason: `unknown mode "${mode}"` }
}

/**
 * The record a forwarded message becomes in the target room.
 *
 * It keeps its own provenance: which room it came from, which message it was, and
 * the trail so far. That provenance is what makes the loop guards work — and it
 * is also what lets a reader in the target room see that this is a relay rather
 * than something a member said.
 *
 * @param {object} input - `{link, fromGroup, record, at, seq, mentions, reason}`.
 * @returns {object} message record for the target room.
 */
export function relayRecord({ link, fromGroup, record, at, seq, mentions, reason }) {
  const trail = [...trailOf(record), fromGroup.id]
  return {
    seq,
    at,
    fromId: `liaison:${link.id}`,
    fromName: `沟通员·${fromGroup.title ?? fromGroup.id}`,
    text: record.text,
    // CARRY THE ORIGIN'S KIND FORWARD. A relayed conclusion is still a
    // conclusion: `kind` answers "what is this", and `relay` answers "where did
    // it come from". Setting `kind: 'relay'` here would break every chain at the
    // first hop, because the next room's `mode=只传结论` link would look at a
    // relayed decision and see something that is not a conclusion.
    kind: typeof record.kind === 'string' && record.kind.length > 0 ? record.kind : 'relay',
    mentions: Array.isArray(mentions) ? mentions : [],
    relay: {
      fromGroup: fromGroup.id,
      fromSeq: record.seq,
      linkId: link.id,
      reason: reason ?? '',
      trail,
      hops: trail.length,
    },
  }
}

/** How a relay shows up in the target room's transcript. */
export function describeRelay(record) {
  const relay = record?.relay
  if (relay === undefined) return ''
  return `来自「${relay.fromGroup}」#${relay.fromSeq}（经过 ${(relay.trail ?? []).join(' → ')}）`
}

/** A room's own view of whether its links can run at all. */
export function linkSummary(group) {
  const links = Array.isArray(group?.links) ? group.links : []
  return {
    total: links.length,
    enabled: links.filter((link) => link.enabled !== false).length,
    routes: links.map((link) => ({
      id: link.id,
      to: link.to,
      mode: link.mode ?? RELAY_MODE.conclusion,
      enabled: link.enabled !== false,
      wake: link.wake === true,
      keywords: link.keywords ?? [],
      maxHops: link.maxHops ?? DEFAULT_MAX_HOPS,
    })),
  }
}

/** The routing mode a relayed message uses in its target — rules only, always. */
export const RELAY_TARGET_ROUTE = ROUTE_MODE.rules
