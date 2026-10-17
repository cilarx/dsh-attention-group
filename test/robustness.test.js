/**
 * Robustness regressions from adversarial audit A (2026-10-16).
 *
 * These three findings share a shape worth naming: each one was reachable, none
 * of them crashed, and the damage was in what the plugin *did* rather than in
 * what it said. A write outside the data root, an unbounded fan-out, and two
 * rooms quietly merging into one id are all invisible from the tool result —
 * which is why they need a test rather than a careful reading.
 *
 * Run: node --test test/robustness.test.js
 */

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { moduleUrl } from './support/entry.mjs'
import { createHost } from './support/host-harness.mjs'

const { appendMessage, readMessages } = await import(moduleUrl('store.js'))

/** A throwaway data root; nothing here may touch the user's real one. */
function freshRoot(name) {
  const root = mkdtempSync(join(tmpdir(), `attention-${name}-`))
  return root
}

after(() => {
  rmSync(join(tmpdir(), 'attention-traversal-'), { recursive: true, force: true })
})

test('A-7: a group id is a file name, not a path — nothing lands outside the data root', () => {
  // Audit A-7 (2026-10-16): an id of `../../escaped` in the ledger made
  // `attention_send` write a transcript to `<DSH_HOME>/escaped.jsonl` — outside
  // the plugin's data root entirely. This is NOT reachable from a tool call:
  // `slugify` collapses every non-letter and non-digit to `-`, so no title can
  // produce such an id. It IS reachable from a hand-edited `groups.json`, which
  // is why the guard lives where the path is built (store.js) instead of at the
  // dozen call sites.
  const root = freshRoot('traversal')
  const hostile = '../../escaped'
  const record = { seq: 1, at: '2026-10-16T00:00:00.000Z', fromName: 'A', text: 'TRAVERSAL', mentions: [] }
  appendMessage(root, hostile, record)

  const escapedPath = join(root, '..', 'escaped.jsonl')
  assert.equal(existsSync(escapedPath), false, `the transcript escaped the data root to ${escapedPath}`)
  // It must land INSIDE the messages directory...
  assert.equal(existsSync(join(root, 'messages')), true, 'the messages directory is the only destination')
  // ...and it must still be readable back through the same id, or the guard
  // would have quietly orphaned the room's history.
  const back = readMessages(root, hostile, { limit: 0 })
  assert.equal(back.length, 1, 'the same id must read back what it wrote')
  assert.equal(back[0].text, 'TRAVERSAL')
  rmSync(root, { recursive: true, force: true })
})

test('A-7: an ordinary non-ASCII id still maps to its own unchanged file name', () => {
  // The guard must be the identity for every id this plugin actually creates,
  // including Chinese ones — otherwise existing transcripts stop resolving and
  // the fix silently loses history instead of protecting it.
  const root = freshRoot('identity')
  appendMessage(root, '插件工程协调-fpab', { seq: 1, at: '2026-10-16T00:00:00.000Z', text: '中文', mentions: [] })
  assert.equal(existsSync(join(root, 'messages', '插件工程协调-fpab.jsonl')), true, 'real ids must keep their real file names')
  assert.equal(readMessages(root, '插件工程协调-fpab', { limit: 0 })[0].text, '中文')
  rmSync(root, { recursive: true, force: true })
})

test('A-11: two rooms with the same title never merge into one id', async () => {
  // Audit A-11 (2026-10-16): the id suffix was the last four base-36 digits of
  // the clock, so the same title 28 minutes apart derived the SAME id — and
  // `requireGroup` returns the first match, meaning every later tool call for the
  // second room silently landed in the first. Twenty-five back-to-back creates
  // cross at least one millisecond boundary many times over, which is exactly the
  // collision this asserts against.
  const host = await createHost({})
  host.boot()
  try {
    const ids = []
    for (let index = 0; index < 25; index += 1) ids.push(await host.newRoom('同一个名字'))
    assert.equal(new Set(ids).size, ids.length, `ids must be unique; got ${ids.length - new Set(ids).size} collision(s)`)
    assert.equal(host.ledgerOnDisk().groups.length, 25, 'all 25 rooms must exist separately on disk')
  } finally {
    host.cleanup()
  }
})

