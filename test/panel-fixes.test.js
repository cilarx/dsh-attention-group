/**
 * Panel-line regression tests for the 16 findings of the adversarial audit
 * (2026-10-16, `_docs/05_对抗审计_C_面板.md`), panel half.
 *
 * These live in their own file because they are all one shape: feed the panel a
 * payload the OLD panel rendered as a comfortable lie, and assert that it now
 * says something true. The evidence in the audit was produced by exactly this
 * technique (`test/support/panel-harness.mjs` + a hand-written `fetchImpl`), so
 * it is the right instrument for the fix as well.
 *
 * The contract for the new host fields is `_docs/06_修复接口冻结.md`; the host
 * half is changed in parallel and is NOT imported here on purpose — both halves
 * are written against the frozen field names only.
 *
 * Run: node --test test/panel-fixes.test.js
 * (requires: pwsh -File tools/sync-plugin.ps1 — the panel under test is the
 * installed copy when there is one, see test/support/entry.mjs)
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'

import { mountPanel, findAll, textOf, findButton } from './support/panel-harness.mjs'
import { createHost } from './support/host-harness.mjs'
import { clientEntry, describeSource } from './support/entry.mjs'

if (!existsSync(clientEntry)) {
  throw new Error(`the panel under test is missing: ${clientEntry} (${describeSource()})`)
}
const SOURCE = readFileSync(clientEntry, 'utf8')

const A_ID = 'room-a-aaaa'
const B_ID = 'room-b-bbbb'
const JIA = 'session-aaaa1111-2222-3333-4444-555566667777'

const KNOBS = {
  routeModes: [
    { value: 'rules', label: '规则', hint: '规则提示' },
    { value: 'classify', label: '语义', hint: '语义提示' },
    { value: 'broadcast', label: '全体', hint: '全体提示' },
  ],
  efforts: [
    { value: '', label: '跟随', hint: '跟随提示' },
    { value: 'off', label: '关', hint: '' },
    { value: 'low', label: '低', hint: '' },
    { value: 'high', label: '高', hint: '' },
    { value: 'max', label: '最高', hint: '' },
  ],
  joinPolicies: [
    { value: 'open', label: '开放', hint: '' },
    { value: 'members', label: '群成员', hint: '' },
    { value: 'user', label: '仅用户', hint: '' },
    { value: 'nobody', label: '冻结', hint: '' },
  ],
  memberKinds: ['session', 'user', 'admin', 'bot', 'liaison'],
  relayModes: [
    { value: 'conclusion', label: '只传结论', hint: '' },
    { value: 'keyword', label: '按关键词', hint: '' },
    { value: 'mention', label: '按点名', hint: '' },
    { value: 'all', label: '全部转发', hint: '' },
  ],
}

const ROWS = [
  { id: A_ID, title: '甲群', messages: 1, unread: 2, memberCount: 2, memberNames: ['用户', '甲'], wakeEnabled: false, routeMode: 'rules' },
  { id: B_ID, title: '乙群', messages: 1, unread: 0, memberCount: 1, memberNames: ['丙'], wakeEnabled: true, routeMode: 'broadcast' },
]

const DETAILS = {
  [A_ID]: {
    id: A_ID,
    title: '甲群',
    charter: '甲群规：先看再说',
    wakeEnabled: false,
    routeMode: 'rules',
    selfReflect: true,
    joinPolicy: 'members',
    defaultEffort: '',
    liveEffort: false,
    effortStatus: 'available',
    sinkEnabled: true,
    sinkDir: '',
    sinkMemory: false,
    sink: { dir: 'C:\\data\\sink', conclusionPath: 'C:\\data\\sink\\a.conclusions.md', conclusions: 3, conclusionBytes: 512, files: 2 },
    members: [
      { id: 'user', name: '用户', kind: 'user', enabled: true, subscribe: [], wakeEffort: '', wakeable: false, isHuman: true },
      { id: JIA, name: '甲', kind: 'session', enabled: true, subscribe: ['部署'], wakeEffort: 'max', wakeable: true, isHuman: false },
    ],
    messageCount: 1,
    truncated: false,
    messages: [{ seq: 1, at: '2026-10-16T10:00:00.000Z', fromId: 'user', fromName: '用户', text: '甲群的正文', mentions: [] }],
  },
  [B_ID]: {
    id: B_ID,
    title: '乙群',
    charter: '',
    wakeEnabled: true,
    routeMode: 'broadcast',
    selfReflect: false,
    joinPolicy: 'open',
    defaultEffort: 'high',
    liveEffort: false,
    effortStatus: 'available',
    sinkEnabled: false,
    sinkDir: '',
    sinkMemory: false,
    sink: {},
    members: [{ id: 'b-user', name: '丙', kind: 'bot', enabled: true, subscribe: [], wakeEffort: '', wakeable: false, isHuman: false }],
    messageCount: 1,
    truncated: false,
    messages: [{ seq: 1, at: '2026-10-16T10:00:00.000Z', fromId: 'b-user', fromName: '丙', text: '乙群的正文', mentions: [] }],
  },
}

/** A successful HTTP response carrying `data`. */
function ok(data) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) })
}

/** An HTTP response whose status and body are set independently (C-15). */
function status(code, data) {
  return Promise.resolve({ ok: code >= 200 && code < 300, status: code, json: () => Promise.resolve(data) })
}

