/**
 * Tool contract tests.
 *
 * These exist because of a real incident on 2026-10-16: this plugin's first live
 * run ended with the session unable to start another turn —
 *
 *   UNSUPPORTED_CONTENT: DeepSeek Messages cannot represent user/tool-result content undefined
 *
 * thrown by `@deepseek-ai/dsh-llm-deepseek`'s serializer when a message carries
 * a content element that is not a typed block. The plugin was the only new
 * variable, so the contract it must prove is narrow and checkable:
 *
 *   1. every tool output is LOSSLESS JSON (no `undefined`, no functions, no cycles)
 *   2. every `render` returns an array of plain strings
 *   3. the durable ledger round-trips through JSON unchanged
 *
 * A crash that costs the user their session is not something to reason about in
 * prose. These assertions are the falsification.
 *
 * Run: node --test test/
 */

import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { entry, describeSource, moduleUrl, usingInstalled } from './support/entry.mjs'
import { toolOutputViolations } from './support/schema-check.mjs'

const dataHome = mkdtempSync(join(tmpdir(), 'attention-group-home-'))
process.env.DSH_HOME = dataHome

/**
 * Load the plugin from whichever copy is authoritative.
 *
 * Preference order and the reasoning behind it live in `support/entry.mjs`:
 * the INSTALLED profile copy wins because that is the artifact DSH loads, with a
 * fallback to this source tree so a fresh clone can run the suite at all.
 */
const installedUrl = moduleUrl('index.js')
const { apply } = await import(installedUrl)
const { appendMessage, readMessages, readLedger, writeLedger, emptyLedger } = await import(
  `${installedUrl.slice(0, installedUrl.lastIndexOf('/'))}/store.js`
)

after(() => {
  rmSync(dataHome, { recursive: true, force: true })
  rmSync(dataHome, { recursive: true, force: true })
})

/** True when `value` survives JSON.stringify/parse without losing anything. */
function isLosslessJson(value, path = '$', seen = new Set()) {
  if (value === undefined) return `${path} is undefined`
  if (value === null) return true
  const kind = typeof value
  if (kind === 'string' || kind === 'boolean') return true
  if (kind === 'number') return Number.isFinite(value) ? true : `${path} is not finite`
  if (kind === 'bigint' || kind === 'symbol' || kind === 'function') return `${path} is ${kind}`
  if (seen.has(value)) return `${path} is cyclic`
  seen.add(value)
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const problem = isLosslessJson(item, `${path}[${index}]`, seen)
      if (problem !== true) return problem
    }
    seen.delete(value)
    return true
  }
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return `${path} is a non-plain object`
  for (const [key, item] of Object.entries(value)) {
    const problem = isLosslessJson(item, `${path}.${key}`, seen)
    if (problem !== true) return problem
  }
  seen.delete(value)
  return true
}

/** Build a Cordis-shaped context good enough for `apply`. */
function fakeContext(options = {}) {
  const tools = new Map()
  const liveAgents = Array.isArray(options.liveAgents) ? options.liveAgents : []
  const ctx = {
    tools: {
      register(definition) {
        assert.equal(typeof definition.name, 'string')
        assert.ok(definition.name.length > 0, 'tool needs a name')
        assert.ok(!tools.has(definition.name), `duplicate tool name ${definition.name}`)
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    agents: {
      list: () => liveAgents,
      get: (id) => liveAgents.find((agent) => agent.id === id),
    },
    get: () => undefined,
  }
  apply(ctx)
  return { ctx, tools }
}

/** Invoke one tool and assert the whole output/render contract. */
async function callTool(tools, name, args = {}, agent) {
  const tool = tools.get(name)
  assert.ok(tool !== undefined, `tool ${name} is not registered`)
  const exec = { agent, signal: undefined }
  const value = await tool.execute(args, exec)

  // DSH snapshots the result as lossless JSON before it becomes durable.
  // `snapshotProjection` throws `output returned non-lossless JSON` for anything
  // JSON would drop, so an `undefined` here is a live-session hazard.
  const problem = isLosslessJson(value)
  assert.equal(problem, true, `${name} output is not lossless JSON: ${problem}`)
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(value)), `${name} output does not survive JSON`)

  // DSH re-checks the value against the schema the plugin declared for itself,
  // AFTER execute, and throws `ToolOutputError` when they disagree:
  //     const violations = validateJsonSchemaValue(tool.output.schema, value, 'value')
  //     if (violations.length > 0) throw new ToolOutputError(tool.name, violations)
  // So a failure branch that returns a field the schema never declared, or omits
  // one it marked required, does not reach the model as the sentence the plugin
  // wrote — it reaches it as an internal error. Found by adversarial audit A-1/A-2
  // (2026-10-16) on two tools whose refusal paths were unreachable in exactly this
  // way. Checking it on EVERY call is how that class stays closed.
  const violations = toolOutputViolations(tool, value)
  assert.deepEqual(violations, [], `${name} output violates its own output.schema`)

  if (tool.output?.render !== undefined) {
    const rendered = tool.output.render(args, value)
    assert.ok(Array.isArray(rendered), `${name} render must return an array`)

    // THE regression this file exists for. `dsh-tools` does:
    //     rendered = tool.output.render(args, value)
    //     const content = snapshotProjection(tool.name, 'render', rendered)
    // so the array returned here IS the durable tool-result content, verbatim,
    // with no wrapping. A bare string has no `.type`, and the model serializer
    // (`@deepseek-ai/dsh-llm-deepseek`) then throws
    //     UNSUPPORTED_CONTENT: cannot represent user/tool-result content undefined
    // That bad record is append-only, so it breaks every later turn of the
    // session — measured in this project on 2026-10-16.
    for (const [index, block] of rendered.entries()) {
      assert.equal(
        typeof block,
        'object',
        `${name} render[${index}] is ${typeof block} — render must return typed content blocks, not bare strings`,
      )
      assert.notEqual(block, null, `${name} render[${index}] is null`)
      assert.equal(block.type, 'text', `${name} render[${index}] needs type:"text"`)
      assert.equal(typeof block.text, 'string', `${name} render[${index}].text must be a string`)
      assert.doesNotMatch(block.text, /undefined/, `${name} render[${index}] leaked "undefined": ${block.text}`)
    }
  }
  return value
}