test('A-8: one message cannot fan out without bound across a fully linked ring', async () => {
  // Audit A-8 (2026-10-16): 7 rooms wired to each other (42 links) with
  // `mode:"all"` turned ONE send into **1,957** messages and 17 seconds, growing
  // ~6x per room (5 → 65, 6 → 326, 7 → 1,957). Capping `maxHops` does not fix it:
  // with N rooms the anti-loop trail already bounds a chain to N hops, so what is
  // being spent is the FAN-OUT, not the depth. The bound therefore has to be on
  // total work per call, shared across the recursive walk.
  //
  // The ring is built through `attention_link` rather than the panel because the
  // panel has no `maxHops` control (audit C-16) and links it creates default to
  // 3 hops, which alone caps a 6-room ring at 86 messages. Measured: with the
  // default the amplification simply does not happen; it needs a raised hop
  // limit, and `maxHops` is now clamped to MAX_LINK_HOPS on top of that.
  const host = await createHost({})
  host.boot()
  const exec = { agent: { id: 'session-test' } }
  try {
    const rooms = []
    for (let index = 0; index < 7; index += 1) rooms.push(await host.newRoom(`ring-${index}`))
    for (const from of rooms) {
      for (const to of rooms) {
        if (from === to) continue
        const linked = await host.tool('attention_link').execute({ groupId: from, to, mode: 'all', maxHops: 1000 }, exec)
        assert.equal(linked.ok, true, `link ${from} -> ${to} must be created`)
      }
    }

    const sent = await host.post({ action: 'post', group: rooms[0], text: 'boom' })
    assert.equal(sent.json.ok, true)

    const perRoom = []
    let total = 0
    for (const room of rooms) {
      const count = host.messagesOnDisk(room).split('\n').filter((line) => line.trim().length > 0).length
      perRoom.push(count)
      total += count
    }
    // ⚠️ The DIAMOND guard is the bound that actually holds: a message is
    // delivered to any given room at most once, no matter how many routes reach
    // it, so one message over N rooms writes at most N records. Measured before
    // that guard: 1,956 messages / 17 seconds for 7 rooms, with the budget cap
    // being the only thing standing between the plugin and a minute of writing.
    // MAX_RELAY_MESSAGES remains as a second, independent ceiling — it is what
    // protects a deployment with more rooms than a budget can cover — but this
    // test asserts the CORRECTNESS property rather than the ceiling, because
    // "bounded" and "right" are not the same claim.
    assert.ok(total <= rooms.length, `each room may receive the message at most once; the ring wrote ${total} (per room: ${perRoom.join(', ')})`)
    for (const count of perRoom) {
      assert.ok(count <= 1, `a room received the same message more than once (per room: ${perRoom.join(', ')})`)
    }
  } finally {
    host.cleanup()
  }
})

test('A-8: a hop limit is clamped, so 1e9 is not accepted as a budget', async () => {
  const { newLink, clampHops, MAX_LINK_HOPS, DEFAULT_MAX_HOPS } = await import(moduleUrl('relay.js'))
  assert.equal(newLink({ to: 'x', maxHops: 1e9 }).maxHops, MAX_LINK_HOPS, 'an absurd hop limit must be clamped')
  assert.equal(newLink({ to: 'x' }).maxHops, DEFAULT_MAX_HOPS)
  assert.equal(newLink({ to: 'x', maxHops: -5 }).maxHops, DEFAULT_MAX_HOPS, 'a negative hop limit falls back to the default')
  assert.equal(newLink({ to: 'x', maxHops: Number.NaN }).maxHops, DEFAULT_MAX_HOPS, 'NaN is not a hop limit')
  assert.equal(clampHops(2), 2, 'a sane hop limit is left alone')
})

test('B-04: re-joining a member does not silently demote an admin', async () => {
  // Adversarial audit B-04 (2026-10-16): the panel's `join` action defaulted a
  // missing `kind` to 'session' and then wrote it unconditionally, so a caller
  // that only wanted to add or rename someone DEMOTED an existing admin. The room
  // then had no 群管理 at all, and `attention_summarize` reported "no enabled
  // kind=admin member" for a room that visibly had one.
  const host = await createHost({})
  host.boot()
  try {
    const room = await host.newRoom('群管理测试')
    const first = await host.post({ action: 'join', group: room, memberId: 'session-boss', memberName: '群管理', kind: 'admin' })
    assert.equal(first.json.ok, true)
    assert.equal(first.json.kind, 'admin')

    // Same member, no `kind` in the body — the shape a rename produces.
    const again = await host.post({ action: 'join', group: room, memberId: 'session-boss', memberName: '群管理（改名）' })
    assert.equal(again.json.ok, true)
    assert.equal(again.json.kind, 'admin', 'a join that does not mention kind must not change it')

    const stored = host.ledgerOnDisk().groups[0].members.find((member) => member.id === 'session-boss')
    assert.equal(stored.kind, 'admin', 'the stored member must still be an admin')
    assert.equal(stored.name, '群管理（改名）', 'the rename itself must still apply')

    // An EXPLICIT kind is still honoured — the guard must not make kind immutable.
    const changed = await host.post({ action: 'join', group: room, memberId: 'session-boss', kind: 'bot' })
    assert.equal(changed.json.kind, 'bot', 'an explicit kind must still win')
  } finally {
    host.cleanup()
  }
})

