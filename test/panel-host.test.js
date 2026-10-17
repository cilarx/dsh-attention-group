/**
 * Host-side panel tests: the route the browser half actually talks to.
 *
 * The panel is only as good as this route. Everything the browser can do is an
 * HTTP GET (read model) or POST (one named action), so this file drives the REAL
 * registered handler with fake req/res objects — no HTTP server, no browser, but
 * the same code path, including the JSON body parsing and the status codes.
 *
 * What it pins down, and why each one is worth a test:
 *   - every action the panel can send lands somewhere durable;
 *   - an illegal value is refused by NAMING the legal ones (the panel renders the
 *     host's own table, so a refusal here means the two have drifted);
 *   - waking from the panel is NARROW: with the room's 唤醒 switch on, a post
 *     that NAMES somebody wakes exactly those people (2026-10-18, user request);
 *     a plain note, a keyword hit, or a room with waking off wakes nobody. The
 *     old blanket rule ("a click never starts a turn") was replaced because the
 *     human needs @-addressing to reach the room — the two halves below pin the
 *     new rule, including the half that must still stay silent;
 *   - `joinPolicy` is a real permission control for agents (R8), and a room whose
 *     record predates the field behaves like the default rather than falling open.
 *
 * Run: node --test test/panel-host.test.js
 * (requires: pwsh -File tools/sync-plugin.ps1)
 */

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, rmSync, writeFileSync, existsSync, mkdirSync, utimesSync } from 'node:fs'
import { join } from 'node:path'

import { createHost } from './support/host-harness.mjs'

/** The one participant this harness declares LIVE, so a wake-up can succeed. */
const LIVE_JIA = 'session-aaaa1111-2222-3333-4444-555566667777'

const host = await createHost({ liveSessions: [LIVE_JIA] })
after(() => host.cleanup())

// Thin aliases, so each test reads as a sequence of requests.
const boot = () => host.boot()
const reboot = () => host.reboot()
const call = (options) => host.call(options)
const get = (query) => host.get(query)
const post = (body) => host.post(body)
const ledgerOnDisk = () => host.ledgerOnDisk()
const newRoom = (title) => host.newRoom(title)

/** Every delivery attempt the plugin audited, oldest first. */
function deliveryRows() {
  const path = join(host.home, 'attention-group', 'messages', 'deliveries.jsonl')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line))
}

test('the panel route registers as an exact path', () => {
  boot()
  const route = host.route
  assert.ok(route !== null, 'ctx.inject(["webServer"]) must yield a route')
  assert.equal(route.kind, 'exact')
  assert.equal(route.path, '/attention-group')
  assert.equal(typeof route.handler, 'function')
})

test('a re-activated child fiber re-registers the route instead of failing on a duplicate', async () => {
  // Cordis can activate an `ctx.inject` child fiber more than once (the web
  // entry reloads, a dependency is re-composed). Measured on 0.2.1-rc.1 at boot:
  // the second `webServer.register` threw `duplicate exact route`, the FIRST
  // route stayed live, and the only casualty was the probe — which then reported
  // a working panel as `failed: …duplicate…`. The fix releases the previous
  // registration first; this test pins it.
  boot()
  const first = host.route
  assert.ok(first !== null)
  host.reactivate()
  assert.equal(host.routeCount, 1, 'exactly one live registration after re-activation')
  assert.notEqual(host.route, first, 'the most recent activation owns the live route')
  const response = await get()
  assert.equal(response.status, 200)
  assert.equal(response.json.ok, true)
})

test('an opted-in room announces its unread count in the member prompt, and only to members', async () => {
  // R6's missing half: a member that gets started for some OTHER reason used to
  // have no idea the room had messages waiting. The runtime prompt context is the
  // only channel that survives compaction, so this is where it belongs.
  boot()
  const groupId = await newRoom('未读提示群')
  const memberId = 'session-7777aaaa-8888-9999-aaaa-bbbbccccdddd'
  await post({ action: 'join', group: groupId, memberId, memberName: '成员甲' })
  await post({ action: 'post', group: groupId, text: '有人吗' })

  const lineFor = (id) =>
    host.promptContexts
      .map((row) => (typeof row.text === 'function' ? row.text({ agent: { session: { id } } }) : row.text))
      .join('\n')

  assert.equal(lineFor(memberId), '', 'the default stays quiet: no per-step prompt noise')
  await post({ action: 'promptUnread', group: groupId, promptUnread: true })
  assert.match(lineFor(memberId), /群聊未读/)
  assert.match(lineFor(memberId), /未读提示群/)
  assert.equal(lineFor('session-00000000-0000-0000-0000-000000000000'), '', 'a non-member is never told')
  // A switch that can only be turned ON is not a switch.
  await post({ action: 'promptUnread', group: groupId, promptUnread: false })
  assert.equal(lineFor(memberId), '')
})