const agentA = { id: 'session-a' }
const agentB = { id: 'session-b' }

beforeEach(() => {
  rmSync(join(dataHome, 'attention-group'), { recursive: true, force: true })
})

test('the plugin loads from the copy under test, through the real defineTool when it is there', () => {
  // A passing run here means the artifact that actually runs in DSH accepted
  // every tool definition — not a test-only stand-in for defineTool. On a fresh
  // clone there is no profile, so the shim stands in; either way the suite says
  // which copy it used rather than leaving that to be guessed.
  assert.equal(typeof apply, 'function')
  assert.equal(existsSync(entry), true)
  if (usingInstalled) {
    assert.match(describeSource(), /installed profile copy/)
  } else {
    assert.match(describeSource(), /source tree/)
  }
})

test('attention_probe output and render satisfy the contract on an empty ledger', async () => {
  const { tools } = fakeContext()
  const value = await callTool(tools, 'attention_probe', {}, agentA)
  assert.equal(value.plugin.startsWith('attention-group@'), true)
  assert.deepEqual(value.groups, 0)
  assert.equal(Array.isArray(value.liveAgents), true)
})

test('attention_probe never reports a live agent with an undefined status', async () => {
  const { ctx, tools } = fakeContext()
  // A live agent with no `status` property is exactly the shape that used to
  // put `undefined` into an indexed output field.
  ctx.agents.list = () => [{ id: 'session-x' }]
  const value = await callTool(tools, 'attention_probe', {}, agentA)
  assert.equal(value.liveAgents.length, 1)
  assert.equal('status' in value.liveAgents[0], false, 'an absent status must be omitted, not undefined')
})

test('creating a group writes a ledger that survives JSON unchanged', async () => {
  const { tools } = fakeContext()
  const created = await callTool(tools, 'attention_group_create', { title: '插件工程协调', charter: '规则' }, agentA)
  assert.equal(created.ok, true)
  const file = join(dataHome, 'attention-group', 'groups.json')
  assert.equal(existsSync(file), true, 'ledger file must exist after create')
  const onDisk = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(onDisk.groups.length, 1)
  assert.deepEqual(onDisk, JSON.parse(JSON.stringify(onDisk)), 'ledger must be lossless JSON')
  assert.equal(onDisk.groups[0].members[0].id, 'session-a', 'the creating session joins itself')
})

test('a member name defaults to a string, never undefined', async () => {
  const { tools } = fakeContext()
  const created = await callTool(tools, 'attention_group_create', { title: 'g' }, agentA)
  const joined = await callTool(
    tools,
    'attention_group_join',
    { groupId: created.groupId, memberId: 'session-zzz' },
    agentA,
  )
  assert.equal(joined.ok, true)
  assert.equal(typeof joined.name, 'string')
  assert.ok(joined.name.length > 0, 'a defaulted name must not be empty')
})

test('joining an unknown group fails with a message, not a throw', async () => {
  const { tools } = fakeContext()
  const value = await callTool(tools, 'attention_group_join', { groupId: 'nope', memberId: 'session-a' }, agentA)
  assert.equal(value.ok, false)
  assert.match(value.error, /no groups exist|unknown group/)
})

test('an irrelevant message is reported silent and wakes nobody', async () => {
  const { tools } = fakeContext()
  const created = await callTool(tools, 'attention_group_create', { title: 'g' }, agentA)
  await callTool(tools, 'attention_group_join', { groupId: created.groupId, memberId: 'session-b', memberName: 'Bob', subscribe: ['抖音'] }, agentA)
  const sent = await callTool(tools, 'attention_send', { groupId: created.groupId, text: '今天天气不错' }, agentA)
  assert.equal(sent.ok, true)
  assert.equal(sent.silent, true)
  assert.deepEqual(sent.recipients, [])
})

test('the probe says whether a live session effort can be changed at all', async () => {
  // c7 ②: a capability that is missing must be explained at the plugin's own
  // diagnostic outlet. "The effort switch did nothing to my running session" is
  // exactly the kind of silent gap this line exists to prevent.
  const { tools } = fakeContext()
  const value = await callTool(tools, 'attention_probe')
  assert.equal(typeof value.liveEffortControl, 'string', 'the probe must report it')
  const text = tools.get('attention_probe').output.render({}, value).map((block) => block.text).join('\n')
  assert.match(text, /live effort control:/)
  // This harness deliberately has no sessionController, so the honest answer is
  // "not available" plus the reason.
  assert.match(text, /NOT available/)
  assert.match(text, /ctx\.inject is unavailable/)
})