/** A response whose body is not JSON at all — what a proxy error page looks like. */
function notJson(code) {
  return Promise.resolve({
    ok: false,
    status: code,
    json: () => Promise.reject(new SyntaxError("Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON")),
  })
}

/** The `?group=` a request asked for, or undefined for the list read. */
function wantedGroup(record) {
  const found = /[?&]group=([^&]+)/u.exec(record.url)
  return found === null ? undefined : decodeURIComponent(found[1])
}

function payload(extra = {}) {
  return Object.assign(
    {
      ok: true,
      version: '0.1.0',
      groups: ROWS,
      knobs: KNOBS,
      linkTargets: [
        { id: A_ID, title: '甲群' },
        { id: B_ID, title: '乙群' },
      ],
    },
    extra,
  )
}

/** The host's default GET: list, or one room's detail. */
function defaultGet(record) {
  const wanted = wantedGroup(record)
  if (wanted === undefined) return ok(payload())
  const detail = DETAILS[wanted]
  if (detail === undefined) return status(200, { ok: false, error: `unknown group "${wanted}"` })
  return ok(payload({ group: detail }))
}

/**
 * Mount the panel against a fake host.
 *
 * @param {object} [options] - `{get}` replaces the read; `post(body)` returns
 *   extra fields to merge into an ok answer, or a response of its own.
 */
async function mount(options = {}) {
  const { get = defaultGet, post } = options
  const panel = await mountPanel({
    source: SOURCE,
    fetchImpl: (record) => {
      if (record.method === 'POST') {
        const answer = typeof post === 'function' ? post(record.body ?? {}) : undefined
        if (answer instanceof Promise) return answer
        return ok(Object.assign({ ok: true }, answer))
      }
      return get(record)
    },
  })
  panel.render(panel.h(panel.componentFor('main'), {}))
  await panel.settle()
  return panel
}

/** Open 甲群 and switch to its settings tab. */
async function openSettings(panel) {
  const target = panel ?? (await mount())
  target.click(findButton(target.tree, '甲群'))
  await target.settle()
  target.click(findButton(target.tree, '设置'))
  await target.settle()
  return target
}

/** Everything the panel says must be readable prose, never a leaked JS value. */
function assertNoLeaks(shown, where) {
  assert.doesNotMatch(shown, /undefined/u, `${where}: leaked the literal "undefined"`)
  assert.doesNotMatch(shown, /NaN/u, `${where}: leaked "NaN"`)
  assert.doesNotMatch(shown, /\[object Object\]/u, `${where}: leaked "[object Object]"`)
}

/** Buttons whose entire text is exactly `label`. */
function exactButton(tree, label) {
  return findAll(tree, (node) => node.type === 'button' && textOf(node) === label)[0]
}

/** Both switches in document order (唤醒, 自省, 结论沉淀). */
function switchesOf(tree) {
  return findAll(tree, (node) => node.type === 'button' && (textOf(node) === '开' || textOf(node) === '关'))
}

function sliderOf(tree) {
  return findAll(tree, (node) => node.type === 'input' && node.props.type === 'range')[0]
}

function targetPicker(tree) {
  return findAll(
    tree,
    (node) => node.type === 'select' && findAll(node, (option) => option.type === 'option' && textOf(option) === '选一个目标群…').length > 0,
  )[0]
}

function keywordInput(tree) {
  return findAll(tree, (node) => node.type === 'input' && (node.props.placeholder ?? '').includes('关键词'))[0]
}

/** Smallest node that contains `needle` and at least one button. */
function cardContaining(tree, needle) {
  const size = (node) => {
    let count = 0
    const visit = (n) => {
      count += 1
      for (const child of n.children ?? []) visit(child)
    }
    visit(node)
    return count
  }
  const candidates = findAll(tree, (node) => textOf(node).includes(needle) && findAll(node, (inner) => inner.type === 'button').length > 0)
  return candidates.sort((a, b) => size(a) - size(b))[0]
}

// ─────────────────────────────────────────────────────────────────────────────
// C-01 (high): a failed read must never render as an empty room
// ─────────────────────────────────────────────────────────────────────────────

test('C-01 an unreadable ledger is stated as a failure, never as 「还没有群」', async () => {
  const panel = await mount({
    get: () => ok(payload({ groups: [], ledgerUnreadable: true, ledgerError: 'EACCES: permission denied, open groups.json' })),
  })
  const shown = textOf(panel.tree)
  assert.match(shown, /读取失败/u, 'the read failure must be visible')
  assert.match(shown, /EACCES/u, "the host's own reason must reach the user")
  assert.doesNotMatch(shown, /还没有群/u, 'an unreadable ledger is not an empty one')
  assert.doesNotMatch(shown, /0 个群/u, 'and its counts are not zero either — they are unknown')
  assertNoLeaks(shown, 'unreadable ledger')
})

test('C-01 a ledger recovered from a corrupt backup says so, and does not claim the rooms are gone', async () => {
  const panel = await mount({
    get: () => ok(payload({ groups: [], ledgerRecoveredFrom: 'C:\\data\\attention-group\\groups.json.corrupt-1750000000000' })),
  })
  const shown = textOf(panel.tree)
  assert.match(shown, /账本损坏/u)
  assert.match(shown, /groups\.json\.corrupt-1750000000000/u, 'the backup path is the one fact worth keeping')
  assert.doesNotMatch(shown, /还没有群/u)
  assertNoLeaks(shown, 'recovered ledger')
})