test('one tool result is capped in TOTAL characters, not only in lines', async () => {
  // 200 lines x 2000 characters is 400,000 characters — roughly 100k tokens — and
  // a line count alone would happily allow exactly that. A tool result is replayed
  // into every later request of the session that asked for it, so the projection
  // also has a total budget; it keeps the newest lines and says how many it dropped.
  boot()
  const groupId = await newRoom('大群')
  const filler = 'x'.repeat(1900)
  for (let i = 0; i < 40; i += 1) {
    await post({ action: 'post', group: groupId, text: `MSG-${i} ${filler}` })
  }
  const history = host.tool('attention_history')
  const value = await history.execute({ groupId, limit: 200 }, {})
  const blocks = history.output.render({ groupId, limit: 200 }, value)
  const total = blocks.reduce((sum, block) => sum + (typeof block.text === 'string' ? block.text.length : 0), 0)
  assert.ok(total <= 61500, `one result must stay near the 60000-character cap, got ${total}`)
  assert.ok(
    blocks.some((block) => /omitted from this view/.test(String(block.text))),
    'and it must say how many lines it dropped',
  )
  // The TAIL has to survive: for a transcript the newest lines are what a reader
  // needs, so the budget drops from the FRONT.
  assert.ok(blocks.some((block) => String(block.text).includes('MSG-39')), 'the newest line is kept')
  assert.ok(!blocks.some((block) => String(block.text).includes('MSG-0 ')), 'the oldest line is the one dropped')
})

test('/group is a real human command, and typing it never wakes anybody', async () => {
  boot()
  const groupId = await newRoom('命令测试群')
  const command = host.commands.get('group')
  assert.ok(command !== undefined, 'the runtime command registry must see /group')

  const listed = await command.handler({ rawInput: 'list', agent: { id: 'session-abc' } })
  assert.equal(listed.kind, 'success')
  assert.match(listed.text, /命令测试群/)

  const said = await command.handler({ rawInput: 'say 命令测试群 你好', agent: { id: 'session-abc' } })
  assert.equal(said.kind, 'success')
  assert.equal(host.messagesOnDisk(groupId).trim().split('\n').length, 1, 'the message must land on disk')

  const bad = await command.handler({ rawInput: 'say 不存在的群 你好', agent: { id: 'session-abc' } })
  assert.equal(bad.kind, 'error')
  assert.match(bad.text, /找不到群/)

  const unknown = await command.handler({ rawInput: 'nope', agent: { id: 'session-abc' } })
  assert.equal(unknown.kind, 'error')
  assert.match(unknown.text, /用法/)

  assert.equal(host.delivered.length, 0, 'a typed command is not a reason to start a turn')
})

test('the summary button refuses clearly when the room cannot produce one', async () => {
  boot()
  const groupId = await newRoom('摘要按钮群')
  // No admin member at all — the reason must name the member, not a generic failure.
  const noAdmin = await post({ action: 'summaryGenerate', group: groupId })
  assert.equal(noAdmin.status, 400)
  assert.match(noAdmin.json.error, /群管理/)

  // An admin exists, but this room's waking switch is off: the button must not be
  // the thing that turns a silent room noisy by accident.
  await post({ action: 'join', group: groupId, memberId: 'session-admin-0001', memberName: '群管理', kind: 'admin' })
  await post({ action: 'post', group: groupId, text: '一条消息' })
  const noWake = await post({ action: 'summaryGenerate', group: groupId })
  assert.equal(noWake.status, 400)
  assert.match(noWake.json.error, /唤醒/)
  assert.equal(host.delivered.length, 0, 'and nothing may be woken on the refusal path')
})

