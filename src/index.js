/**
 * dsh-attention-group — a multi-agent group chat for DSH that decides who is
 * worth waking.
 *
 * This module is the host half. It owns:
 *   - the room ledger (groups, members, charters, per-member focus settings)
 *   - the durable message log (JSONL, one file per group)
 *   - the attention router that decides who a message is worth waking
 *   - delivery (`agent.followup` for live sessions, cold resume for stored ones)
 *
 * Safety posture: creating a room, joining members, reading history and posting
 * a message never wake anybody. Posting returns the routing plan; waking is a
 * second, explicit step that also requires the room to have it enabled. A group
 * chat that can silently start N turns in N sessions is a footgun, so no path
 * here wakes a session unless the caller asked for exactly that.
 *
 * @module dsh-attention-group
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { readLedger, writeLedger, appendMessage, readMessages, readMessagesWithStatus, resolveDataRoot, appendDelivery, readDeliveries, transcriptGroupIds } from './store.js'
import { ROUTE_MODE, REASON, route, extractMentions, hasMentionAll } from './router.js'
import { renderWakeMessage } from './router.js'
import {
  sinkConclusion,
  sinkTranscript,
  conclusionFile,
  groupSinkDir,
  countBullets,
  sizeOf,
  listSunk,
  inRange,
  singleLine,
} from './sink.js'
import { buildDigest, resolveRange } from './digest.js'
import { RELAY_MODES, RELAY_MODE, newLink, shouldRelay, relayRecord, linkSummary } from './relay.js'

/** Cordis plugin name. Must match the bundle row id. */
const name = 'attention-group'

/**
 * Services this plugin reads. Cordis refuses an undeclared service read — it
 * throws `cannot get property "x" without inject` — and a declared-but-absent
 * service blocks the whole plugin from activating, so only hard requirements
 * are listed. Optional capabilities are probed through `ctx.get()`.
 */
/**
 * U5's shape: which services are HARD requirements and which are probed.
 *
 * `agents` and `tools` are hard. Everything else is optional and probed, so a
 * deployment that lacks one loses exactly that capability rather than going
 * PENDING and disappearing. Measured 2026-10-16 by another agent against the
 * runtime sources: a missing hard dependency makes Cordis park the whole row in
 * PENDING (`fiber.ts:611-623 _refresh` → `_setEpoch(INACTIVE)` → `_unload`), and
 * it activates later if the service appears — so a hard dependency is a silent
 * "plugin does nothing", never a visible error. `dsh-base` and `dsh-sdk-minimal`
 * both provide `agents` and `tools`; only `dsh-web-app` provides `webServer`,
 * `agentPresets` and `sessionController`.
 */
const inject = ['agents', 'tools']

const VERSION = '0.1.0'

/**
 * Wrap human-readable lines as typed content blocks.
 *
 * This is not cosmetic. `@deepseek-ai/dsh-tools` treats a tool's `render` return
 * value as the durable tool-result CONTENT, verbatim:
 *
 *     rendered = tool.output.render(exec.arguments, value)
 *     const content = snapshotProjection(tool.name, 'render', rendered)
 *     return this.materializeFinalResult({ ..., content, ... })
 *
 * A bare string in that array has no `.type`, so the model serializer
 * (`@deepseek-ai/dsh-llm-deepseek`) throws
 * `UNSUPPORTED_CONTENT: cannot represent user/tool-result content undefined`.
 * That bad record is append-only, so it breaks EVERY later turn of the session —
 * measured on 2026-10-16, and the session had to be repaired by rewriting its
 * log. Every `render` in this file must therefore return this shape.
 *
 * @param {string[]} lines - display lines.
 * @returns {{type: 'text', text: string}[]} typed content blocks.
 */
/**
 * One rendered line, bounded, and honest about it.
 *
 * ⚠️ `MAX_RENDER_LINES` bounds how MANY lines a result carries and says nothing
 * about how long one is. Adversarial audit A-6 (2026-10-16) measured a single
 * 1 MiB message producing a **1,048,656-byte** tool result — two "lines" — and a
 * 100,000-character room id producing a **100,120-byte** error line. A tool
 * result is replayed into every later request of the session, so one enormous
 * line costs exactly what many short ones cost, which is the compounding failure
 * this project is built to avoid. The log keeps the full text; only the
 * projection is cut, and the cut says so.
 *
 * @param {string} text - one rendered line.
 * @returns {string} the line, no longer than `MAX_RENDER_LINE_CHARS`.
 */
function clampLine(text) {
  if (text.length <= MAX_RENDER_LINE_CHARS) return text
  const dropped = text.length - MAX_RENDER_LINE_CHARS
  return `${text.slice(0, MAX_RENDER_LINE_CHARS)} … [line truncated here: ${dropped} more character(s) in the record; the durable log keeps everything]`
}

/**
 * Hard cap on how many characters ONE rendered tool result may carry in total.
 *
 * The third budget, and the one that was missing until 2026-10-17: a line count
 * bounds shape, a per-line cap bounds a single record, but 200 lines of 2000
 * characters each is still 400,000 characters — roughly 100k tokens — replayed
 * into every later request of the session. `attention_history` on a long room is
 * exactly where that would happen, so the total is capped here, at the one point
 * every render goes through, and the projection says how many lines it dropped.
 */
const MAX_RENDER_TOTAL_CHARS = 60000

function textBlocks(lines) {
  const clamped = lines.map((text) => clampLine(String(text)))
  let total = 0
  for (const text of clamped) total += text.length + 1
  if (total <= MAX_RENDER_TOTAL_CHARS) {
    return clamped.map((text) => ({ type: 'text', text }))
  }
  // Keep the TAIL: for a transcript projection, the newest lines are the ones the
  // reader needs; dropping them to save space would be the wrong trade.
  const kept = []
  let used = 0
  for (let index = clamped.length - 1; index >= 0; index -= 1) {
    const text = clamped[index]
    if (used + text.length + 1 > MAX_RENDER_TOTAL_CHARS - 300) break
    kept.push(text)
    used += text.length + 1
  }
  kept.reverse()
  return [
    {
      type: 'text',
      text: `… ${clamped.length - kept.length} line(s) omitted from this view: one result is capped at ${MAX_RENDER_TOTAL_CHARS} characters because it is replayed into every later request; the durable log keeps everything.`,
    },
    ...kept.map((text) => ({ type: 'text', text })),
  ]
}

/** One typed content block from a single line. */
function textBlock(text) {
  return textBlocks([text])
}

/**
 * Hard cap on how many lines one tool result may carry.
 *
 * A tool result is replayed into EVERY later request of the session, so an
 * unbounded render is a compounding cost — the same failure mode this project
 * exists to avoid. The full transcript stays in the log; only the rendered
 * projection is bounded, and the projection says so when it truncates.
 */
const MAX_RENDER_LINES = 200

/**
 * Hard cap on how many characters ONE rendered line may carry.
 *
 * The companion to `MAX_RENDER_LINES`, and it exists because a line count alone
 * is not a size: one 1 MiB message is a two-line tool result. Applied in
 * `clampLine`, i.e. at the single point every `render` in this file goes through,
 * so a new render cannot forget it.
 */
const MAX_RENDER_LINE_CHARS = 2000

/**
 * How much text a stored room-history summary may hold.
 *
 * A summary is a projection, not a transcript dump. 8000 characters already
 * covers a long stretch of a room; anything bigger means the caller pasted
 * messages instead of summarising them, and that paste would then be re-read by
 * every later reader — which is exactly what the summary exists to avoid.
 */
const MAX_SUMMARY_CHARS = 8000

/** Short, readable group id from a title. */
function slugify(title) {
  const base = String(title)
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  const stem = base.length > 0 ? base : 'group'
  return `${stem}-${Date.now().toString(36).slice(-4)}`
}

/**
 * A group id that is not already taken.
 *
 * ⚠️ The suffix is the last four base-36 digits of the clock, which is
 * `36^4 = 1,679,616 ms` — so two rooms created with the same title **28 minutes
 * apart** derive the SAME id. Adversarial audit A-11 (2026-10-16) computed it,
 * and showed the consequence: `requireGroup` returns the first match, so every
 * later tool call for the second room silently lands in the first one. Two
 * rooms merging into one is a much worse failure than an ugly id.
 *
 * @param {string} title - room title.
 * @param {object[]} existing - current ledger rooms.
 * @returns {string} a unique id.
 */
function uniqueGroupId(title, existing) {
  const taken = new Set((Array.isArray(existing) ? existing : []).map((group) => group?.id))
  const first = slugify(title)
  if (!taken.has(first)) return first
  // Same title, same 28-minute window: widen the suffix until it is free. The
  // loop is bounded because each pass adds entropy, but a ledger with thousands
  // of same-titled rooms is not a thing, so keep it short and deterministic.
  for (let attempt = 2; attempt <= 99; attempt += 1) {
    const candidate = `${first}-${attempt}`
    if (!taken.has(candidate)) return candidate
  }
  return `${first}-${Math.random().toString(36).slice(2, 8)}`
}

/** Find a group, or throw a message that names the real problem. */
function requireGroup(ledger, groupId) {
  const group = ledger.groups.find((candidate) => candidate.id === groupId)
  if (group === undefined) {
    const known = ledger.groups.map((candidate) => candidate.id).join(', ')
    throw new Error(
      known.length === 0
        ? 'no groups exist yet; create one with attention_group_create'
        : `unknown group "${groupId}"; known groups: ${known}`,
    )
  }
  return group
}

/** A fresh group record: every knob has a default, every knob is settable later. */
function newGroup(title, options = {}) {
  return {
    id: uniqueGroupId(title, options.existing),
    title,
    createdAt: new Date().toISOString(),
    charter: typeof options.charter === 'string' ? options.charter : '',
    members: [],
    // Rules only by default: a message nobody subscribes to wakes nobody.
    routeMode: ROUTE_MODE.rules,
    // Waking is opt-in per group even when routing says someone is relevant.
    wakeEnabled: options.wakeEnabled === true,
    // Tell woken members to consider replying cheaply and stay silent otherwise.
    selfReflect: true,
    // Who may add members to this room.
    joinPolicy: 'members',
    // The room's ONE reasoning-effort control (R4b). A member with no personal
    // `wakeEffort` is woken at this effort. `''` means the room has no opinion
    // and the session's own route wins — so nothing is forced on anyone.
    defaultEffort: typeof options.defaultEffort === 'string' ? options.defaultEffort : '',
    // R7: conclusions may sink into a file. On by default because nothing happens
    // until someone explicitly concludes something — and off is one click away.
    sinkEnabled: options.sinkEnabled !== false,
    // `''` means "the plugin's own data folder": a bare deployment never has to
    // know where that is.
    sinkDir: typeof options.sinkDir === 'string' ? options.sinkDir : '',
    // Soft integration: when on, a conclusion's output also asks the CALLING
    // agent to record it in task memory if its deployment has one. Nothing is
    // called by name, so a bare DSH simply never acts on that sentence.
    sinkMemory: options.sinkMemory === true,
    // R10: directed links carrying messages OUT of this room. Empty by default —
    // a room relays nowhere until someone deliberately points it somewhere.
    links: [],
    // U3, answered 2026-10-16: there IS an API that changes a session's reasoning
    // effort — `sessionController.selectModel` — and it applies from the next
    // step, for live and stored sessions alike. It is OFF by default because it
    // has a side effect nobody would guess: it also saves the selection as the
    // DEPLOYMENT default model in the background.
    liveEffort: options.liveEffort === true,
  }
}

/** A fresh member record. */
function newMember(input) {
  return {
    id: String(input.id),
    // ⚠️ No `slice(0, 12)` here any more. That fallback ran whenever the caller
    // did not pass a name, and it TRUNCATED THE STORED NAME: a member invited as
    // `Agent会话群聊专项DSH Agent` was written to the ledger as
    // `Agent会话群聊专项D` (12 characters), so the panel could never show the real
    // name and renaming it looked like a display bug. Measured 2026-10-17 against
    // the user's own ledger.
    //
    // The fallback now keeps the WHOLE id. A long id is ugly but honest, and the
    // panel — the only thing that has to fit it on a screen — wraps it. Data must
    // not be shortened on the way in to make a view easier.
    name: typeof input.name === 'string' && input.name.length > 0 ? input.name : String(input.id),
    kind: typeof input.kind === 'string' ? input.kind : 'session',
    joinedAt: new Date().toISOString(),
    subscribe: Array.isArray(input.subscribe) ? input.subscribe.filter((term) => typeof term === 'string') : [],
    ...(typeof input.wakeEffort === 'string' ? { wakeEffort: input.wakeEffort } : {}),
    enabled: true,
  }
}

/**
 * The human member's stable id.
 *
 * Members are told apart by id shape (`isSessionId`), so the person needs a
 * non-session id — a person has no session id to give. Used by the panel to
 * post, to count unread, and to mark a room read.
 */
const HUMAN_ID = 'user'
const HUMAN_NAME = '用户'

/**
 * Legal `reasoningEffort` values, plus `''` meaning "do not touch".
 *
 * The enum is the DeepSeek Messages protocol's, read from the shipped schema
 * rather than guessed:
 *   `reasoningEffort: z.union(["off","low","high","max"])`
 * (evidence: `@deepseek-ai/dsh-llm-deepseek` config schema, asar dump line 313).
 * The empty string is this plugin's own addition: it means the room has no
 * opinion, so a woken member keeps whatever effort its own session used.
 */
const EFFORT_VALUES = ['', 'off', 'low', 'high', 'max']

/**
 * Every setting the panel is allowed to offer, described once, here.
 *
 * The browser half renders whatever it is handed, so adding a routing mode or a
 * new member kind is a change to this table and nothing else — the panel cannot
 * drift behind the host, and it cannot invent a value the host would reject.
 */
const PANEL_KNOBS = {
  routeModes: [
    { value: ROUTE_MODE.rules, label: '规则', hint: '被 @ 或命中订阅词才叫醒。不匹配就是零唤醒。' },
    {
      value: ROUTE_MODE.classify,
      label: '语义',
      hint: '规则判不出来的人不会被叫醒，而是作为「灰区」报给发消息的人，由它决定要不要点名。不会静默广播，也不会偷偷花一次模型调用。',
    },
    { value: ROUTE_MODE.broadcast, label: '全体', hint: '没匹配上也把所有启用成员叫醒。最贵，慎用。' },
  ],
  efforts: [
    { value: '', label: '跟随', hint: '这个群不干预，叫醒时沿用成员会话自己上次的推理强度。' },
    { value: 'off', label: '关', hint: '不推理，最快最省。' },
    { value: 'low', label: '低', hint: '略想一下。' },
    { value: 'high', label: '高', hint: '默认档。' },
    { value: 'max', label: '最高', hint: '叫醒时让它想得最久，回得最慢也最贵。' },
  ],
  joinPolicies: [
    { value: 'open', label: '开放', hint: '谁都能进这个群，谁都能拉人。' },
    { value: 'members', label: '群成员', hint: '只有已经在群里的人能拉人。' },
    { value: 'user', label: '仅用户', hint: '只有你能拉人，Agent 一律拉不动。' },
    { value: 'nobody', label: '冻结', hint: '谁都拉不进人，成员表锁死。' },
  ],
  memberKinds: ['session', 'user', 'admin', 'bot', 'liaison'],
  // R9+ (user's decision, 2026-10-17): the room REMINDS, it never compacts by
  // itself. Generating a summary spends a model turn in someone else's session, so
  // it stays a deliberate click; this knob only decides when the panel starts
  // saying "this room has N messages without a summary".
  summaryEveries: [
    { value: 0, label: '关', hint: '不提醒。' },
    { value: 200, label: '200 条', hint: '攒到 200 条没摘要时，面板里出现提醒。' },
    { value: 500, label: '500 条', hint: '默认。够大，平时不会一直念。' },
    { value: 2000, label: '2000 条', hint: '只有真的很长才提醒。' },
  ],
  // R10: what a liaison is allowed to carry. Declared once, here, so the panel
  // cannot offer a mode the host would refuse.
  relayModes: RELAY_MODES,
}

/** First non-empty effort string, so `''` never reaches a provider. */
function firstEffort(...candidates) {
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return undefined
}

/** A member's display name for whoever is asking, or a short id if they are not one. */
function memberNameOf(group, agent) {
  if (agent === undefined) return '未知成员'
  const id = String(agent.id)
  const member = group.members.find((candidate) => candidate.id === id)
  return member === undefined ? id.slice(0, 12) : member.name
}

/**
 * Does this deployment actually expose a task-memory tool right now?
 *
 * This is the honest half of the soft integration. The other half is in
 * `sink.js`: the plugin never CALLS another package's tool by name, because
 * `dsh-expedition-memory` is a tool provider rather than a Cordis service
 * (checked 2026-10-16 against the runtime's own Service catalogue) and reaching
 * into another package's internals would be a hidden dependency.
 *
 * But "is it there?" IS answerable without guessing: `ctx.tools.get(name)` is a
 * catalogued API, and `tools` is a hard dependency of this plugin, so the
 * question costs one lookup. The answer turns the integration note from a guess
 * into a fact the caller can act on.
 *
 * @param {object} ctx - Cordis context.
 * @param {string} toolName - tool to look for.
 * @returns {boolean} whether the deployment has it.
 */
function hasTool(ctx, toolName) {
  try {
    return ctx.tools.get(toolName) !== undefined
  } catch {
    return false
  }
}

/** Normalize a panel-supplied effort: `undefined` means "not a legal value". */
function normalizeEffort(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  return EFFORT_VALUES.includes(text) ? text : undefined
}

/**
 * May `actorId` add a member to `group`?
 *
 * R8: every member (agents included) can invite, but the user must be able to
 * turn that off. So the rule is data, not code — `joinPolicy` is a per-group
 * setting the panel exposes, and the actor is the caller's own member id.
 *
 * The `user` id always passes: the human is the one the policy protects, and a
 * person who locks themselves out of their own room has been failed by design.
 *
 * @param {object} group - group record.
 * @param {string|undefined} actorId - member id of whoever is asking.
 * @returns {{allowed: boolean, reason?: string}} the verdict.
 */
function mayInvite(group, actorId) {
  const policy = typeof group.joinPolicy === 'string' ? group.joinPolicy : 'members'
  if (actorId === HUMAN_ID) return { allowed: true }
  if (policy === 'nobody') return { allowed: false, reason: 'this group is frozen (joinPolicy=nobody)' }
  if (policy === 'user') return { allowed: false, reason: 'this group only lets the user add members (joinPolicy=user)' }
  if (policy === 'open') return { allowed: true }
  const member = group.members.find((candidate) => candidate.id === actorId)
  if (member === undefined) {
    return { allowed: false, reason: 'this group only lets existing members add people (joinPolicy=members)' }
  }
  if (member.enabled === false) return { allowed: false, reason: `member ${actorId} is disabled` }
  return { allowed: true }
}

/** Messages this member has not seen: everything appended after its last read. */
function countUnread(root, groupId, member, excludeSeq) {
  if (typeof member.lastReadAt !== 'string') return undefined
  const all = readMessages(root, groupId, { limit: 0 })
  return all.filter(
    (row) =>
      row.at > member.lastReadAt &&
      // ⚠️ You have seen what you yourself wrote. Without this line, a member that
      // posted a conclusion and had not yet re-read the room showed itself one
      // unread message, forever, for its own words — adversarial audit B-08
      // (2026-10-16). "Unread" has to mean "someone else said something I have
      // not seen", or the badge is noise the human learns to ignore.
      row.fromId !== member.id &&
      row.seq !== excludeSeq,
  ).length
}