test('classify mode hands the grey zone to the caller instead of guessing', async () => {
  // R4's second stage. `classify` must be observably different from `rules`, or
  // it is a switch in the panel that does nothing: the router refuses to decide
  // the members it could not match, so the CALLER gets to decide. Measured
  // 2026-10-16, this output did not exist and the mode was silently identical to
  // `rules` — the exact kind of "nothing happened and nobody said why" this
  // project is built to avoid.
  const first = fakeContext()
  const created = await callTool(first.tools, 'attention_group_create', { title: '灰区群' }, agentA)
  await callTool(first.tools, 'attention_group_join', { groupId: created.groupId, memberId: 'session-b', memberName: 'Bob', subscribe: ['抖音'] }, agentA)

  // `routeMode` is normally set from the panel, and there is no panel route in
  // this harness. The ledger is read once per `apply()`, so set it on disk and
  // boot again — which is also the honest way to prove the value survives a
  // restart.
  const ledgerFile = join(dataHome, 'attention-group', 'groups.json')
  const ledger = JSON.parse(readFileSync(ledgerFile, 'utf8'))
  ledger.groups[0].routeMode = 'classify'
  writeFileSync(ledgerFile, `${JSON.stringify(ledger, null, 2)}\n`)

  const { ctx, tools } = fakeContext()
  let woke = 0
  ctx.agents.get = () => ({ id: 'session-b', followup: () => { woke += 1 } })

  const sent = await callTool(tools, 'attention_send', { groupId: created.groupId, text: '今天发布一版' }, agentA)
  assert.equal(sent.mode, 'classify')
  assert.deepEqual(sent.recipients, [], 'the grey zone is not woken')
  assert.equal(sent.silent, true)
  assert.equal(sent.greyZone.length, 1, 'but it must be REPORTED, or the mode does nothing')
  assert.equal(sent.greyZone[0].name, 'Bob')
  assert.equal(woke, 0, 'classify must never turn into broadcast')

  const rendered = tools.get('attention_send').output.render({}, sent).map((block) => block.text).join('\n')
  assert.match(rendered, /grey zone/)
  assert.match(rendered, /Bob/)
  assert.match(rendered, /nobody woken/)
})

test('a bare-uuid session id is wakeable, because that is a real DSH session id', async () => {
  // Measured 2026-10-16 against the live runtime: `008bda70-4811-4349-a1a5-d6c6ff54d7d1`
  // is `stored` with route `deepseek-official/deepseek-flash @max`. Most sessions
  // on this machine look like that, with no `session-` prefix. Requiring the
  // prefix filed all of them as "a name, not a process", so they could never be
  // woken — the worst kind of bug: a capability that is simply absent for most of
  // the user's data, with no error to notice.
  const { ctx, tools } = fakeContext()
  const bareUuid = '008bda70-4811-4349-a1a5-d6c6ff54d7d1'
  let woke = 0
  ctx.agents.get = () => ({ id: bareUuid, followup: () => { woke += 1 } })

  const created = await callTool(tools, 'attention_group_create', { title: '裸id群' }, agentA)
  await callTool(tools, 'attention_group_join', { groupId: created.groupId, memberId: bareUuid, memberName: 'Tom' }, agentA)
  const ledger = JSON.parse(readFileSync(join(dataHome, 'attention-group', 'groups.json'), 'utf8'))
  ledger.groups[0].wakeEnabled = true
  writeFileSync(join(dataHome, 'attention-group', 'groups.json'), `${JSON.stringify(ledger, null, 2)}\n`)
  const second = fakeContext()
  second.ctx.agents.get = () => ({ id: bareUuid, followup: () => { woke += 1 } })

  const sent = await callTool(second.tools, 'attention_send', { groupId: created.groupId, text: '@Tom 看一下', wake: true }, agentA)
  assert.equal(sent.recipients.length, 1)
  assert.equal(sent.recipients[0].delivered, true, 'a bare-uuid session must actually receive the wake-up')
  assert.equal(woke, 1)

  // And a display name is still just a name.
  await callTool(second.tools, 'attention_group_join', { groupId: created.groupId, memberId: 'room-admin', memberName: '群管理', kind: 'admin' }, agentA)
  const named = await callTool(second.tools, 'attention_send', { groupId: created.groupId, text: '@群管理 在吗', wake: true }, agentA)
  const adminRow = named.recipients.find((row) => row.name === '群管理')
  assert.equal(adminRow.delivered, false)
  assert.match(adminRow.note, /non-session member/)
  assert.equal(woke, 1, 'a name in the room is never a process to wake')
})

test('a mention routes to exactly one member and never wakes on a dry run', async () => {
  const { ctx, tools } = fakeContext()
  let woke = 0
  ctx.agents.get = () => ({ id: 'session-b', followup: () => { woke += 1 } })
  const created = await callTool(tools, 'attention_group_create', { title: 'g' }, agentA)
  await callTool(tools, 'attention_group_join', { groupId: created.groupId, memberId: 'session-b', memberName: 'Bob' }, agentA)
  const sent = await callTool(tools, 'attention_send', { groupId: created.groupId, text: '@Bob 看一下' }, agentA)
  assert.equal(sent.recipients.length, 1)
  assert.equal(sent.recipients[0].reason, 'mention')
  assert.equal(sent.woken, false)
  assert.equal(woke, 0, 'a dry run must not start a turn anywhere')
})