test('@所有人 is inert until the room allows it, and then it addresses the whole room', async () => {
  boot()
  const groupId = await newRoom('全体广播群')
  const first = 'session-aaaa0001-0000-0000-0000-000000000001'
  const second = 'session-bbbb0002-0000-0000-0000-000000000002'
  await post({ action: 'join', group: groupId, memberId: first, memberName: '甲' })
  await post({ action: 'join', group: groupId, memberId: second, memberName: '乙' })

  const send = host.tool('attention_send')
  const admin = 'session-adm1n-0000-0000-0000-000000000009'
  await post({ action: 'join', group: groupId, memberId: admin, memberName: '管理', kind: 'admin' })
  const execAdmin = { agent: { id: admin } }
  const execPlain = { agent: { id: first } }
  // A caller that is not a member at all must never get the megaphone.
  const execOutsider = { agent: { id: 'session-outside-0000-0000-0000-00000000ffff' } }

  // Default OFF. The message is still posted; the phrase just stays plain text,
  // and the answer names the gate that refused it (no silent downgrade).
  const off = await send.execute({ groupId, text: '@所有人 开会' }, execAdmin)
  assert.equal(off.ok, true)
  assert.equal(off.allMention, false)
  assert.match(off.allMentionNote, /允许 @所有人/)
  assert.equal(off.silent, true, 'with the switch off nobody is addressed')
  assert.equal(host.delivered.length, 0)

  await post({ action: 'mentionAll', group: groupId, mentionAll: true })

  // Switch on, but a plain SESSION member still cannot address everyone...
  const plainTry = await send.execute({ groupId, text: '@所有人 开会' }, execPlain)
  assert.equal(plainTry.allMention, false)
  assert.match(plainTry.allMentionNote, /human or an admin/)

  // ...and neither can a caller that is not a member of this room.
  const outsiderTry = await send.execute({ groupId, text: '@所有人 开会' }, execOutsider)
  assert.equal(outsiderTry.allMention, false)
  assert.match(outsiderTry.allMentionNote, /human or an admin/)

  // Only the human and room admins get through.
  const on = await send.execute({ groupId, text: '@所有人 开会' }, execAdmin)
  assert.equal(on.ok, true)
  assert.equal(on.allMention, true)
  assert.equal(on.allMentionNote, undefined, 'a granted broadcast needs no excuse')
  const addressed = on.recipients.map((row) => row.name)
  assert.ok(
    addressed.includes('甲') && addressed.includes('乙'),
    `both members must be addressed, got ${addressed.join(',')}`,
  )
  assert.ok(on.recipients.every((row) => row.reason === 'broadcast'), 'and the reason is the broadcast reason')
  assert.equal(host.delivered.length, 0, 'a dry run still wakes nobody')
})

test('the summary reminder counts un-summarised messages and never acts on its own', async () => {
  // The user's decision (2026-10-17): remind at a limit, but never compact by
  // itself. A summary costs a model turn in someone else's session, so the panel
  // may only NAG. This test pins the counting, the knob table and the refusal —
  // and that nagging changes nothing on disk.
  boot()
  const groupId = await newRoom('摘要提醒群')
  await post({ action: 'post', group: groupId, text: '第一条' })
  await post({ action: 'post', group: groupId, text: '第二条' })
  const detail = async () => (await get(`?group=${groupId}`)).json.group

  const before = await detail()
  assert.equal(before.summary.every, 500, 'the default threshold is large, not zero')
  assert.equal(before.summary.pending, 2, 'two messages and no summary yet')
  assert.equal(before.summary.count, 0)

  // The panel renders the host's own table, so an illegal value must be refused
  // by NAMING the legal ones (the panel and the host cannot drift).
  const refused = await post({ action: 'summaryEvery', group: groupId, summaryEvery: 12345 })
  assert.equal(refused.status, 400)
  assert.match(refused.json.error, /0 \/ 200 \/ 500 \/ 2000/)

  const accepted = await post({ action: 'summaryEvery', group: groupId, summaryEvery: 200 })
  assert.equal(accepted.json.summaryEvery, 200)
  assert.equal((await detail()).summary.every, 200)

  // Reminding is inert: no summary recorded, no message appended.
  assert.equal((await detail()).summary.count, 0)
  assert.equal(host.messagesOnDisk(groupId).trim().split('\n').length, 2)
})

test('one GET returns the room list, per-room unread, and the knob table', async () => {
  boot()
  const groupId = await newRoom('读模型群')
  await post({ action: 'post', group: groupId, text: '第一条' })

  const response = await get()
  assert.equal(response.status, 200)
  assert.equal(response.headers['cache-control'], 'no-store')

  const payload = response.json
  assert.equal(payload.ok, true)
  assert.equal(payload.groups.length, 1)
  const row = payload.groups[0]
  assert.equal(row.id, groupId)
  assert.equal(row.messages, 1)
  assert.equal(row.memberCount, 1, 'the creating human is a member')
  assert.equal(row.wakeEnabled, false, 'waking is off until it is turned on')
  assert.equal(row.routeMode, 'rules')
  assert.equal(row.lastPreview, '第一条')
  // The human wrote it, so it is not unread to them.
  assert.equal(row.unread, 0)

  // The panel renders whatever the host declares here, so this table IS the UI.
  assert.deepEqual(
    payload.knobs.routeModes.map((row) => row.value),
    ['rules', 'classify', 'broadcast'],
  )
  assert.deepEqual(
    payload.knobs.efforts.map((row) => row.value),
    ['', 'off', 'low', 'high', 'max'],
  )
  assert.deepEqual(
    payload.knobs.joinPolicies.map((row) => row.value),
    ['open', 'members', 'user', 'nobody'],
  )
  assert.ok(payload.knobs.memberKinds.includes('liaison'), 'the liaison seat must be reservable')
  for (const option of [...payload.knobs.routeModes, ...payload.knobs.efforts, ...payload.knobs.joinPolicies]) {
    assert.equal(typeof option.label, 'string')
    assert.equal(typeof option.hint, 'string', `${option.value} needs a hint: the panel shows it as the tooltip`)
  }
})