/** Summary snapshots this room has stored, oldest first. Junk rows are dropped. */
function groupSummaries(group) {
  if (!Array.isArray(group?.summaries)) return []
  return group.summaries.filter(
    (row) => row !== null && typeof row === 'object' && typeof row.text === 'string' && row.text.length > 0,
  )
}

/** The highest message number covered by a stored summary, or 0 when there is none. */
function summarizedUpTo(group) {
  let upTo = 0
  for (const row of groupSummaries(group)) {
    if (Number.isFinite(row.upToSeq) && row.upToSeq > upTo) upTo = row.upToSeq
  }
  return upTo
}

/**
 * How long a computed unread count may be reused before it is recomputed.
 *
 * ⚠️ This exists because the prompt line below runs on EVERY step of EVERY agent.
 * `countUnread` reads the room's whole JSONL, so asking it per step would turn a
 * long-lived room into a per-step disk scan — exactly the "the group got big and
 * now everything is slow" failure. Five seconds is short enough that a member
 * never misses a fresh message for long, and long enough that a step costs one
 * `Map` lookup. The cache key carries `lastReadAt`, so reading the room also
 * invalidates it immediately.
 */
const UNREAD_PROMPT_CACHE_MS = 5000

/**
 * The one line a member agent sees about its unread rooms.
 *
 * This is the R6 upgrade: "offline members do not miss messages" used to mean
 * "we tell you when we wake you". A member that gets started for some other
 * reason had no idea the room had three messages waiting. The runtime-context
 * channel survives compaction, so this line is re-projected into every later
 * step by the harness itself.
 *
 * Rules it follows:
 *   - only rooms that opted in (`promptUnread`), only for members of that room;
 *   - nothing at all when there is nothing to say (the quiet default matters:
 *     this plugin's whole claim is that it shuts up);
 *   - `undefined` from `countUnread` means "never read this room" — the line says
 *     "有未读" instead of inventing a number (c7: no false precision);
 *   - capped to three rooms so the line cannot grow with the number of rooms.
 *
 * @param {object} state - plugin state.
 * @param {string} sessionId - the session whose prompt is being assembled.
 * @returns {string} one Chinese line, or '' when there is nothing to say.
 */
function unreadPromptLine(state, sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return ''
  const groups = state.ledger?.groups
  if (!Array.isArray(groups)) return ''
  const cache = state.unreadPromptCache ?? (state.unreadPromptCache = new Map())
  const now = Date.now()
  const parts = []
  for (const group of groups) {
    if (group?.promptUnread !== true) continue
    const member = safeMembers(group).find((row) => row?.id === sessionId)
    if (member === undefined || member.enabled === false) continue
    const readMark = typeof member.lastReadAt === 'string' ? member.lastReadAt : ''
    const key = `${group.id}\u0000${sessionId}`
    const hit = cache.get(key)
    let count
    if (hit !== undefined && hit.readMark === readMark && now - hit.at < UNREAD_PROMPT_CACHE_MS) {
      count = hit.count
    } else {
      try {
        count = countUnread(state.root, group.id, member)
      } catch {
        // A room whose transcript cannot be read is "unknown", never "empty".
        count = undefined
      }
      cache.set(key, { at: now, readMark, count })
    }
    if (count === 0) continue
    parts.push(`「${singleLine(group.title, 40) || '(untitled)'}」${count === undefined ? '有未读' : `${count} 条`}`)
    if (parts.length >= 3) break
  }
  if (parts.length === 0) return ''
  return `群聊未读：${parts.join('、')}。用 attention_history 读，attention_send 回复。`
}

/**
 * Publish the unread line as a runtime prompt context.
 *
 * `ctx.inject` because `systemPrompt` is not in this plugin's own scope (c8), and
 * `scope.effect` because the child fiber can activate more than once — the effect
 * disposes the previous registration first, so this is idempotent (c23).
 *
 * @param {object} ctx - Cordis context.
 * @param {object} state - plugin state.
 */
function registerPromptContext(ctx, state) {
  if (typeof ctx.inject !== 'function') {
    state.promptStatus = 'ctx.inject is unavailable'
    return
  }
  try {
    ctx.inject(['systemPrompt'], (scope) => {
      const prompt = scope.systemPrompt
      if (prompt === undefined || prompt === null || typeof prompt.context !== 'function') {
        state.promptStatus = 'systemPrompt child context carried no service'
        return
      }
      scope.effect(() => {
        const dispose = prompt.context({
          name: 'attention-group-unread',
          // After the task-memory context (order 900): memory is background, this
          // is a "there is something waiting for you" nudge and reads better last.
          order: 901,
          text: (assembly) => {
            try {
              return unreadPromptLine(state, assembly?.agent?.session?.id)
            } catch {
              // A diagnostic-grade failure must not break the model step.
              return ''
            }
          },
        })
        state.promptStatus = 'registered'
        return () => {
          state.promptStatus = 'disposed'
          if (typeof dispose === 'function') dispose()
        }
      }, 'attention-group: unread prompt context')
    })
  } catch (error) {
    state.promptStatus = `inject failed: ${errorMessage(error)}`
  }
}

/**
 * The next sequence number for a room: one past the highest number ever used.
 *
 * ⚠️ NOT `messages.length + 1`. Sequence numbers are the room's ordering, and a
 * hand-deleted or hand-edited line shortens the file without renumbering
 * anything, so `length + 1` hands out a number that is already taken — measured
 * `[1,3,3]` — and then anything keyed by `seq` (the unread exclusion above, a
 * relay's `fromSeq` pointer) addresses two different messages at once.
 * Adversarial audit B-08, 2026-10-16.
 *
 * @param {string} root - data root.
 * @param {string} groupId - owning room.
 * @returns {number} the next unused sequence number.
 */
function nextSeq(root, groupId) {
  return nextSeqFrom(readMessages(root, groupId, { limit: 0 }))
}

/** `nextSeq` over rows the caller already read, so a relay does not read twice. */
function nextSeqFrom(rows) {
  let highest = 0
  for (const row of rows) {
    if (typeof row.seq === 'number' && Number.isFinite(row.seq) && row.seq > highest) highest = row.seq
  }
  return highest + 1
}

/**
 * The origin keys (`fromGroup#fromSeq`) a room has already received by relay.
 *
 * Used for the diamond guard: in `A → B → D` plus `A → C → D`, the two copies of
 * one message carry DIFFERENT trails, so the anti-loop trail cannot see that they
 * are the same message and D receives it twice. What both copies share is their
 * origin, which is exactly what this records. Adversarial audit B-07 (2026-10-16).
 *
 * @param {object[]} rows - a room's transcript.
 * @returns {Set<string>} origin keys already present.
 */
function relayOriginsIn(rows) {
  const keys = new Set()
  for (const row of rows) {
    const relay = row?.relay
    if (relay === undefined || typeof relay.fromGroup !== 'string') continue
    // The ROOT origin when the record carries one. `fromGroup`/`fromSeq` alone
    // describe only the last hop, so two copies of one message arriving by
    // different routes would look like two different messages.
    const root = relay.origin
    if (root !== undefined && typeof root.group === 'string' && typeof root.seq === 'number') {
      keys.add(`${root.group}#${root.seq}`)
      continue
    }
    if (typeof relay.fromSeq !== 'number') continue
    keys.add(`${relay.fromGroup}#${relay.fromSeq}`)
  }
  return keys
}

/**
 * Language rule for this plugin, so it stops drifting:
 *
 *   - Tool NAMES, descriptions, result renders and error strings are ENGLISH:
 *     that surface is the model-facing API, and every other tool here reads the
 *     same way.
 *   - Messages SENT to a member are written in the room's language (Chinese
 *     here) — `renderWakeMessage` and `renderSummaryRequest` both are, because a
 *     Chinese-speaking agent is the one that has to act on them.
 *   - Panel text is Chinese: that surface is the human's.
 *   - When an error must name a control the human will go looking for, the
 *     sentence stays English and quotes the label: `turn on 「结论沉淀」`.
 *
 * The soft integration's memory note is the one deliberate exception: it is a
 * sentence ADDRESSED TO a member, so it follows the message rule, not the tool
 * rule.
 */

/**
 * Build the user message a member receives.
 *
 * Two contracts meet here, and getting either wrong breaks the RECEIVING
 * session rather than this one:
 *
 *  - `content` must be typed blocks; the model serializer walks `block.type`.
 *  - `source` must be a producer-owned kind. The v4 session format rejects the
 *    generic marker `kind: "plugin"` outright:
 *      `format v4 message requires a producer-owned source kind`
 *    (evidence: `/dsh/node_modules/@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js`).
 *    So the plugin names itself. Measured on 2026-10-16: with `kind: "plugin"`
 *    every wake-up was refused on arrival and the target session showed
 *    `本轮运行失败 … UNKNOWN`.
 */
