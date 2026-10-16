/**
 * R10 tests: liaisons between rooms.
 *
 * The requirement is "arrange a liaison between different group chats". The whole
 * risk is that two rooms pointing at each other echo forever, which is the exact
 * opposite of what this plugin exists for. So these tests are mostly about the
 * things that must NOT happen:
 *
 *   - A→B→A must be refused, and the refusal must name the guard;
 *   - a message must not travel further than its link allows;
 *   - a liaison must not wake anybody unless it was explicitly told to;
 *   - a message must not be silently dropped — every decline says why.
 *
 * The first half is pure-function testing, because "can this loop?" is a question
 * about an algorithm and should not need two live rooms to answer.
 *
 * Run: node --test test/relay.test.js
 * (requires: pwsh -File tools/sync-plugin.ps1)
 */

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { createHost } from './support/host-harness.mjs'
import { moduleUrl } from './support/entry.mjs'

const relay = await import(moduleUrl('relay.js'))

const host = await createHost()
const loud = await createHost({ liveSessions: ['session-aaaa1111-2222-3333-4444-555566667777'] })
after(() => {
  host.cleanup()
  loud.cleanup()
})

/** Read a room's transcript off disk. */
function transcript(h, groupId) {
  const raw = h.messagesOnDisk(groupId)
  return raw.length === 0 ? [] : raw.trim().split('\n').map((line) => JSON.parse(line))
}

test('a link defaults to carrying conclusions only, and never waking anyone', () => {
  const link = relay.newLink({ to: 'room-b' })
  assert.equal(link.to, 'room-b')
  assert.equal(link.mode, relay.RELAY_MODE.conclusion, 'the quiet mode is the default')
  assert.equal(link.enabled, true)
  assert.equal(link.wake, false, 'relaying must not wake anyone unless told to')
  assert.equal(link.maxHops, relay.DEFAULT_MAX_HOPS)
  assert.ok(link.id.startsWith('link-'))
})

test('a link carries a conclusion and refuses everything else, saying why', () => {
  const link = relay.newLink({ to: 'B' })
  const from = { id: 'A' }
  const conclusion = { seq: 1, kind: 'conclusion', text: 'x', mentions: [] }
  const chatter = { seq: 2, text: 'x', mentions: [] }

  assert.deepEqual(relay.shouldRelay({ link, from, record: conclusion, targetId: 'B' }), {
    relay: true,
    reason: 'it is a conclusion',
  })
  const refused = relay.shouldRelay({ link, from, record: chatter, targetId: 'B' })
  assert.equal(refused.relay, false)
  assert.match(refused.reason, /not a conclusion/)
})

test('A→B→A is refused, and the refusal names the room already on the trail', () => {
  const linkAB = relay.newLink({ to: 'B' })
  const linkBA = relay.newLink({ to: 'A' })

  // A conclusion posted in A, forwarded into B.
  const atB = relay.relayRecord({ link: linkAB, fromGroup: { id: 'A', title: 'A群' }, record: { seq: 1, text: 'x' }, at: 'now', seq: 1 })
  assert.deepEqual(atB.relay.trail, ['A'])
  assert.equal(atB.relay.hops, 1)

  // B's link back into A must refuse it.
  const back = relay.shouldRelay({ link: linkBA, from: { id: 'B' }, record: atB, targetId: 'A' })
  assert.equal(back.relay, false, 'a message must never come back to a room it has left')
  assert.match(back.reason, /loop refused/)
  assert.match(back.reason, /A/)
  assert.match(back.reason, /A$|A /, 'the trail must be shown, so the loop is diagnosable')
})

test('the trail also stops the long way round, and maxHops stops it sooner', () => {
  // A → B → C → D, then D tries to reach A again.
  let record = { seq: 1, text: 'x' }
  for (const [from, to] of [
    ['A', 'B'],
    ['B', 'C'],
    ['C', 'D'],
  ]) {
    record = relay.relayRecord({ link: relay.newLink({ to }), fromGroup: { id: from }, record, at: 'now', seq: 1 })
  }
  assert.deepEqual(record.relay.trail, ['A', 'B', 'C'])
  assert.equal(record.relay.hops, 3)

  const backToA = relay.shouldRelay({ link: relay.newLink({ to: 'A' }), from: { id: 'D' }, record, targetId: 'A' })
  assert.equal(backToA.relay, false)
  assert.match(backToA.reason, /loop refused/)

  // And with a tight hop budget it stops before even reaching a fresh room.
  const tight = relay.newLink({ to: 'E', maxHops: 3 })
  const far = relay.shouldRelay({ link: tight, from: { id: 'D' }, record, targetId: 'E' })
  assert.equal(far.relay, false)
  assert.match(far.reason, /hop limit/)
})