test('waking requires both the request and the group switch', async () => {
  const { ctx, tools } = fakeContext()
  let woke = 0
  const delivered = []
  ctx.agents.get = () => ({ id: 'session-b', followup: (message) => { woke += 1; delivered.push(message) } })
  const created = await callTool(tools, 'attention_group_create', { title: 'g' }, agentA)
  await callTool(tools, 'attention_group_join', { groupId: created.groupId, memberId: 'session-b', memberName: 'Bob' }, agentA)

  // Group switch off: an explicit wake request must still refuse.
  const blocked = await callTool(tools, 'attention_send', { groupId: created.groupId, text: '@Bob hi', wake: true }, agentA)
  assert.equal(blocked.woken, false)
  assert.equal(woke, 0, 'waking disabled for the group must hold even when asked')

  // Turn the switch on and it delivers once.
  const on = await callTool(tools, 'attention_group_create', { title: 'g2', wakeEnabled: true }, agentA)
  await callTool(tools, 'attention_group_join', { groupId: on.groupId, memberId: 'session-b', memberName: 'Bob' }, agentA)
  const sent = await callTool(tools, 'attention_send', { groupId: on.groupId, text: '@Bob hi', wake: true }, agentA)
  assert.equal(sent.woken, true)
  assert.equal(woke, 1)
  assert.equal(delivered.length, 1)
})

/** Mirror of the v4 session format's message-source rule (see the test below). */
function v4SourceProblem(source) {
  const isPlainObject =
    typeof source === 'object' && source !== null && !Array.isArray(source)
  if (!isPlainObject) return 'source is not a plain object'
  if (typeof source.kind !== 'string' || source.kind.length === 0) return 'kind must be a non-empty string'
  if (source.kind === 'plugin') return 'kind "plugin" is rejected: the source must be producer-owned'
  return true
}

test('the delivered wake message is a well-formed user message', async () => {
  const { ctx, tools } = fakeContext()
  const delivered = []
  ctx.agents.get = () => ({ id: 'session-b', followup: (message) => delivered.push(message) })
  const created = await callTool(tools, 'attention_group_create', { title: 'g', wakeEnabled: true }, agentA)
  await callTool(tools, 'attention_group_join', { groupId: created.groupId, memberId: 'session-b', memberName: 'Bob' }, agentA)
  await callTool(tools, 'attention_send', { groupId: created.groupId, text: '@Bob 看一下', wake: true }, agentA)

  assert.equal(delivered.length, 1)
  const message = delivered[0]
  // This shape is what the RECEIVING session validates before it adopts the
  // event. Everything here was a live failure at least once.
  assert.equal(message.role, 'user')
  assert.ok(Array.isArray(message.content) && message.content.length > 0, 'content must be a non-empty array')
  for (const block of message.content) {
    assert.equal(typeof block, 'object')
    assert.notEqual(block, null)
    assert.equal(block.type, 'text', 'every content block needs a type the serializer knows')
    assert.equal(typeof block.text, 'string')
  }
  // v4 refuses the generic marker. Measured 2026-10-16 on a real target session:
  //   `format v4 message requires a producer-owned source kind`
  // which surfaced to the user as `本轮运行失败 … UNKNOWN` in that session.
  const sourceProblem = v4SourceProblem(message.source)
  assert.equal(sourceProblem, true, `wake message source is invalid: ${sourceProblem}`)
  assert.equal(message.source.kind, 'attention-group')
  assert.equal(typeof message.id, 'string')
  const problem = isLosslessJson(message)
  assert.equal(problem, true, `wake message is not lossless JSON: ${problem}`)
})

test('history returns an array and marks the reader caught up', async () => {
  const { tools } = fakeContext()
  const created = await callTool(tools, 'attention_group_create', { title: 'g' }, agentA)
  await callTool(tools, 'attention_send', { groupId: created.groupId, text: 'one' }, agentA)
  await callTool(tools, 'attention_send', { groupId: created.groupId, text: 'two' }, agentA)
  const history = await callTool(tools, 'attention_history', { groupId: created.groupId }, agentA)
  assert.equal(history.ok, true)
  assert.equal(history.total, 2)
  assert.equal(history.messages.length, 2)
  assert.deepEqual(history.messages.map((row) => row.text), ['one', 'two'])
})

test('history on an unknown group fails with a message, not a throw', async () => {
  const { tools } = fakeContext()
  const value = await callTool(tools, 'attention_history', { groupId: 'nope' }, agentA)
  assert.equal(value.ok, false)
  assert.deepEqual(value.messages, [])
})

test('history render is bounded and says so when it truncates', async () => {
  const { tools } = fakeContext()
  const created = await callTool(tools, 'attention_group_create', { title: 'g' }, agentA)
  // Write straight to the transcript: 260 messages is a size no tool result
  // should ever replay, and the point is what the projection does about it.
  const root = join(dataHome, 'attention-group')
  for (let index = 1; index <= 260; index += 1) {
    appendMessage(root, created.groupId, {
      seq: index,
      at: `2026-10-16T00:00:${String(index % 60).padStart(2, '0')}.000Z`,
      fromName: 'Bob',
      text: `message ${index}`,
      mentions: [],
    })
  }
  const history = await callTool(tools, 'attention_history', { groupId: created.groupId, limit: 10000 }, agentA)
  assert.equal(history.total, 260, 'the durable log keeps everything')
  const rendered = tools.get('attention_history').output.render({ groupId: created.groupId }, history)
  assert.ok(rendered.length <= 200, `render must stay bounded, got ${rendered.length} lines`)
  const joined = rendered.map((block) => block.text).join('\n')
  assert.match(joined, /omitted from this view/, 'a truncated view must say so')
  assert.match(joined, /message 260/, 'the newest message must survive truncation')
  assert.doesNotMatch(joined, /message 1\b/, 'the oldest messages are the ones dropped')
})