function wakeUserMessage(text) {
  return {
    id: `attention-group-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: name, plugin: name },
  }
}

/**
 * Read the route (provider/model/effort) a persisted session last used.
 *
 * A resumed agent has no route of its own: without `agentOptions` the loop has
 * no provider or model, and a delivered message produces a turn that never calls
 * a model. The route is not in the session header, so it is read from the log —
 * the newest `request/header` event carries the call configuration, with
 * `request/context` as the fallback. Other event types are ignored even when
 * their data happens to carry provider/model fields.
 *
 * Read through `ctx.get()` rather than `inject`: cold wake-up is an optional
 * capability, and a deployment without session query should still get a fully
 * working plugin for live sessions.
 *
 * @param {object} ctx - Cordis context.
 * @param {string} sessionId - persisted session to inspect.
 * @returns {Promise<{provider: string, model: string, reasoningEffort?: string}|undefined>}
 */
async function lastKnownRoute(ctx, sessionId) {
  let query
  try {
    query = ctx.get('sessionQuery')
  } catch {
    return undefined
  }
  if (query === undefined) return undefined

  let events
  try {
    const snapshot = await query.readSession(sessionId)
    events = snapshot?.events ?? (Array.isArray(snapshot) ? snapshot : [])
  } catch {
    // An unreadable log is not fatal here: resume reports the real failure.
    return undefined
  }
  if (!Array.isArray(events)) return undefined

  const isRoute = (value) =>
    typeof value?.provider === 'string' &&
    value.provider.length > 0 &&
    typeof value?.model === 'string' &&
    value.model.length > 0
  let fallback
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'request/header') {
      const config = event.data?.header?.config
      if (isRoute(config)) {
        return {
          provider: config.provider,
          model: config.model,
          ...(typeof config.reasoningEffort === 'string' ? { reasoningEffort: config.reasoningEffort } : {}),
        }
      }
    } else if (fallback === undefined && event?.type === 'request/context' && isRoute(event.data)) {
      fallback = { provider: event.data.provider, model: event.data.model }
    }
  }
  return fallback
}

/**
 * The message a summariser receives (R9).
 *
 * Unlike a routed wake-up this is a direct assignment, so there is deliberately
 * no self-reflection line: the request exists because someone was asked to
 * produce something, and "should I speak?" has already been answered by the
 * asking. The digest travels INSIDE the message because making the woken session
 * fetch history first would spend a second turn on work the sender already did —
 * which is the opposite of what this plugin is for.
 *
 * @param {object} input - `{group, digest, requester}`.
 * @returns {string} the user message body.
 */
function renderSummaryRequest({ group, digest, requester }) {
  // Like the wake message, this is sent TO a member, so a newline smuggled in
  // through a room title or a member name would append what reads as an
  // instruction from the plugin. Fields are flattened; `digest.text` is not,
  // because it is the excerpt the member is being asked to read.
  return [
    `【群聊总结请求】群「${singleLine(group.title, 80)}」（${singleLine(group.id, 80)}）`,
    `${singleLine(requester, 80)} 请你总结下面这段时间的交流。`,
    '',
    '----- 摘录开始 -----',
    digest.text,
    '----- 摘录结束 -----',
    '',
    '请直接给出总结，分三段：',
    '1) 发生了什么',
    '2) 决定了什么',
    '3) 还没解决什么',
    '',
    '要求：只依据上面的摘录，不要补充你不知道的事；没有内容的段落写「无」；总长不超过 300 字。',
    '（这是别人点名请你做的总结，不需要判断要不要发言，直接写总结。）',
  ].join('\n')
}

/**
 * Type guard: does this look like a DSH session id, i.e. is there a process to wake?
 *
 * BOTH SHAPES ARE REAL, and assuming otherwise silently broke roughly seventy
 * sessions on this machine. Measured 2026-10-16 against the live runtime:
 *
 *   `attention_probe_session 008bda70-4811-4349-a1a5-d6c6ff54d7d1`
 *     -> stored, route deepseek-official/deepseek-flash @max, resumable
 *
 * That session id has no `session-` prefix, and neither do most of the sessions
 * under `~/.dsh/sessions/--J-…--/`. The earlier check (`startsWith('session-')`)
 * filed every one of them as "a name, not a process", so they could never be
 * woken — a feature quietly missing for most of the user's history rather than a
 * visible failure.
 *
 * Note what this does NOT key on: `kind`. A member's kind is its ROLE in the room
 * (R8 allows an `admin`-kind or `bot`-kind member that IS a live session — the
 * summariser is chosen exactly that way). Whether there is something to wake is a
 * property of the id, not of the role.
 */
function isSessionId(value) {
  if (typeof value !== 'string') return false
  if (value.startsWith('session-')) return true
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)
}

/**
 * Read the agent preset a stored session was created with.
 *
 * A resumed agent gets the preset this call passes, so omitting it silently
 * swaps the session's TOOLSET for the deployment default. That is not cosmetic:
 * measured 2026-10-16, a cold resume without `setup` left a peer agent unable to
 * call `read`/`glob`/`grep`/`pwsh` — it could still be woken, but could no
 * longer work. The session's own preset is a projection its persisted log
 * already carries.
 *
 * @param {object} ctx - Cordis context.
 * @param {string} sessionId - stored session to inspect.
 * @returns {Promise<string|undefined>} preset id, or undefined for the default.
 */
async function sessionPreset(ctx, sessionId) {
  let query
  try {
    query = ctx.get('sessionQuery')
  } catch {
    return undefined
  }
  if (query?.observeSession === undefined) return undefined
  try {
    const observation = await query.observeSession(sessionId)
    const preset = observation?.projections?.values?.agentPreset
    return typeof preset === 'string' && preset.length > 0 ? preset : undefined
  } catch {
    // An unreadable projection means the deployment default, which is what the
    // caller would have used anyway.
    return undefined
  }
}

/**
 * Compose the launch the way a session expects to be resumed.
 *
 * Model inputs, in priority order: the room's configured effort for this member,
 * the route the session itself last used, then the deployment default. The
 * preset is ALWAYS the session's own — see {@link sessionPreset}.
 *
 * @param {object} ctx - Cordis context.
 * @param {string} sessionId - session being resumed.
 * @param {string} [memberEffort] - effort the room wants for this member.
 * @returns {Promise<{agentOptions: object, setup?: Function, preset?: string}>}
 */
async function composeLaunch(ctx, sessionId, memberEffort) {
  const route = await lastKnownRoute(ctx, sessionId)
  let agentOptions = route === undefined ? {} : { ...route }
  if (Object.keys(agentOptions).length === 0) {
    try {
      const selection = ctx.get('agentDefaultModel')?.currentSelection()
      if (selection !== undefined) {
        agentOptions = { provider: selection.provider, model: selection.model }
        if (selection.reasoningEffort !== undefined) agentOptions.reasoningEffort = selection.reasoningEffort
      }
    } catch {
      // Leave agentOptions empty; resume reports the real failure.
    }
  }
  if (memberEffort !== undefined) agentOptions.reasoningEffort = memberEffort

  const presetId = await sessionPreset(ctx, sessionId)
  let setup
  try {
    const presets = ctx.get('agentPresets')
    if (presets?.resolve !== undefined && presets?.mount !== undefined) {
      const resolved = await presets.resolve(presetId)
      setup = async (agentCtx) => {
        await presets.mount(agentCtx, resolved.id)
      }
    }
  } catch {
    // Preset composition is best-effort: waking with the default still beats not
    // waking at all, and the outcome note records which path was taken.
  }
  return {
    agentOptions,
    ...(setup === undefined ? {} : { setup }),
    ...(presetId === undefined ? {} : { preset: presetId }),
  }
}

/**
 * Deliver one routed message to one member.
 *
 * Three cases, in order of cost:
 *   - non-session member (user, admin, bot) -> recorded only; nothing to wake.
 *   - live session -> a follow-up; cheapest real delivery.
 *   - stored session -> cold resume with the member's own route, then deliver.
 *
 * @param {object} ctx - Cordis context.
 * @param {object} state - plugin state (`root`).
 * @param {object} group - group record.
 * @param {object} member - member record.
 * @param {object} record - the message record.
 * @param {object} target - routing decision for this member.
 * @returns {Promise<{delivered: boolean, note?: string}>}
 */
async function deliver(ctx, state, group, member, record, target, override) {
  const outcome = await attemptDelivery(ctx, state, group, member, record, target, override)
  // Third-witness audit. A delivery that reports success while the target's log
  // shows nothing is the hardest failure to diagnose, so every attempt is
  // recorded with the path it took. Measured on 2026-10-16: this exact gap cost
  // an hour of guessing between "the plugin is broken" and "the target is wedged".
  appendDelivery(state.root, {
    groupId: group.id,
    memberId: member?.id,
    messageSeq: record.seq,
    reason: target.reason,
    delivered: outcome.delivered,
    ...(outcome.path === undefined ? {} : { path: outcome.path }),
    ...(outcome.note === undefined ? {} : { note: outcome.note }),
  })
  return outcome
}

/**
 * One delivery attempt, without auditing.
 *
 * `override` replaces the generated wake message. It exists for R9: a summary
 * request is a direct assignment carrying its own digest, not something the
 * relevance router produced — but it must inherit EVERYTHING else: the disabled
 * check, the non-session check, the live/cold paths, the room's effort knob and
 * the preset-safe cold resume. Re-implementing that would have been a second
 * place to get the 2026-10-16 preset bug wrong.
 *
 * @returns {Promise<{delivered: boolean, path?: string, note?: string}>}
 */
async function attemptDelivery(ctx, state, group, member, record, target, override) {
  if (member?.enabled === false) return { delivered: false, path: 'skipped', note: 'member disabled' }

  // A non-session member is a name in the room, not a process to wake. Saying so
  // is better than reporting a delivery failure the user cannot act on.
  if (!isSessionId(member.id)) {
    return { delivered: false, path: 'non-session', note: `non-session member (${member.kind ?? 'unknown'}); recorded only` }
  }

  const text =
    typeof override === 'string' && override.length > 0
      ? override
      : renderWakeMessage({
          group,
          message: record,
          reason: target.reason,
          detail: target.detail,
          unread: countUnread(state.root, group.id, member, record.seq),
          selfReflect: group.selfReflect !== false,
        })
  const message = wakeUserMessage(text)
  // The room's effort control (R4b) is ONE knob for the whole room; a member may
  // still override it with its own `wakeEffort`. `firstEffort` drops empty
  // strings so "follow the session" never reaches the provider as a value.
  const memberEffort = firstEffort(member.wakeEffort, group.defaultEffort)

  try {
    const live = ctx.agents.get(member.id)
    if (live !== undefined) {
      live.followup(message)
      return { delivered: true, path: 'live-followup', note: `live session, status=${String(live.status ?? 'unknown')}` }
    }
  } catch (error) {
    return { delivered: false, path: 'live-followup', note: `live delivery failed: ${errorMessage(error)}` }
  }

  // Cold path. The launch is composed from the session's OWN preset and route:
  // resuming without `setup` silently swaps the session's toolset for the
  // deployment default, which left a peer agent unable to call its file tools
  // after this plugin woke it (measured 2026-10-16).
  const launch = await composeLaunch(ctx, member.id, memberEffort)
  if (launch.agentOptions.provider === undefined || launch.agentOptions.model === undefined) {
    return {
      delivered: false,
      path: 'cold-resume',
      note: 'member is offline and no route could be resolved (no session query, no request/header, no default model)',
    }
  }
  try {
    const handle = await ctx.agents.resume({
      resumeSessionId: member.id,
      agentOptions: launch.agentOptions,
      ...(launch.setup === undefined ? {} : { setup: launch.setup }),
    })
    handle.agent.followup(message)
    return {
      delivered: true,
      path: 'cold-resume',
      note: `cold resume as ${launch.agentOptions.provider}/${launch.agentOptions.model}${launch.agentOptions.reasoningEffort === undefined ? '' : ` @${launch.agentOptions.reasoningEffort}`}, preset=${launch.preset ?? 'default'}${launch.setup === undefined ? ' (NO SETUP — toolset may differ)' : ''}`,
    }
  } catch (error) {
    return { delivered: false, path: 'cold-resume', note: `cold resume failed: ${errorMessage(error)}` }
  }
}

/** A short, safe message from an unknown thrown value. */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Carry a message into every room this one links to (R10).
 *
 * Forwarding writes the message into the TARGET room's record. Waking anybody
 * there is a SECOND, independent decision: it needs the link's own `wake` flag
 * AND the target room's `wakeEnabled`, exactly like a send. So a liaison can
 * carry decisions into a room without touching anyone's session — and that is
 * the default.
 *
 * Every link is asked separately and every answer is reported, refusal reasons
 * included: "nothing was forwarded" with no reason is indistinguishable from a
 * broken link (c7 ②).
 *
 * @param {object} ctx - Cordis context.
 * @param {object} state - plugin state.
 * @param {object} fromGroup - the room the message was posted in.
 * @param {object} record - the message that was posted.
 * @param {number} [depth] - recursion depth; the trail is what really stops it.
 * @returns {Promise<object[]>} one row per link, relayed or refused.
 */
async function relayMessage(ctx, state, fromGroup, record, depth = 0, budget = { writes: MAX_RELAY_MESSAGES }) {
  const links = Array.isArray(fromGroup.links) ? fromGroup.links : []
  const report = []

  for (const link of links) {
    if (budget.writes <= 0) {
      // Shared across the whole recursive walk — see MAX_RELAY_MESSAGES.
      report.push({
        linkId: link.id,
        to: link.to,
        relayed: false,
        reason: `relay budget exhausted (${MAX_RELAY_MESSAGES} messages written by a single call); send again or narrow the links`,
      })
      continue
    }
    const target = state.ledger.groups.find((candidate) => candidate.id === link.to)
    if (target === undefined) {
      report.push({ linkId: link.id, to: link.to, relayed: false, reason: `the target room "${link.to}" no longer exists` })
      continue
    }

    // One read of the target's transcript serves both the diamond guard and the
    // next sequence number. Reading it twice would also open a window where the
    // two answers disagree.
    const targetRows = readMessages(state.root, target.id, { limit: 0 })
    const verdict = shouldRelay({
      link,
      from: fromGroup,
      record,
      targetId: target.id,
      targetMemberNames: target.members.map((member) => member.name),
      targetRelayOrigins: relayOriginsIn(targetRows),
    })
    if (verdict.relay !== true) {
      report.push({ linkId: link.id, to: target.id, relayed: false, reason: verdict.reason })
      continue
    }

    const at = new Date().toISOString()
    const mentions = extractMentions(
      String(record.text ?? ''),
      target.members.map((member) => member.name),
    )
    const forwarded = relayRecord({
      link,
      fromGroup,
      record,
      at,
      seq: nextSeqFrom(targetRows),
      mentions,
      reason: verdict.reason,
    })
    appendMessage(state.root, target.id, forwarded)
    budget.writes -= 1
    link.lastFiredAt = at
    link.fireCount = (typeof link.fireCount === 'number' ? link.fireCount : 0) + 1

    // The target room runs its OWN router. Note that this is rules-only routing
    // for a relay: a forwarded message should not trigger the target room's
    // semantic classifier, because nobody in the target asked for this message to
    // be judged — it arrived on someone else's decision.
    const plan = route({ group: { ...target, routeMode: RELAY_MODE_TARGET_ROUTE }, message: forwarded, excludeMemberId: forwarded.fromId })
    const wantWake = link.wake === true && target.wakeEnabled === true
    let delivered = 0
    if (wantWake) {
      for (const routed of plan.recipients) {
        const member = target.members.find((candidate) => candidate.id === routed.memberId)
        const outcome = await deliver(ctx, state, target, member, forwarded, routed)
        if (outcome.delivered === true) delivered += 1
      }
    }

    report.push({
      linkId: link.id,
      to: target.id,
      relayed: true,
      seq: forwarded.seq,
      reason: verdict.reason,
      hops: forwarded.relay.hops,
      mentions,
      woken: wantWake,
      delivered,
      note:
        wantWake === true
          ? 'delivered inside the target room'
          : link.wake === true
            ? "the target room's waking switch is off, so it was recorded only"
            : 'the link carries messages without waking anyone',
    })

    // CHAINING is what makes a network of liaisons a network: the room that just
    // received a relayed message gets to relay it onward under its OWN links.
    // This is also where the loop guards earn their keep — without them, two rooms
    // pointing at each other would echo forever. `trail` grows by one per hop, and
    // `shouldRelay` refuses both a room already on the trail and a trail at
    // `maxHops`, so the recursion terminates on a finite set of rooms. `depth` is
    // a belt-and-braces bound for a pathological configuration.
    if (depth < MAX_RELAY_DEPTH) {
      const onward = await relayMessage(ctx, state, target, forwarded, depth + 1, budget)
      for (const row of onward) {
        report.push({ ...row, via: [target.id, ...(row.via ?? [])] })
      }
    }
  }

  if (report.some((row) => row.relayed === true)) writeLedger(state.root, state.ledger)
  return report
}

/**
 * Rules-only routing for a relayed message.
 *
 * A forwarded message must not trigger the target room's semantic classifier:
 * nobody in the target asked for this message to be judged, and paying a model
 * to evaluate someone else's forwarding decision is exactly the kind of spend
 * this plugin exists to refuse.
 */
const RELAY_MODE_TARGET_ROUTE = ROUTE_MODE.rules

/**
 * Belt-and-braces recursion bound for a chain of liaisons.
 *
 * The real terminator is the message's own `trail`: a room already on it is
 * refused, so the chain can never be longer than the number of rooms. This bound
 * exists so that a pathological configuration cannot spin, and it is deliberately
 * larger than any sane `maxHops`.
 */
const MAX_RELAY_DEPTH = 8

/**
 * How many messages ONE call may write through liaisons, across every room.
 *
 * ⚠️ A fully-connected set of rooms multiplies. Adversarial audit A-8
 * (2026-10-16) wired 7 rooms to each other (42 links) with `mode:"all"` and sent
 * one message: it wrote **1,957** messages and took **17 seconds**, growing about
 * 6x per room added (5 rooms → 65, 6 → 326, 7 → 1,957). Eight rooms is minutes;
 * ten is hours.
 *
 * Capping `maxHops` does NOT fix this, which is worth stating because it looks
 * like it should: with N rooms the anti-loop trail already bounds a chain to N
 * hops, so the hop limit is not what is being spent — the fan-out is. The bound
 * has to be on total work per call, and it has to be shared across the whole
 * recursive walk rather than applied per room.
 *
 * Exhausting it is reported, never silent: a link that did not fire must say so.
 */
const MAX_RELAY_MESSAGES = 200

/**
 * Take the session-controller service if this deployment has one.
 *
 * WHY `ctx.inject` AND NOT `ctx.get`: this is the c8 lesson. A Cordis service is
 * visible per SCOPE, and at `apply()` time this plugin's own scope could not see
 * even `webServer`; `ctx.inject(deps, cb)` runs `cb` in a child fiber that
 * activates when the service is composed. It is also why the service is stashed
 * on `state` and read at call time — the callback may run long after `apply()`.
 *
 * `sessionController` is mounted by `@deepseek-ai/dsh-web-app`, so a headless
 * deployment simply never gets it. That costs the "change a live session's
 * effort" capability and nothing else, and `attention_probe` says so.
 *
 * @param {object} ctx - Cordis context.
 * @param {object} state - plugin state.
 */
function registerSessionController(ctx, state) {
  state.effortStatus = 'not composed (this deployment has no sessionController)'
  if (typeof ctx.inject !== 'function') {
    state.effortStatus = 'ctx.inject is unavailable'
    return
  }
  try {
    ctx.inject(['sessionController'], (childCtx) => {
      const controller = childCtx.sessionController
      if (controller === undefined || controller === null) {
        state.effortStatus = 'the child context carried no sessionController'
        return
      }
      state.sessionController = controller
      state.effortStatus = 'available'
    })
  } catch (error) {
    state.effortStatus = `inject failed: ${errorMessage(error)}`
  }
}

/**
 * Change the reasoning effort of the room's LIVE sessions, right now.
 *
 * THE API EXISTS — this was open question U3 and the answer is not "no". As of
 * 2026-10-16, verified against the runtime sources by a separate read-only
 * investigation:
 *
 *   `sessionController.selectModel({sessionId, provider, model, reasoningEffort})`
 *   → `agents.selectForNextRequest(agent, selected)` and a `model/selection` event
 *   (`dsh-api-session-controller/lib/types/commands.js:145-176`)
 *
 * Three properties decide the shape of this function:
 *
 *  - It takes effect on the session's **next step**, not on a request already in
 *    flight (`dsh-agent/lib/types/model-selection.js:29-33`). So the honest note
 *    is "applied, effective from its next step".
 *  - It needs a provider and a model, not just an effort. They come from the
 *    session's own last known route, so nothing is guessed.
 *  - **It also saves the selection as the deployment default model**, in the
 *    background. That is a side effect nobody would predict from a switch called
 *    "effort", which is exactly why the room has to opt in per group and the
 *    panel says so in as many words.
 *
 * LIVE SESSIONS ONLY, on purpose. `selectModel` would cold-resume a stored
 * session to change its effort, which spends a whole turn on bookkeeping; a
 * stored session gets its effort when it is next woken anyway (R4b), for free.
 *
 * @param {object} ctx - Cordis context.
 * @param {object} state - plugin state.
 * @param {object} group - group record.
 * @param {string} effort - the effort to apply.
 * @param {string} [onlyMemberId] - restrict to one member.
 * @returns {Promise<object>} `{ok, results, reason?}`.
 */
async function applyEffortToLive(ctx, state, group, effort, onlyMemberId) {
  const controller = state.sessionController
  if (controller === undefined || typeof controller.selectModel !== 'function') {
    return {
      ok: false,
      results: [],
      reason: `this deployment has no sessionController (${state.effortStatus ?? 'unknown'}), so a live session's effort cannot be changed; a stored session still gets it when it is woken`,
    }
  }
  const wanted = firstEffort(effort)
  if (wanted === undefined) {
    return { ok: false, results: [], reason: 'empty effort means "follow the session", so there is nothing to apply' }
  }

  const targets = group.members.filter(
    (member) =>
      (onlyMemberId === undefined || member.id === onlyMemberId) &&
      member.enabled !== false &&
      isSessionId(member.id) &&
      ctx.agents.get(member.id) !== undefined,
  )
  const results = []
  for (const member of targets) {
    const route = await lastKnownRoute(ctx, member.id)
    if (route === undefined || route.provider === undefined || route.model === undefined) {
      results.push({ memberId: member.id, name: member.name, applied: false, note: 'no provider/model could be read for this session' })
      continue
    }
    try {
      await controller.selectModel({
        sessionId: member.id,
        provider: route.provider,
        model: route.model,
        reasoningEffort: wanted,
      })
      results.push({ memberId: member.id, name: member.name, applied: true, note: "effective from the session's next step" })
    } catch (error) {
      results.push({ memberId: member.id, name: member.name, applied: false, note: errorMessage(error) })
    }
  }
  return { ok: true, results }
}