test('a room detail carries the whole settings surface and its members', async () => {
  boot()
  const groupId = await newRoom('详情群')
  await post({ action: 'join', group: groupId, memberId: 'session-aaaa1111-2222-3333-4444-555566667777', memberName: '甲' })

  const response = await get(`?group=${groupId}`)
  assert.equal(response.status, 200)
  const group = response.json.group
  assert.equal(group.id, groupId)
  assert.equal(group.routeMode, 'rules')
  assert.equal(group.defaultEffort, '')
  assert.equal(group.joinPolicy, 'members')
  assert.equal(group.selfReflect, true)
  assert.equal(group.wakeEnabled, false)
  assert.equal(group.members.length, 2)

  const human = group.members.find((row) => row.isHuman === true)
  assert.equal(human.id, 'user')
  assert.equal(human.wakeable, false, 'a person has no session to wake')
  const jia = group.members.find((row) => row.name === '甲')
  assert.equal(jia.wakeable, true)
  assert.equal(jia.enabled, true)
  assert.deepEqual(jia.subscribe, [])
})

test('an unknown room fails loudly and still hands back the list', async () => {
  boot()
  await newRoom('存在的群')
  const response = await get('?group=nope')
  assert.equal(response.status, 404)
  assert.equal(response.json.ok, false)
  assert.match(response.json.error, /nope/)
  assert.equal(response.json.groups.length, 1, 'the list still renders: one bad id must not blank the panel')
})

test('the human can create a room, and the room survives on disk', async () => {
  boot()
  const groupId = await newRoom('我自己建的群')
  assert.match(groupId, /^我自己建的群-/u, 'the id is derived from the title and stays readable')

  const onDisk = ledgerOnDisk()
  assert.equal(onDisk.groups.length, 1)
  assert.equal(onDisk.groups[0].title, '我自己建的群')
  assert.deepEqual(
    onDisk.groups[0].members.map((row) => row.id),
    ['user'],
    'the creator is a member, or nobody could ever add anyone',
  )
})

test('a panel post appends a message, extracts mentions, and wakes nobody', async () => {
  boot()
  const groupId = await newRoom('发言群')
  await post({ action: 'join', group: groupId, memberId: 'session-aaaa1111-2222-3333-4444-555566667777', memberName: '甲' })

  const response = await post({ action: 'post', group: groupId, text: '大家好 @甲 看一下' })
  assert.equal(response.status, 200)
  assert.equal(response.json.seq, 1)
  assert.deepEqual(response.json.mentions, ['甲'], 'the panel must route the same way a tool call does')
  assert.equal(response.json.addressed, true, 'the message DOES name somebody')
  assert.equal(response.json.woken, 0, 'but this room has waking off, so nobody is woken')
  assert.equal(response.json.recipients[0].note, 'waking is off for this room', 'and the reason is reported, not guessed')

  const lines = host.messagesOnDisk(groupId).trim().split('\n')
  assert.equal(lines.length, 1)
  const record = JSON.parse(lines[0])
  assert.equal(record.text, '大家好 @甲 看一下')
  assert.equal(record.fromId, 'user')
  assert.equal(record.fromName, '用户')

  // The invariant: a click never starts a turn, so there is no delivery to audit.
  assert.equal(
    existsSync(join(host.home, 'attention-group', 'messages', 'deliveries.jsonl')),
    false,
    'speaking from the panel must not attempt any delivery',
  )
})

test('opening a room joins the human and clears its unread count', async () => {
  boot()
  // Enough that the human has genuinely not seen it: the human is not a member
  // here, which is exactly the state the two pre-existing rooms were in.
  const groupId = await newRoom('待读群')
  await post({ action: 'post', group: groupId, text: '一' })
  await post({ action: 'post', group: groupId, text: '二' })
  await call({
    method: 'POST',
    body: { action: 'leave', group: groupId, memberId: 'user' },
  })

  const before = await get()
  assert.equal(before.json.groups[0].unread, 2, 'a room the human never joined is entirely unread')

  const read = await post({ action: 'read', group: groupId })
  assert.equal(read.json.ok, true)
  assert.equal(read.json.joined, true, 'opening a room is joining it')

  const after = await get(`?group=${groupId}`)
  assert.equal(after.json.groups[0].unread, 0)
  assert.ok(after.json.group.members.some((row) => row.isHuman === true))
})

