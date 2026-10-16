/**
 * U3 / R4b tests: the room's reasoning-effort knob, and what it can reach.
 *
 * For most of this project's life the honest answer was "there is no API to change
 * a session that is already alive", and the knob only affected sessions that were
 * woken from storage. A read-only investigation on 2026-10-16 found that this was
 * WRONG: `sessionController.selectModel({sessionId, provider, model,
 * reasoningEffort})` changes a live session's effort, effective from its next
 * step. These tests pin the three properties that make that safe to expose:
 *
 *   1. it is OFF by default — it also saves the selection as the DEPLOYMENT
 *      default model, which is a side effect nobody would predict;
 *   2. it refuses with a reason when the deployment has no `sessionController`
 *      (a headless tree does not), instead of silently doing nothing;
 *   3. it never touches a STORED session, because that would cold-resume a whole
 *      agent just to change a number — a stored session gets its effort for free
 *      when it is next woken.
 *
 * Run: node --test test/effort.test.js
 * (requires: pwsh -File tools/sync-plugin.ps1)
 */

import { test, after } from 'node:test'
import assert from 'node:assert/strict'

import { createHost } from './support/host-harness.mjs'

const LIVE = 'session-aaaa1111-2222-3333-4444-555566667777'
const STORED = 'session-bbbb1111-2222-3333-4444-555566667777'
const ROUTE = { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' }

const capable = await createHost({ liveSessions: [LIVE], withSessionController: true, sessionRoutes: { [LIVE]: ROUTE, [STORED]: ROUTE } })
const headless = await createHost({ liveSessions: [LIVE], sessionRoutes: { [LIVE]: ROUTE } })
// A live session whose route cannot be read: the deployment has it in memory but
// nothing on disk to copy a provider/model from.
const NO_ROUTE = 'session-cccc1111-2222-3333-4444-555566667777'
const partial = await createHost({ liveSessions: [LIVE, NO_ROUTE], withSessionController: true, sessionRoutes: { [LIVE]: ROUTE } })
after(() => {
  capable.cleanup()
  headless.cleanup()
  partial.cleanup()
})

/** A room with one live session member and one stored session member. */

test('a deployment without sessionController says so instead of pretending', async () => {
  headless.boot()
  const groupId = await headless.newRoom('无控制器群')
  await headless.post({ action: 'join', group: groupId, memberId: LIVE, memberName: '活的' })

  const value = await headless.tool('attention_effort').execute({ groupId, effort: 'max', live: true }, {})
  assert.equal(value.ok, true, value.error, 'recording the setting still succeeds')
  assert.equal(value.liveApplied, false)
  assert.equal(value.applied, 0)
  assert.match(value.reason, /no sessionController/, 'the refusal must name the missing capability')
  assert.match(value.reason, /stored session still gets it when it is woken/, 'and what the fallback is')

  const rendered = headless.tool('attention_effort').output.render({}, value).map((block) => block.text).join('\n')
  assert.match(rendered, /live sessions NOT changed/)

  // The setting itself did land.
  const group = (await headless.get(`?group=${groupId}`)).json.group
  assert.equal(group.defaultEffort, 'max')
  assert.equal(group.effortStatus.includes('no sessionController'), true, 'the probe reports WHY')
})

test('the room knob is recorded without touching anyone until asked', async () => {
  capable.boot()
  const groupId = await capable.newRoom('安静群')
  await capable.post({ action: 'join', group: groupId, memberId: LIVE, memberName: '活的' })

  const value = await capable.tool('attention_effort').execute({ groupId, effort: 'low' }, {})
  assert.equal(value.ok, true, value.error)
  assert.equal(value.liveRequested, false)
  assert.deepEqual(capable.effortCalls, [], 'recording an effort must not reach into a running session')

  const rendered = capable.tool('attention_effort').output.render({}, value).map((block) => block.text).join('\n')
  assert.match(rendered, /recorded only/)
})

test('with the service present, live means live — and stored stays untouched', async () => {
  capable.boot()
  capable.effortCalls.length = 0
  const groupId = await capable.newRoom('真改群')
  await capable.post({ action: 'join', group: groupId, memberId: LIVE, memberName: '活的' })
  await capable.post({ action: 'join', group: groupId, memberId: STORED, memberName: '睡着的' })

  const value = await capable.tool('attention_effort').execute({ groupId, effort: 'max', live: true }, {})
  assert.equal(value.ok, true, value.error)
  assert.equal(value.liveApplied, true)
  assert.equal(value.applied, 1, 'exactly one live session')
  assert.equal(capable.effortCalls.length, 1, 'a stored session must NOT be cold-resumed just to change a number')
  assert.deepEqual(capable.effortCalls[0], {
    sessionId: LIVE,
    provider: ROUTE.provider,
    model: ROUTE.model,
    reasoningEffort: 'max',
  })
  assert.match(value.results[0].note, /next step/, 'the timing must be stated, because it is not immediate')
})

test('an unreadable route is reported per member, not thrown', async () => {
  partial.boot()
  const groupId = await partial.newRoom('没路由群')
  await partial.post({ action: 'join', group: groupId, memberId: LIVE, memberName: '有路由的' })
  await partial.post({ action: 'join', group: groupId, memberId: NO_ROUTE, memberName: '没路由的' })

  const value = await partial.tool('attention_effort').execute({ groupId, effort: 'low', live: true }, {})
  assert.equal(value.ok, true, value.error)
  assert.equal(value.results.length, 2, 'every live member must appear in the report')
  const missed = value.results.find((row) => row.memberId === NO_ROUTE)
  assert.equal(missed.applied, false)
  assert.match(missed.note, /no provider\/model could be read/)
  const done = value.results.find((row) => row.memberId === LIVE)
  assert.equal(done.applied, true)
  assert.equal(partial.effortCalls.length, 1, 'only the member with a known route is touched')
})

test('a member override is set and cleared, and empty means "follow the room"', async () => {
  capable.boot()
  const groupId = await capable.newRoom('覆盖群')
  await capable.post({ action: 'join', group: groupId, memberId: LIVE, memberName: '活的' })

  const set = await capable.tool('attention_effort').execute({ groupId, effort: 'off', memberId: LIVE }, {})
  assert.equal(set.ok, true, set.error)
  assert.equal(set.scope, 'member')
  let member = (await capable.get(`?group=${groupId}`)).json.group.members.find((row) => row.id === LIVE)
  assert.equal(member.wakeEffort, 'off')

  const cleared = await capable.tool('attention_effort').execute({ groupId, effort: '', memberId: LIVE }, {})
  assert.equal(cleared.ok, true, cleared.error)
  member = (await capable.get(`?group=${groupId}`)).json.group.members.find((row) => row.id === LIVE)
  assert.equal(member.wakeEffort, '', 'clearing must remove the override, not store an empty string')

  const refused = await capable.tool('attention_effort').execute({ groupId, effort: 'turbo' }, {})
  assert.equal(refused.ok, false)
  assert.match(refused.error, /max/, 'the refusal names the legal values')

  const nobody = await capable.tool('attention_effort').execute({ groupId, effort: 'low', memberId: 'nope' }, {})
  assert.equal(nobody.ok, false)
  assert.match(nobody.error, /unknown member/)
})

test('the panel switch is off until the human turns it on, and then it applies', async () => {
  capable.boot()
  capable.effortCalls.length = 0
  const groupId = await capable.newRoom('面板群')
  await capable.post({ action: 'join', group: groupId, memberId: LIVE, memberName: '活的' })

  let group = (await capable.get(`?group=${groupId}`)).json.group
  assert.equal(group.liveEffort, false, 'the side effect must be opt-in')
  assert.equal(group.effortStatus, 'available')

  // Moving the slider while the switch is off changes only the room setting.
  await capable.post({ action: 'effort', group: groupId, effort: 'high' })
  assert.equal(capable.effortCalls.length, 0)

  // Turning the switch on applies the room's current effort, because that is
  // what "on" means — not "the next time you touch something".
  const on = await capable.post({ action: 'effort', group: groupId, liveEffort: true })
  assert.equal(on.json.ok, true, on.json.error)
  assert.equal(on.json.liveEffort, true)
  assert.equal(on.json.liveApplied, true)
  assert.equal(capable.effortCalls.length, 1)
  assert.equal(capable.effortCalls[0].reasoningEffort, 'high')

  // And now a slider move goes through too.
  await capable.post({ action: 'effort', group: groupId, effort: 'low' })
  assert.equal(capable.effortCalls.length, 2)
  assert.equal(capable.effortCalls[1].reasoningEffort, 'low')

  group = (await capable.get(`?group=${groupId}`)).json.group
  assert.equal(group.liveEffort, true)
  assert.equal(group.defaultEffort, 'low')

  // Turning it back off stops the reach into running sessions.
  await capable.post({ action: 'effort', group: groupId, liveEffort: false })
  await capable.post({ action: 'effort', group: groupId, effort: 'max' })
  assert.equal(capable.effortCalls.length, 2, 'switched off means switched off')
})

test('the rendered report never leaks the word undefined', async () => {
  capable.boot()
  const groupId = await capable.newRoom('渲染群')
  const tool = capable.tool('attention_effort')
  for (const args of [
    { groupId, effort: 'low' },
    { groupId, effort: 'max', live: true },
    { groupId, effort: 'off', memberId: LIVE },
    { groupId: 'nope', effort: 'low' },
    { groupId, effort: 'bogus' },
  ]) {
    const value = await tool.execute(args, {})
    const rendered = tool.output.render(args, value)
    const text = rendered.map((block) => block.text).join('\n')
    assert.equal(text.includes('undefined'), false, `render leaked undefined for ${JSON.stringify(args)}`)
    for (const block of rendered) assert.equal(block.type, 'text')
  }
})