/** Register the model-facing tools. */
function registerTools(ctx, state) {
  const commit = () => writeLedger(state.root, state.ledger)
  const has = (key) => {
    try {
      return ctx.get(key) !== undefined
    } catch {
      // An undeclared read throws rather than returning undefined, so a
      // capability this plugin did not declare is simply reported as absent.
      return false
    }
  }

  ctx.tools.register(
    defineTool({
      name: 'attention_probe',
      description:
        'Report the DSH runtime capabilities dsh-attention-group depends on: live agents, the group ledger location and reachability, and which optional services this deployment offers. Use it to diagnose why a group feature is unavailable.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            plugin: { type: 'string', required: true },
            dataRoot: { type: 'string', required: true },
            groups: { type: 'number', required: true },
            liveAgents: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  status: { type: 'string' },
                  self: { type: 'boolean' },
                },
              },
            },
            capabilities: {
              type: 'object',
              required: true,
              additionalProperties: false,
              properties: {
                workspaceRegistry: { type: 'boolean', required: true },
                commands: { type: 'boolean', required: true },
                storageDomain: { type: 'boolean', required: true },
                webServer: { type: 'boolean', required: true },
                systemPrompt: { type: 'boolean', required: true },
                sessionPersistence: { type: 'boolean', required: true },
              },
            },
            deliveryAudit: {
              type: 'object',
              required: true,
              additionalProperties: false,
              properties: {
                total: { type: 'number', required: true },
                recent: {
                  type: 'array',
                  required: true,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      at: { type: 'string' },
                      memberId: { type: 'string' },
                      delivered: { type: 'boolean' },
                      path: { type: 'string' },
                      note: { type: 'string' },
                    },
                  },
                },
              },
            },
            panelRoute: {
              type: 'object',
              required: true,
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                status: { type: 'string', required: true },
                // How many times the inject child fiber activated the route. >1 is
                // normal; it is published so a re-activation is a fact, not a
                // mystery. Optional: older hosts never set it.
                activations: { type: 'number' },
              },
            },
            // R6: whether the unread line can reach a member's prompt at all, and
            // how many rooms opted in. Same rule as the route above — a capability
            // that is silently unavailable has to say so (c7 ②).
            promptContext: {
              type: 'object',
              required: true,
              additionalProperties: false,
              properties: {
                status: { type: 'string', required: true },
                rooms: { type: 'number', required: true },
              },
            },
            // U3's answer, reported here because "the effort switch did nothing to
            // my running session" must never be a mystery (c7 ②). `available`
            // means this deployment can change a live session's effort; anything
            // else is the reason it cannot.
            liveEffortControl: { type: 'string', required: true },
            // Transcripts on disk that the ledger does not list. After a
            // corrupt-ledger recovery the rooms look gone while every message is
            // still there, so this is the line that answers "did I lose my
            // history?" with a fact instead of a guess.
            orphanedTranscripts: {
              type: 'array',
              required: true,
              items: { type: 'string' },
            },
          },
        },
        render: (_args, value) => {
          const lines = [`plugin: ${value.plugin}`, `data root: ${value.dataRoot}`, `groups: ${value.groups}`]
          lines.push(
            `capabilities: ${Object.entries(value.capabilities)
              .map(([key, ok]) => `${key}=${ok ? 'yes' : 'no'}`)
              .join(' ')}`,
          )
          lines.push(
            value.liveEffortControl === 'available'
              ? 'live effort control: available (a room may change a live session\'s effort with liveEffort)'
              : `live effort control: NOT available — ${value.liveEffortControl}`,
          )
          // A deployment with three hundred live sessions must not turn this
          // diagnostic into a three-hundred-line tool result that is then
          // replayed into every later request of the session (c4). The COUNT is
          // always the real one; only the listing is trimmed, and it says so.
          const AGENT_ROWS = 20
          lines.push(`live agents (${value.liveAgents.length}):`)
          for (const row of value.liveAgents.slice(0, AGENT_ROWS)) {
            lines.push(`  ${row.self ? '* ' : '  '}${singleLine(row.id, 120)}\t${singleLine(row.status ?? '?', 40)}`)
          }
          if (value.liveAgents.length > AGENT_ROWS) {
            lines.push(`  … ${value.liveAgents.length - AGENT_ROWS} more live session(s) omitted from this view; the count above is the real one`)
          }
          // The wake-up audit is the answer to "did it actually get delivered?".
          lines.push(`wake-up attempts logged: ${value.deliveryAudit.total}`)
          for (const row of value.deliveryAudit.recent) {
            lines.push(
              `  ${singleLine(row.at, 40) || '?'}\t${singleLine(row.memberId, 80) || '?'}\t${row.delivered === true ? 'delivered' : 'NOT delivered'}\t${singleLine(row.path, 40) || '?'}${row.note === undefined ? '' : `\t${singleLine(row.note, 200)}`}`,
            )
          }
          // Why the panel is or is not reachable. Without this line a missing
          // panel reads as "you have no groups yet".
          lines.push(`panel route: ${value.panelRoute.path} -> ${value.panelRoute.status}`)
          lines.push(
            `unread-in-prompt: ${value.promptContext.status}${value.promptContext.rooms > 0 ? ` (${value.promptContext.rooms} room(s) opted in)` : ''}`,
          )
          if (value.orphanedTranscripts.length > 0) {
            lines.push(
              `transcripts on disk that the ledger does not list: ${value.orphanedTranscripts.length} — the messages still exist, only the room entry is missing (${value.orphanedTranscripts.slice(0, 5).join(', ')}${value.orphanedTranscripts.length > 5 ? ', …' : ''})`,
            )
          }
          return textBlocks(lines)
        },
      },
      execute(_args, exec) {
        const self = exec.agent?.id
        const liveAgents = ctx.agents.list().map((agent) => ({
          id: String(agent.id),
          ...(typeof agent.status === 'string' ? { status: agent.status } : {}),
          self: agent.id === self,
        }))
        return {
          plugin: `${name}@${VERSION}`,
          dataRoot: state.root,
          groups: state.ledger.groups.length,
          liveAgents,
          capabilities: {
            workspaceRegistry: has('workspaceRegistry'),
            commands: has('commands'),
            storageDomain: has('storageDomain'),
            webServer: has('webServer'),
            systemPrompt: has('systemPrompt'),
            sessionPersistence: has('sessionPersistence'),
          },
          // U3: whether this deployment can change a LIVE session's effort.
          liveEffortControl: state.effortStatus ?? 'unknown',
          deliveryAudit: (() => {
            const all = readDeliveries(state.root, { limit: 0 })
            return {
              total: all.length,
              // ⚠️ Every field is defaulted, not passed through. A hand-edited or
              // truncated `deliveries.jsonl` can hold a line like `{}`; forwarding
              // its absent keys would put `undefined` in the result, and `undefined`
              // is not lossless JSON — so the runtime would reject this diagnostic
              // tool's entire answer with `ToolOutputError`. The one tool whose job
              // is explaining what went wrong must not be the one that breaks.
              recent: all.slice(-5).map((row) => ({
                at: typeof row.at === 'string' ? row.at : '',
                memberId: typeof row.memberId === 'string' ? row.memberId : '',
                delivered: row.delivered === true,
                path: typeof row.path === 'string' ? row.path : '',
                ...(typeof row.note === 'string' ? { note: row.note } : {}),
              })),
            }
          })(),
          panelRoute: {
            path: '/attention-group',
            status: typeof state.routeStatus === 'string' ? state.routeStatus : 'not attempted',
            // >1 means the inject child fiber activated more than once. That is
            // normal (a dependency can be re-composed); the registration is
            // idempotent, so the last activation owns the live route.
            ...(state.routeAttempts > 0 ? { activations: state.routeAttempts } : {}),
          },
          // R6: whether the unread line can reach a member's prompt at all. A
          // deployment without `systemPrompt` degrades to "the panel still shows
          // unread, the agent just is not told" — and this line says so.
          promptContext: {
            status: typeof state.promptStatus === 'string' ? state.promptStatus : 'not attempted',
            rooms: state.ledger.groups.filter((group) => group.promptUnread === true).length,
          },
          // The one caller of `transcriptGroupIds`. A transcript whose room is not
          // in the ledger is history the user still has: after a corrupt-ledger
          // recovery the panel shows an empty room list, and without this line
          // nothing anywhere says the messages survived. Reported as a fact, with
          // the count, rather than inferred from the empty ledger.
          //
          // ⚠️ `deliveries` is the wake-up audit log, not a room transcript — it
          // lives in the same directory and `transcriptGroupIds` has no way to
          // tell. Counting it as an orphan made the probe report "1 transcript the
          // ledger does not list" on a perfectly healthy deployment (measured on
          // 0.2.1-rc.1, 2026-10-17). A diagnostic that cries wolf once is a
          // diagnostic people stop reading.
          orphanedTranscripts: (() => {
            const known = new Set(state.ledger.groups.map((group) => group.id))
            return transcriptGroupIds(state.root).filter((id) => id !== 'deliveries' && !known.has(id))
          })(),
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'attention_probe_session',
      description:
        'Report whether one session can be woken by this plugin: whether it is live, whether its stored route (provider/model/reasoning effort) is readable from the session log, and what the wake-up attempt would do. Read-only unless resume=true, which performs a REAL cold resume and starts a turn — only use that when you intend to spend tokens in that session.',
      parameters: {
        sessionId: { type: 'string', required: true, description: 'Session id to inspect.' },
        resume: {
          type: 'boolean',
          description: 'Actually attempt a cold resume. Default false: report the plan only. This starts a real agent loop and costs tokens.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            sessionId: { type: 'string', required: true },
            live: { type: 'boolean', required: true },
            sessionQueryAvailable: { type: 'boolean', required: true },
            route: {
              type: 'object',
              additionalProperties: false,
              properties: {
                provider: { type: 'string' },
                model: { type: 'string' },
                reasoningEffort: { type: 'string' },
              },
            },
            wouldDo: { type: 'string', required: true },
            resumeAttempted: { type: 'boolean', required: true },
            resumed: { type: 'boolean' },
            note: { type: 'string' },
            // ⚠️ Every other tool in this file declares `error`, and this one did
            // not, while its own failure branch returns `{ok:false, error}`. The
            // schema is enforced by the runtime AFTER execute (`createSuccessResult`
            // → `validateJsonSchemaValue`), so a perfectly well-behaved refusal —
            // an empty sessionId, reachable with no bad data at all — threw
            // `ToolOutputError: "value.error" is not a declared property` instead of
            // reaching the model as the sentence written below. A failure branch is
            // still a return value; it has to satisfy the contract too.
            error: { type: 'string' },
          },
        },
        render: (_args, value) => {
          if (value.ok !== true) return textBlock(`failed: ${value.error ?? 'unknown error'}`)
          const lines = [
            `${value.sessionId}: ${value.live ? 'live' : 'stored'}`,
            `session query: ${value.sessionQueryAvailable ? 'available' : 'UNAVAILABLE'}`,
            `route: ${value.route === undefined ? 'unknown' : `${value.route.provider}/${value.route.model}${value.route.reasoningEffort === undefined ? '' : ` @${value.route.reasoningEffort}`}`}`,
            `would do: ${value.wouldDo}`,
            `resume attempted: ${value.resumeAttempted === true ? 'yes' : 'no'}`,
          ]
          if (value.resumed === true) lines.push('resumed: YES — the session now has a live agent loop')
          if (value.note !== undefined) lines.push(`note: ${value.note}`)
          return textBlocks(lines)
        },
      },
      async execute(args) {
        const sessionId = String(args.sessionId ?? '').trim()
        if (sessionId.length === 0) return { ok: false, sessionId, live: false, sessionQueryAvailable: false, wouldDo: 'nothing', resumeAttempted: false, error: 'sessionId is required' }

        const live = ctx.agents.get(sessionId) !== undefined
        let query
        try {
          query = ctx.get('sessionQuery')
        } catch {
          query = undefined
        }
        const route = await lastKnownRoute(ctx, sessionId)

        let wouldDo
        if (live) wouldDo = 'a follow-up into the live loop (no resume needed)'
        else if (route === undefined) wouldDo = 'refuse: the session is offline and its route cannot be read'
        else wouldDo = `cold resume as ${route.provider}/${route.model}, then deliver one message`

        const base = { ok: true, sessionId, live, sessionQueryAvailable: query !== undefined, wouldDo, resumeAttempted: false }
        if (args.resume !== true) {
          return { ...base, ...(route === undefined ? {} : { route }) }
        }
        if (live) return { ...base, resumeAttempted: true, resumed: false, note: 'already live; a resume would create a duplicate loop, so it was skipped' }
        if (route === undefined) return { ...base, resumeAttempted: true, resumed: false, note: 'no route available' }
        try {
          // ⚠️ `setup` is NOT optional, and this branch used to omit it.
          //
          // `ctx.agents.resume` without `setup` gives the session the DEPLOYMENT
          // DEFAULT preset instead of its own, which silently REPLACES its
          // toolset. Measured 2026-10-16 (c6): a peer agent came back with
          // `read`/`glob`/`grep`/`pwsh` all reporting as unknown tools, i.e. a
          // diagnostic call stripped someone else's working environment. The
          // delivery path was fixed then; this probe path was not, so the same
          // accident was still reachable through the very tool built to check
          // whether resuming works.
          const launch = await composeLaunch(ctx, sessionId, undefined)
          if (launch.agentOptions.provider === undefined || launch.agentOptions.model === undefined) {
            return { ...base, route, resumeAttempted: true, resumed: false, note: 'no provider/model could be resolved for a resume' }
          }
          const handle = await ctx.agents.resume({
            resumeSessionId: sessionId,
            agentOptions: launch.agentOptions,
            ...(launch.setup === undefined ? {} : { setup: launch.setup }),
          })
          return {
            ...base,
            route,
            resumeAttempted: true,
            resumed: true,
            note: `resumed ${String(handle.agent.id)} with preset=${launch.preset ?? 'default'}${launch.setup === undefined ? ' (NO SETUP — this session may have the wrong toolset)' : ''}`,
          }
        } catch (error) {
          return { ...base, route, resumeAttempted: true, resumed: false, note: `resume failed: ${errorMessage(error)}` }
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'attention_group_create',
      description:
        'Create a chat room. The room is written to durable storage immediately and survives restart. Nothing is woken by this call. The creating session joins as a member. Routing defaults to rules-only and waking defaults to disabled.',
      parameters: {
        title: { type: 'string', required: true, description: 'Human-readable room title.' },
        charter: { type: 'string', description: 'Room charter shown to every member when it is woken.' },
        wakeEnabled: {
          type: 'boolean',
          description: 'Allow this room to actually start turns in member sessions. Default false: routing is computed and reported, but nobody is woken.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            groupId: { type: 'string' },
            title: { type: 'string' },
            error: { type: 'string' },
          },
        },
        render: (_args, value) =>
          value.ok === true
            ? textBlock(`created group ${value.groupId} (${value.title})`)
            : textBlock(`failed: ${value.error ?? 'unknown error'}`),
      },
      execute(args, exec) {
        const title = typeof args.title === 'string' ? args.title.trim() : ''
        if (title.length === 0) return { ok: false, error: 'title is required' }
        const group = newGroup(title, { charter: args.charter, wakeEnabled: args.wakeEnabled === true, existing: state.ledger.groups })
        // The creator always joins, regardless of policy: a room whose maker is
        // not in it is, under the default `members` policy, a room nobody can
        // ever add anyone to — dead on arrival.
        if (exec.agent !== undefined) {
          group.members.push(newMember({ id: String(exec.agent.id), kind: 'session' }))
        }
        state.ledger.groups.push(group)
        commit()
        return { ok: true, groupId: group.id, title: group.title }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'attention_group_list',
      description:
        'List the groups this session belongs to, with each group\'s UNREAD count for this session and a preview of its newest message. Groups keep their own transcripts and nothing is ever pushed into your session, so this is the index you consult to decide which room is worth reading right now. Reading a room is attention_history.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            unreadTotal: { type: 'number', required: true },
            groups: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  title: { type: 'string' },
                  members: { type: 'number' },
                  routeMode: { type: 'string' },
                  wakeEnabled: { type: 'boolean' },
                  messages: { type: 'number' },
                  memberNames: { type: 'array', items: { type: 'string' } },
                  unread: { type: 'number', required: true },
                  joined: { type: 'boolean', required: true },
                  lastAt: { type: 'string' },
                  lastFrom: { type: 'string' },
                  lastPreview: { type: 'string' },
                },
              },
            },
          },
        },
        render: (_args, value) => {
          if (value.groups.length === 0) return textBlock('no groups yet — create one with attention_group_create')
          const lines = [
            value.unreadTotal === 0
              ? 'all caught up: no unread group messages'
              : `${value.unreadTotal} unread group message(s) across ${value.groups.filter((g) => g.unread > 0).length} group(s)`,
          ]
          for (const group of value.groups) {
            const badge = group.unread > 0 ? `\u2749 ${group.unread} unread` : 'caught up'
            lines.push(
              `${group.id}\t${group.title ?? '-'}\t${badge}\tmsgs=${group.messages}\twake=${group.wakeEnabled === true ? 'on' : 'off'}${group.joined === true ? '' : '\t[not a member]'}`,
            )
            if (group.lastPreview !== undefined) {
              lines.push(`    latest ${group.lastAt ?? '?'} <${group.lastFrom ?? '?'}> ${group.lastPreview}`)
            }
          }
          lines.push('')
          lines.push('Nothing was pushed into this session. Read a room with attention_history.')
          return textBlocks(lines)
        },
      },
      execute(_args, exec) {
        const me = exec.agent === undefined ? undefined : String(exec.agent.id)
        let unreadTotal = 0
        const groups = state.ledger.groups.map((group) => {
          const all = readMessages(state.root, group.id, { limit: 0 })
          const member = group.members.find((candidate) => candidate.id === me)
          // A session that never read a room has every message unread. A session
          // that is not a member sees the room but is not counted: membership is
          // what makes a room's backlog yours.
          //
          // ⚠️ This used to hand-roll the same filter `countUnread` does, and the
          // two drifted: this copy did not exclude the member's OWN messages, so
          // an agent that had just posted showed itself an unread badge for its
          // own words — the exact symptom of adversarial audit B-08 (2026-10-16).
          // Two implementations of one rule is one implementation too many, so it
          // now delegates. (Same lesson as c15: fixing `countUnread` alone would
          // have fixed a path nobody reads.)
          const unread =
            member === undefined
              ? 0
              : countUnread(state.root, group.id, member, undefined) ?? all.length
          unreadTotal += unread
          const last = all.length > 0 ? all[all.length - 1] : undefined
          return {
            id: group.id,
            title: group.title,
            members: group.members.length,
            routeMode: group.routeMode,
            wakeEnabled: group.wakeEnabled === true,
            messages: all.length,
            memberNames: group.members.map((m) => m.name),
            unread,
            joined: member !== undefined,
            ...(last === undefined
              ? {}
              : {
                  lastAt: last.at,
                  lastFrom: last.fromName,
                  lastPreview: String(last.text).replace(/\s+/gu, ' ').slice(0, 80),
                }),
          }
        })
        return { unreadTotal, groups }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'attention_group_join',
      description:
        'Add a member to a group, or update an existing member. A session member is identified by its session id; non-session members (user, admin, bot, liaison) may use any stable id. Nothing is woken by this call. Whether you may add anyone is the group\'s own `joinPolicy` setting (开放 / 群成员 / 仅用户 / 冻结), so a refusal here is a permission answer, not a bug — the panel shows and changes that setting.',
      parameters: {
        groupId: { type: 'string', required: true },
        memberId: { type: 'string', required: true, description: 'Session id, or a stable id for a non-session member.' },
        memberName: { type: 'string', description: 'Display name used for @mentions. Defaults to a short id prefix.' },
        kind: { type: 'string', description: 'Member kind: session (default), user, admin, bot, liaison.' },
        subscribe: {
          type: 'array',
          description: 'Focus terms: this member is woken by a message containing any of them. Plain text, or /regex/flags.',
          items: { type: 'string' },
        },
        wakeEffort: { type: 'string', description: 'Reasoning effort used when this member is woken for a group message.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            groupId: { type: 'string' },
            memberId: { type: 'string' },
            name: { type: 'string' },
            members: { type: 'number' },
            error: { type: 'string' },
          },
        },
        render: (_args, value) =>
          value.ok === true
            ? textBlock(`${value.memberId} is in ${value.groupId} as "${value.name}" (${value.members} members)`)
            : textBlock(`failed: ${value.error ?? 'unknown error'}`),
      },
      execute(args, exec) {
        let group
        try {
          group = requireGroup(state.ledger, args.groupId)
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) }
        }
        // R8: members may invite, but the user controls that with a per-group
        // setting. The actor is whoever called the tool, so a non-member cannot
        // walk into someone else's room under the default policy.
        const actorId = exec.agent === undefined ? undefined : String(exec.agent.id)
        const verdict = mayInvite(group, actorId)
        if (!verdict.allowed) {
          return { ok: false, error: `refused: ${verdict.reason}` }
        }
        const memberId = String(args.memberId ?? '').trim()
        if (memberId.length === 0) return { ok: false, error: 'memberId is required' }
        const existing = group.members.find((member) => member.id === memberId)
        if (existing === undefined) {
          group.members.push(
            newMember({
              id: memberId,
              name: args.memberName,
              kind: args.kind,
              subscribe: args.subscribe,
              wakeEffort: args.wakeEffort,
            }),
          )
        } else {
          if (typeof args.memberName === 'string') existing.name = args.memberName
          if (typeof args.kind === 'string') existing.kind = args.kind
          if (Array.isArray(args.subscribe)) existing.subscribe = args.subscribe.filter((t) => typeof t === 'string')
          if (typeof args.wakeEffort === 'string') existing.wakeEffort = args.wakeEffort
          existing.enabled = true
        }
        commit()
        const member = group.members.find((candidate) => candidate.id === memberId)
        return { ok: true, groupId: group.id, memberId: member.id, name: member.name, members: group.members.length }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'attention_send',
      description:
        'Post a message to a group. The message is appended to the durable log first, then the attention router decides who it is worth waking, and the plan is returned. This call does not wake anyone unless wake=true AND the group has waking enabled — that is what makes "an irrelevant message costs zero turns" a property rather than a hope.',
      parameters: {
        groupId: { type: 'string', required: true },
        text: { type: 'string', required: true, description: 'Message body. @Name mentions are extracted from it.' },
        wake: {
          type: 'boolean',
          description: 'Actually deliver to the routed members. Default false (plan only). The group must also have wakeEnabled=true.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            seq: { type: 'number' },
            groupId: { type: 'string' },
            silent: { type: 'boolean' },
            mode: { type: 'string' },
            // R4's second stage: in `classify` mode the router reports the
            // members it could NOT decide about instead of guessing. Surfacing
            // them is the whole difference between `classify` and `rules` — a
            // mode whose output nobody reads is a mode that does nothing.
            greyZone: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  memberId: { type: 'string' },
                  name: { type: 'string' },
                },
              },
            },
            woken: { type: 'boolean' },
            recipients: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  name: { type: 'string' },
                  memberId: { type: 'string' },
                  reason: { type: 'string' },
                  detail: { type: 'string' },
                  delivered: { type: 'boolean' },
                  note: { type: 'string' },
                },
              },
            },
            // R10: what each outgoing liaison did with this message, refusals
            // included. A link that silently does nothing is the hardest kind of
            // broken to notice.
            relayed: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  linkId: { type: 'string' },
                  to: { type: 'string' },
                  relayed: { type: 'boolean' },
                  seq: { type: 'number' },
                  reason: { type: 'string' },
                  hops: { type: 'number' },
                  mentions: { type: 'array', items: { type: 'string' } },
                  woken: { type: 'boolean' },
                  delivered: { type: 'number' },
                  note: { type: 'string' },
                  via: { type: 'array', items: { type: 'string' } },
                },
              },
            },
            // The two @所有人 gates, published as facts: `allMention` says whether
            // the message really addressed everyone; `allMentionNote` names the gate
            // that refused it when the text asked and could not.
            allMention: { type: 'boolean' },
            allMentionNote: { type: 'string' },
            error: { type: 'string' },
          },
        },
        render: (_args, value) => {
          if (value.ok !== true) return textBlock(`failed: ${value.error ?? 'unknown error'}`)
          const lines = [`posted seq=${value.seq} to ${value.groupId} (route=${value.mode})`]
          if (value.allMention === true) {
            lines.push('mention: the whole room (@所有人) — every enabled member was addressed')
          }
          if (typeof value.allMentionNote === 'string' && value.allMentionNote.length > 0) {
            lines.push(`mention note: ${value.allMentionNote}`)
          }
          if (value.silent === true) {
            lines.push('routing: SILENT — nobody matched, zero turns spent')
          } else {
            lines.push(
              `routing: ${value.recipients.length} recipient(s)${value.woken === true ? ' — delivered' : ' — plan only, nothing woken'}`,
            )
            for (const row of value.recipients) {
              const extra = row.note === undefined ? '' : ` (${row.note})`
              lines.push(
                `  ${row.name}\t${row.reason}${row.detail === undefined ? '' : `:${row.detail}`}\t${row.delivered === true ? 'delivered' : 'not-woken'}${extra}`,
              )
            }
          }
          if (Array.isArray(value.greyZone) && value.greyZone.length > 0) {
            lines.push(
              `grey zone (route=${value.mode}): ${value.greyZone.map((row) => row.name).join(', ')} — nobody woken; mention them if this matters`,
            )
          }
          for (const row of value.relayed ?? []) {
            lines.push(
              row.relayed === true
                ? `  relay → ${row.to} as #${row.seq} (hops=${row.hops}, ${row.woken === true ? `woke ${row.delivered}` : 'nobody woken'}) — ${row.reason}`
                : `  relay → ${row.to} declined: ${row.reason}`,
            )
          }
          return textBlocks(lines)
        },
      },
      async execute(args, exec) {
        let group
        try {
          group = requireGroup(state.ledger, args.groupId)
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error), recipients: [], relayed: [], greyZone: [] }
        }
        const text = typeof args.text === 'string' ? args.text : ''
        if (text.trim().length === 0) return { ok: false, error: 'text is required', recipients: [], relayed: [], greyZone: [] }

        const senderId = exec.agent === undefined ? undefined : String(exec.agent.id)
        const sender = group.members.find((member) => member.id === senderId)
        const mentions = extractMentions(text, group.members.map((member) => member.name))

        // ⚠️ `@所有人` is the one phrase that can wake an entire room, so it is
        // gated TWICE and the gate is decided here, not in the router:
        //   - the room must opt in (`mentionAll`, default off), because a room
        //     where every member can wake everybody is a room nobody can afford;
        //   - the sender must be the human or a room admin, because "everybody"
        //     is a megaphone and handing it to every member by default is how a
        //     quiet room becomes noise.
        // When either gate is shut the message is still posted — the phrase just
        // stays plain text, and the answer SAYS which gate refused it (c7: no
        // silent downgrade of a feature the sender believed in).
        const askedAll = hasMentionAll(text)
        // ⚠️ STRICT on purpose: an UNKNOWN sender is not allowed. A megaphone that
        // anyone can pick up by calling the tool without being a member is worse
        // than no megaphone at all. The sender must be a real room member whose
        // kind is `user` (the human) or `admin` — a session member's `@所有人` stays
        // plain text even after the room opts in.
        const senderKind = typeof sender?.kind === 'string' ? sender.kind : ''
        const senderMayAddressAll = sender !== undefined && (senderKind === 'user' || senderKind === 'admin')
        const allMention = askedAll && group.mentionAll === true && senderMayAddressAll
        const allMentionNote = !askedAll
          ? undefined
          : allMention
            ? undefined
            : group.mentionAll !== true
              ? 'text says @所有人, but 「允许 @所有人」 is off for this room — only the @-named members were addressed'
              : '@所有人 was ignored: only a room member who is the human or an admin may address everyone'

        const record = {
          seq: nextSeq(state.root, group.id),
          at: new Date().toISOString(),
          fromId: senderId,
          fromName: sender?.name ?? (senderId === undefined ? 'system' : String(senderId).slice(0, 12)),
          text,
          mentions,
          ...(allMention ? { allMention: true } : {}),
        }
        appendMessage(state.root, group.id, record)

        const plan = route({ group, message: record, excludeMemberId: senderId })
        const wantWake = args.wake === true && group.wakeEnabled === true
        const recipients = []

        for (const target of plan.recipients) {
          const member = group.members.find((candidate) => candidate.id === target.memberId)
          const row = {
            name: target.name,
            memberId: target.memberId,
            reason: target.reason,
            ...(target.detail === undefined ? {} : { detail: target.detail }),
            delivered: false,
          }
          if (!wantWake) {
            row.note = args.wake === true ? 'waking disabled for this group' : 'dry run'
            recipients.push(row)
            continue
          }
          const outcome = await deliver(ctx, state, group, member, record, target)
          row.delivered = outcome.delivered
          if (outcome.note !== undefined) row.note = outcome.note
          recipients.push(row)
        }

        let readMoved = false
        // The sender has by definition seen its own message: counting it as the
        // sender's unread would inflate every room's badge for its most active
        // member.
        if (sender !== undefined) {
          sender.lastReadAt = record.at
          readMoved = true
        }
        if (wantWake) {
          for (const row of recipients) {
            const member = group.members.find((candidate) => candidate.id === row.memberId)
            if (member !== undefined) member.lastReadAt = record.at
          }
          readMoved = true
        }
        if (readMoved) commit()

        // R10: carry it into any room this one links to. This happens AFTER the
        // local routing is decided, so the local answer cannot be changed by a
        // link, and it is reported whether or not anything moved.
        const relayed = await relayMessage(ctx, state, group, record)

        return {
          ok: true,
          seq: record.seq,
          groupId: group.id,
          silent: plan.silent,
          mode: plan.mode,
          greyZone: Array.isArray(plan.greyZone) ? plan.greyZone : [],
          woken: wantWake,
          recipients,
          relayed,
          // Whether the message actually addressed the whole room, and — when the
          // text asked for it but a gate refused — why (c7: no silent downgrade).
          allMention: allMention === true,
          ...(allMentionNote === undefined ? {} : { allMentionNote }),
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'attention_history',
      description:
        "Read a group's durable message log, oldest-first, and mark the reading session as caught up. Use it after a wake-up hint, or to review a period before summarising it.",
      parameters: {
        groupId: { type: 'string', required: true },
        limit: { type: 'number', description: 'How many of the newest messages to return. Default 20.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            groupId: { type: 'string' },
            total: { type: 'number' },
            messages: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  seq: { type: 'number' },
                  at: { type: 'string' },
                  fromName: { type: 'string' },
                  text: { type: 'string' },
                  mentions: { type: 'array', items: { type: 'string' } },
                },
              },
            },
            error: { type: 'string' },
          },
        },
        render: (_args, value) => {
          if (value.ok !== true) return textBlock(`failed: ${value.error ?? 'unknown error'}`)
          const header = `${value.groupId}: ${value.messages.length} of ${value.total} message(s)`
          const all = value.messages.map((row) => `#${row.seq} ${row.at} <${row.fromName}> ${row.text}`)
          // Keep the NEWEST lines when the cap bites: the tail is what a wake-up
          // hint refers to, and the notice states how much was dropped. The
          // budget is explicit so the header and the notice always fit.
          const budget = MAX_RENDER_LINES - 1
          const kept = all.slice(Math.max(0, all.length - budget))
          const lines = [header, ...kept]
          if (kept.length < all.length) {
            while (lines.length >= MAX_RENDER_LINES) lines.splice(1, 1)
            lines.splice(1, 0, `… ${all.length - (lines.length - 1)} older line(s) omitted from this view; the log keeps everything`)
          }
          return textBlocks(lines)
        },
      },
      execute(args, exec) {
        let group
        try {
          group = requireGroup(state.ledger, args.groupId)
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            messages: [],
            total: 0,
            groupId: args.groupId,
          }
        }
        // Clamped to the render cap: a request for 10,000 messages would return
        // a projection that is truncated anyway, and the read itself is the
        // expensive half. The durable log keeps everything either way.
        const requested = typeof args.limit === 'number' && args.limit > 0 ? Math.floor(args.limit) : 20
        const limit = Math.min(requested, MAX_RENDER_LINES)
        const all = readMessages(state.root, group.id, { limit: 0 })
        const readerId = exec.agent === undefined ? undefined : String(exec.agent.id)
        const reader = group.members.find((member) => member.id === readerId)
        if (reader !== undefined && all.length > 0) {
          reader.lastReadAt = all[all.length - 1].at
          commit()
        }
        return {
          ok: true,
          groupId: group.id,
          total: all.length,
          messages: all.slice(-limit).map((row) => ({
            seq: row.seq,
            at: row.at,
            fromName: row.fromName,
            text: row.text,
            mentions: Array.isArray(row.mentions) ? row.mentions : [],
          })),
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'attention_conclude',
      description:
        "Sink one CONCLUSION into the group's own public file, and append it to the group record. This is how a decision stops living only in a chat log: it lands in a markdown file on disk that outlives this plugin. It does NOT wake anybody — sinking is not speaking; use attention_send if the room also needs to hear about it.",
      parameters: {
        groupId: { type: 'string', required: true },
        text: { type: 'string', required: true, description: 'The conclusion itself. Multi-line is fine; it stays one list item.' },
        author: { type: 'string', description: "Who concluded it. Defaults to the calling session's name in this group." },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            groupId: { type: 'string' },
            seq: { type: 'number' },
            path: { type: 'string' },
            bytes: { type: 'number' },
            conclusions: { type: 'number' },
            created: { type: 'boolean' },
            memoryNote: { type: 'string' },
            relayed: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  linkId: { type: 'string' },
                  to: { type: 'string' },
                  relayed: { type: 'boolean' },
                  seq: { type: 'number' },
                  reason: { type: 'string' },
                  hops: { type: 'number' },
                  mentions: { type: 'array', items: { type: 'string' } },
                  woken: { type: 'boolean' },
                  delivered: { type: 'number' },
                  note: { type: 'string' },
                  via: { type: 'array', items: { type: 'string' } },
                },
              },
            },
            error: { type: 'string' },
          },
        },
        render: (_args, value) =>
          value.ok === true
            ? textBlocks([
                `concluded in ${value.groupId} (message #${value.seq})`,
                `sunk to ${value.path} — ${value.bytes} B, ${value.conclusions} conclusion(s) in that file`,
                ...(typeof value.memoryNote === 'string' && value.memoryNote.length > 0 ? [value.memoryNote] : []),
                ...(value.relayed ?? []).map((row) =>
                  row.relayed === true
                    ? `relay → ${row.to} as #${row.seq} (hops=${row.hops}, ${row.woken === true ? `woke ${row.delivered}` : 'nobody woken'})`
                    : `relay → ${row.to} declined: ${row.reason}`,
                ),
              ])
            : textBlock(`failed: ${value.error ?? 'unknown error'}`),
      },
      async execute(args, exec) {
        let group
        try {
          group = requireGroup(state.ledger, args.groupId)
        } catch (error) {
          return { ok: false, error: errorMessage(error), relayed: [] }
        }
        if (group.sinkEnabled === false) {
          return { ok: false, error: `conclusion sinking is off for group ${group.id}; turn on 「结论沉淀」 in the panel`, relayed: [] }
        }
        const text = typeof args.text === 'string' ? args.text.trim() : ''
        if (text.length === 0) return { ok: false, error: 'text is required', relayed: [] }

        const author =
          typeof args.author === 'string' && args.author.trim().length > 0
            ? args.author.trim()
            : memberNameOf(group, exec.agent)
        const at = new Date().toISOString()
        let sunk
        try {
          sunk = sinkConclusion({ root: state.root, group, at, author, text })
        } catch (error) {
          return { ok: false, error: `cannot write the conclusion file: ${errorMessage(error)}`, relayed: [] }
        }
        const record = {
          seq: nextSeq(state.root, group.id),
          at,
          fromId: exec.agent === undefined ? 'unknown' : String(exec.agent.id),
          fromName: author,
          text,
          kind: 'conclusion',
          mentions: [],
        }
        appendMessage(state.root, group.id, record)
        // R10: a conclusion is the default thing a liaison carries, so the relay
        // evaluation has to happen here too — otherwise `mode=只传结论` links
        // would never fire at all.
        const relayed = await relayMessage(ctx, state, group, record)
        return {
          ok: true,
          groupId: group.id,
          seq: record.seq,
          path: sunk.path,
          bytes: sunk.bytes,
          conclusions: countBullets(sunk.path),
          created: sunk.created,
          relayed,
          // The soft integration with task memory. It is a SENTENCE, not a call:
          // see sink.js. What makes it honest is that the sentence is only
          // written once the runtime has been asked whether the tool exists.
          ...(group.sinkMemory === true
            ? {
                memoryNote: hasTool(ctx, 'task_memory_write')
                  ? '这个群开了「同时写进任务记忆」：请把这条结论也写进任务记忆（decision 或 fact）。'
                  : '这个群开了「同时写进任务记忆」，但当前部署里没有任务记忆工具，已跳过（结论仍然写进了文件）。',
              }
            : {}),
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'attention_export',
      description:
        "Write a time range of a group's transcript to a markdown file and report where it landed. Use it to hand a room's decisions to a human, to another tool, or to version control. It never overwrites an existing file, and it never wakes anybody. Give `since`/`until` (ISO-8601) for a range, or neither for everything.",
      parameters: {
        groupId: { type: 'string', required: true },
        since: { type: 'string', description: 'ISO-8601 instant: only messages strictly after it are exported.' },
        until: { type: 'string', description: 'ISO-8601 instant: messages up to and including it are exported.' },
        limit: { type: 'number', description: 'Cap how many messages are written (newest kept). Default: all of them.' },
        path: {
          type: 'string',
          description: "Where to write: absolute, or relative to the group's sink folder. Default: an auto-named file there.",
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            groupId: { type: 'string' },
            path: { type: 'string' },
            bytes: { type: 'number' },
            messages: { type: 'number' },
            total: { type: 'number' },
            since: { type: 'string' },
            until: { type: 'string' },
            error: { type: 'string' },
          },
        },
        render: (_args, value) =>
          value.ok === true
            ? textBlocks([
                `exported ${value.messages}/${value.total} message(s) from ${value.groupId}`,
                `wrote ${value.path} (${value.bytes} B)`,
              ])
            : textBlock(`failed: ${value.error ?? 'unknown error'}`),
      },
      execute(args) {
        let group
        try {
          group = requireGroup(state.ledger, args.groupId)
        } catch (error) {
          return { ok: false, error: errorMessage(error) }
        }
        const all = readMessages(state.root, group.id, { limit: 0 })
        const since = typeof args.since === 'string' ? args.since : ''
        const until = typeof args.until === 'string' ? args.until : ''
        let picked = all.filter((row) => inRange(row, since, until))
        if (typeof args.limit === 'number' && args.limit > 0) picked = picked.slice(-Math.floor(args.limit))
        const at = new Date().toISOString()
        try {
          const written = sinkTranscript({ root: state.root, group, messages: picked, since, until, at, path: args.path })
          return {
            ok: true,
            groupId: group.id,
            path: written.path,
            bytes: written.bytes,
            messages: written.messages,
            total: all.length,
            since,
            until,
          }
        } catch (error) {
          return { ok: false, error: `cannot write the export: ${errorMessage(error)}` }
        }
      },
    }),
  )

  // ⚠️ Why this tool has to exist: delivery is ONE-WAY. `deliver()` hands a woken
  // member a `followup` message, and this plugin never sees the answer it writes
  // back. So a summary produced by the room's own manager has no way home unless
  // the member hands it back itself — that is this tool, the write-back half of
  // the manual 「生成群史摘要」 button (user decision 2026-10-17, memory d6).
  //
  // Recording a summary never wakes anybody, never deletes a message and never
  // touches the transcript: it appends one snapshot to `group.summaries`.
  ctx.tools.register(
    defineTool({
      name: 'attention_record_summary',
      description:
        "Store a room-history summary snapshot. Use it when you were asked to summarise a room (for example by the panel button 「生成群史摘要」): the summary you wrote is kept in the room record next to the message number it covers, while every original message stays exactly where it is. Recording is quiet — it wakes nobody and deletes nothing.",
      parameters: {
        groupId: { type: 'string', required: true, description: 'Which room the summary belongs to.' },
        text: {
          type: 'string',
          required: true,
          description: 'The summary itself. 300-800 characters is a good size; do not paste the transcript.',
        },
        upToSeq: {
          type: 'number',
          description: 'Last message number this summary covers. Omit to use the room\'s newest message.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            groupId: { type: 'string' },
            upToSeq: { type: 'number' },
            covered: { type: 'number' },
            summaries: { type: 'number' },
            error: { type: 'string' },
          },
        },
        render: (_args, value) =>
          value.ok === true
            ? textBlock(
                `summary stored in 「${String(value.groupId)}」: covers up to #${String(value.upToSeq)} (${String(value.covered)} message(s) summarised); the room now has ${String(value.summaries)} snapshot(s). No message was deleted.`,
              )
            : textBlock(`summary not stored: ${value.error ?? 'unknown error'}`),
      },
      execute(args, exec) {
        let group
        try {
          group = requireGroup(state.ledger, args.groupId)
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) }
        }
        const text = String(args.text ?? '').trim()
        if (text.length === 0) return { ok: false, error: 'text is required: the summary itself' }
        if (text.length > MAX_SUMMARY_CHARS) {
          return {
            ok: false,
            error: `text is ${text.length} characters; a summary must be at most ${MAX_SUMMARY_CHARS} — summarise it, do not paste the transcript`,
          }
        }
        const all = readMessages(state.root, group.id, { limit: 0 })
        const latestSeq = all.reduce(
          (max, row) => (Number.isFinite(row.seq) && row.seq > max ? row.seq : max),
          0,
        )
        if (latestSeq === 0) {
          return { ok: false, error: 'this room has no messages yet, so there is nothing to summarise' }
        }
        const wanted = Number.isFinite(args.upToSeq) ? Math.floor(args.upToSeq) : latestSeq
        const upToSeq = Math.max(0, Math.min(wanted, latestSeq))
        if (upToSeq === 0) return { ok: false, error: 'upToSeq must be a message number greater than 0' }
        const already = summarizedUpTo(group)
        const covered = all.filter(
          (row) => Number.isFinite(row.seq) && row.seq > already && row.seq <= upToSeq,
        ).length
        const record = {
          upToSeq,
          at: new Date().toISOString(),
          by: memberNameOf(group, exec?.agent),
          text,
          covered,
        }
        if (!Array.isArray(group.summaries)) group.summaries = []
        group.summaries.push(record)
        writeLedger(state.root, state.ledger)
        return { ok: true, groupId: group.id, upToSeq, covered, summaries: group.summaries.length }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'attention_digest',
      description:
        'Summarise a time range of a room WITHOUT a model and without waking anybody: who spoke how often, which conclusions were sunk, and the messages themselves. Use `range:"today"` for "今天这个群都交流了什么", or give `since`/`until`. This is the free half of summarising — you can answer from it directly, or hand it to attention_summarize and let the room\'s own manager write the prose.',
      parameters: {
        groupId: { type: 'string', required: true },
        range: { type: 'string', description: '"today" (local midnight to now), "24h", or "all" (default).' },
        since: { type: 'string', description: 'ISO-8601 instant; overrides `range` when given.' },
        until: { type: 'string', description: 'ISO-8601 instant; overrides `range` when given.' },
        limit: { type: 'number', description: 'How many messages to list (newest kept). Default 50, capped by the render budget.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            groupId: { type: 'string' },
            since: { type: 'string' },
            until: { type: 'string' },
            total: { type: 'number' },
            shown: { type: 'number' },
            omitted: { type: 'number' },
            text: { type: 'string' },
            error: { type: 'string' },
          },
        },
        render: (_args, value) => (value.ok === true ? textBlocks(String(value.text).split('\n')) : textBlock(`failed: ${value.error ?? 'unknown error'}`)),
      },
      execute(args) {
        let group
        try {
          group = requireGroup(state.ledger, args.groupId)
        } catch (error) {
          return { ok: false, error: errorMessage(error) }
        }
        const { since, until, invalid } = resolveRange({ range: args.range, since: args.since, until: args.until })
        // A period that could not be understood must be an error, not an empty
        // answer. "Nothing in that range" for a range nobody actually described is
        // a lie the caller cannot detect — adversarial audit A-10 (2026-10-16).
        if (invalid !== undefined) {
          return {
            ok: false,
            error: `${invalid} is not a date; pass an ISO-8601 instant (for example 2026-10-16T00:00:00.000Z) or use range "today" / "24h"`,
          }
        }
        const all = readMessages(state.root, group.id, { limit: 0 }).filter((row) => inRange(row, since, until))
        // The digest is a tool result, so it is bounded by construction: one line
        // per message plus a fixed header, and the cap leaves room for the header.
        const requested = typeof args.limit === 'number' && args.limit > 0 ? Math.floor(args.limit) : 50
        const limit = Math.min(requested, MAX_RENDER_LINES - 20)
        const digest = buildDigest({ group, messages: all, since, until, limit })
        return { ok: true, groupId: group.id, since, until, total: digest.total, shown: digest.shown, omitted: digest.omitted, text: digest.text }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'attention_summarize',
      description:
        'Ask a member of the room — by default its built-in administrator (kind=admin) — to write a summary of a time range. The request carries a ready-made digest, so the woken member answers in ONE turn instead of reading history first. Waking requires wake=true AND the room\'s wake switch; without both this is a dry run that reports the plan. The request itself is recorded in the room either way.',
      parameters: {
        groupId: { type: 'string', required: true },
        range: { type: 'string', description: '"today" (local midnight to now), "24h", or "all" (default).' },
        since: { type: 'string', description: 'ISO-8601 instant; overrides `range` when given.' },
        until: { type: 'string', description: 'ISO-8601 instant; overrides `range` when given.' },
        limit: { type: 'number', description: 'How many messages the digest carries (newest kept). Default 80.' },
        memberId: { type: 'string', description: 'Who should write it. Defaults to the room\'s first enabled kind=admin member.' },
        wake: { type: 'boolean', description: 'Actually deliver the request. Default false (dry run). The room must also have waking enabled.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            groupId: { type: 'string' },
            since: { type: 'string' },
            until: { type: 'string' },
            total: { type: 'number' },
            seq: { type: 'number' },
            summarizerId: { type: 'string' },
            summarizerName: { type: 'string' },
            delivered: { type: 'boolean' },
            path: { type: 'string' },
            note: { type: 'string' },
            request: { type: 'string' },
            error: { type: 'string' },
          },
        },
        render: (_args, value) => {
          if (value.ok !== true) return textBlock(`failed: ${value.error ?? 'unknown error'}`)
          // Kept as a defensive path only: `execute` now refuses an empty window
          // before anything is sent, so reaching this line with `total === 0`
          // would mean a caller hand-built the value. It must not claim nobody
          // was woken, because at this point in the old code that was a lie.
          if (value.total === 0) return textBlock(`nothing to summarise in ${value.groupId} for that range`)
          return textBlocks([
            `${value.summarizerName} (${value.summarizerId}) was asked to summarise ${value.total} message(s) of ${value.groupId}`,
            value.delivered === true ? `delivered via ${value.path}` : `NOT delivered: ${value.note ?? 'dry run'}`,
          ])
        },
      },
      async execute(args, exec) {
        let group
        try {
          group = requireGroup(state.ledger, args.groupId)
        } catch (error) {
          return { ok: false, error: errorMessage(error) }
        }
        const { since, until, invalid } = resolveRange({ range: args.range, since: args.since, until: args.until })
        // A period that could not be understood must be an error, not an empty
        // answer. "Nothing in that range" for a range nobody actually described is
        // a lie the caller cannot detect — adversarial audit A-10 (2026-10-16).
        if (invalid !== undefined) {
          return {
            ok: false,
            error: `${invalid} is not a date; pass an ISO-8601 instant (for example 2026-10-16T00:00:00.000Z) or use range "today" / "24h"`,
          }
        }
        const all = readMessages(state.root, group.id, { limit: 0 }).filter((row) => inRange(row, since, until))

        // Who writes it. An explicit id wins; otherwise the room's own built-in
        // administrator, which is what R9 means by "群管理自带".
        let summarizer
        if (typeof args.memberId === 'string' && args.memberId.trim().length > 0) {
          summarizer = group.members.find((member) => member.id === args.memberId.trim())
          if (summarizer === undefined) return { ok: false, error: `unknown member "${args.memberId}"` }
        } else {
          summarizer = group.members.find((member) => member.kind === 'admin' && member.enabled !== false)
          if (summarizer === undefined) {
            return {
              ok: false,
              error: `no enabled kind=admin member in 「${group.title}」, so this room has no 群管理 to summarise it; add one, or pass memberId`,
            }
          }
        }

        const requested = typeof args.limit === 'number' && args.limit > 0 ? Math.floor(args.limit) : 80
        const limit = Math.min(requested, MAX_RENDER_LINES - 20)
        const digest = buildDigest({ group, messages: all, since, until, limit })

        // ⚠️ An empty window is a REFUSAL, not a request to summarise nothing.
        //
        // This check used to live ONLY in `render`, i.e. after the request had
        // already been appended to the room and the summariser already woken — so
        // `range:"today"` on a quiet morning spent a real turn in someone else's
        // session, and then the tool's own text claimed "nobody was woken". Two
        // lies for the price of one: a burnt turn, and a diagnostic that denies
        // having spent it. Adversarial audit A-9 / B-09, 2026-10-16.
        if (digest.total === 0) {
          return {
            ok: false,
            error: `nothing to summarise in 「${group.title}」 for that range, so no summariser was woken and no request was recorded`,
            groupId: group.id,
            since,
            until,
            total: 0,
          }
        }

        const requester = memberNameOf(group, exec.agent)
        const at = new Date().toISOString()
        const record = {
          seq: nextSeq(state.root, group.id),
          at,
          fromId: exec.agent === undefined ? 'unknown' : String(exec.agent.id),
          fromName: requester,
          text: `请 ${summarizer.name} 总结${since.length > 0 || until.length > 0 ? '这段时间' : '全部'}的交流（${digest.total} 条）`,
          kind: 'summary-request',
          mentions: [summarizer.name],
        }
        appendMessage(state.root, group.id, record)

        const request = renderSummaryRequest({ group, digest, requester })
        const wantWake = args.wake === true && group.wakeEnabled === true
        // Say WHICH of the two switches is missing. "Nothing was sent" plus a
        // guess at the cause is how an hour gets spent on the wrong problem.
        const blocker =
          args.wake !== true
            ? group.wakeEnabled === true
              ? 'nothing was sent: pass wake=true to actually send it'
              : "nothing was sent: pass wake=true AND turn this room's waking on in the panel"
            : "nothing was sent: this room's waking switch is off (turn it on in the panel)"
        const outcome = wantWake
          ? await deliver(ctx, state, group, summarizer, record, { reason: REASON.summary, detail: `${digest.total} message(s)` }, request)
          : { delivered: false, path: 'dry-run', note: blocker }

        return {
          ok: true,
          groupId: group.id,
          since,
          until,
          total: digest.total,
          seq: record.seq,
          summarizerId: summarizer.id,
          summarizerName: summarizer.name,
          delivered: outcome.delivered === true,
          path: outcome.path,
          ...(outcome.note === undefined ? {} : { note: outcome.note }),
          request,
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'attention_link',
      description:
        'Manage this room\'s liaisons (R10): DIRECTED links that carry messages into another room. Call with `to` omitted to list them. A liaison never echoes: a forwarded message carries the trail of rooms it has passed through, and a link refuses to carry it back into any room already on that trail, so A→B→A cannot happen however the links are arranged. Forwarding also never wakes anyone unless the link says wake=true AND the target room has waking enabled.',
      parameters: {
        groupId: { type: 'string', required: true, description: 'The SENDING room: links live on the room they carry messages out of.' },
        to: { type: 'string', description: 'The target room id. Omit to just list the current links.' },
        mode: { type: 'string', description: '"conclusion" (default: only messages sunk as conclusions), "keyword", "mention", or "all".' },
        keywords: { type: 'array', description: 'For mode=keyword: terms to match (plain text or /regex/flags). For mode=mention: names to watch for.', items: { type: 'string' } },
        wake: { type: 'boolean', description: 'Also wake the routed members INSIDE the target room. Default false: the message is recorded there and nobody is disturbed.' },
        enabled: { type: 'boolean', description: 'Switch this link off without deleting it. Default true.' },
        maxHops: { type: 'number', description: 'How many rooms a message may pass through before links stop carrying it. Default 3.' },
        remove: { type: 'boolean', description: 'Delete the link to `to` instead of creating or updating it.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            groupId: { type: 'string' },
            to: { type: 'string' },
            mode: { type: 'string' },
            enabled: { type: 'boolean' },
            wake: { type: 'boolean' },
            keywords: { type: 'array', items: { type: 'string' } },
            removed: { type: 'boolean' },
            links: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string' },
                  to: { type: 'string' },
                  mode: { type: 'string' },
                  enabled: { type: 'boolean' },
                  wake: { type: 'boolean' },
                  keywords: { type: 'array', items: { type: 'string' } },
                  maxHops: { type: 'number' },
                },
              },
            },
            error: { type: 'string' },
          },
        },
        render: (_args, value) => {
          if (value.ok !== true) return textBlock(`failed: ${value.error ?? 'unknown error'}`)
          if (value.links.length === 0) return textBlock(`${value.groupId} links to nowhere`)
          return textBlocks([
            value.removed === true
              ? `removed the link ${value.groupId} → ${value.to}`
              : `links out of ${value.groupId}:`,
            ...value.links.map(
              (link) =>
                `  → ${link.to}\t${link.mode}\t${link.enabled === true ? 'on' : 'off'}\t${link.wake === true ? 'wakes the target' : 'records only'}${
                  link.keywords.length > 0 ? `\t${link.keywords.join(', ')}` : ''
                }`,
            ),
          ])
        },
      },
      execute(args) {
        let group
        try {
          group = requireGroup(state.ledger, args.groupId)
        } catch (error) {
          return { ok: false, error: errorMessage(error), links: [] }
        }
        if (!Array.isArray(group.links)) group.links = []
        const summarise = () => linkSummary(group).routes

        const to = typeof args.to === 'string' ? args.to.trim() : ''
        if (to.length === 0) return { ok: true, groupId: group.id, links: summarise() }

        const target = state.ledger.groups.find((candidate) => candidate.id === to)
        if (target === undefined) {
          return {
            ok: false,
            error: `unknown target room "${to}"; known rooms: ${state.ledger.groups.map((candidate) => candidate.id).join(', ')}`,
            links: summarise(),
          }
        }
        if (target.id === group.id) return { ok: false, error: 'a room cannot link to itself', links: summarise() }

        if (args.remove === true) {
          const before = group.links.length
          group.links = group.links.filter((link) => link.to !== target.id)
          writeLedger(state.root, state.ledger)
          return { ok: true, groupId: group.id, to: target.id, removed: group.links.length < before, links: summarise() }
        }

        const modes = RELAY_MODES.map((row) => row.value)
        if (args.mode !== undefined && !modes.includes(args.mode)) {
          return { ok: false, error: `mode must be one of ${modes.join(' / ')}`, links: summarise() }
        }

        const existing = group.links.find((link) => link.to === target.id)
        if (existing === undefined) {
          group.links.push(newLink({ to: target.id, mode: args.mode, keywords: args.keywords, wake: args.wake, enabled: args.enabled, maxHops: args.maxHops }))
        } else {
          if (args.mode !== undefined) existing.mode = args.mode
          if (Array.isArray(args.keywords)) existing.keywords = args.keywords.filter((term) => typeof term === 'string' && term.trim().length > 0)
          if (typeof args.wake === 'boolean') existing.wake = args.wake
          if (typeof args.enabled === 'boolean') existing.enabled = args.enabled
          if (typeof args.maxHops === 'number' && args.maxHops > 0) existing.maxHops = Math.floor(args.maxHops)
        }
        writeLedger(state.root, state.ledger)
        const link = group.links.find((candidate) => candidate.to === target.id)
        return {
          ok: true,
          groupId: group.id,
          to: link.to,
          mode: link.mode,
          enabled: link.enabled !== false,
          wake: link.wake === true,
          keywords: link.keywords ?? [],
          links: summarise(),
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'attention_effort',
      description:
        "Set the room's ONE reasoning-effort knob (R4b) — or one member's override — and optionally apply it to the room's LIVE sessions right now. Without `live` this only records the setting: a stored session picks it up when it is next woken, for free. With `live` it calls the deployment's session controller, which takes effect on each session's NEXT step; be aware that the same call also saves the selection as the deployment default model.",
      parameters: {
        groupId: { type: 'string', required: true },
        effort: { type: 'string', required: true, description: 'off / low / high / max, or "" to mean "follow the session" (clears the room knob, or a member override).' },
        memberId: { type: 'string', description: "Set this member's own override instead of the room knob." },
        live: { type: 'boolean', description: 'Also change the LIVE sessions in this room now. Default false. Needs a deployment that mounts sessionController.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            groupId: { type: 'string' },
            scope: { type: 'string' },
            effort: { type: 'string' },
            memberId: { type: 'string' },
            liveRequested: { type: 'boolean' },
            liveApplied: { type: 'boolean' },
            applied: { type: 'number' },
            reason: { type: 'string' },
            results: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  memberId: { type: 'string' },
                  name: { type: 'string' },
                  applied: { type: 'boolean' },
                  note: { type: 'string' },
                },
              },
            },
            error: { type: 'string' },
          },
        },
        render: (_args, value) => {
          if (value.ok !== true) return textBlock(`failed: ${value.error ?? 'unknown error'}`)
          const where = value.scope === 'member' ? `member ${value.memberId}` : `room ${value.groupId}`
          const lines = [`${where}: effort = ${value.effort === '' ? '(follow the session)' : value.effort}`]
          if (value.liveRequested !== true) {
            lines.push('recorded only: a stored session takes this up when it is next woken')
          } else if (value.liveApplied !== true) {
            lines.push(`live sessions NOT changed: ${value.reason ?? 'unavailable'}`)
          } else if (value.results.length === 0) {
            lines.push('no live session in this room to change')
          } else {
            for (const row of value.results) {
              lines.push(`  ${row.name}\t${row.applied === true ? 'applied' : 'not applied'}${row.note === undefined ? '' : ` (${row.note})`}`)
            }
          }
          return textBlocks(lines)
        },
      },
      async execute(args) {
        let group
        try {
          group = requireGroup(state.ledger, args.groupId)
        } catch (error) {
          return { ok: false, error: errorMessage(error), results: [] }
        }
        const value = normalizeEffort(args.effort)
        if (value === undefined) {
          return { ok: false, error: `effort must be one of ${EFFORT_VALUES.join(' / ')} ("" means follow the session)`, results: [] }
        }

        const memberId = typeof args.memberId === 'string' && args.memberId.trim().length > 0 ? args.memberId.trim() : undefined
        if (memberId !== undefined) {
          const member = group.members.find((candidate) => candidate.id === memberId)
          if (member === undefined) return { ok: false, error: `unknown member "${memberId}"`, results: [] }
          if (value === '') delete member.wakeEffort
          else member.wakeEffort = value
        } else {
          group.defaultEffort = value
        }
        writeLedger(state.root, state.ledger)

        const liveRequested = args.live === true
        let liveApplied = false
        let reason
        let results = []
        if (liveRequested) {
          const outcome = await applyEffortToLive(ctx, state, group, value, memberId)
          liveApplied = outcome.ok === true
          reason = outcome.reason
          results = outcome.results
        }

        return {
          ok: true,
          groupId: group.id,
          scope: memberId === undefined ? 'group' : 'member',
          effort: value,
          ...(memberId === undefined ? {} : { memberId }),
          liveRequested,
          liveApplied,
          applied: results.filter((row) => row.applied === true).length,
          ...(reason === undefined ? {} : { reason }),
          results,
        }
      },
    }),
  )
}