test('every knob round-trips through disk', async () => {
  boot()
  const groupId = await newRoom('旋钮群')
  const writes = [
    { action: 'rename', title: '旋钮群改名', check: (group) => group.title === '旋钮群改名' },
    { action: 'route', routeMode: 'classify', check: (group) => group.routeMode === 'classify' },
    { action: 'effort', effort: 'max', check: (group) => group.defaultEffort === 'max' },
    { action: 'selfReflect', selfReflect: false, check: (group) => group.selfReflect === false },
    { action: 'joinPolicy', joinPolicy: 'user', check: (group) => group.joinPolicy === 'user' },
    { action: 'charter', charter: '新群规：只谈正事', check: (group) => group.charter === '新群规：只谈正事' },
    { action: 'wake', wakeEnabled: true, check: (group) => group.wakeEnabled === true },
  ]
  for (const write of writes) {
    const response = await post(Object.assign({ group: groupId }, write))
    assert.equal(response.status, 200, `${write.action} failed: ${response.text}`)
    const group = (await get(`?group=${groupId}`)).json.group
    assert.ok(write.check(group), `${write.action} did not stick: ${JSON.stringify(group)}`)
  }

  // And the same values are on disk, not just in this process's memory.
  const onDisk = ledgerOnDisk().groups[0]
  assert.equal(onDisk.title, '旋钮群改名')
  assert.equal(onDisk.routeMode, 'classify')
  assert.equal(onDisk.defaultEffort, 'max')
  assert.equal(onDisk.selfReflect, false)
  assert.equal(onDisk.joinPolicy, 'user')
  assert.equal(onDisk.wakeEnabled, true)
})

test('an illegal knob value is refused by naming the legal ones', async () => {
  boot()
  const groupId = await newRoom('校验群')
  const cases = [
    { body: { action: 'route', routeMode: 'vibes' }, names: 'rules' },
    { body: { action: 'effort', effort: 'turbo' }, names: 'max' },
    { body: { action: 'joinPolicy', joinPolicy: 'friends' }, names: 'nobody' },
  ]
  for (const row of cases) {
    const response = await post(Object.assign({ group: groupId }, row.body))
    assert.equal(response.status, 400, `${row.body.action} must be refused`)
    assert.equal(response.json.ok, false)
    assert.match(response.json.error, new RegExp(row.names), 'the refusal must say what IS allowed')
  }
  // Nothing was written by any of the refusals.
  const group = (await get(`?group=${groupId}`)).json.group
  assert.equal(group.routeMode, 'rules')
  assert.equal(group.defaultEffort, '')
  assert.equal(group.joinPolicy, 'members')
})

test('a member row can be added, slept, re-subscribed, re-pointed and removed', async () => {
  boot()
  const groupId = await newRoom('成员群')
  const jia = 'session-aaaa1111-2222-3333-4444-555566667777'

  await post({ action: 'join', group: groupId, memberId: jia, memberName: '甲', kind: 'session' })
  await post({ action: 'member', group: groupId, memberId: jia, subscribe: '部署, 发布\n上线' })
  let member = (await get(`?group=${groupId}`)).json.group.members.find((row) => row.id === jia)
  assert.deepEqual(member.subscribe, ['部署', '发布', '上线'], 'the panel sends text; the host splits it')

  await post({ action: 'member', group: groupId, memberId: jia, wakeEffort: 'low' })
  member = (await get(`?group=${groupId}`)).json.group.members.find((row) => row.id === jia)
  assert.equal(member.wakeEffort, 'low')

  // Clearing an override must remove the field, not store an empty string the
  // delivery path would have to keep filtering out.
  await post({ action: 'member', group: groupId, memberId: jia, wakeEffort: '' })
  member = (await get(`?group=${groupId}`)).json.group.members.find((row) => row.id === jia)
  assert.equal(member.wakeEffort, '')
  assert.equal(Object.prototype.hasOwnProperty.call(ledgerOnDisk().groups[0].members.find((row) => row.id === jia), 'wakeEffort'), false)

  await post({ action: 'member', group: groupId, memberId: jia, enabled: false })
  member = (await get(`?group=${groupId}`)).json.group.members.find((row) => row.id === jia)
  assert.equal(member.enabled, false)

  const removed = await post({ action: 'leave', group: groupId, memberId: jia })
  assert.equal(removed.json.ok, true)
  assert.equal((await get(`?group=${groupId}`)).json.group.members.some((row) => row.id === jia), false)

  const again = await post({ action: 'leave', group: groupId, memberId: jia })
  assert.equal(again.status, 400)
  assert.match(again.json.error, /unknown member/)
})