test('B-07: a diamond does not deliver the same message twice', async () => {
  // Adversarial audit B-07 (2026-10-16). The three loop guards reason about the
  // TRAIL, and a trail is a path. In `A → B → D` plus `A → C → D` the copy
  // arriving through B carries `[A,B]` and the copy through C carries `[A,C]` —
  // neither contains the other room, so D receives the same message twice and
  // nothing in the guards can tell. What the two copies share is their ORIGIN,
  // which is why a relay record now carries one forward unchanged.
  const host = await createHost({})
  host.boot()
  const exec = { agent: { id: 'session-test' } }
  try {
    const a = await host.newRoom('diamond-a')
    const b = await host.newRoom('diamond-b')
    const c = await host.newRoom('diamond-c')
    const d = await host.newRoom('diamond-d')
    for (const [from, to] of [
      [a, b],
      [a, c],
      [b, d],
      [c, d],
    ]) {
      const linked = await host.tool('attention_link').execute({ groupId: from, to, mode: 'all' }, exec)
      assert.equal(linked.ok, true, `link must be created (${from} -> ${to})`)
    }

    const sent = await host.post({ action: 'post', group: a, text: '只应该到一次' })
    assert.equal(sent.json.ok, true)

    const rows = host
      .messagesOnDisk(d)
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line))
    const relayed = rows.filter((row) => row.relay !== undefined)
    assert.equal(relayed.length, 1, `room D must receive the message exactly once, got ${relayed.length}`)

    const refusals = (Array.isArray(sent.json.relayed) ? sent.json.relayed : [])
      .filter((row) => row.relayed === false)
      .map((row) => String(row.reason))
    assert.ok(
      refusals.some((reason) => /another route/.test(reason)),
      `the duplicate must be refused with a reason, not dropped silently; reasons were ${JSON.stringify(refusals)}`,
    )
  } finally {
    host.cleanup()
  }
})

test('B-08: a member never shows itself unread for its own words', async () => {
  // Adversarial audit B-08 (2026-10-16). Unread used to mean "appended after my
  // last read", which counts the member's OWN message. So an agent that read a
  // room and then posted a conclusion saw an unread badge for its own words — a
  // badge that is always wrong is a badge people learn to ignore.
  //
  // The second half of this test matters just as much as the first: the list tool
  // had hand-rolled the same filter instead of calling `countUnread`, so fixing
  // the helper alone would have fixed a path nobody reads.
  const host = await createHost({})
  host.boot()
  const asA = { agent: { id: 'session-a' } }
  const asB = { agent: { id: 'session-b' } }
  try {
    // Built through the tools so that session-a is the room's CREATOR and is
    // therefore a member: `joinPolicy=members` refuses an outsider, and a refused
    // join would leave `unread` at 0 for the wrong reason — which is exactly how
    // the first draft of this test passed its first assertion by accident.
    const created = await host.tool('attention_group_create').execute({ title: 'unread room' }, asA)
    assert.equal(created.ok, true)
    const room = created.groupId
    await host.tool('attention_group_join').execute({ groupId: room, memberId: 'session-b', memberName: '阿乙' }, asA)

    // B speaks first, then A reads: that is what gives A a watermark.
    await host.tool('attention_send').execute({ groupId: room, text: '阿乙说的第一句' }, asB)
    const read = await host.tool('attention_history').execute({ groupId: room }, asA)
    assert.equal(read.total, 1)

    // A concludes something. Its own words must not come back as unread.
    const concluded = await host.tool('attention_conclude').execute({ groupId: room, text: '这是一条结论' }, asA)
    assert.equal(concluded.ok, true)

    const listed = await host.tool('attention_group_list').execute({}, asA)
    const row = listed.groups.find((group) => group.id === room)
    assert.ok(row !== undefined, 'the room must appear in the list')
    assert.equal(row.unread, 0, `a member's own conclusion must not be unread for it, got ${row.unread}`)
    assert.equal(listed.unreadTotal, 0, 'and it must not inflate the total either')

    // A DIFFERENT member posting must still register as unread — the fix must not
    // have simply switched the badge off.
    await host.tool('attention_send').execute({ groupId: room, text: '阿乙说的第二句' }, asB)
    const after = await host.tool('attention_group_list').execute({}, asA)
    assert.equal(after.groups.find((group) => group.id === room).unread, 1, "someone else's message must still count")
  } finally {
    host.cleanup()
  }
})