const GROUP_COMMAND_USAGE = [
  '用法：/group <子命令>',
  '  list                 列出所有房间 + 你的未读数',
  '  say <群> <内容>       以你的名义发言（不叫醒任何人）',
  '  today <群>           本地统计「今天」聊了什么（不调模型）',
  '群可以用 id 或标题指定；标题有歧义时用 id。',
].join('\n')

/**
 * Find a room by id, else by exact title (case-insensitive).
 *
 * @param {object[]} groups - ledger rooms.
 * @param {string} target - what the human typed.
 * @returns {object|undefined} the room.
 */
function findGroupByTarget(groups, target) {
  const wanted = String(target ?? '').trim()
  if (wanted.length === 0) return undefined
  const byId = groups.find((group) => group.id === wanted)
  if (byId !== undefined) return byId
  const lower = wanted.toLowerCase()
  return groups.find((group) => String(group.title ?? '').toLowerCase() === lower)
}

/**
 * Implement `/group`.
 *
 * Shape notes (read from the runtime's own `commands` contract, 2026-10-17):
 * `handler(invocation) -> {kind:'success', text?} | {kind:'error', text}` and
 * `invocation` carries `agent` (the session it was typed in), `rawInput`, `signal`.
 *
 * Two deliberate rules:
 *  - **A typed command never wakes anybody.** `/group say` writes the message and
 *    records its mentions, but waking stays behind the explicit wake switch; the
 *    keyboard is not a reason to start turns in N sessions.
 *  - **Errors are answers, not throws.** A wrong room name comes back as
 *    `{kind:'error', text}` naming the rooms that exist.
 *
 * @param {object} state - plugin state.
 * @param {object} invocation - CommandInvocation from the runtime.
 * @returns {object} CommandResult.
 */