test('a nameless action is still a post, and an empty one is refused', async () => {
  boot()
  const groupId = await newRoom('默认动作群')
  const plain = await post({ group: groupId, text: '没有 action 字段' })
  assert.equal(plain.json.ok, true)
  assert.equal(plain.json.seq, 1)

  const empty = await post({ group: groupId, text: '   ' })
  assert.equal(empty.status, 400)
  assert.match(empty.json.error, /text is required/)

  const noText = await post({ action: 'create', title: '  ' })
  assert.equal(noText.status, 400)
  assert.match(noText.json.error, /title is required/)
})

test('with waking ON, a panel post wakes exactly the people it NAMES', async () => {
  // 2026-10-18, user request: "打开唤醒，@ 到人，就真的叫醒他". The old blanket
  // rule ("a click never wakes anybody") is replaced by this narrower one.
  boot()
  const groupId = await newRoom('点名群')
  await post({ action: 'join', group: groupId, memberId: LIVE_JIA, memberName: '甲' })
  await post({ action: 'join', group: groupId, memberId: 'session-99999999-8888-7777-6666-555544443333', memberName: '乙' })
  await post({ action: 'wake', group: groupId, wakeEnabled: true })

  const before = host.delivered.length
  const fired = await post({ action: 'post', group: groupId, text: '大家好 @甲 看一下' })
  assert.equal(fired.json.ok, true)
  assert.equal(fired.json.addressed, true)
  assert.equal(fired.json.woken, 1, 'exactly the named member — not the whole room')
  assert.equal(host.delivered.length, before + 1, 'and a turn really started in that session')
  assert.equal(host.delivered[host.delivered.length - 1].sessionId, LIVE_JIA)

  const rows = deliveryRows().filter((row) => row.groupId === groupId)
  assert.equal(rows.length, 1, 'every attempt is audited (third witness, c5)')
  assert.equal(rows[0].delivered, true)
  assert.equal(rows[0].memberId, LIVE_JIA)
  assert.equal(rows[0].reason, 'mention')
})

test('with waking ON, a plain panel note and a keyword hit still wake nobody', async () => {
  boot()
  const groupId = await newRoom('闭嘴群')
  await post({ action: 'join', group: groupId, memberId: LIVE_JIA, memberName: '甲' })
  await post({ action: 'member', group: groupId, memberId: LIVE_JIA, subscribe: '部署' })
  await post({ action: 'wake', group: groupId, wakeEnabled: true })

  const before = host.delivered.length
  const plain = await post({ action: 'post', group: groupId, text: '有人吗，随便说说' })
  assert.equal(plain.json.woken, 0)

  // A subscription matches, but a panel note that names nobody is not an
  // address: waking a subscriber because a stray word appeared is exactly the
  // noise this plugin exists to remove.
  const keywordOnly = await post({ action: 'post', group: groupId, text: '部署上线了' })
  assert.equal(keywordOnly.json.woken, 0)
  assert.equal(host.delivered.length, before, 'no turn may start from a note nobody was addressed in')
})

test('@所有人 from the panel needs BOTH switches, exactly like the tool', async () => {
  boot()
  const groupId = await newRoom('广播群')
  await post({ action: 'join', group: groupId, memberId: LIVE_JIA, memberName: '甲' })
  await post({ action: 'wake', group: groupId, wakeEnabled: true })

  // 「允许 @所有人」 is off by default, so the phrase stays plain text.
  const off = await post({ action: 'post', group: groupId, text: '@所有人 开会了' })
  assert.equal(off.json.allMention, false)
  assert.match(off.json.allMentionNote, /允许 @所有人/)
  assert.equal(off.json.woken, 0)

  await post({ action: 'mentionAll', group: groupId, mentionAll: true })
  const before = host.delivered.length
  const on = await post({ action: 'post', group: groupId, text: '@所有人 开会了' })
  assert.equal(on.json.allMention, true)
  assert.equal(on.json.woken, 1)
  assert.equal(host.delivered.length, before + 1)

  // The decision lives on the record; the router never re-reads the text.
  const rows = host.messagesOnDisk(groupId).trim().split('\n').map((line) => JSON.parse(line))
  const last = rows[rows.length - 1]
  assert.equal(last.allMention, true)
})