test('C-01 an empty list from a HEALTHY read still says 还没有群', async () => {
  const panel = await mount({ get: () => ok(payload({ groups: [] })) })
  assert.match(textOf(panel.tree), /还没有群/u, 'the honest empty state must survive the fix')
})

test('C-01 a transcript that cannot be read is a failure, never 「这个群还没有消息」', async () => {
  const panel = await mount({
    get: (record) => {
      const wanted = wantedGroup(record)
      if (wanted === undefined) return ok(payload())
      return ok(
        payload({
          group: Object.assign({}, DETAILS[A_ID], { messages: [], messagesUnreadable: true, messagesError: 'EBUSY: resource busy or locked' }),
        }),
      )
    },
  })
  panel.click(findButton(panel.tree, '甲群'))
  await panel.settle()
  const shown = textOf(panel.tree)
  assert.match(shown, /读取失败/u)
  assert.match(shown, /EBUSY/u)
  assert.doesNotMatch(shown, /这个群还没有消息/u, 'an unreadable transcript is not an empty one')
  assertNoLeaks(shown, 'unreadable transcript')
})

test('C-01 the room LIST marks a room whose transcript could not be read', async () => {
  const panel = await mount({
    get: () =>
      ok(
        payload({
          groups: [Object.assign({}, ROWS[0], { messagesUnreadable: true, messagesError: 'EACCES' }), ROWS[1]],
          ledgerUnreadable: false,
        }),
      ),
  })
  const shown = textOf(panel.tree)
  assert.match(shown, /记录读取失败/u)
  assert.match(shown, /乙群/u, 'the healthy room must still be listed')
  assertNoLeaks(shown, 'unreadable row')
})

// ─────────────────────────────────────────────────────────────────────────────
// C-06: one malformed room degrades one row, not the whole panel
// ─────────────────────────────────────────────────────────────────────────────

test('C-06 a degraded room is marked, still listed, and does not take the healthy room down', async () => {
  const broken = Object.assign({}, ROWS[0], { degraded: true, degradedReason: 'members is not an array' })
  const panel = await mount({
    get: (record) => {
      const wanted = wantedGroup(record)
      if (wanted === undefined) return ok(payload({ groups: [broken, ROWS[1]] }))
      return ok(payload({ group: DETAILS[wanted] }))
    },
  })
  const shown = textOf(panel.tree)
  assert.match(shown, /记录异常/u, 'the degraded row must say it is degraded')
  assert.match(shown, /乙群/u, 'the healthy room must survive its neighbour')
  const row = findButton(panel.tree, '甲群')
  assert.match(row.props.title, /members is not an array/u, 'the reason belongs on the row')

  // And the healthy room still opens normally.
  panel.click(findButton(panel.tree, '乙群'))
  await panel.settle()
  assert.match(textOf(panel.tree), /乙群的正文/u)
  assertNoLeaks(textOf(panel.tree), 'degraded list')
})

test('C-06 a detail with no members array renders instead of throwing', async () => {
  const panel = await mount({
    get: (record) => {
      const wanted = wantedGroup(record)
      if (wanted === undefined) return ok(payload())
      const broken = Object.assign({}, DETAILS[A_ID], { degraded: true, degradedReason: 'members is not an array' })
      delete broken.members
      return ok(payload({ group: broken }))
    },
  })
  panel.click(findButton(panel.tree, '甲群'))
  await panel.settle()
  const shown = textOf(panel.tree)
  assert.match(shown, /字段异常/u)
  assert.match(shown, /members is not an array/u)
  assertNoLeaks(shown, 'degraded detail')
})

// ─────────────────────────────────────────────────────────────────────────────
// C-02 (high) + C-02b: the keywords seam
// ─────────────────────────────────────────────────────────────────────────────

test('C-02 the keywords leave the panel as an ARRAY, with newlines and both comma widths split', async () => {
  const panel = await openSettings()
  panel.change(targetPicker(panel.tree), B_ID)
  panel.change(keywordInput(panel.tree), '发布, 上线\n部署，回滚')
  panel.click(findButton(panel.tree, '建立/更新'))

  const posted = panel.lastPost()
  assert.equal(posted.action, 'link')
  assert.equal(posted.to, B_ID)
  assert.deepEqual(posted.keywords, ['发布', '上线', '部署', '回滚'], 'the host normalizes arrays only; a string is dropped in silence')
  await panel.settle()
})

test('C-02 empty keyword text is sent as an empty ARRAY, never as an empty string', async () => {
  const panel = await openSettings()
  panel.change(targetPicker(panel.tree), B_ID)
  panel.click(findButton(panel.tree, '建立/更新'))
  assert.deepEqual(panel.lastPost().keywords, [])
  await panel.settle()
})

test('C-02b a link whose keywords are a STRING (an old ledger) renders instead of白屏', async () => {
  const link = { id: 'link-1', to: B_ID, mode: 'keyword', keywords: '发布, 上线', wake: false, enabled: true, maxHops: 3 }
  const panel = await mount({
    get: (record) => {
      const wanted = wantedGroup(record)
      if (wanted === undefined) return ok(payload())
      return ok(payload({ group: Object.assign({}, DETAILS[A_ID], { links: [link] }) }))
    },
  })
  await openSettings(panel)
  const shown = textOf(panel.tree)
  assert.match(shown, /发布, 上线/u, 'the old string shape must still be readable')
  assertNoLeaks(shown, 'string keywords')
})