function runGroupCommand(state, invocation) {
  const fail = (text) => ({ kind: 'error', text })
  const raw = typeof invocation?.rawInput === 'string' ? invocation.rawInput.trim() : ''
  if (raw.length === 0) return { kind: 'success', text: GROUP_COMMAND_USAGE }
  const space = raw.indexOf(' ')
  const command = (space === -1 ? raw : raw.slice(0, space)).toLowerCase()
  const rest = space === -1 ? '' : raw.slice(space + 1).trim()
  const sessionId = invocation?.agent?.id === undefined ? undefined : String(invocation.agent.id)
  const groups = state.ledger.groups

  const unreadOf = (group) => {
    if (sessionId === undefined) return undefined
    const member = safeMembers(group).find((row) => row?.id === sessionId)
    if (member === undefined) return undefined
    try {
      return countUnread(state.root, group.id, member)
    } catch {
      return undefined
    }
  }

  if (command === 'list' || command === 'ls') {
    if (groups.length === 0) return { kind: 'success', text: '还没有任何群。' }
    const lines = [`群聊（${groups.length} 个）`]
    for (const group of groups) {
      const unread = unreadOf(group)
      lines.push(
        `${unread === undefined ? '·' : `[${unread}]`} ${singleLine(group.title, 60)}  (${group.id}, ${safeMembers(group).length} 人)`,
      )
    }
    return { kind: 'success', text: lines.join('\n') }
  }

  if (command === 'say' || command === 'send') {
    const split = rest.indexOf(' ')
    if (split === -1) return fail(`用法：/group say <群> <内容>\n\n${GROUP_COMMAND_USAGE}`)
    const target = rest.slice(0, split).trim()
    const text = rest.slice(split + 1).trim()
    if (text.length === 0) return fail('内容不能为空')
    const group = findGroupByTarget(groups, target)
    if (group === undefined) {
      return fail(
        `找不到群「${target}」。现有的群：${groups.map((row) => row.title).join('、') || '（没有）'}`,
      )
    }
    const names = safeMembers(group)
      .map((member) => member?.name)
      .filter((name) => typeof name === 'string' && name.length > 0)
    const record = {
      seq: nextSeq(state.root, group.id),
      at: new Date().toISOString(),
      fromId: 'user',
      fromName: '用户',
      text,
      kind: 'message',
      mentions: extractMentions(text, names),
    }
    appendMessage(state.root, group.id, record)
    return {
      kind: 'success',
      text: `已在「${group.title}」发言（#${record.seq}${record.mentions.length > 0 ? `，提到 ${record.mentions.join('、')}` : ''}）。没有叫醒任何人 —— 唤醒是另一个显式动作。`,
    }
  }

  if (command === 'today') {
    if (rest.length === 0) return fail(`用法：/group today <群>\n\n${GROUP_COMMAND_USAGE}`)
    const group = findGroupByTarget(groups, rest)
    if (group === undefined) {
      return fail(`找不到群「${rest}」。现有的群：${groups.map((row) => row.title).join('、') || '（没有）'}`)
    }
    const range = resolveRange({ range: 'today' })
    if (range.invalid !== undefined) return fail(`时间范围无法解析：${range.invalid}`)
    const all = readMessages(state.root, group.id, { limit: 0 })
    const digest = buildDigest({ group, messages: all, since: range.since, until: range.until })
    if (digest.total === 0) return { kind: 'success', text: `「${group.title}」今天还没有消息。` }
    const text =
      digest.text.length > MAX_RENDER_TOTAL_CHARS
        ? `${digest.text.slice(0, MAX_RENDER_TOTAL_CHARS)}\n…（已按 ${MAX_RENDER_TOTAL_CHARS} 字符截断；完整记录还在日志里）`
        : digest.text
    return { kind: 'success', text }
  }

  return fail(`不认识的子命令「${command}」\n\n${GROUP_COMMAND_USAGE}`)
}