test('joinPolicy is a real permission control for agents (R8)', async () => {
  boot()
  const groupId = await newRoom('权限群')
  const join = host.tool('attention_group_join')
  assert.ok(join !== undefined)
  const outsider = 'session-99999999-8888-7777-6666-555544443333'
  const member = 'session-aaaa1111-2222-3333-4444-555566667777'

  // Default policy: only existing members may add anyone.
  let out = await join.execute({ groupId, memberId: member }, { agent: { id: outsider } })
  assert.equal(out.ok, false, 'a non-member must not walk into a room under the default policy')
  assert.match(out.error, /joinPolicy=members/)
  assert.match(out.error, /refused/, 'a refusal is a permission answer, and must read like one')

  // The human adds that session, and now it may invite in turn.
  await post({ action: 'join', group: groupId, memberId: outsider, memberName: '外部' })
  out = await join.execute({ groupId, memberId: member }, { agent: { id: outsider } })
  assert.equal(out.ok, true)

  // 仅用户: every agent is locked out, member or not.
  await post({ action: 'joinPolicy', group: groupId, joinPolicy: 'user' })
  out = await join.execute({ groupId, memberId: 'session-11111111-1111-1111-1111-111111111111' }, { agent: { id: outsider } })
  assert.equal(out.ok, false)
  assert.match(out.error, /joinPolicy=user/)

  // 冻结: nobody.
  await post({ action: 'joinPolicy', group: groupId, joinPolicy: 'nobody' })
  out = await join.execute({ groupId, memberId: 'session-22222222-2222-2222-2222-222222222222' }, { agent: { id: outsider } })
  assert.equal(out.ok, false)
  assert.match(out.error, /frozen/)

  // 开放: anyone.
  await post({ action: 'joinPolicy', group: groupId, joinPolicy: 'open' })
  out = await join.execute({ groupId, memberId: 'session-33333333-3333-3333-3333-333333333333' }, { agent: { id: 'session-nobody-at-all' } })
  assert.equal(out.ok, true)
})

test('a room recorded before joinPolicy existed stays at the default, not open', async () => {
  boot()
  const groupId = await newRoom('老群')
  const file = join(host.home, 'attention-group', 'groups.json')
  const ledger = JSON.parse(readFileSync(file, 'utf8'))
  delete ledger.groups[0].joinPolicy
  delete ledger.groups[0].defaultEffort
  writeFileSync(file, `${JSON.stringify(ledger, null, 2)}\n`)

  // A restart, as an upgrade would be.
  reboot()
  const group = (await get(`?group=${groupId}`)).json.group
  assert.equal(group.joinPolicy, 'members', 'an absent policy must default closed, never open')
  assert.equal(group.defaultEffort, '')

  const out = await host.tool('attention_group_join').execute(
    { groupId, memberId: 'session-55555555-5555-5555-5555-555555555555' },
    { agent: { id: 'session-outsider-0000' } },
  )
  assert.equal(out.ok, false, 'a legacy room must not silently become public')
})

test('A-12: a request body larger than the cap is refused with 413 instead of being buffered', async () => {
  // Adversarial audit A-12 (2026-10-16): a 16 MiB body was accepted, parsed and
  // answered with status 200 in 192 ms — nothing refused it. The panel never sends
  // more than a few kilobytes (a charter, one message), so a megabyte cap costs
  // nothing and refusing early is far cheaper than parsing.
  boot()
  await newRoom('big-body room')
  const huge = await call({ method: 'POST', body: { action: 'create', title: 'x'.repeat(2 * 1024 * 1024) } })
  assert.equal(huge.status, 413, `a 2 MiB body must be refused, got ${huge.status}`)
  assert.match(String(huge.json?.error ?? ''), /rejected|limit/i)

  // The cap must not break ordinary use — the next request still works.
  const normal = await call({ method: 'POST', body: { action: 'create', title: 'after the cap' } })
  assert.equal(normal.status, 200, 'a normal body must still be accepted')
})

// ---------------------------------------------------------------------------
// The 「拉人」 picker's host side (2026-10-17).
//
// The panel must be able to offer sessions instead of a blank id box, which means
// the host has to answer a query it never answered before: which sessions exist,
// what are they called, where do they live, and when did each last do anything.
// ---------------------------------------------------------------------------

test('the picker refuses with the missing capability named, never with an empty list', async () => {
  // A headless deployment has no `sessionQuery`. "You have no sessions" would be
  // false and would send the human looking for the problem in the wrong place.
  boot()
  const response = await get('?candidates=1')
  assert.equal(response.status, 404)
  assert.equal(response.json.ok, false)
  assert.match(String(response.json.error), /sessionQuery/u)
  assert.equal(response.json.sessions, undefined)
})

