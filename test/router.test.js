/**
 * Router tests. The claim this plugin makes is "an irrelevant message costs zero
 * turns", so that is asserted directly rather than described.
 *
 * Run: node --test test/
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ROUTE_MODE, REASON, extractMentions, matchKeywords, route, renderWakeMessage } from '../src/router.js'

/** A group with three members and no overlap between their subscriptions. */
function group(overrides = {}) {
  return {
    id: 'g1',
    title: '插件工程协调',
    routeMode: ROUTE_MODE.rules,
    members: [
      { id: 's-a', name: 'Alice', kind: 'session', subscribe: ['群聊插件', 'attention'], enabled: true },
      { id: 's-b', name: 'Bob', kind: 'session', subscribe: ['抖音'], enabled: true },
      { id: 's-c', name: 'Carol', kind: 'session', subscribe: [], enabled: true },
    ],
    ...overrides,
  }
}

test('a message nobody subscribes to wakes nobody', () => {
  const plan = route({ group: group(), message: { fromName: 'user', text: '今天天气不错' } })
  assert.equal(plan.silent, true)
  assert.equal(plan.recipients.length, 0)
})

test('a mention wakes exactly the mentioned member', () => {
  const plan = route({ group: group(), message: { fromName: 'user', text: '@Alice 看下这个' } })
  assert.equal(plan.recipients.length, 1)
  assert.equal(plan.recipients[0].memberId, 's-a')
  assert.equal(plan.recipients[0].reason, REASON.mention)
})

test('a subscription keyword wakes only its subscriber', () => {
  const plan = route({ group: group(), message: { fromName: 'user', text: '群聊插件的新版本发布了' } })
  assert.equal(plan.recipients.length, 1)
  assert.equal(plan.recipients[0].memberId, 's-a')
  assert.equal(plan.recipients[0].reason, REASON.keyword)
})

test('a member is woken once even when mention and keyword both match', () => {
  const plan = route({ group: group(), message: { fromName: 'user', text: '@Alice 群聊插件搞定了' } })
  assert.equal(plan.recipients.length, 1)
  assert.equal(plan.recipients[0].reason, REASON.mention)
})

test('the sender is never woken by its own message', () => {
  const plan = route({
    group: group(),
    message: { fromName: 'Alice', text: '@Alice 提醒自己' },
    excludeMemberId: 's-a',
  })
  assert.equal(plan.silent, true)
})

test('broadcast mode falls back to everyone, and still only once each', () => {
  const plan = route({
    group: group({ routeMode: ROUTE_MODE.broadcast }),
    message: { fromName: 'user', text: '@Alice 群聊插件' },
  })
  assert.equal(plan.recipients.length, 3)
  const ids = plan.recipients.map((row) => row.memberId).sort()
  assert.deepEqual(ids, ['s-a', 's-b', 's-c'])
})

test('classify mode reports the grey zone instead of silently broadcasting', () => {
  const plan = route({
    group: group({ routeMode: ROUTE_MODE.classify }),
    message: { fromName: 'user', text: '群聊插件' },
  })
  assert.equal(plan.recipients.length, 1)
  assert.equal(plan.greyZone.length, 2)
  assert.deepEqual(plan.greyZone.map((row) => row.memberId).sort(), ['s-b', 's-c'])
})

test('mentions are extracted longest-first and not from addresses', () => {
  const names = ['room', 'room-admin']
  assert.deepEqual(extractMentions('@room-admin please look', names), ['room-admin'])
  assert.deepEqual(extractMentions('mail me at foo@room', names), [])
  assert.deepEqual(extractMentions('hi @room!', names), ['room'])
})

test('a mention needs a word boundary so a prefix does not match', () => {
  assert.deepEqual(extractMentions('@Alice2 hello', ['Alice']), [])
})

test('keywords are case-insensitive and support /regex/flags', () => {
  assert.equal(matchKeywords(['Attention'], 'the ATTENTION group'), 'Attention')
  assert.equal(matchKeywords(['/gr[ae]y/'], 'a grey zone'), '/gr[ae]y/')
  // `/[/` is deliberately not a regex form (`[/` is not a valid pattern); a
  // malformed pattern falls back to a literal, which is why it is not asserted
  // here. `/[unclosed/` IS the regex form and fails to compile, so it must
  // degrade to a literal comparison rather than throwing inside a delivery path
  // or being dropped from the subscription.
  assert.equal(matchKeywords(['/[unclosed/'], 'the tag /[unclosed/ appears here'), '/[unclosed/')
  assert.equal(matchKeywords(['nothing'], 'a grey zone'), undefined)
})

test('the wake message names the room, the sender and the reason', () => {
  const text = renderWakeMessage({
    group: group(),
    message: { fromName: 'Bob', text: '这个给你', seq: 3, at: '2026-10-16T00:00:00.000Z' },
    reason: REASON.mention,
    unread: 5,
  })
  assert.match(text, /插件工程协调/)
  assert.match(text, /Bob/)
  assert.match(text, /被 @ 点名/)
  assert.match(text, /5 条新消息/)
  assert.match(text, /与我无关/)
})

test('self-reflection can be turned off per group', () => {
  const text = renderWakeMessage({
    group: group(),
    message: { fromName: 'Bob', text: 'hi' },
    reason: REASON.keyword,
    detail: '抖音',
    selfReflect: false,
  })
  assert.doesNotMatch(text, /与我无关/)
  assert.match(text, /抖音/)
})