/**
 * Register `/group` with the runtime's human-command registry.
 *
 * Same two disciplines as the other registrations: `ctx.inject` because the
 * service is not in this plugin's own scope (c8), and `scope.effect` so a
 * re-activated child fiber replaces the command instead of piling up (c23).
 * A deployment without `commands` loses only the slash command.
 *
 * @param {object} ctx - Cordis context.
 * @param {object} state - plugin state.
 */
function registerCommands(ctx, state) {
  if (typeof ctx.inject !== 'function') {
    state.commandStatus = 'ctx.inject is unavailable'
    return
  }
  try {
    ctx.inject(['commands'], (scope) => {
      const registry = scope.commands
      if (registry === undefined || registry === null || typeof registry.register !== 'function') {
        state.commandStatus = 'commands child context carried no service'
        return
      }
      scope.effect(() => {
        const dispose = registry.register({
          definitionId: 'attention-group/group',
          name: 'group',
          description: 'Group chat: list rooms, say something, or summarise today — without opening the panel.',
          input: { hint: '<subcommand> [args]' },
          handler: (invocation) => runGroupCommand(state, invocation),
        })
        state.commandStatus = 'registered'
        return () => {
          state.commandStatus = 'disposed'
          if (typeof dispose === 'function') dispose()
        }
      }, 'attention-group: /group command')
    })
  } catch (error) {
    state.commandStatus = `inject failed: ${errorMessage(error)}`
  }
}

/**
 * Serve the panel's data over the deployment's own web server.
 *
 * The browser half owns no state: it asks this route on open and on a timer, so
 * two windows cannot disagree about a room and a restart cannot lose a view.
 *
 * WHY THIS USES `ctx.inject`: a Cordis service is visible per SCOPE, and at
 * `apply()` time this plugin's own scope cannot see `webServer` at all —
 * measured 2026-10-16, `ctx.get('webServer')` returned nothing while the very
 * same call inside a tool reported the service present. `ctx.inject(deps, cb)`
 * runs `cb` in a child fiber that activates when those services are composed,
 * which is the sanctioned form (`@deepseek-ai/dsh-agent-loop` and
 * `@deepseek-ai/dsh-agent-tool-presentation` both use it). A deployment with no
 * web server therefore loses the panel, never the plugin.
 *
 * Posting as the human here NEVER wakes anyone: the panel is where a person
 * reads and speaks, and a click is not a reason to start N turns.
 *
 * @param {object} ctx - Cordis context.
 * @param {object} state - plugin state (`root`, `ledger`).
 */
function registerWebRoute(ctx, state) {
  if (typeof ctx.inject !== 'function') {
    state.routeStatus = 'ctx.inject is unavailable; panel route not registered'
    return
  }

  try {
    ctx.inject(['webServer'], (webCtx) => {
      const webServer = webCtx.webServer
      if (webServer === undefined || webServer === null) {
        state.routeStatus = 'webServer child context carried no service'
        return
      }
      registerPanelRoute(webServer, state)
    })
  } catch (error) {
    state.routeStatus = `inject failed: ${errorMessage(error)}`
  }
}

/**
 * Register the panel route on a web server that is known to be in scope.
 *
 * @param {object} webServer - the `webServer` service.
 * @param {object} state - plugin state.
 */
function registerPanelRoute(webServer, state) {
  const sendJson = (res, status, value) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(value))
  }
  // ⚠️ A request body needs a ceiling. Without one this handler would happily
  // buffer 16 MiB and then try to parse it as JSON — measured by adversarial
  // audit A-12 (2026-10-16): status 200, 192 ms, nothing refused. The panel never
  // sends more than a few kilobytes (a charter, a message), so a megabyte is
  // already generous, and refusing early is cheaper than parsing.
  const MAX_BODY_BYTES = 1024 * 1024
  const readBody = (req) =>
    new Promise((resolve, reject) => {
      const chunks = []
      let bytes = 0
      let overflow = false
      req.on('data', (chunk) => {
        if (overflow) return
        bytes += chunk.length
        if (bytes > MAX_BODY_BYTES) {
          overflow = true
          reject(new Error(`${bytes} bytes exceeds the ${MAX_BODY_BYTES}-byte limit`))
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        if (!overflow) resolve(Buffer.concat(chunks).toString('utf8'))
      })
      req.on('error', () => {
        if (!overflow) resolve('')
      })
    })

  try {
    // ⚠️ Registration must be IDEMPOTENT. A Cordis `ctx.inject` child fiber can
    // activate more than once (a dependency is re-composed, or the web entry
    // reloads), and an unguarded second `webServer.register` for the same exact
    // path throws `webserver: duplicate exact route` — measured on 0.2.1-rc.1 at
    // boot. The route from the FIRST activation stayed alive, so the panel kept
    // working while `state.routeStatus` said `failed: …duplicate…`: the panel was
    // healthy and the diagnostic lied about it, which is exactly what the c7
    // rule forbids. Disposing the previous registration first makes the LAST
    // activation the only live one, so the status line and the route agree.
    if (typeof state.disposeRoute === 'function') {
      try {
        state.disposeRoute()
      } catch {
        // The previous route was already gone; nothing to release.
      }
      state.disposeRoute = undefined
    }
    state.routeAttempts = (state.routeAttempts ?? 0) + 1
    state.disposeRoute = webServer.register({
      kind: 'exact',
      path: '/attention-group',
      async handler(req, res) {
        try {
          const url = new URL(req.url ?? '/attention-group', 'http://localhost')
          const wanted = url.searchParams.get('group')

          if (req.method === 'GET' || req.method === 'HEAD') {
            const payload = panelState(state, wanted)
            sendJson(res, payload.ok === true ? 200 : 404, payload)
            return
          }

          if (req.method === 'POST') {
            let raw
            try {
              raw = await readBody(req)
            } catch (error) {
              // 413, not 500: the request was too big, and saying so lets the
              // caller fix it instead of retrying the same body.
              sendJson(res, 413, { ok: false, error: `request body rejected: ${errorMessage(error)}` })
              return
            }
            let body
            try {
              body = JSON.parse(raw)
            } catch {
              sendJson(res, 400, { ok: false, error: 'body must be JSON' })
              return
            }
            const result = await applyPanelAction(state, body)
            sendJson(res, result.ok === true ? 200 : 400, result)
            return
          }

          sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
        } catch (error) {
          sendJson(res, 500, { ok: false, error: errorMessage(error) })
        }
      },
    })
    state.routeStatus = 'registered'
  } catch (error) {
    // A missing route costs the panel, never the plugin.
    state.routeStatus = `failed: ${errorMessage(error)}`
    console.warn(`${name}: web route not registered (${state.routeStatus})`)
  }
}

/** A room's member list, guaranteed to be an array. */
function safeMembers(group) {
  return Array.isArray(group?.members) ? group.members : []
}

/**
 * Why a room record is not shaped the way the panel expects, or `undefined`.
 *
 * Two sources, because a room can be malformed in two different moments:
 *  - `state.ledgerRepairs` — what `store.js` had to fill in when it loaded the
 *    ledger, which is the only place that sees the raw file;
 *  - the shape check below — what is true of the ledger *right now*, since it is
 *    mutated in memory long after that load.
 *
 * Either way the answer reaches the human. A malformed room may cost that room's
 * detail; it must never cost the panel, and it must never be invisible.
 *
 * @param {object} state - plugin state.
 * @param {object} group - ledger record.
 * @returns {string|undefined} a human-readable list of problems.
 */
function degradedReason(state, group) {
  const problems = []
  for (const repair of Array.isArray(state.ledgerRepairs) ? state.ledgerRepairs : []) {
    if (repair.id === group?.id) problems.push(...repair.problems)
  }
  if (typeof group?.id !== 'string' || group.id.length === 0) problems.push('id is missing')
  if (typeof group?.title !== 'string') problems.push('title is not a string')
  if (!Array.isArray(group?.members)) problems.push('members is not an array')
  return problems.length === 0 ? undefined : [...new Set(problems)].join('; ')
}

/** One room as the panel list sees it, with every field defensively defaulted. */
function panelGroupRow(state, group) {
  const id = typeof group?.id === 'string' && group.id.length > 0 ? group.id : ''
  const status = id.length === 0 ? { records: [] } : readMessagesWithStatus(state.root, id, { limit: 0 })
  const all = status.records
  const newest = all.length === 0 ? undefined : all[all.length - 1]
  const members = safeMembers(group)
  const human = members.find((member) => member.id === HUMAN_ID)
  const unread = id.length === 0 ? all.length : countUnread(state.root, id, human ?? {}, undefined)
  const degraded = degradedReason(state, group)
  return {
    id,
    title: typeof group?.title === 'string' ? group.title : '(untitled room)',
    messages: all.length,
    lastAt: newest === undefined ? '' : String(newest.at ?? ''),
    lastFrom: newest === undefined ? '' : String(newest.fromName ?? ''),
    lastPreview: newest === undefined ? '' : String(newest.text ?? '').replace(/\s+/gu, ' ').slice(0, 80),
    wakeEnabled: group?.wakeEnabled === true,
    routeMode: typeof group?.routeMode === 'string' ? group.routeMode : ROUTE_MODE.rules,
    memberCount: members.length,
    memberNames: members.map((member) => (typeof member?.name === 'string' ? member.name : '(unnamed)')),
    // A room the human never joined cannot be "read", so everything in it is
    // new — which is exactly right: they have in fact not seen any of it.
    unread: unread === undefined ? all.length : unread,
    // "The transcript is there but I could not open it" is not "no messages".
    ...(status.unreadable === true ? { messagesUnreadable: true, messagesError: status.error ?? 'unknown error' } : {}),
    ...(degraded === undefined ? {} : { degraded: true, degradedReason: degraded }),
  }
}

/**
 * The panel's whole room list, in one response.
 *
 * @param {object} state - plugin state.
 * @returns {object[]} one row per room.
 */
function panelGroups(state) {
  return state.ledger.groups.map((group) => {
    try {
      return panelGroupRow(state, group)
    } catch (error) {
      // Last-resort guard. The field-level defaults above cover everything known;
      // this makes "one bad room takes the panel down" impossible for the rest.
      return {
        id: typeof group?.id === 'string' ? group.id : '',
        title: typeof group?.title === 'string' ? group.title : '(unreadable room)',
        messages: 0,
        lastAt: '',
        lastFrom: '',
        lastPreview: '',
        wakeEnabled: false,
        routeMode: ROUTE_MODE.rules,
        memberCount: 0,
        memberNames: [],
        unread: 0,
        degraded: true,
        degradedReason: errorMessage(error),
      }
    }
  })
}

/** One room's full detail, including every knob the settings view edits. */
function panelGroupDetail(state, group) {
  const id = typeof group?.id === 'string' && group.id.length > 0 ? group.id : ''
  const status = id.length === 0 ? { records: [] } : readMessagesWithStatus(state.root, id, { limit: 0 })
  const all = status.records
  const degraded = degradedReason(state, group)
  return {
    id,
    title: typeof group?.title === 'string' ? group.title : '(untitled room)',
    createdAt: group?.createdAt,
    charter: typeof group.charter === 'string' ? group.charter : '',
    wakeEnabled: group.wakeEnabled === true,
    routeMode: typeof group.routeMode === 'string' ? group.routeMode : ROUTE_MODE.rules,
    selfReflect: group.selfReflect !== false,
    joinPolicy: typeof group.joinPolicy === 'string' ? group.joinPolicy : 'members',
    defaultEffort: typeof group.defaultEffort === 'string' ? group.defaultEffort : '',
    // U3: whether this deployment can change a LIVE session's effort, and whether
    // this room is allowed to. The panel shows both, because "the slider did
    // nothing to the running session" must never be a mystery.
    liveEffort: group.liveEffort === true,
    effortStatus: state.effortStatus ?? 'unknown',
    // R7: where this room's conclusions go, so the panel can show the real path
    // instead of making the human guess at it.
    sinkEnabled: group.sinkEnabled !== false,
    sinkDir: typeof group.sinkDir === 'string' ? group.sinkDir : '',
    sinkMemory: group.sinkMemory === true,
    // R6: when this is on, a member sees "群聊未读：…" in its own system prompt on
    // every step, so it learns about waiting messages even when nobody woke it.
    promptUnread: group.promptUnread === true,
    // R3+: may a member address the whole room with `@所有人`? Off by default: a
    // room where everyone can wake everyone is a room nobody can afford.
    mentionAll: group.mentionAll === true,
    // R9+: how many messages have no summary yet, and how many it takes for the
    // panel to NAG. The panel never generates anything on its own — a summary
    // costs a model turn, so it is always a deliberate click (2026-10-17).
    summary: (() => {
      const upToSeq = summarizedUpTo(group)
      const latestSeq = all.reduce((max, row) => (Number.isFinite(row.seq) && row.seq > max ? row.seq : max), 0)
      const every = typeof group.summaryEvery === 'number' && group.summaryEvery > 0 ? group.summaryEvery : 500
      const stored = groupSummaries(group)
      const last = stored.length > 0 ? stored[stored.length - 1] : undefined
      return {
        every,
        upToSeq,
        latestSeq,
        pending: Math.max(0, latestSeq - upToSeq),
        count: stored.length,
        ...(last !== undefined && typeof last.at === 'string' ? { lastAt: last.at } : {}),
      }
    })(),
    // R10: where this room relays to, and what each link is willing to carry.
    links: linkSummary(group).routes,
    sink: {
      dir: groupSinkDir(state.root, group),
      conclusionPath: conclusionFile(state.root, group),
      conclusions: countBullets(conclusionFile(state.root, group)),
      conclusionBytes: sizeOf(conclusionFile(state.root, group)),
      files: listSunk(state.root, group).length,
    },
    members: safeMembers(group).map((member) => ({
      id: member?.id,
      name: typeof member?.name === 'string' ? member.name : '(unnamed)',
      kind: typeof member.kind === 'string' ? member.kind : 'session',
      enabled: member.enabled !== false,
      subscribe: Array.isArray(member.subscribe) ? member.subscribe : [],
      wakeEffort: typeof member.wakeEffort === 'string' ? member.wakeEffort : '',
      // A name with no session behind it is recorded, never resumed. The panel
      // says so per row instead of offering a switch that cannot do anything.
      wakeable: isSessionId(member.id),
      isHuman: member.id === HUMAN_ID,
      joinedAt: member.joinedAt,
    })),
    messageCount: all.length,
    // Newest-last, capped: the panel scrolls, and a room with years of history
    // must not become one enormous response. `truncated` has always been sent
    // and was never read — 305 messages drew 300 rows and said nothing.
    truncated: all.length > 300,
    // "I could not open the transcript" must reach the human as an error, not as
    // an empty room. Same rule as `panelGroupRow`.
    ...(status.unreadable === true ? { messagesUnreadable: true, messagesError: status.error ?? 'unknown error' } : {}),
    ...(degraded === undefined ? {} : { degraded: true, degradedReason: degraded }),
    messages: all.slice(-300).map((row) => ({
      seq: row.seq,
      at: row.at,
      fromId: row.fromId,
      fromName: row.fromName,
      text: row.text,
      mentions: Array.isArray(row.mentions) ? row.mentions : [],
    })),
  }
}

/**
 * The panel's whole read model, in one response.
 *
 * @param {object} state - plugin state.
 * @param {string|null} wanted - group to include a transcript for.
 * @returns {object} panel payload.
 */
function panelState(state, wanted) {
  const groups = panelGroups(state)
  // R10 needs a list of rooms to point a liaison at; the panel filters itself out.
  const linkTargets = groups.map((row) => ({ id: row.id, title: row.title }))
  const base = {
    ok: true,
    version: VERSION,
    groups,
    knobs: PANEL_KNOBS,
    linkTargets,
    // ⚠️ An unreadable ledger used to be indistinguishable from an empty one:
    // `readLedger` collapsed both into "no rooms", this payload said `ok:true`,
    // and the panel — correctly — drew "you have no rooms" while groups.json sat
    // on disk completely intact. The status travels WITH the data now, because
    // the panel has no second way to ask.
    ...(state.ledgerUnreadable === true ? { ledgerUnreadable: true, ledgerError: state.ledgerError ?? 'unknown error' } : {}),
    ...(state.ledgerRecoveredFrom === undefined ? {} : { ledgerRecoveredFrom: state.ledgerRecoveredFrom }),
  }
  if (wanted === null || wanted === undefined) return base

  const group = state.ledger.groups.find((candidate) => candidate.id === wanted)
  if (group === undefined) return { ok: false, error: `unknown group "${wanted}"`, groups }

  try {
    return { ...base, group: panelGroupDetail(state, group) }
  } catch (error) {
    // Building one room's detail must never cost the whole panel. Fall back to
    // the list row plus the marker the panel already draws for a bad room, so
    // the human sees one degraded room instead of an empty window.
    const row = groups.find((candidate) => candidate.id === wanted) ?? { id: wanted, title: wanted }
    return {
      ...base,
      group: {
        ...row,
        createdAt: undefined,
        charter: '',
        selfReflect: true,
        joinPolicy: 'members',
        defaultEffort: '',
        liveEffort: false,
        effortStatus: state.effortStatus ?? 'unknown',
        sinkEnabled: true,
        sinkDir: '',
        sinkMemory: false,
        links: [],
        members: [],
        sink: { dir: '', conclusionPath: '', conclusions: 0, conclusionBytes: 0, files: 0 },
        messageCount: 0,
        truncated: false,
        messages: [],
        degraded: true,
        degradedReason: errorMessage(error),
      },
    }
  }
}