test('the picker lists sessions with title, workspace and last activity, and marks room members', async () => {
  const ACTIVITY = Date.parse('2026-10-17T12:00:00.000Z')
  const catalog = [
    { id: 'session-1111aaaa-1111-1111-1111-111111111111', title: '插件工程协调', cwd: 'J:\\work', updatedAt: ACTIVITY, live: true },
    { id: 'session-2222bbbb-2222-2222-2222-222222222222', title: '测试群', cwd: 'C:\\Users\\test\\.dsh\\bot-workspace', updatedAt: ACTIVITY - 1000 },
    { id: 'session-3333cccc-3333-3333-3333-333333333333', title: '', updatedAt: 0, origin: 'subagent' },
  ]
  // A SEPARATE deployment: this one has a session catalogue, and the shared host
  // deliberately has none (so every other test keeps covering the "absent service"
  // path). Its own DSH_HOME is what the log mtimes are read from.
  const picker = await createHost({
    sessionCatalog: catalog,
    workspaces: [
      { title: 'DSH默认', path: 'J:\\work', sessionIds: [catalog[0].id] },
      { title: 'DS Bot', path: 'C:\\Users\\test\\.dsh\\bot-workspace', sessionIds: [catalog[1].id] },
    ],
  })
  try {
    picker.boot()
    const home = picker.home
    const logDir = join(home, 'sessions', '--J-work--', catalog[0].id)
    mkdirSync(logDir, { recursive: true })
    const log = join(logDir, 'session.v4.jsonl.zstd')
    writeFileSync(log, 'log')
    utimesSync(log, new Date('2026-10-17T12:00:00.000Z'), new Date('2026-10-17T12:00:00.000Z'))

    const roomA = await picker.newRoom('选人群 A')
    await picker.post({ action: 'join', group: roomA, memberId: catalog[1].id, memberName: '测试群' })

    const listed = await picker.get(`?candidates=1&group=${roomA}`)
    assert.equal(listed.status, 200)
    assert.equal(listed.json.ok, true)
    const byId = new Map(listed.json.sessions.map((row) => [row.id, row]))
    assert.equal(listed.json.sessions.length, 3)
    assert.equal(byId.get(catalog[0].id).title, '插件工程协调', 'the title the sidebar shows must travel')
    assert.equal(byId.get(catalog[0].id).workspace, 'DSH默认', 'the workspace is the tie-breaker for similar titles')
    assert.equal(byId.get(catalog[0].id).lastUsedAt, '2026-10-17T12:00:00.000Z', 'last activity comes from the session log mtime')
    assert.equal(byId.get(catalog[0].id).live, true)
    assert.equal(byId.get(catalog[0].id).member, false)
    assert.equal(byId.get(catalog[1].id).member, true, 'a session already in this room must say so')
    assert.equal(byId.get(catalog[2].id).title, '')
    assert.equal(byId.get(catalog[2].id).subagent, true)
    assert.equal(byId.get(catalog[2].id).lastUsedAt, '', 'a session the runtime cannot date has no time, not a guess')
    assert.equal(listed.json.titleSource, 'projection-cache')
    assert.equal(listed.json.titlesStatus, 'ok')
    assert.equal(byId.get(catalog[0].id).workspace, 'DSH默认')

    // ⚠️ The list is cached (titles cost a log read per row), and membership is
    // per-room. A second room must NOT inherit the first room's 「已在群里」 tags.
    const roomB = await picker.newRoom('选人群 B')
    await picker.post({ action: 'join', group: roomB, memberId: catalog[0].id, memberName: '插件工程协调' })
    const listedB = await picker.get(`?candidates=1&group=${roomB}`)
    const byIdB = new Map(listedB.json.sessions.map((row) => [row.id, row]))
    assert.equal(byIdB.get(catalog[0].id).member, true, 'the second room sees its own member')
    assert.equal(byIdB.get(catalog[1].id).member, false, 'and must not inherit the first room\'s tag')
    // A session with no title yet is not a read failure — it is counted as
    // untitled, so the panel can say 「有 1 个会话还没有标题」 instead of alarming
    // the human about a broken catalogue.
    assert.equal(listedB.json.titlesStatus, 'ok')
    assert.equal(listedB.json.untitled, 1)

    // The new query parameter must not disturb the reads that already existed.
    const detail = await picker.get(`?group=${roomA}`)
    assert.equal(detail.status, 200)
    assert.equal(detail.json.group.id, roomA)
    const plain = await picker.get('')
    assert.equal(plain.status, 200)
    assert.ok(Array.isArray(plain.json.groups), 'the plain list read still returns the room list')
  } finally {
    picker.cleanup()
  }
})