test('a relayed message knows where it came from, so a reader can tell', () => {
  const link = relay.newLink({ to: 'B' })
  const record = relay.relayRecord({
    link,
    fromGroup: { id: 'A', title: 'A群' },
    record: { seq: 7, text: '正文' },
    at: '2026-10-16T00:00:00.000Z',
    seq: 1,
    mentions: ['甲'],
    reason: 'it is a conclusion',
  })
  assert.equal(record.kind, 'relay', 'carried chatter is not a conclusion')
  assert.equal(record.text, '正文', 'the text travels verbatim')
  assert.equal(record.relay.fromGroup, 'A')
  assert.equal(record.relay.fromSeq, 7)
  assert.deepEqual(record.mentions, ['甲'])
  assert.ok(record.fromName.includes('A群'), 'the sender line says which room it came from')
  assert.match(relay.describeRelay(record), /「A」#7/)

  // A relayed CONCLUSION keeps its kind, or every chain would break at hop one:
  // the next room's 只传结论 link would see "not a conclusion" and refuse it.
  const carried = relay.relayRecord({
    link,
    fromGroup: { id: 'A', title: 'A群' },
    record: { seq: 7, text: '决定', kind: 'conclusion' },
    at: 'now',
    seq: 1,
  })
  assert.equal(carried.kind, 'conclusion')
  assert.equal(carried.relay.fromGroup, 'A', 'and it still says where it came from')
})

test('keyword and mention modes only fire on their own terms', () => {
  const keyword = relay.newLink({ to: 'B', mode: 'keyword', keywords: ['发布', '/上线\\d+/'] })
  assert.equal(relay.shouldRelay({ link: keyword, from: { id: 'A' }, record: { text: '准备发布' }, targetId: 'B' }).relay, true)
  assert.equal(relay.shouldRelay({ link: keyword, from: { id: 'A' }, record: { text: '上线12 了' }, targetId: 'B' }).relay, true)
  assert.equal(relay.shouldRelay({ link: keyword, from: { id: 'A' }, record: { text: '吃水果' }, targetId: 'B' }).relay, false)

  const empty = relay.newLink({ to: 'B', mode: 'keyword' })
  const refused = relay.shouldRelay({ link: empty, from: { id: 'A' }, record: { text: 'anything' }, targetId: 'B' })
  assert.equal(refused.relay, false)
  assert.match(refused.reason, /no keywords are set/, 'a half-configured link must say so rather than look broken')

  const mention = relay.newLink({ to: 'B', mode: 'mention', keywords: ['甲'] })
  assert.equal(
    relay.shouldRelay({ link: mention, from: { id: 'A' }, record: { text: '@甲', mentions: ['甲'] }, targetId: 'B', targetMemberNames: ['甲'] }).relay,
    true,
  )
  const absent = relay.shouldRelay({ link: mention, from: { id: 'A' }, record: { text: '@甲', mentions: ['甲'] }, targetId: 'B', targetMemberNames: ['乙'] })
  assert.equal(absent.relay, false)
  assert.match(absent.reason, /nobody by that name/, 'forwarding a mention nobody answers to is a dead end, not a delivery')
})

test('every refusal has a reason, including the boring ones', () => {
  const link = relay.newLink({ to: 'B' })
  const cases = [
    { input: { record: { text: 'x' }, targetId: 'B' }, pattern: /no such link/ },
    { input: { link: relay.newLink({ to: 'B', enabled: false }), from: { id: 'A' }, record: { text: 'x' }, targetId: 'B' }, pattern: /switched off/ },
    { input: { link, from: { id: 'A' }, record: { text: 'x' }, targetId: 'A' }, pattern: /cannot relay to itself/ },
    { input: { link, from: { id: 'A' }, record: { text: 'x', relay: { fromGroup: 'B' } }, targetId: 'B' }, pattern: /came from B/ },
    { input: { link: relay.newLink({ to: 'B', mode: 'nonsense' }), from: { id: 'A' }, record: { text: 'x' }, targetId: 'B' }, pattern: /unknown mode/ },
  ]
  for (const row of cases) {
    const verdict = relay.shouldRelay(row.input)
    assert.equal(verdict.relay, false)
    assert.ok(typeof verdict.reason === 'string' && verdict.reason.length > 0, `no reason for ${JSON.stringify(row.input.link?.mode)}`)
    assert.match(verdict.reason, row.pattern)
  }
})

test('a conclusion in A lands in B as a relay, and wakes nobody', async () => {
  host.boot()
  const a = await host.newRoom('A群')
  const b = await host.newRoom('B群')
  await host.post({ action: 'link', group: a, to: b, mode: 'conclusion' })

  const value = await host.tool('attention_conclude').execute({ groupId: a, text: 'A 决定了周五发布' }, {})
  assert.equal(value.ok, true, value.error)
  assert.equal(value.relayed.length, 1)
  assert.equal(value.relayed[0].relayed, true)
  assert.equal(value.relayed[0].to, b)

  const inB = transcript(host, b)
  assert.equal(inB.length, 1)
  assert.equal(inB[0].kind, 'conclusion', 'a relayed decision is still a decision')
  assert.equal(inB[0].relay.fromGroup, a, 'and it says which room it came from')
  assert.equal(inB[0].text, 'A 决定了周五发布')
  assert.deepEqual(inB[0].relay.trail, [a])

  // A liaison carries decisions; it does not start turns.
  assert.equal(existsSync(join(host.home, 'attention-group', 'messages', 'deliveries.jsonl')), false)
})

test('plain chatter is not carried, and the refusal is reported', async () => {
  host.boot()
  const a = await host.newRoom('A群')
  const b = await host.newRoom('B群')
  await host.post({ action: 'link', group: a, to: b, mode: 'conclusion' })

  const sent = await host.tool('attention_send').execute({ groupId: a, text: '随便聊聊' }, {})
  assert.equal(sent.ok, true, sent.error)
  assert.equal(sent.relayed.length, 1)
  assert.equal(sent.relayed[0].relayed, false)
  assert.match(sent.relayed[0].reason, /not a conclusion/)
  assert.equal(transcript(host, b).length, 0, 'nothing may arrive in B')
})

test('a chain of three rooms delivers once each way and never comes back', async () => {
  host.boot()
  const a = await host.newRoom('链A')
  const b = await host.newRoom('链B')
  const c = await host.newRoom('链C')
  // A→B→C, and C→A to make the loop attempt explicit.
  await host.post({ action: 'link', group: a, to: b, mode: 'conclusion' })
  await host.post({ action: 'link', group: b, to: c, mode: 'conclusion' })
  await host.post({ action: 'link', group: c, to: a, mode: 'conclusion' })

  const value = await host.tool('attention_conclude').execute({ groupId: a, text: '一路传下去' }, {})
  assert.equal(value.ok, true, value.error)

  // A → B, then B → C (chained), then C → A refused.
  const relayed = value.relayed.filter((row) => row.relayed === true)
  assert.equal(relayed.length, 2, `expected two hops, got ${JSON.stringify(value.relayed)}`)
  assert.equal(relayed[0].to, b)
  assert.equal(relayed[1].to, c)
  assert.deepEqual(relayed[1].via, [b], 'the second hop records how it got there')

  assert.equal(transcript(host, b).length, 1)
  assert.equal(transcript(host, c).length, 1)
  const inC = transcript(host, c)[0]
  assert.deepEqual(inC.relay.trail, [a, b])
  // A already saw its own message; the loop guard is what keeps C→A from adding one.
  assert.equal(transcript(host, a).length, 1, 'A must contain only the original, not a returning copy')
})

test('two rooms pointing at each other cannot echo', async () => {
  host.boot()
  const a = await host.newRoom('回音A')
  const b = await host.newRoom('回音B')
  await host.post({ action: 'link', group: a, to: b, mode: 'all' })
  await host.post({ action: 'link', group: b, to: a, mode: 'all' })

  const sent = await host.tool('attention_send').execute({ groupId: a, text: '喊一声' }, {})
  assert.equal(sent.ok, true, sent.error)
  assert.equal(transcript(host, a).length, 1, 'A keeps only what was said there')
  assert.equal(transcript(host, b).length, 1, 'B keeps only the one carried copy')
  assert.equal(sent.relayed.filter((row) => row.relayed === true).length, 1)
  const refused = sent.relayed.find((row) => row.relayed === false)
  assert.ok(refused !== undefined, 'the echo attempt must be reported, not silently dropped')
  assert.match(refused.reason, /loop refused/)
})

test('a liaison wakes the target room only when both switches say so', async () => {
  loud.boot()
  const member = 'session-aaaa1111-2222-3333-4444-555566667777'
  const a = await loud.newRoom('喊话A')
  const b = await loud.newRoom('喊话B')
  await loud.post({ action: 'join', group: b, memberId: member, memberName: '甲', kind: 'session' })
  await loud.post({ action: 'link', group: a, to: b, mode: 'all' })

  // Switch one: the link says nothing about waking, and B's waking is off anyway.
  await loud.post({ action: 'post', group: a, text: '第一次' })
  assert.equal(loud.delivered.length, 0, 'nothing may be woken by default')

  // Switch two: turn B's waking on, keep the link quiet.
  await loud.post({ action: 'wake', group: b, wakeEnabled: true })
  await loud.post({ action: 'post', group: a, text: '第二次' })
  assert.equal(loud.delivered.length, 0, 'the link still says "records only"')

  // Both switches: now it delivers, and it says so.
  await loud.post({ action: 'link', group: a, to: b, wake: true })
  const sent = await loud.tool('attention_send').execute({ groupId: a, text: '@甲 第三次' }, {})
  const row = sent.relayed.find((candidate) => candidate.relayed === true)
  assert.equal(row.woken, true)
  assert.equal(row.delivered, 1)
  assert.equal(loud.delivered.length, 1)
  const body = loud.delivered[0].message.content.map((block) => block.text).join('\n')
  assert.ok(body.includes('第三次'))
})

test('the panel can point a room at another, and cannot point it at itself', async () => {
  host.boot()
  const a = await host.newRoom('面板A')
  const b = await host.newRoom('面板B')

  const self = await host.post({ action: 'link', group: a, to: a })
  assert.equal(self.json.ok, false)
  assert.match(self.json.error, /cannot link to itself/)

  const unknown = await host.post({ action: 'link', group: a, to: 'nope' })
  assert.equal(unknown.json.ok, false)
  assert.match(unknown.json.error, /unknown target room/)

  const made = await host.post({ action: 'link', group: a, to: b, mode: 'keyword', keywords: ['发布'] })
  assert.equal(made.json.ok, true, made.json.error)
  assert.equal(made.json.links.length, 1)
  assert.equal(made.json.links[0].mode, 'keyword')

  let detail = (await host.get(`?group=${a}`)).json.group
  assert.equal(detail.links.length, 1)
  assert.deepEqual(detail.links[0].keywords, ['发布'])
  assert.equal(detail.links[0].wake, false)
  // The panel needs a list of rooms to aim at, and its own room is in it so the
  // browser can filter it out rather than the host guessing who is looking.
  assert.ok((await host.get()).json.linkTargets.some((row) => row.id === b))

  const bad = await host.post({ action: 'link', group: a, to: b, mode: 'nonsense' })
  assert.equal(bad.json.ok, false)
  assert.match(bad.json.error, /mode must be one of/)

  const off = await host.post({ action: 'link', group: a, to: b, enabled: false })
  assert.equal(off.json.ok, true)
  detail = (await host.get(`?group=${a}`)).json.group
  assert.equal(detail.links[0].enabled, false)

  const gone = await host.post({ action: 'unlink', group: a, to: b })
  assert.equal(gone.json.ok, true)
  detail = (await host.get(`?group=${a}`)).json.group
  assert.deepEqual(detail.links, [])

  const again = await host.post({ action: 'unlink', group: a, to: b })
  assert.equal(again.json.ok, false)
  assert.match(again.json.error, /no link/)
})

test('a link to a deleted room is reported, not crashed on', async () => {
  host.boot()
  const a = await host.newRoom('孤儿A')
  const b = await host.newRoom('孤儿B')
  await host.post({ action: 'link', group: a, to: b, mode: 'all' })

  // Simulate the target disappearing from the ledger.
  const file = join(host.home, 'attention-group', 'groups.json')
  const ledger = JSON.parse(readFileSync(file, 'utf8'))
  ledger.groups = ledger.groups.filter((group) => group.id !== b)
  host.writeFileSync(file, `${JSON.stringify(ledger, null, 2)}\n`)
  host.reboot()

  const sent = await host.tool('attention_send').execute({ groupId: a, text: '还有人吗' }, {})
  assert.equal(sent.ok, true, sent.error)
  assert.equal(sent.relayed[0].relayed, false)
  assert.match(sent.relayed[0].reason, /no longer exists/)
})