/**
 * Apply one write from the panel.
 *
 * The human is a first-class member: creating a room, adding people, editing the
 * charter and turning every knob are things a person should be able to do
 * without asking an agent to do it for them. None of these actions wake anybody
 * — a click is not a reason to start a turn in someone else's session. Waking
 * stays behind `wake=true` AND the room's own `wakeEnabled`.
 *
 * Every verb names itself explicitly, so a future action can never be silently
 * mistaken for "post a message", and every refusal says which value was wrong
 * and what the legal ones are.
 *
 * @param {object} state - plugin state (`ctx` is carried on it — see `apply`).
 * @param {object} body - parsed request body.
 * @returns {Promise<object>} `{ok, ...}` result.
 */
async function applyPanelAction(state, body) {
  const action = typeof body?.action === 'string' ? body.action : 'post'

  if (action === 'create') {
    const title = typeof body?.title === 'string' ? body.title.trim() : ''
    if (title.length === 0) return { ok: false, error: 'title is required' }
    const group = newGroup(title, { charter: body?.charter, existing: state.ledger.groups })
    // Whoever made the room is in it. Members are told apart by id shape, so the
    // human uses a stable, non-session id rather than a session id it has none of.
    group.members.push(newMember({ id: HUMAN_ID, name: HUMAN_NAME, kind: 'user' }))
    state.ledger.groups.push(group)
    writeLedger(state.root, state.ledger)
    return { ok: true, groupId: group.id, title: group.title }
  }

  const group = state.ledger.groups.find((candidate) => candidate.id === body?.group)
  if (group === undefined) return { ok: false, error: 'unknown group' }

  const save = () => writeLedger(state.root, state.ledger)
  const done = (extra) => Object.assign({ ok: true, groupId: group.id }, extra)

  if (action === 'join') {
    const memberId = String(body?.memberId ?? '').trim()
    if (memberId.length === 0) return { ok: false, error: 'memberId is required' }
    // ⚠️ `undefined` when the caller did not name a kind, NOT 'session'.
    // Defaulting here meant a caller that only wanted to re-join or rename
    // someone silently DEMOTED an existing admin to a plain session — and the
    // room then had no 群管理 at all, so `attention_summarize` had nobody to ask
    // and reported "no admin member" for a room that visibly had one. A missing
    // field must mean "leave it alone", never "set it to the default".
    const kind = PANEL_KNOBS.memberKinds.includes(body?.kind) ? body.kind : undefined
    const existing = group.members.find((member) => member.id === memberId)
    if (existing === undefined) {
      group.members.push(
        newMember({
          id: memberId,
          name: body?.memberName,
          kind: kind ?? 'session',
          subscribe: Array.isArray(body?.subscribe) ? body.subscribe : [],
        }),
      )
    } else {
      if (typeof body?.memberName === 'string' && body.memberName.trim().length > 0) existing.name = body.memberName.trim()
      if (kind !== undefined) existing.kind = kind
      existing.enabled = true
    }
    save()
    const changed = group.members.find((member) => member.id === memberId)
    return done({ memberId, kind: changed?.kind ?? 'session', members: group.members.length })
  }

  if (action === 'charter') {
    group.charter = typeof body?.charter === 'string' ? body.charter : ''
    save()
    return done({ charter: group.charter })
  }

  if (action === 'wake') {
    group.wakeEnabled = body?.wakeEnabled === true
    save()
    return done({ wakeEnabled: group.wakeEnabled })
  }

  if (action === 'route') {
    const mode = String(body?.routeMode ?? '')
    const legal = Object.values(ROUTE_MODE)
    if (!legal.includes(mode)) return { ok: false, error: `routeMode must be one of ${legal.join(' / ')}` }
    group.routeMode = mode
    save()
    return done({ routeMode: mode })
  }

  if (action === 'effort') {
    const liveEffortChange = typeof body?.liveEffort === 'boolean' ? body.liveEffort : undefined
    if (liveEffortChange !== undefined) group.liveEffort = liveEffortChange

    let applied
    if (body?.effort !== undefined) {
      const value = normalizeEffort(body.effort)
      if (value === undefined) {
        return { ok: false, error: `effort must be one of ${EFFORT_VALUES.join(' / ')} ("" means follow the session)` }
      }
      group.defaultEffort = value
      // Turning the switch ON, or moving the slider while it is on, is the human
      // saying "yes, change the live sessions too" — otherwise the switch would be
      // a promise that only takes effect the NEXT time they touch something.
      if (group.liveEffort === true) applied = await applyEffortToLive(state.ctx, state, group, value, undefined)
    } else if (liveEffortChange === true) {
      if (typeof group.defaultEffort === 'string' && group.defaultEffort.length > 0) {
        applied = await applyEffortToLive(state.ctx, state, group, group.defaultEffort, undefined)
      } else {
        // The switch was turned on while the room sits on "follow the session",
        // so there is no effort to apply and zero sessions were touched. Saying
        // nothing here is exactly how a switch ends up drawn as "on" while
        // nothing happened at all — and the human reads that as success.
        applied = {
          ok: false,
          results: [],
          reason: 'the room effort is "follow the session", so switching this on changed nothing; choose an effort first',
        }
      }
    }

    save()
    return done({
      defaultEffort: typeof group.defaultEffort === 'string' ? group.defaultEffort : '',
      liveEffort: group.liveEffort === true,
      effortStatus: state.effortStatus ?? 'unknown',
      ...(applied === undefined
        ? {}
        : {
            liveApplied: applied.ok === true,
            applied: applied.results.filter((row) => row.applied === true).length,
            // "2 members are live but only 1 could be changed" has to be visible:
            // a partial success that says nothing is indistinguishable from a
            // complete one, and the human has no way to find out which they got.
            skipped: applied.results.filter((row) => row.applied !== true).length,
            ...(applied.reason === undefined ? {} : { liveReason: applied.reason }),
          }),
    })
  }

  if (action === 'selfReflect') {
    group.selfReflect = body?.selfReflect === true
    save()
    return done({ selfReflect: group.selfReflect })
  }

  if (action === 'promptUnread') {
    group.promptUnread = body?.promptUnread === true
    save()
    return done({ promptUnread: group.promptUnread })
  }

  if (action === 'mentionAll') {
    group.mentionAll = body?.mentionAll === true
    save()
    return done({ mentionAll: group.mentionAll })
  }

  if (action === 'summaryEvery') {
    const legal = PANEL_KNOBS.summaryEveries.map((row) => row.value)
    const wanted = Number(body?.summaryEvery)
    if (!legal.includes(wanted)) return { ok: false, error: `summaryEvery must be one of ${legal.join(' / ')}` }
    group.summaryEvery = wanted
    save()
    return done({ summaryEvery: wanted })
  }

  // ⚠️ THE ONE PANEL ACTION THAT CAN START A TURN — and only because the human
  // clicked 「生成群史摘要」 on purpose; a summary costs a model call in someone
  // else's session. Two guards keep the "panel never wakes anybody" promise
  // meaningful: the room must have a usable admin session to write it, and the
  // room's own waking switch must be on. With waking off the button refuses and
  // says so, so a click can never turn a silent room noisy by accident.
  if (action === 'summaryGenerate') {
    const summarizer = safeMembers(group).find(
      (member) => member?.kind === 'admin' && member.enabled !== false && isSessionId(member.id),
    )
    if (summarizer === undefined) {
      return {
        ok: false,
        error: '这个群还没有可用的群管理成员：需要 kind=admin 且本身是 DSH 会话，摘要由它来写',
      }
    }
    if (group.wakeEnabled !== true) {
      return {
        ok: false,
        error: '这个群的唤醒开关是关的：生成摘要必须先叫醒群管理，请先在面板打开唤醒，再点这个按钮',
      }
    }
    const all = readMessages(state.root, group.id, { limit: 0 })
    const latestSeq = all.reduce((max, row) => (Number.isFinite(row.seq) && row.seq > max ? row.seq : max), 0)
    const from = summarizedUpTo(group)
    const slice = all.filter((row) => Number.isFinite(row.seq) && row.seq > from)
    if (slice.length === 0) {
      return {
        ok: false,
        error: `这个群没有未摘要的消息（已有摘要覆盖到第 ${from} 条），不需要生成`,
      }
    }
    const digest = buildDigest({ group, messages: slice, since: '', until: '' })
    const record = {
      seq: nextSeq(state.root, group.id),
      at: new Date().toISOString(),
      fromId: 'panel',
      fromName: '面板',
      text: `请 ${summarizer.name} 生成群史摘要（${slice.length} 条，截至第 ${latestSeq} 条）`,
      kind: 'summary-request',
      mentions: [summarizer.name],
    }
    appendMessage(state.root, group.id, record)
    // Tell it EXACTLY how to hand the summary back: delivery is one-way, so a
    // summary that is not recorded through the tool would be lost.
    const request =
      renderSummaryRequest({ group, digest, requester: '面板' }) +
      `\n\n【写回方式】摘要写完后，调用 attention_record_summary 登记回群里：groupId="${group.id}"，text=<你的摘要>，upToSeq=${latestSeq}。摘要 300-800 字，不要贴原文。`
    const outcome = await deliver(
      state.ctx,
      state,
      group,
      summarizer,
      record,
      { reason: REASON.summary, detail: `${slice.length} message(s)` },
      request,
    )
    return {
      ok: true,
      summarizerId: summarizer.id,
      summarizerName: summarizer.name,
      messages: slice.length,
      upToSeq: latestSeq,
      delivered: outcome.delivered === true,
      path: outcome.path,
      ...(outcome.note === undefined ? {} : { note: outcome.note }),
    }
  }

  if (action === 'joinPolicy') {
    const legal = PANEL_KNOBS.joinPolicies.map((row) => row.value)
    const policy = String(body?.joinPolicy ?? '')
    if (!legal.includes(policy)) return { ok: false, error: `joinPolicy must be one of ${legal.join(' / ')}` }
    group.joinPolicy = policy
    save()
    return done({ joinPolicy: policy })
  }

  if (action === 'sink') {
    if (typeof body?.sinkEnabled === 'boolean') group.sinkEnabled = body.sinkEnabled
    if (typeof body?.sinkMemory === 'boolean') group.sinkMemory = body.sinkMemory
    if (typeof body?.sinkDir === 'string') group.sinkDir = body.sinkDir.trim()
    save()
    return done({
      sinkEnabled: group.sinkEnabled !== false,
      sinkMemory: group.sinkMemory === true,
      sinkDir: typeof group.sinkDir === 'string' ? group.sinkDir : '',
    })
  }

  if (action === 'sinkExport') {
    // The human pressing "export this room" is the same write the
    // attention_export tool performs, so it goes through the same function. It
    // writes a file and nothing else: no message, no wake, no state change.
    const all = readMessages(state.root, group.id, { limit: 0 })
    const at = new Date().toISOString()
    try {
      const written = sinkTranscript({ root: state.root, group, messages: all, since: '', until: '', at, path: '' })
      return done({ path: written.path, bytes: written.bytes, messages: written.messages })
    } catch (error) {
      return { ok: false, error: `cannot write the export: ${errorMessage(error)}` }
    }
  }

  if (action === 'digest') {
    // R9's free half: a human asking "what did this room talk about today" gets
    // an answer without any model being involved, and without anybody waking up.
    const { since, until, invalid } = resolveRange({
      range: body?.range,
      since: typeof body?.since === 'string' ? body.since : undefined,
      until: typeof body?.until === 'string' ? body.until : undefined,
    })
    if (invalid !== undefined) {
      return { ok: false, error: `${invalid} is not a date; pass an ISO-8601 instant (for example 2026-10-16T00:00:00.000Z)` }
    }
    const rows = readMessages(state.root, group.id, { limit: 0 }).filter((row) => inRange(row, since, until))
    const digest = buildDigest({ group, messages: rows, since, until, limit: 200 })
    return done({
      since,
      until,
      total: digest.total,
      shown: digest.shown,
      omitted: digest.omitted,
      text: digest.text,
    })
  }

  if (action === 'link') {
    // R10 from the panel. Same rules as the tool, including the refusal to link
    // a room to itself — a self-link is the shortest possible loop.
    if (!Array.isArray(group.links)) group.links = []
    const to = String(body?.to ?? '').trim()
    if (to.length === 0) return { ok: false, error: 'to is required' }
    if (to === group.id) return { ok: false, error: 'a room cannot link to itself' }
    const target = state.ledger.groups.find((candidate) => candidate.id === to)
    if (target === undefined) return { ok: false, error: `unknown target room "${to}"` }

    const modes = RELAY_MODES.map((row) => row.value)
    const existing = group.links.find((link) => link.to === to)
    if (typeof body?.mode === 'string' && !modes.includes(body.mode)) {
      return { ok: false, error: `mode must be one of ${modes.join(' / ')}` }
    }
    if (existing === undefined) {
      group.links.push(
        newLink({ to, mode: body?.mode, keywords: body?.keywords, wake: body?.wake, enabled: body?.enabled, maxHops: body?.maxHops }),
      )
    } else {
      if (typeof body?.mode === 'string') existing.mode = body.mode
      if (Array.isArray(body?.keywords)) existing.keywords = body.keywords.filter((term) => typeof term === 'string' && term.trim().length > 0)
      if (typeof body?.wake === 'boolean') existing.wake = body.wake
      if (typeof body?.enabled === 'boolean') existing.enabled = body.enabled
      if (typeof body?.maxHops === 'number' && body.maxHops > 0) existing.maxHops = Math.floor(body.maxHops)
    }
    save()
    return done({ to, links: linkSummary(group).routes })
  }

  if (action === 'unlink') {
    const to = String(body?.to ?? '').trim()
    if (!Array.isArray(group.links)) group.links = []
    const before = group.links.length
    group.links = group.links.filter((link) => link.to !== to)
    if (group.links.length === before) return { ok: false, error: `there is no link to "${to}"` }
    save()
    return done({ to, links: linkSummary(group).routes })
  }

  if (action === 'rename') {
    const title = typeof body?.title === 'string' ? body.title.trim() : ''
    if (title.length === 0) return { ok: false, error: 'title is required' }
    group.title = title
    save()
    return done({ title })
  }

  if (action === 'member') {
    const memberId = String(body?.memberId ?? '').trim()
    const member = group.members.find((candidate) => candidate.id === memberId)
    if (member === undefined) return { ok: false, error: `unknown member "${memberId}"` }
    if (typeof body?.name === 'string' && body.name.trim().length > 0) member.name = body.name.trim()
    if (typeof body?.enabled === 'boolean') member.enabled = body.enabled
    if (body?.subscribe !== undefined) {
      const list = Array.isArray(body.subscribe) ? body.subscribe : String(body.subscribe).split(/[\n,]/u)
      member.subscribe = list.map((term) => String(term).trim()).filter((term) => term.length > 0)
    }
    if (body?.wakeEffort !== undefined) {
      const value = normalizeEffort(body.wakeEffort)
      if (value === undefined) {
        return { ok: false, error: `wakeEffort must be one of ${EFFORT_VALUES.join(' / ')}` }
      }
      // `''` means "no personal override" — delete the field rather than store a
      // value the delivery path would have to keep filtering out.
      if (value === '') delete member.wakeEffort
      else member.wakeEffort = value
    }
    save()
    return done({ memberId, name: member.name, enabled: member.enabled !== false })
  }

  if (action === 'leave') {
    const memberId = String(body?.memberId ?? '').trim()
    if (memberId.length === 0) return { ok: false, error: 'memberId is required' }
    const before = group.members.length
    group.members = group.members.filter((member) => member.id !== memberId)
    if (group.members.length === before) return { ok: false, error: `unknown member "${memberId}"` }
    save()
    return done({ memberId, members: group.members.length })
  }

  if (action === 'read') {
    // Opening a room IS joining it. The human is never constrained by
    // joinPolicy — that policy exists to protect them, and a person who can read
    // a room but never "catch up" on it would make the unread badge a lie.
    let member = group.members.find((candidate) => candidate.id === HUMAN_ID)
    const joined = member === undefined
    if (member === undefined) {
      member = newMember({ id: HUMAN_ID, name: HUMAN_NAME, kind: 'user' })
      group.members.push(member)
    }
    member.lastReadAt = new Date().toISOString()
    save()
    return done({ lastReadAt: member.lastReadAt, joined })
  }

  // Default: post a message as the human. This never wakes anyone, however the
  // room is configured — a person typing in their own panel is not an event.
  const text = typeof body?.text === 'string' ? body.text : ''
  if (text.trim().length === 0) return { ok: false, error: 'text is required' }
  const at = new Date().toISOString()
  const record = {
    seq: nextSeq(state.root, group.id),
    at,
    fromId: HUMAN_ID,
    fromName: HUMAN_NAME,
    text,
    mentions: extractMentions(text, group.members.map((member) => member.name)),
  }
  appendMessage(state.root, group.id, record)
  // The human has obviously seen their own message, so it must not come back as
  // unread. Without this the badge would grow every time they speak.
  const speaker = group.members.find((candidate) => candidate.id === HUMAN_ID)
  if (speaker !== undefined) {
    speaker.lastReadAt = at
    save()
  }

  // R10: a message spoken in the panel is still a message in this room, so it
  // obeys the room's liaisons exactly like one sent through `attention_send` —
  // the panel promises "everything said here is forwarded" and that has to be
  // true. Forwarding wakes nobody by default (a link needs `wake` AND the target
  // room's `wakeEnabled`), so this cannot turn a click into N turns.
  const relayed = await relayMessage(state.ctx, state, group, record)

  return { ok: true, seq: record.seq, mentions: record.mentions, woken: false, relayed }
}

/** Cordis plugin entry point. */
function apply(ctx) {
  const root = resolveDataRoot()
  const { ledger, recoveredFrom, unreadable, error, repairs } = readLedger(root)
  // The context is kept on the state because some capability registration is
  // asynchronous: the panel route runs later, and it needs the same `ctx` the
  // tools already use to reach `sessionQuery` and `agents`.
  //
  // The ledger's read status is kept too, and for the same reason: "there are no
  // rooms" and "I could not open the room list" are different facts, and the
  // panel route has no way to re-derive the second one later.
  const state = { root, ledger, ctx, ledgerRepairs: Array.isArray(repairs) ? repairs : [] }
  if (state.ledgerRepairs.length > 0) {
    // Rooms that had to be repaired on load are still usable — `store.js` fills
    // in the missing fields — but the human should hear about it rather than
    // discover it later as a mystery.
    console.warn(`${name}: ${state.ledgerRepairs.length} room(s) had malformed fields and were repaired on load: ${state.ledgerRepairs.map((row) => `${row.id || '(no id)'} (${row.problems.join(', ')})`).join('; ')}`)
  }
  if (unreadable === true) {
    state.ledgerUnreadable = true
    state.ledgerError = error ?? 'unknown error'
    console.warn(`${name}: groups.json exists but could not be read (${state.ledgerError}); the panel will say so rather than report an empty room list`)
  }
  if (recoveredFrom !== undefined) {
    state.ledgerRecoveredFrom = recoveredFrom
    console.warn(`${name}: group ledger was unreadable and moved to ${recoveredFrom}; starting from an empty ledger`)
  }
  registerTools(ctx, state)
  // One panel action (生成群史摘要) has to start a turn, and starting a turn needs
  // the Cordis context. Keeping the reference on `state` is the smallest honest
  // way to give the route handler what it needs without threading ctx through
  // four signatures; it is the SAME context this apply() was called with.
  state.ctx = ctx
  registerCommands(ctx, state)
  registerWebRoute(ctx, state)
  registerPromptContext(ctx, state)
  registerSessionController(ctx, state)
}

export { apply, inject, name }