test('group list reports per-session unread so P and Q are distinguishable', async () => {
  const { tools } = fakeContext()
  // Two rooms, as the user described: P and Q must be tellable apart, and
  // reading one must not clear the other.
  const p = await callTool(tools, 'attention_group_create', { title: 'P' }, agentA)
  const q = await callTool(tools, 'attention_group_create', { title: 'Q' }, agentA)
  await callTool(tools, 'attention_group_join', { groupId: p.groupId, memberId: 'session-b', memberName: 'Bob' }, agentA)
  await callTool(tools, 'attention_group_join', { groupId: q.groupId, memberId: 'session-c', memberName: 'Carol' }, agentA)

  await callTool(tools, 'attention_send', { groupId: p.groupId, text: 'P 的第一条' }, agentB)
  await callTool(tools, 'attention_send', { groupId: p.groupId, text: 'P 的第二条' }, agentB)
  await callTool(tools, 'attention_send', { groupId: q.groupId, text: 'Q 的第一条' }, { id: 'session-c' })

  const listing = await callTool(tools, 'attention_group_list', {}, agentA)
  assert.equal(listing.unreadTotal, 3, 'agentA has 3 unread across both rooms')
  const pRow = listing.groups.find((row) => row.id === p.groupId)
  const qRow = listing.groups.find((row) => row.id === q.groupId)
  assert.equal(pRow.unread, 2)
  assert.equal(qRow.unread, 1)
  assert.equal(pRow.lastPreview, 'P 的第二条')
  assert.equal(qRow.lastPreview, 'Q 的第一条')

  await callTool(tools, 'attention_history', { groupId: p.groupId }, agentA)
  const after = await callTool(tools, 'attention_group_list', {}, agentA)
  assert.equal(after.groups.find((row) => row.id === p.groupId).unread, 0, 'reading P clears P')
  assert.equal(after.groups.find((row) => row.id === q.groupId).unread, 1, 'reading P must not clear Q')
  assert.equal(after.unreadTotal, 1)
})

test('a sender does not accrue unread from its own messages', async () => {
  const { tools } = fakeContext()
  const created = await callTool(tools, 'attention_group_create', { title: 'g' }, agentA)
  await callTool(tools, 'attention_send', { groupId: created.groupId, text: '自己发的' }, agentA)
  const listing = await callTool(tools, 'attention_group_list', {}, agentA)
  assert.equal(listing.groups[0].unread, 0, 'your own post is not your unread')
})

test('group list reports every group without leaking undefined', async () => {
  const { tools } = fakeContext()
  await callTool(tools, 'attention_group_create', { title: 'one' }, agentA)
  await callTool(tools, 'attention_group_create', { title: 'two' }, agentA)
  const value = await callTool(tools, 'attention_group_list', {}, agentA)
  assert.equal(value.groups.length, 2)
  for (const group of value.groups) {
    assert.equal(typeof group.id, 'string')
    assert.equal(typeof group.members, 'number')
    assert.equal(Array.isArray(group.memberNames), true)
    for (const name of group.memberNames) assert.equal(typeof name, 'string')
  }
})

test('a torn final JSONL line is skipped without losing earlier messages', () => {
  const root = join(dataHome, 'attention-group')
  mkdirSync(join(root, 'messages'), { recursive: true })
  appendMessage(root, 'g1', { seq: 1, at: '2026-10-16T00:00:00.000Z', text: 'good' })
  const file = join(root, 'messages', 'g1.jsonl')
  writeFileSync(file, `${readFileSync(file, 'utf8')}{"seq":2,"text":"tor`)
  const records = readMessages(root, 'g1', { limit: 0 })
  assert.equal(records.length, 1, 'the torn tail must not make history unreadable')
  assert.equal(records[0].text, 'good')
})

test('a JSONL line that parses but is not a message is dropped, not repaired into a phantom', () => {
  // Found by adversarial audit A-4 (2026-10-16). The doc comment promised
  // "unparseable lines are skipped" — but `null`, `42`, `[1,2]` and `{}` DO parse.
  // Keeping them was worse than dropping them: consumers read `row.seq` / `row.at`
  // off a null and threw, and `undefined` is not lossless JSON, so the runtime
  // rejected the whole tool result with `ToolOutputError`. One foreign line in a
  // transcript was enough to turn four tools into internal errors.
  const root = join(dataHome, 'attention-group')
  mkdirSync(join(root, 'messages'), { recursive: true })
  const good = JSON.stringify({ seq: 7, at: '2026-10-16T00:00:00.000Z', fromName: 'Bob', text: 'real', mentions: [] })
  const dirt = ['null', '42', '"a string"', '[1,2,3]', '{"foo":1}', '{}', '{"at":123}']
  writeFileSync(join(root, 'messages', 'g-dirt.jsonl'), `${dirt.join('\n')}\n${good}\n`)

  const records = readMessages(root, 'g-dirt', { limit: 0 })
  assert.equal(records.length, 1, `only the real message may survive, got ${records.length}`)
  assert.equal(records[0].text, 'real')
  assert.equal(records[0].seq, 7, 'a real sequence number must be preserved, not renumbered')
})