test('C-02b keywords of any other shape do not throw either', async () => {
  const shapes = [{ a: 1 }, 42, null, ['发布', 7, {}, '上线']]
  for (const keywords of shapes) {
    const link = { id: 'link-1', to: B_ID, mode: 'keyword', keywords, wake: false, enabled: true, maxHops: 3 }
    const panel = await mount({
      get: (record) => {
        const wanted = wantedGroup(record)
        if (wanted === undefined) return ok(payload())
        return ok(payload({ group: Object.assign({}, DETAILS[A_ID], { links: [link] }) }))
      },
    })
    await openSettings(panel)
    const shown = textOf(panel.tree)
    assert.match(shown, /按关键词/u, `keywords ${JSON.stringify(keywords)} must still render the row`)
    assertNoLeaks(shown, `keywords ${JSON.stringify(keywords)}`)
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// C-03: a stale answer must not overwrite the room clicked last
// ─────────────────────────────────────────────────────────────────────────────

test('C-03 a slow answer for the previous room cannot repaint the room clicked last', async () => {
  const pending = []
  const panel = await mount({
    get: (record) => {
      const wanted = wantedGroup(record)
      if (wanted === undefined) return ok(payload())
      const answer = ok(payload({ group: DETAILS[wanted] }))
      if (wanted === A_ID) return new Promise((resolve) => pending.push(() => resolve(answer)))
      return answer
    },
  })

  panel.click(findButton(panel.tree, '甲群'))
  await panel.settle()
  panel.click(findButton(panel.tree, '乙群'))
  await panel.settle()
  assert.match(textOf(panel.tree), /乙群的正文/u)

  // The slow room finally answers, AFTER the user moved on.
  for (const resolve of pending) resolve()
  await panel.settle()
  const shown = textOf(panel.tree)
  assert.match(shown, /乙群的正文/u, 'the room clicked last must stay on screen')
  assert.doesNotMatch(shown, /甲群的正文/u, 'a stale answer must be dropped, not painted')
  assertNoLeaks(shown, 'stale response')
})

// ─────────────────────────────────────────────────────────────────────────────
// C-04 + C-05: the live-session effort knob
// ─────────────────────────────────────────────────────────────────────────────

test('C-04 the deployment-default side effect is in the VISIBLE text, not only the tooltip', async () => {
  const panel = await openSettings()
  const shown = textOf(panel.tree)
  assert.match(shown, /部署默认模型/u, 'the side effect changes the deployment, so the screen must say it')
  assert.match(findButton(panel.tree, '也改活会话').props.title, /部署默认模型/u)
})

test('C-04 a room already on live effort says what that currently means', async () => {
  const panel = await mount({
    get: (record) => {
      const wanted = wantedGroup(record)
      if (wanted === undefined) return ok(payload())
      return ok(payload({ group: Object.assign({}, DETAILS[A_ID], { liveEffort: true }) }))
    },
  })
  await openSettings(panel)
  assert.match(textOf(panel.tree), /已生效/u)
})

test('C-05 a partial application says how many sessions changed and how many were skipped', async () => {
  const panel = await mount({
    post: (body) => (body.action === 'effort' ? { liveApplied: true, applied: 1, skipped: 1, liveReason: 'one member has no readable route' } : {}),
  })
  await openSettings(panel)
  panel.change(sliderOf(panel.tree), '4')
  await panel.settle()
  const shown = textOf(panel.tree)
  assert.match(shown, /已改 1 个活会话/u, 'the count is the whole point: 2 live members, 1 changed')
  assert.match(shown, /1 个没有可用路由，被跳过/u)
  assertNoLeaks(shown, 'partial effort')
})

test('C-05 a live-effort switch that changed nothing says why', async () => {
  const panel = await mount({
    post: (body) => (body.action === 'effort' ? { liveApplied: false, applied: 0, skipped: 0, liveReason: 'no sessionController in this deployment' } : {}),
  })
  await openSettings(panel)
  panel.click(findButton(panel.tree, '也改活会话'))
  await panel.settle()
  const shown = textOf(panel.tree)
  assert.match(shown, /活会话一个也没改/u, 'a switch that shows 「开」 while nothing changed is the bug')
  assert.match(shown, /no sessionController in this deployment/u)
  assertNoLeaks(shown, 'failed live effort')
})

test('C-05 turning it on with no effort set says there was nothing to apply', async () => {
  const panel = await mount({ post: (body) => (body.action === 'effort' ? { liveApplied: true, applied: 0, skipped: 0 } : {}) })
  await openSettings(panel)
  panel.click(findButton(panel.tree, '也改活会话'))
  await panel.settle()
  assert.match(textOf(panel.tree), /没有活会话需要改/u)
})

test('C-05 a host that reports nothing at all is admitted, not papered over', async () => {
  const panel = await mount({ post: (body) => (body.action === 'effort' ? { liveEffort: true, effortStatus: 'available' } : {}) })
  await openSettings(panel)
  panel.click(findButton(panel.tree, '也改活会话'))
  await panel.settle()
  assert.match(textOf(panel.tree), /宿主没有报告活会话的改动结果/u)
})

test('C-05 the result note belongs to the room it happened in', async () => {
  const panel = await mount({
    post: (body) => (body.action === 'effort' ? { liveApplied: true, applied: 1, skipped: 0 } : {}),
  })
  await openSettings(panel)
  panel.change(sliderOf(panel.tree), '4')
  await panel.settle()
  assert.match(textOf(panel.tree), /已改 1 个活会话/u)

  // Move to another room: the previous room's result must not follow.
  panel.click(findButton(panel.tree, '聊天'))
  await panel.settle()
  panel.click(findButton(panel.tree, '乙群'))
  await panel.settle()
  panel.click(findButton(panel.tree, '设置'))
  await panel.settle()
  assert.doesNotMatch(textOf(panel.tree), /已改 1 个活会话/u, "another room's result must not be shown as this room's state")
})

// ─────────────────────────────────────────────────────────────────────────────
// C-07: a panel message that the host relayed has to say where it went
// ─────────────────────────────────────────────────────────────────────────────

test('C-07 a relayed panel message reports the room it reached', async () => {
  const panel = await mount({
    post: (body) => (body.action === 'post' ? { relayed: [{ linkId: 'link-1', to: B_ID, relayed: true, reason: '' }] } : {}),
  })
  panel.click(findButton(panel.tree, '甲群'))
  await panel.settle()
  const composer = findAll(panel.tree, (node) => node.type === 'input' && (node.props.placeholder ?? '').includes('以「用户」身份发言'))[0]
  panel.change(composer, '大家好')
  panel.click(findButton(panel.tree, '发送'))
  await panel.settle()
  assert.match(textOf(panel.tree), /已转发到 乙群/u, 'the promise 「这个群每说一句都转发过去」 must be followed by the fact')
})

test('C-07 a refused relay reports the host’s reason instead of silence', async () => {
  const panel = await mount({
    post: (body) =>
      body.action === 'post' ? { relayed: [{ linkId: 'link-1', to: B_ID, relayed: false, reason: 'mode=按关键词 but no keywords are set' }] } : {},
  })
  panel.click(findButton(panel.tree, '甲群'))
  await panel.settle()
  const composer = findAll(panel.tree, (node) => node.type === 'input' && (node.props.placeholder ?? '').includes('以「用户」身份发言'))[0]
  panel.change(composer, '大家好')
  panel.click(findButton(panel.tree, '发送'))
  await panel.settle()
  const shown = textOf(panel.tree)
  assert.match(shown, /未转发/u)
  assert.match(shown, /no keywords are set/u)
  assertNoLeaks(shown, 'refused relay')
})

// ─────────────────────────────────────────────────────────────────────────────
// C-08: 「唤醒 开」 must not promise something the panel cannot do
// ─────────────────────────────────────────────────────────────────────────────

test('C-08 the wake wording says a panel message wakes nobody', async () => {
  const panel = await mount()
  panel.click(findButton(panel.tree, '乙群')) // wakeEnabled: true
  await panel.settle()

  const button = findButton(panel.tree, '唤醒 开')
  assert.ok(button !== undefined, 'a room with waking on must still say so')
  assert.match(button.props.title, /面板里发言/u)
  assert.match(button.props.title, /不叫醒任何人/u)
  assert.doesNotMatch(button.props.title, /被 @ 或命中订阅词的成员会被真的叫起来跑一轮/u, 'that sentence was false for anything typed here')

  const composer = findAll(panel.tree, (node) => node.type === 'input' && (node.props.placeholder ?? '').includes('以「用户」身份发言'))[0]
  assert.match(composer.props.placeholder, /不会叫醒任何人/u)
  assert.match(textOf(panel.tree), /不叫醒任何人/u, 'and the truth must be VISIBLE, not only in a tooltip')
  assertNoLeaks(textOf(panel.tree), 'wake wording')
})

// ─────────────────────────────────────────────────────────────────────────────
// C-09: 「未知」 is a third state, not 「关」/「跟随」/0
// ─────────────────────────────────────────────────────────────────────────────

test('C-09 fields the host never reported are shown as unreported, not as 关', async () => {
  const bare = { id: A_ID, title: '甲群', members: [], messages: [], messageCount: 0 }
  const panel = await mount({
    get: (record) => {
      const wanted = wantedGroup(record)
      if (wanted === undefined) return ok({ ok: true, groups: [{ id: A_ID, title: '甲群' }] })
      return ok({ ok: true, group: bare })
    },
  })
  panel.click(findButton(panel.tree, '甲群'))
  await panel.settle()
  panel.click(findButton(panel.tree, '设置'))
  await panel.settle()

  const shown = textOf(panel.tree)
  assert.match(shown, /宿主未报告/u, 'an unreported field must say so')
  assert.match(shown, /未报告（面板不认识的值）/u, 'an effort nobody reported is not a label the panel may pick')
  // 「跟随」 survives only inside the members hint, which explains what the
  // option MEANS. What must never come back is the head claiming the room IS on
  // 「跟随」 because the panel could not read its real value.
  assert.doesNotMatch(shown, /强度 跟随/u, 'the panel must not invent 「跟随」 for an effort it never received')
  assert.equal(sliderOf(panel.tree).props.disabled, true, 'an unknown effort must not leave a live slider')
  assertNoLeaks(shown, 'unreported fields')
})

test('C-09 an effort value outside the host table shows the raw value and disables the slider', async () => {
  const panel = await mount({
    get: (record) => {
      const wanted = wantedGroup(record)
      if (wanted === undefined) return ok(payload())
      return ok(payload({ group: Object.assign({}, DETAILS[A_ID], { defaultEffort: 'medium' }) }))
    },
  })
  panel.click(findButton(panel.tree, '甲群'))
  await panel.settle()
  assert.match(textOf(panel.tree), /medium/u, 'the raw value is the honest thing to show')
  assert.match(textOf(panel.tree), /面板不认识/u)
  panel.click(findButton(panel.tree, '设置'))
  await panel.settle()
  assert.equal(sliderOf(panel.tree).props.disabled, true)
  assertNoLeaks(textOf(panel.tree), 'unknown effort')
})

test('C-09 a room row without counts does not claim 0 人 · 0 条', async () => {
  const panel = await mount({ get: () => ok(payload({ groups: [{ id: A_ID, title: '甲群' }] })) })
  const shown = textOf(panel.tree)
  assert.match(shown, /宿主未报告/u)
  assert.doesNotMatch(shown, /0 人/u)
  assertNoLeaks(shown, 'countless row')
})

test('C-09 a response without a groups array is a failure, not an empty room', async () => {
  for (const groups of [undefined, null, 'oops', 7]) {
    const panel = await mount({ get: () => ok({ ok: true, groups, knobs: KNOBS }) })
    const shown = textOf(panel.tree)
    assert.match(shown, /读取失败/u, `groups=${String(groups)} must be a failure`)
    assert.doesNotMatch(shown, /还没有群/u, `groups=${String(groups)} is not "you have no rooms"`)
    assertNoLeaks(shown, `groups=${String(groups)}`)
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// C-10: the 300-row cut has to be visible
// ─────────────────────────────────────────────────────────────────────────────

test('C-10 a truncated transcript says it is truncated and where the rest lives', async () => {
  const messages = Array.from({ length: 300 }, (_, index) => ({
    seq: index + 6,
    at: '2026-10-16T10:00:00.000Z',
    fromName: '用户',
    text: `第${index + 6}条`,
  }))
  const panel = await mount({
    get: (record) => {
      const wanted = wantedGroup(record)
      if (wanted === undefined) return ok(payload())
      return ok(payload({ group: Object.assign({}, DETAILS[A_ID], { messageCount: 305, truncated: true, messages }) }))
    },
  })
  panel.click(findButton(panel.tree, '甲群'))
  await panel.settle()
  const shown = textOf(panel.tree)
  assert.match(shown, /只显示最新 300 条/u, '305 rows on disk, 300 drawn, and the panel said nothing')
  assert.match(shown, /messages\/room-a-aaaa\.jsonl/u, 'and it must point at the complete record')
  assert.doesNotMatch(shown, /这个群还没有消息/u)
  assertNoLeaks(shown, 'truncated transcript')
})

test('C-10 an untruncated transcript says nothing about truncation', async () => {
  const panel = await mount()
  panel.click(findButton(panel.tree, '甲群'))
  await panel.settle()
  assert.doesNotMatch(textOf(panel.tree), /只显示最新/u)
})

// ─────────────────────────────────────────────────────────────────────────────
// C-11 / C-12 / C-13 / C-14 / C-15 / C-16
// ─────────────────────────────────────────────────────────────────────────────

test('C-11 建立/更新 with no target chosen sends nothing and says why', async () => {
  const panel = await openSettings()
  panel.clearRequests()
  panel.click(findButton(panel.tree, '建立/更新'))
  assert.equal(panel.posts().length, 0, 'a click that cannot be honoured must not become a write')
  assert.match(textOf(panel.tree), /请先选一个目标群/u)
})

test('C-12 a failed read is reported instead of being swallowed', async () => {
  const panel = await mount({ post: (body) => (body.action === 'read' ? status(500, { ok: false, error: 'read write failed' }) : {}) })
  panel.click(findButton(panel.tree, '甲群'))
  await panel.settle()
  const shown = textOf(panel.tree)
  assert.match(shown, /未读状态没有同步/u, 'the badge staying at 「未读 2」 was the visible symptom of a silent failure')
  assert.match(shown, /read write failed/u)
  assertNoLeaks(shown, 'failed read')
})

test('C-13 two clicks inside one round trip send one write, not two of the same value', async () => {
  const panel = await openSettings()
  panel.clearRequests()
  const sink = switchesOf(panel.tree)[2]
  panel.click(sink)
  panel.click(sink)
  const writes = panel.posts().filter((row) => row.action === 'sink')
  assert.equal(writes.length, 1, 'the second click must be dropped while the first is in flight')
  assert.deepEqual(writes[0], { action: 'sink', group: A_ID, sinkEnabled: false })
  await panel.settle()
})

test('C-13 a control is usable again once its write has settled', async () => {
  const panel = await openSettings()
  panel.clearRequests()
  const wake = switchesOf(panel.tree)[0]
  panel.click(wake)
  await panel.settle()
  panel.clearRequests()
  panel.click(switchesOf(panel.tree)[0])
  await panel.settle()
  assert.equal(panel.posts().filter((row) => row.action === 'wake').length, 1, 'the guard must not latch')
})

test('C-14 a room deleted from disk is reported once, and the selection is dropped', async () => {
  const panel = await mount({
    get: (record) => {
      const wanted = wantedGroup(record)
      if (wanted === undefined) return ok(payload())
      return status(200, { ok: false, error: `unknown group "${wanted}"` })
    },
  })
  panel.click(findButton(panel.tree, '甲群'))
  await panel.settle()
  const shown = textOf(panel.tree)
  assert.match(shown, /这个群已被删除/u)
  assert.doesNotMatch(shown, /读取失败/u, 'a deleted room is a fact, not a transport failure')
  assertNoLeaks(shown, 'deleted room')

  panel.clearRequests()
  await panel.settle()
  assert.equal(
    panel.requests.filter((row) => row.method === 'GET' && row.url.includes('group=')).length,
    0,
    'the poll must stop asking for a room that no longer exists',
  )
})

test('C-15 a non-JSON failure keeps its HTTP status instead of the parser error', async () => {
  const panel = await mount({ get: () => notJson(500) })
  const shown = textOf(panel.tree)
  assert.match(shown, /HTTP 500/u, 'the status is the one fact a proxy error page cannot take away')
  assert.doesNotMatch(shown, /Unexpected token/u, 'the JSON parser error must not replace it')
  assert.doesNotMatch(shown, /还没有群/u)
  assert.doesNotMatch(shown, /操作失败/u, 'a READ failure must not be announced as a write failure either')
  assertNoLeaks(shown, 'non-JSON failure')
})

test('C-15 a write failure is announced as 操作失败, never as 读取失败', async () => {
  const panel = await mount({
    post: (body) => (body.action === 'sink' ? status(500, { ok: false, error: 'sinkDir must be absolute' }) : {}),
  })
  await openSettings(panel)
  panel.click(findButton(panel.tree, '同时写任务记忆'))
  await panel.settle()
  const shown = textOf(panel.tree)
  assert.match(shown, /操作失败/u)
  assert.match(shown, /sinkDir must be absolute/u)
  assert.doesNotMatch(shown, /读取失败/u, 'a failed write must not be reported as a failed read — the reads all worked')
  assertNoLeaks(shown, 'failed write label')
})

test('C-15 a failing POST still reports the host’s own reason', async () => {
  const panel = await mount({ post: (body) => (body.action === 'sink' ? status(500, { ok: false, error: 'sinkDir must be absolute' }) : {}) })
  await openSettings(panel)
  panel.click(findButton(panel.tree, '同时写任务记忆'))
  await panel.settle()
  const shown = textOf(panel.tree)
  assert.match(shown, /操作失败/u)
  assert.match(shown, /sinkDir must be absolute/u)
  assert.match(shown, /HTTP 500/u)
})

test('C-16 the panel can send the liaison hop limit the host already accepts', async () => {
  const link = { id: 'link-1', to: B_ID, mode: 'all', keywords: [], wake: false, enabled: true, maxHops: 3 }
  const panel = await mount({
    get: (record) => {
      const wanted = wantedGroup(record)
      if (wanted === undefined) return ok(payload())
      return ok(payload({ group: Object.assign({}, DETAILS[A_ID], { links: [link] }) }))
    },
  })
  await openSettings(panel)
  const hop = findAll(panel.tree, (node) => node.type === 'input' && node.props.type === 'number')[0]
  assert.ok(hop !== undefined, 'the hop limit needs a control, or the panel cannot express it')
  assert.equal(hop.props.value, '3', 'and it must start from the value the host reported')
  panel.change(hop, '5')
  panel.click(findButton(panel.tree, '存跳数'))
  assert.deepEqual(panel.lastPost(), { action: 'link', group: A_ID, to: B_ID, maxHops: 5 })
  await panel.settle()
})

test('C-16 the hop field shows what the HOST stored, not what the human typed', async () => {
  // The host clamps maxHops to its own ceiling. After a clamp, leaving the typed
  // number on screen would state a value nobody has — the same class of lie as
  // 「还没有群」, one field down.
  let stored = 3
  const panel = await mount({
    post: (body) => {
      if (body.action === 'link' && body.maxHops !== undefined) stored = Math.min(8, body.maxHops)
      return {}
    },
    get: (record) => {
      const wanted = wantedGroup(record)
      if (wanted === undefined) return ok(payload())
      const link = { id: 'link-1', to: B_ID, mode: 'all', keywords: [], wake: false, enabled: true, maxHops: stored }
      return ok(payload({ group: Object.assign({}, DETAILS[A_ID], { links: [link] }) }))
    },
  })
  await openSettings(panel)
  const hop = findAll(panel.tree, (node) => node.type === 'input' && node.props.type === 'number')[0]
  panel.change(hop, '100')
  panel.click(findButton(panel.tree, '存跳数'))
  assert.equal(panel.lastPost().maxHops, 100, 'the panel sends what the human typed and lets the host decide')
  await panel.settle()
  const after = findAll(panel.tree, (node) => node.type === 'input' && node.props.type === 'number')[0]
  assert.equal(after.props.value, '8', 'and then shows the value the host actually stored')
})

test('C-16 a member rename control starts from the host’s own name', async () => {
  const panel = await openSettings()
  const jiaCard = cardContaining(panel.tree, JIA)
  const nameInput = findAll(jiaCard, (node) => node.type === 'input' && (node.props.placeholder ?? '').includes('在群里的名字'))[0]
  assert.ok(nameInput !== undefined, 'a member rename needs a control')
  assert.equal(nameInput.props.value, '甲', 'and it must start from the name the host reported')
  panel.change(nameInput, '甲改名了')
  panel.click(findButton(cardContaining(panel.tree, JIA), '改名'))
  assert.deepEqual(panel.lastPost(), { action: 'member', group: A_ID, memberId: JIA, name: '甲改名了' })
  await panel.settle()
})

// ─────────────────────────────────────────────────────────────────────────────
// The seam the audit's root-cause section was about: 「两半各自有测试，接缝没人测」
// ─────────────────────────────────────────────────────────────────────────────

test('C-02 the keywords typed in the panel reach the REAL ledger as an array', async () => {
  // Everything above uses a hand-written host stand-in, which by construction
  // cannot catch the two halves disagreeing about a field's TYPE. This one wires
  // the panel's own fetch into the real registered route and reads the ledger
  // back through the host, so the seam has a test of its own.
  const host = await createHost()
  try {
    host.boot()
    const sourceId = await host.newRoom('源群')
    const targetId = await host.newRoom('目标群')

    const panel = await mountPanel({
      source: SOURCE,
      fetchImpl: async (record) => {
        const response = record.method === 'POST' ? await host.post(record.body) : await host.call({ method: 'GET', url: record.url })
        return { ok: response.status === 200, status: response.status, json: async () => response.json }
      },
    })
    panel.render(panel.h(panel.componentFor('main'), {}))
    await panel.settle()

    panel.click(findButton(panel.tree, '源群'))
    await panel.settle()
    panel.click(findButton(panel.tree, '设置'))
    await panel.settle()

    panel.change(targetPicker(panel.tree), targetId)
    panel.change(keywordInput(panel.tree), '发布, 上线')
    panel.click(findButton(panel.tree, '建立/更新'))
    await panel.settle()

    const detail = await host.get(`?group=${sourceId}`)
    const links = detail.json.group.links
    assert.equal(links.length, 1, 'the liaison the panel created must exist on the host')
    assert.deepEqual(
      links[0].keywords,
      ['发布', '上线'],
      'the keywords must survive the panel → route → ledger trip as an ARRAY; a string here means the link can never relay',
    )
  } finally {
    host.cleanup()
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// The two invariants this whole file exists to protect
// ─────────────────────────────────────────────────────────────────────────────

test('no malformed payload can make the panel throw or leak a JS value', async () => {
  const cases = [
    { name: 'no groups field', body: { ok: true, knobs: KNOBS } },
    { name: 'groups is a string', body: { ok: true, groups: 'oops', knobs: KNOBS } },
    { name: 'groups is an object', body: { ok: true, groups: { a: 1 }, knobs: KNOBS } },
    { name: 'knobs is a string', body: { ok: true, groups: ROWS, knobs: 'oops' } },
    { name: 'a row is null', body: { ok: true, groups: [null, ROWS[1]], knobs: KNOBS } },
    { name: 'a row is a string', body: { ok: true, groups: ['oops'], knobs: KNOBS } },
    { name: 'linkTargets is a string', body: { ok: true, groups: ROWS, knobs: KNOBS, linkTargets: 'oops' } },
    { name: 'ledgerError is an object', body: { ok: true, groups: [], ledgerUnreadable: true, ledgerError: { code: 5 } } },
    { name: 'an empty object', body: { ok: true } },
  ]
  for (const one of cases) {
    const panel = await mount({ get: () => ok(one.body) })
    const shown = textOf(panel.tree)
    assertNoLeaks(shown, `list: ${one.name}`)
    assert.ok(shown.length > 0, `list: ${one.name} rendered nothing at all`)
  }
})

test('no malformed GROUP DETAIL can make the panel throw or leak a JS value', async () => {
  const details = [
    { name: 'detail is a string', group: 'oops' },
    { name: 'only an id', group: { id: A_ID } },
    { name: 'members is a string', group: Object.assign({}, DETAILS[A_ID], { members: 'oops' }) },
    { name: 'links is a string', group: Object.assign({}, DETAILS[A_ID], { links: 'oops' }) },
    { name: 'messages holds junk rows', group: Object.assign({}, DETAILS[A_ID], { messages: [null, 7, 'oops'] }) },
    { name: 'sink is a string', group: Object.assign({}, DETAILS[A_ID], { sink: 'oops' }) },
    { name: 'title is a number', group: Object.assign({}, DETAILS[A_ID], { title: 42 }) },
    { name: 'members hold junk', group: Object.assign({}, DETAILS[A_ID], { members: [null, 'oops'] }) },
  ]
  for (const one of details) {
    const panel = await mount({
      get: (record) => (wantedGroup(record) === undefined ? ok(payload()) : ok(payload({ group: one.group }))),
    })
    panel.click(findButton(panel.tree, '甲群'))
    await panel.settle()
    assertNoLeaks(textOf(panel.tree), `detail: ${one.name}`)

    panel.click(findButton(panel.tree, '设置'))
    await panel.settle()
    assertNoLeaks(textOf(panel.tree), `settings: ${one.name}`)
  }
})