test('a message record with missing fields is filled in at the boundary, never left undefined', () => {
  // A record that loads must never make a render print the literal "undefined".
  // `JSON.parse` cannot produce an `undefined` VALUE — only an absent key — so
  // defaulting the keys every consumer reads is sufficient.
  const root = join(dataHome, 'attention-group')
  mkdirSync(join(root, 'messages'), { recursive: true })
  writeFileSync(join(root, 'messages', 'g-thin.jsonl'), '{"at":"2026-10-16T00:00:00.000Z"}\n')

  const records = readMessages(root, 'g-thin', { limit: 0 })
  assert.equal(records.length, 1, 'a line with a timestamp is a message; it is kept')
  assert.equal(records[0].fromId, '')
  assert.equal(records[0].fromName, '')
  assert.equal(records[0].text, '')
  assert.equal(typeof records[0].seq, 'number', 'a missing sequence number is filled in')
  assert.equal(Array.isArray(records[0].mentions), true)
  assert.equal(JSON.stringify(records[0]).includes('undefined'), false, 'lossless JSON only')
})

test('a room without a members array is repaired on load and reported, never thrown over', () => {
  // Found by adversarial audit A-3 (2026-10-16): `readLedger` validated that
  // `groups` is an array and nothing about the rooms inside it, so ONE room
  // without `members` made SIX tools throw
  // `TypeError: Cannot read properties of undefined (reading 'find')`.
  const root = join(dataHome, 'attention-group')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'groups.json'), JSON.stringify({ version: 1, groups: [{ id: 'g1', title: 'G' }] }))

  const { ledger, repairs } = readLedger(root)
  assert.equal(ledger.groups.length, 1, 'the room must be repaired, not dropped')
  assert.deepEqual(ledger.groups[0].members, [], 'members must be a usable array')
  assert.equal(Array.isArray(repairs), true, 'the repair must be reported, not silent')
  assert.equal(repairs[0].id, 'g1')
  assert.equal(repairs[0].problems.includes('members is not an array'), true)

  // A healthy ledger reports no repairs at all, so the panel never cries wolf.
  const clean = emptyLedger()
  clean.groups.push({ id: 'ok', title: 'OK', members: [] })
  writeLedger(root, clean)
  assert.equal(readLedger(root).repairs, undefined, 'a clean ledger must not produce repair noise')
})

test('ledger rooms that are not objects at all are repaired rather than crashing every reader', () => {
  const root = join(dataHome, 'attention-group')
  mkdirSync(root, { recursive: true })
  writeFileSync(
    join(root, 'groups.json'),
    JSON.stringify({ version: 1, groups: [null, 42, { id: 'g2', title: 'G2', members: [{ id: 'session-a', name: 'A' }] }] }),
  )

  const { ledger, repairs } = readLedger(root)
  assert.equal(ledger.groups.length, 3, 'the count must match the file; nothing is silently dropped')
  assert.equal(ledger.groups[0].title, '(unreadable room)')
  assert.deepEqual(ledger.groups[0].members, [])
  assert.equal(repairs.length, 2, 'both bad entries must be reported')
  // And the healthy room is untouched.
  assert.equal(ledger.groups[2].id, 'g2')
  assert.equal(ledger.groups[2].members.length, 1)
})

test('every tool refuses bad arguments with a schema-legal answer, never an internal error', async () => {
  // Adversarial audit A (2026-10-16) drove ~1,037 hostile argument sets through
  // these tools. The only findings it rated above "low" were refusals that the
  // plugin's OWN `output.schema` rejected after the fact, so the sentence written
  // for the model was replaced by `ToolOutputError`:
  //   attention_probe_session({sessionId:''}) -> "value.error" is not a declared property
  //   attention_conclude({groupId:'ghost'})   -> missing required property "value.relayed"
  // Both are pure-argument reachable: no bad data on disk is needed. `callTool`
  // now checks the schema on every single call, and this battery walks the refusal
  // path of all 13 tools, which is where an untested branch hides.
  const { tools } = fakeContext()
  const created = await callTool(tools, 'attention_group_create', { title: 'battery' }, agentA)
  const groupId = created.groupId

  const battery = [
    ['attention_probe', {}],
    ['attention_probe_session', { sessionId: '' }],
    ['attention_probe_session', { sessionId: '   ' }],
    ['attention_group_create', { title: '   ' }],
    ['attention_group_list', {}],
    ['attention_group_join', { groupId: 'ghost', memberId: 'someone' }],
    ['attention_group_join', { groupId: 'ghost', memberId: '' }],
    ['attention_send', { groupId: 'ghost', text: 'x' }],
    ['attention_send', { groupId, text: '   ' }],
    ['attention_history', { groupId: 'ghost' }],
    ['attention_conclude', { groupId: 'ghost', text: 'x' }],
    ['attention_conclude', { groupId, text: '   ' }],
    ['attention_export', { groupId: 'ghost' }],
    ['attention_digest', { groupId: 'ghost' }],
    ['attention_summarize', { groupId: 'ghost' }],
    ['attention_link', { groupId: 'ghost', to: 'nowhere' }],
    ['attention_effort', { groupId: 'ghost', effort: 'max' }],
    ['attention_effort', { groupId, effort: 'bogus' }],
  ]

  for (const [name, args] of battery) {
    // Only that the call RETURNED. `callTool` has already asserted the three
    // contracts that matter: lossless JSON, the typed-render contract, and
    // conformance to the tool's own `output.schema`. Not every tool carries an
    // `ok` field — `attention_probe` and `attention_group_list` are read-only
    // and always succeed — so asserting one here would be inventing a contract.
    //
    // ⚠️ Every entry must pass DSH's ARGUMENTS gate, which is a different gate
    // from the output schema and runs BEFORE `execute`: `defineTool` throws
    // `ToolArgsError` for a missing required parameter, so that call never
    // reaches the plugin at all and can never return anything. A battery entry
    // missing a required field therefore tests DSH, not this plugin — found by
    // adversarial audit B (2026-10-16) on `attention_group_join {groupId}`.
    await callTool(tools, name, args, agentA)
  }
})

test('a corrupt delivery audit log cannot take the diagnostic tool down with it', async () => {
  // Adversarial audit A-5 (2026-10-16): `attention_probe` is the tool a human
  // reaches for when a wake-up looks like it did not happen, so it is the worst
  // possible tool to break. A `null` line in deliveries.jsonl made it throw
  // `TypeError: Cannot read properties of null (reading 'at')`, and a `{}` line
  // made its result non-lossless JSON, which the runtime rejects outright.
  const { tools } = fakeContext()
  await callTool(tools, 'attention_group_create', { title: 'audit' }, agentA)
  const root = join(dataHome, 'attention-group')
  mkdirSync(join(root, 'messages'), { recursive: true })
  writeFileSync(join(root, 'messages', 'deliveries.jsonl'), 'null\n42\n{}\n"a string"\n{"at":"2026-10-16T00:00:00.000Z","memberId":"session-a","delivered":true}\n')

  const probe = await callTool(tools, 'attention_probe', {}, agentA)
  // `null`, `42` and `"a string"` are dropped at the store boundary (they are not
  // records); `{}` IS an object, so it is kept and defaulted. Dropping is the
  // deliberate choice: keeping them made the tool throw, and turning them into
  // phantom records would be worse than dropping them.
  assert.equal(probe.deliveryAudit.total, 2, 'only object lines are records; the rest are dropped, not counted')
  assert.equal(probe.deliveryAudit.recent.length, 2)
  for (const row of probe.deliveryAudit.recent) {
    for (const [key, cell] of Object.entries(row)) {
      assert.notEqual(cell, undefined, `deliveryAudit.recent.${key} must never be undefined`)
    }
  }
  assert.equal(probe.deliveryAudit.recent[0].at, '', 'a line with no timestamp reports an empty one, not undefined')
  assert.equal(probe.deliveryAudit.recent[0].memberId, '', 'a line with no member reports an empty one')
  assert.equal(probe.deliveryAudit.recent[1].memberId, 'session-a', 'a good line survives intact')
  assert.equal(probe.deliveryAudit.recent[1].delivered, true)
})

test('A-6: a deployment with many live sessions cannot inflate the probe result', async () => {
  // `MAX_RENDER_LINES` bounds how many lines a result carries; the probe listed
  // every live agent unconditionally, so 300 live sessions meant a 308-line tool
  // result replayed into every later request of the session (c4). Found by
  // adversarial audit B's cross-check (2026-10-16).
  const many = Array.from({ length: 300 }, (_, index) => ({ id: `session-${index}`, status: 'running' }))
  const { tools } = fakeContext({ liveAgents: many })
  const value = await callTool(tools, 'attention_probe', {}, agentA)
  assert.equal(value.liveAgents.length, 300, 'the VALUE still carries every agent; only the projection is trimmed')

  const rendered = tools.get('attention_probe').output.render({}, value)
  assert.ok(rendered.length <= 40, `the probe projection must stay small, got ${rendered.length} lines`)
  const text = rendered.map((block) => block.text).join('\n')
  assert.match(text, /live agents \(300\)/, 'the real count must still be reported')
  assert.match(text, /omitted from this view/, 'and the trim must say so rather than silently shortening')
})

test('A-6: one enormous message cannot become an enormous tool result', async () => {
  // A line COUNT is not a size. Adversarial audit A-6 (2026-10-16) measured a
  // single 1 MiB message producing a 1,048,656-byte tool result — two "lines" —
  // and a 100,000-character room id producing a 100,120-byte error line. A tool
  // result is replayed into every later request of the session, so size is the
  // cost, not line count.
  const { tools } = fakeContext()
  const created = await callTool(tools, 'attention_group_create', { title: 'big room' }, agentA)
  const huge = 'x'.repeat(1_000_000)
  await callTool(tools, 'attention_send', { groupId: created.groupId, text: huge }, agentA)

  const history = await callTool(tools, 'attention_history', { groupId: created.groupId, limit: 10 }, agentA)
  assert.equal(history.total, 1, 'the durable log keeps the whole message')
  const rendered = tools.get('attention_history').output.render({ groupId: created.groupId, limit: 10 }, history)
  const bytes = rendered.reduce((sum, block) => sum + Buffer.byteLength(block.text, 'utf8'), 0)
  assert.ok(bytes < 20_000, `a 1 MB message must not become a 1 MB tool result, got ${bytes} bytes`)
  assert.match(rendered.map((block) => block.text).join('\n'), /line truncated/, 'and the truncation must be stated')
})

test('a refusal still says which value was wrong and what the legal ones are', async () => {
  // The point of returning `{ok:false, error}` instead of throwing is that the
  // MODEL reads the sentence and can fix its own call. An error string that does
  // not name the value is a dead end dressed up as a helpful refusal.
  const { tools } = fakeContext()
  const created = await callTool(tools, 'attention_group_create', { title: 'refusals' }, agentA)

  const badEffort = await callTool(tools, 'attention_effort', { groupId: created.groupId, effort: 'bogus' }, agentA)
  assert.equal(badEffort.ok, false)
  assert.match(badEffort.error, /off/, 'the refusal must list the legal values')

  const noText = await callTool(tools, 'attention_send', { groupId: created.groupId, text: '   ' }, agentA)
  assert.equal(noText.ok, false)
  assert.match(noText.error, /text/)

  const noSession = await callTool(tools, 'attention_probe_session', { sessionId: '' }, agentA)
  assert.equal(noSession.ok, false)
  assert.match(noSession.error, /sessionId/)
  // And the render reaches the model with that reason rather than an internal error.
  const rendered = tools.get('attention_probe_session').output.render({ sessionId: '' }, noSession)
  assert.match(rendered.map((block) => block.text).join('\n'), /sessionId is required/)
})

test('B-09: an empty time range is refused before anyone is woken or anything is recorded', async () => {
  // Adversarial audit A-9 / B-09 (2026-10-16). The `total === 0` check lived only
  // in `render`, which runs AFTER the request was appended and the summariser was
  // actually woken. Measured on the old code: `{ok:true, total:0, delivered:true,
  // path:"live-followup"}`, one real delivery — and then the tool's own text said
  // "nobody was woken". A burnt turn in someone else's session, plus a diagnostic
  // that denies having spent it.
  const { tools } = fakeContext()
  const created = await callTool(tools, 'attention_group_create', { title: 'quiet room', wakeEnabled: true }, agentA)
  await callTool(
    tools,
    'attention_group_join',
    { groupId: created.groupId, memberId: 'room-admin', memberName: '群管理', kind: 'admin' },
    agentA,
  )

  const empty = await callTool(
    tools,
    'attention_summarize',
    { groupId: created.groupId, since: '2099-01-01T00:00:00.000Z', until: '2099-01-02T00:00:00.000Z', wake: true },
    agentA,
  )
  assert.equal(empty.ok, false, 'an empty window must be refused, not sent')
  assert.equal(empty.total, 0)
  assert.match(empty.error, /nothing to summarise/)

  // The stronger half: the refusal has to happen BEFORE the append, or the room
  // would still collect a summary-request for a summary that was never asked for.
  const history = await callTool(tools, 'attention_history', { groupId: created.groupId }, agentA)
  assert.equal(history.total, 0, 'a refused summarise must leave no request behind in the room')

  // And the render says the same thing the value does.
  const rendered = tools.get('attention_summarize').output.render({}, empty)
  assert.match(rendered.map((block) => block.text).join('\n'), /nothing to summarise/)
  assert.doesNotMatch(rendered.map((block) => block.text).join('\n'), /nobody was woken/)
})

test('a corrupt ledger is moved aside and reported rather than silently dropped', () => {
  const root = join(dataHome, 'attention-group')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'groups.json'), '{ this is not json')
  const { ledger, recoveredFrom } = readLedger(root)
  assert.deepEqual(ledger, emptyLedger())
  assert.equal(typeof recoveredFrom, 'string', 'the damaged file must be preserved for recovery')
  assert.equal(existsSync(recoveredFrom), true)
  assert.equal(readdirSync(root).some((name) => name.startsWith('groups.json.corrupt-')), true)
})

test('the ledger round-trips through disk unchanged', () => {
  const root = join(dataHome, 'attention-group')
  const ledger = emptyLedger()
  ledger.groups.push({ id: 'g', title: '标题 @#$', members: [{ id: 'session-a', name: 'A', subscribe: ['x'] }] })
  writeLedger(root, ledger)
  const back = readLedger(root)
  assert.deepEqual(back.ledger, JSON.parse(JSON.stringify(ledger)))
})

test('B-06: a stale save merges rooms created by another process instead of erasing them', () => {
  // Adversarial audit B-06 (2026-10-16). The ledger lives in memory for the life
  // of the process, so a second DSH writing `groups.json` is invisible to the
  // first — and the first process's next save would silently erase whatever the
  // second had created. Two DSH instances on one data directory is the only way to
  // hit it, but "silently erased" is the worst possible answer to it.
  const root = join(dataHome, 'attention-group')
  mkdirSync(root, { recursive: true })

  const mine = emptyLedger()
  mine.groups.push({ id: 'mine', title: 'Mine', members: [] })
  writeLedger(root, mine)

  // Another process creates a room; we never see it, because our copy is in memory.
  const theirs = readLedger(root).ledger
  theirs.groups.push({ id: 'theirs', title: 'Theirs', members: [] })
  writeLedger(root, theirs)

  // Saving our stale copy must keep the room we know nothing about.
  writeLedger(root, mine)
  const ids = readLedger(root).ledger.groups.map((group) => group.id).sort()
  assert.deepEqual(ids, ['mine', 'theirs'], `a room written by another process must survive, got ${ids.join(', ')}`)
})

test('A-10: a period that is not a date is refused, not answered as "no messages"', async () => {
  // Adversarial audit A-10 (2026-10-16): `since: "not-a-date"` was accepted and
  // compared as text, which matches nothing — so the caller was told "there is
  // nothing in that period" about a period it never managed to describe.
  const { tools } = fakeContext()
  const created = await callTool(tools, 'attention_group_create', { title: 'range room' }, agentA)

  const bad = await callTool(tools, 'attention_digest', { groupId: created.groupId, since: 'not-a-date' }, agentA)
  assert.equal(bad.ok, false, 'an unparseable instant must be refused')
  assert.match(bad.error, /not a date/)

  // A real ISO instant still works, so the guard is not refusing valid input.
  const good = await callTool(tools, 'attention_digest', { groupId: created.groupId, since: '2026-10-16T00:00:00.000Z' }, agentA)
  assert.equal(good.ok, true)
})
