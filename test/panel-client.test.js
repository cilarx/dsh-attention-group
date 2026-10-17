/**
 * Panel (browser half) tests.
 *
 * These exist because the panel was the one artefact nobody could check: it only
 * ever ran in a real browser, so every change needed a human to open the page and
 * look — and a genuinely broken panel (route 404 -> "还没有群") survived two
 * debugging rounds on 2026-10-16 for exactly that reason.
 *
 * `test/support/panel-harness.mjs` runs this file's real source against a React
 * stand-in. That proves STRUCTURE and BEHAVIOUR — which controls exist, what a
 * click sends to the host — and proves nothing about pixels. The point is that
 * "ask the user to look" becomes "run the test".
 *
 * The interaction pattern mirrors React: interact (which re-renders), then
 * `settle()` to let effects and async reads finish, then assert.
 *
 * Run: node --test test/panel-client.test.js
 * (requires: pwsh -File tools/sync-plugin.ps1)
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import { mountPanel, findAll, textOf, findButton } from './support/panel-harness.mjs'
import { createHost } from './support/host-harness.mjs'
import { clientEntry, describeSource } from './support/entry.mjs'

// The browser is served the installed copy when there is one, and this source
// tree otherwise — see support/entry.mjs. Either way the panel is tested as the
// real file, not as a paraphrase of it.
if (!existsSync(clientEntry)) {
  throw new Error(`the panel under test is missing: ${clientEntry} (${describeSource()})`)
}
const SOURCE = readFileSync(clientEntry, 'utf8')

/** The host's own knob table, as the panel route reports it. */
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
    { value: 'conclusion', label: '只传结论', hint: '只有结论才转发' },
    { value: 'keyword', label: '按关键词', hint: '命中关键词才转发' },
    { value: 'mention', label: '按点名', hint: '@ 到名单里的人才转发' },
    { value: 'all', label: '全部转发', hint: '每句都转发，慎用' },
  ],
}

const P_ID = 'p-room-aaaa'
const Q_ID = 'q-room-bbbb'
const JIA = 'session-aaaa1111-2222-3333-4444-555566667777'

const GROUPS = [
  {
    id: P_ID,
    title: 'P群',
    messages: 2,
    unread: 3,
    memberCount: 3,
    memberNames: ['用户', '甲', '群管理'],
    wakeEnabled: false,
    routeMode: 'rules',
    lastFrom: '甲',
    lastPreview: 'P群最后一条',
  },
  {
    id: Q_ID,
    title: 'Q群',
    messages: 0,
    unread: 0,
    memberCount: 1,
    memberNames: ['丙'],
    wakeEnabled: true,
    routeMode: 'broadcast',
    lastFrom: '',
    lastPreview: '',
  },
]

const DETAIL = {
  [P_ID]: {
    id: P_ID,
    title: 'P群',
    charter: 'P群规：不谈Q群的事',
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
    sink: {
      dir: 'C:\\Users\\test\\.dsh\\attention-group\\sink',
      conclusionPath: 'C:\\Users\\test\\.dsh\\attention-group\\sink\\p-room-aaaa.conclusions.md',
      conclusions: 3,
      conclusionBytes: 512,
      files: 2,
    },
    members: [
      { id: 'user', name: '用户', kind: 'user', enabled: true, subscribe: [], wakeEffort: '', wakeable: false, isHuman: true },
      { id: JIA, name: '甲', kind: 'session', enabled: true, subscribe: ['部署'], wakeEffort: 'max', wakeable: true, isHuman: false },
      { id: 'room-admin', name: '群管理', kind: 'admin', enabled: false, subscribe: [], wakeEffort: '', wakeable: false, isHuman: false },
    ],
    messageCount: 2,
    truncated: false,
    messages: [
      { seq: 1, at: '2026-10-16T10:00:00.000Z', fromId: 'user', fromName: '用户', text: 'P的第一条', mentions: [] },
      { seq: 2, at: '2026-10-16T10:05:00.000Z', fromId: JIA, fromName: '甲', text: 'P的第二条 @用户', mentions: ['用户'] },
    ],
  },
  [Q_ID]: {
    id: Q_ID,
    title: 'Q群',
    charter: '',
    wakeEnabled: true,
    routeMode: 'broadcast',
    selfReflect: false,
    joinPolicy: 'user',
    defaultEffort: 'high',
    members: [
      { id: 'b-user', name: '丙', kind: 'bot', enabled: true, subscribe: [], wakeEffort: '', wakeable: false, isHuman: false },
    ],
    messageCount: 0,
    truncated: false,
    messages: [],
  },
}

/**
 * A host stand-in: GET returns the fixture, POST is accepted and recorded.
 *
 * @param {object} [options] - `{fail}` makes every read fail.
 * @returns {Function} a fetch implementation.
 */
function fakeHost(options = {}) {
  const { fail } = options
  return (record) => {
    if (record.method === 'POST') {
      const body = record.body ?? {}
      const extra =
        body.action === 'digest'
          ? { total: 2, shown: 2, omitted: 0, text: '群：P群（`p-room-aaaa`）\n条数：2\n#1 10-16 18:00 用户：P的第一条' }
          : {}
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            ok: true,
            groupId: P_ID,
            seq: 9,
            // The host reports where a sink write actually landed.
            path: 'C:\\Users\\test\\.dsh\\attention-group\\sink\\p-room-aaaa-export.md',
            messages: 5,
            ...extra,
          }),
      })
    }
    if (fail !== undefined) {
      return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({ ok: false, error: fail }) })
    }
    const wanted = /[?&]group=([^&]+)/u.exec(record.url)
    const groupId = wanted === null ? undefined : decodeURIComponent(wanted[1])
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          ok: true,
          version: '0.1.0',
          groups: GROUPS,
          knobs: KNOBS,
          linkTargets: [
            { id: P_ID, title: 'P群' },
            { id: Q_ID, title: 'Q群' },
          ],
          ...(groupId === undefined ? {} : { group: DETAIL[groupId] }),
        }),
    })
  }
}

/** Mount the panel and let its first read settle. */
async function boot(options = {}) {
  const panel = await mountPanel({ source: SOURCE, fetchImpl: fakeHost(options) })
  panel.render(panel.h(panel.componentFor('main'), {}))
  await panel.settle()
  return panel
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
  const candidates = findAll(
    tree,
    (node) => textOf(node).includes(needle) && findAll(node, (inner) => inner.type === 'button').length > 0,
  )
  return candidates.sort((a, b) => size(a) - size(b))[0]
}

/** Buttons whose entire text is exactly `label` (so "唤醒 关" is not "关"). */
function exactButton(tree, label) {
  return findAll(tree, (node) => node.type === 'button' && textOf(node) === label)[0]
}

/** Both switches, in document order: 唤醒 first, then 自省. */
function switchesOf(tree) {
  return findAll(tree, (node) => node.type === 'button' && (textOf(node) === '开' || textOf(node) === '关'))
}

/** The one range input: the room's effort slider. */
function sliderOf(tree) {
  return findAll(tree, (node) => node.type === 'input' && node.props.type === 'range')[0]
}

/** Open the P room and switch to its settings tab. */
async function openSettings() {
  const panel = await boot()
  panel.click(findButton(panel.tree, 'P群'))
  await panel.settle()
  panel.click(findButton(panel.tree, '设置'))
  await panel.settle()
  return panel
}

test('the sidebar entry exists, is labelled 群聊, and addresses the main panel', async () => {
  const panel = await boot()
  assert.equal(panel.id, 'dsh-attention-group')
  assert.deepEqual(panel.mod.inject, ['slots'])

  const meta = panel.metaFor('sidebar.panellist')
  assert.equal(meta.id, 'attention-group')
  assert.equal(meta.label(), '群聊')
  assert.equal(typeof panel.componentFor('sidebar.panellist'), 'function')
  assert.equal(typeof panel.componentFor('main'), 'function')
  assert.equal(panel.registrations.length, 2)
})

test('P群 and Q群 stay distinguishable, and opening one loads only its transcript', async () => {
  const panel = await boot()
  const listed = textOf(panel.tree)
  assert.match(listed, /P群/)
  assert.match(listed, /Q群/)
  assert.match(listed, /未读 3/, 'the unread count must be visible before opening a room')
  assert.match(listed, /唤醒开/, 'a room with waking enabled must say so in the list')

  panel.click(findButton(panel.tree, 'P群'))
  await panel.settle()

  const reads = panel.requests.filter((row) => row.method === 'GET').map((row) => row.url)
  assert.ok(
    reads.some((url) => url.includes(`group=${P_ID}`)),
    `opening P群 must ask for P群; asked for: ${reads.join(', ')}`,
  )

  const opened = textOf(panel.tree)
  assert.match(opened, /P的第一条/)
  assert.match(opened, /P的第二条/)
  assert.match(opened, /P群规：不谈Q群的事/, 'the charter is shown to whoever reads the room')
  assert.doesNotMatch(opened, /Q的第一条/, "P群 must not show another room's messages")
})

test('a failed read is reported as a failure, never as an empty room', async () => {
  const panel = await boot({ fail: 'HTTP 404' })
  const shown = textOf(panel.tree)
  assert.match(shown, /读取失败/)
  assert.match(shown, /HTTP 404/, "the host's own reason must reach the user")
  // The exact 2026-10-16 bug: a 404 rendered as "you have no rooms yet".
  assert.doesNotMatch(shown, /还没有群/)
})

test('the settings tab exposes every knob the host declares', async () => {
  const panel = await openSettings()
  const shown = textOf(panel.tree)

  for (const label of ['群名称', '唤醒', '推理强度', '路由模式', '自省', '群用途及群规', '拉人权限', '成员']) {
    assert.match(shown, new RegExp(label), `settings must expose 「${label}」`)
  }
  for (const label of ['规则', '语义', '全体']) assert.match(shown, new RegExp(label), `route mode ${label}`)
  for (const label of ['开放', '群成员', '仅用户', '冻结']) assert.match(shown, new RegExp(label), `join policy ${label}`)
  for (const label of ['跟随', '关', '低', '高', '最高']) assert.match(shown, new RegExp(label), `effort ${label}`)

  const slider = sliderOf(panel.tree)
  assert.ok(slider !== undefined, 'the room effort control must be a slider')
  assert.equal(Number(slider.props.max), KNOBS.efforts.length - 1, 'one notch per declared effort')
  assert.match(slider.props['aria-label'], /推理强度/)

  // Every member is listed with the state that matters.
  assert.match(shown, /甲/)
  assert.match(shown, /群管理/)
  assert.match(shown, /用户/)
  assert.match(shown, /已休眠/, 'a disabled member must be visibly disabled')
  assert.match(shown, /只记录/, 'a member that cannot be woken must say so')
})

test('the effort slider sends the room its single effort value', async () => {
  const panel = await openSettings()
  panel.change(sliderOf(panel.tree), '4')
  assert.deepEqual(panel.lastPost(), { action: 'effort', group: P_ID, effort: 'max' })
  await panel.settle()
})

test('each one-of-N knob writes through its own named action', async () => {
  const cases = [
    { label: '语义', expect: { action: 'route', group: P_ID, routeMode: 'classify' } },
    { label: '仅用户', expect: { action: 'joinPolicy', group: P_ID, joinPolicy: 'user' } },
  ]
  for (const row of cases) {
    const panel = await openSettings()
    const button = exactButton(panel.tree, row.label)
    assert.ok(button !== undefined, `no control labelled ${row.label}`)
    panel.click(button)
    assert.deepEqual(panel.lastPost(), row.expect)
    await panel.settle()
  }
})

test('the three switches are the wake gate, self-reflection and the sink', async () => {
  const panel = await openSettings()
  const switches = switchesOf(panel.tree)
  assert.equal(switches.length, 3, 'exactly three switches: 唤醒, 自省, 结论沉淀')

  panel.click(switches[0])
  assert.deepEqual(panel.lastPost(), { action: 'wake', group: P_ID, wakeEnabled: true })
  await panel.settle()

  const again = await openSettings()
  panel.click(switchesOf(again.tree)[1])
  assert.deepEqual(again.lastPost(), { action: 'selfReflect', group: P_ID, selfReflect: false })
  await again.settle()

  const third = await openSettings()
  panel.click(switchesOf(third.tree)[2])
  assert.deepEqual(third.lastPost(), { action: 'sink', group: P_ID, sinkEnabled: false })
})

test('renaming and editing the charter are writes, not decoration', async () => {
  const panel = await openSettings()
  const titleInput = findAll(panel.tree, (node) => node.type === 'input' && node.props.value === 'P群')[0]
  assert.ok(titleInput !== undefined, 'the room name must be editable')
  panel.change(titleInput, 'P群改名了')
  panel.click(findButton(cardContaining(panel.tree, '群名称'), '保存'))
  assert.deepEqual(panel.lastPost(), { action: 'rename', group: P_ID, title: 'P群改名了' })
  await panel.settle()

  const next = await openSettings()
  const charter = findAll(next.tree, (node) => node.type === 'textarea')[0]
  assert.ok(charter !== undefined, 'the charter must be editable')
  assert.equal(charter.props.value, 'P群规：不谈Q群的事')
  next.change(charter, 'P群规：改了')
  next.click(findButton(next.tree, '保存群用途及群规'))
  assert.deepEqual(next.lastPost(), { action: 'charter', group: P_ID, charter: 'P群规：改了' })
})

test('a member row can be slept, re-subscribed, re-pointed and removed', async () => {
  const panel = await openSettings()

  panel.click(findButton(cardContaining(panel.tree, JIA), '休眠'))
  assert.deepEqual(panel.lastPost(), { action: 'member', group: P_ID, memberId: JIA, enabled: false })
  await panel.settle()

  const next = await openSettings()
  const subscribe = findAll(next.tree, (node) => node.type === 'input' && node.props.value === '部署')[0]
  assert.ok(subscribe !== undefined, "a member's focus terms must be editable")
  next.change(subscribe, '部署, 发布')
  next.click(findButton(cardContaining(next.tree, JIA), '存订阅'))
  assert.deepEqual(next.lastPost(), { action: 'member', group: P_ID, memberId: JIA, subscribe: '部署, 发布' })
  await next.settle()

  const third = await openSettings()
  const effort = findAll(third.tree, (node) => node.type === 'select' && node.props.value === 'max')[0]
  assert.ok(effort !== undefined, 'a member must be able to override the room effort')
  third.change(effort, 'low')
  assert.deepEqual(third.lastPost(), { action: 'member', group: P_ID, memberId: JIA, wakeEffort: 'low' })
  await third.settle()

  const fourth = await openSettings()
  const before = fourth.posts().length
  fourth.click(findButton(cardContaining(fourth.tree, JIA), '移出'))
  assert.equal(fourth.posts().length, before, 'removing a member must ask once before it happens')
  fourth.click(findButton(cardContaining(fourth.tree, JIA), '确认移出'))
  assert.deepEqual(fourth.lastPost(), { action: 'leave', group: P_ID, memberId: JIA })
})

test('a person can create a room and add a member without an agent', async () => {
  const panel = await boot()
  panel.click(findButton(panel.tree, '＋'))
  await panel.settle()

  const titleInput = findAll(panel.tree, (node) => node.props.placeholder === '群名称')[0]
  assert.ok(titleInput !== undefined, 'the create form must ask for a room name')
  panel.change(titleInput, '我自己建的群')
  panel.click(findButton(panel.tree, '建'))
  assert.deepEqual(panel.lastPost(), { action: 'create', title: '我自己建的群' })
  await panel.settle()

  const next = await openSettings()
  next.click(findButton(next.tree, '＋ 拉人进群'))
  await next.settle()
  const idInput = findAll(next.tree, (node) => node.type === 'input' && /会话 id/u.test(node.props.placeholder ?? ''))[0]
  assert.ok(idInput !== undefined, 'the invite form must ask for a member id')
  next.change(idInput, 'session-9999')
  next.click(findButton(next.tree, '拉进来'))

  const joined = next.lastPost()
  assert.equal(joined.action, 'join')
  assert.equal(joined.memberId, 'session-9999')
  assert.equal(joined.group, P_ID)
})

test('speaking in a room never asks anyone to wake', async () => {
  const panel = await boot()
  panel.click(findButton(panel.tree, 'P群'))
  await panel.settle()

  const composer = findAll(
    panel.tree,
    (node) => node.type === 'input' && (node.props.placeholder ?? '').includes('以「用户」身份发言'),
  )[0]
  assert.ok(composer !== undefined, 'the human needs a place to speak')
  panel.change(composer, '大家好 @甲')
  panel.click(findButton(panel.tree, '发送'))
  await panel.settle()

  const posted = panel.posts().find((row) => row.action === 'post')
  assert.deepEqual(posted, { action: 'post', group: P_ID, text: '大家好 @甲' })
  assert.equal('wake' in posted, false)
  // The invariant the whole plugin rests on: a click is not a reason to start a
  // turn in someone else's session.
  assert.equal(
    panel.posts().some((row) => row.wake === true),
    false,
    'no panel action may ever request a wake',
  )
})

test('opening a room tells the host the human has read it', async () => {
  const panel = await boot()
  panel.click(findButton(panel.tree, 'Q群'))
  await panel.settle()
  assert.ok(
    panel.posts().some((row) => row.action === 'read' && row.group === Q_ID),
    'opening a room is what reading it means',
  )
})

test('the sink block shows where conclusions go and writes a file on demand', async () => {
  const panel = await openSettings()
  const shown = textOf(panel.tree)
  assert.ok(shown.includes('结论沉淀'), 'R7 must be visible in the panel')
  assert.ok(shown.includes('p-room-aaaa.conclusions.md'), 'the REAL conclusion path must be shown, not a promise')
  assert.ok(shown.includes('已沉淀 3 条'), 'how much has been sunk must be visible')

  // Exporting is a write to a file the host chooses; the panel must show where.
  panel.click(findButton(panel.tree, '导出这个群的记录'))
  assert.deepEqual(panel.lastPost(), { action: 'sinkExport', group: P_ID })
  await panel.settle()
  assert.ok(
    textOf(panel.tree).includes('p-room-aaaa-export.md'),
    'after exporting, the panel must show the path the host reported',
  )

  const next = await openSettings()
  next.click(findButton(next.tree, '同时写任务记忆'))
  assert.deepEqual(next.lastPost(), { action: 'sink', group: P_ID, sinkMemory: true })
  await next.settle()

  const third = await openSettings()
  const dirInput = findAll(third.tree, (node) => node.type === 'input' && (node.props.placeholder ?? '').includes('落到哪个文件夹'))[0]
  assert.ok(dirInput !== undefined, 'the sink folder must be settable')
  third.change(dirInput, 'D:\\群结论')
  third.click(findButton(third.tree, '存目录'))
  assert.deepEqual(third.lastPost(), { action: 'sink', group: P_ID, sinkDir: 'D:\\群结论' })
})

test('the chat tab can summarise a window for free, and collapse it again', async () => {
  const panel = await boot()
  panel.click(findButton(panel.tree, 'P群'))
  await panel.settle()

  const before = textOf(panel.tree)
  assert.ok(before.includes('总结今天'), 'R9 must be reachable from the room a person is looking at')
  assert.ok(before.includes('最近24小时'))

  panel.click(findButton(panel.tree, '总结今天'))
  assert.deepEqual(panel.lastPost(), { action: 'digest', group: P_ID, range: 'today' })
  await panel.settle()

  const shown = textOf(panel.tree)
  assert.ok(shown.includes('条数：2'), 'the digest itself must appear, not a promise of one')
  assert.ok(shown.includes('P的第一条'), 'and it carries the room\'s messages')
  // Summarising costs nothing and wakes nobody: the panel's own invariant.
  assert.equal(panel.posts().some((row) => row.wake === true), false)

  panel.click(findButton(panel.tree, '收起'))
  await panel.settle()
  assert.equal(textOf(panel.tree).includes('条数：2'), false, 'the digest box must be dismissible')
})

test('the liaison block points a room at another and cannot point it at itself', async () => {
  const panel = await openSettings()
  const shown = textOf(panel.tree)
  assert.ok(shown.includes('沟通员'), 'R10 must be visible in the panel')
  assert.ok(shown.includes('只传结论'), 'and must offer the modes the host declared')
  assert.ok(shown.includes('全部转发'))

  // The picker offers the OTHER rooms, and not the one being configured. It is
  // found by its own placeholder option, because a member's effort selector also
  // has an empty value.
  const picker = findAll(
    panel.tree,
    (node) => node.type === 'select' && findAll(node, (option) => option.type === 'option' && textOf(option) === '选一个目标群…').length > 0,
  )[0]
  assert.ok(picker !== undefined, 'there must be a target-room picker')
  const options = findAll(picker, (node) => node.type === 'option').map((node) => textOf(node))
  assert.ok(options.includes('Q群'), 'another room must be selectable')
  assert.equal(options.includes('P群'), false, 'a room must not be offered as a liaison to itself')

  panel.change(picker, Q_ID)
  const keyword = findAll(panel.tree, (node) => node.type === 'input' && (node.props.placeholder ?? '').includes('关键词'))[0]
  assert.ok(keyword !== undefined, 'keyword/mention links need somewhere to type')
  panel.change(keyword, '发布, 上线')
  panel.click(findButton(panel.tree, '建立/更新'))

  const posted = panel.lastPost()
  assert.equal(posted.action, 'link')
  assert.equal(posted.group, P_ID)
  assert.equal(posted.to, Q_ID)
  assert.equal(posted.mode, 'conclusion', 'the quiet mode is what the panel starts on')
  // C-02 (2026-10-16): this line used to assert the STRING '发布, 上线' — it had
  // pinned the wrong type as the contract. The host normalizes only arrays
  // (`relay.js`: `Array.isArray(input.keywords) ? … : []`), so a string here
  // means the keywords are dropped, the link can never relay, and the UI says it
  // was created. The panel must send an array.
  assert.deepEqual(posted.keywords, ['发布', '上线'], 'keywords must be sent as an array, never a string')
  assert.equal(posted.wake, false, 'a liaison must not start out waking anybody')
  await panel.settle()
})

test('an existing liaison can be paused, told to wake, or removed', async () => {
  const linkFixture = { id: 'link-1', to: Q_ID, mode: 'keyword', enabled: true, wake: false, keywords: ['发布'], maxHops: 3 }
  const panel = await mountPanel({
    source: SOURCE,
    fetchImpl: (record) => {
      if (record.method === 'POST') {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) })
      }
      const hasGroup = record.url.includes('group=')
      const detail = Object.assign({}, DETAIL[P_ID], { links: [linkFixture] })
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            ok: true,
            groups: GROUPS,
            knobs: KNOBS,
            linkTargets: [
              { id: P_ID, title: 'P群' },
              { id: Q_ID, title: 'Q群' },
            ],
            ...(hasGroup ? { group: detail } : {}),
          }),
      })
    },
  })
  panel.render(panel.h(panel.componentFor('main'), {}))
  await panel.settle()
  panel.click(findButton(panel.tree, 'P群'))
  await panel.settle()
  panel.click(findButton(panel.tree, '设置'))
  await panel.settle()

  const shown = textOf(panel.tree)
  assert.ok(shown.includes('→ ' + Q_ID), 'an existing link must be listed with its target')
  assert.ok(shown.includes('只记录'), 'and must say whether it wakes anyone')
  assert.ok(shown.includes('发布'), 'and show what it watches for')

  panel.click(findButton(panel.tree, '停用'))
  assert.deepEqual(panel.lastPost(), { action: 'link', group: P_ID, to: Q_ID, enabled: false })
  await panel.settle()

  panel.click(findButton(panel.tree, '改为叫醒'))
  assert.deepEqual(panel.lastPost(), { action: 'link', group: P_ID, to: Q_ID, wake: true })
  await panel.settle()

  panel.clearRequests()
  panel.click(findButton(panel.tree, '移除'))
  assert.deepEqual(panel.lastPost(), { action: 'unlink', group: P_ID, to: Q_ID })
})

test('the effort control can be extended to live sessions, and says what that costs', async () => {
  const panel = await openSettings()
  const shown = textOf(panel.tree)
  // The label used to read 「也改活会话」, which is jargon: "活会话" is not a word a
  // person uses. It now says what it does to whom. Reported by the user 2026-10-17.
  assert.ok(shown.includes('立刻改正在运行的成员'), 'U3 must be reachable from the panel')
  assert.ok(shown.includes('这个部署支持直接改正在运行的会话'), 'and must say whether this deployment can do it')

  panel.click(findButton(panel.tree, '立刻改正在运行的成员'))
  assert.deepEqual(panel.lastPost(), { action: 'effort', group: P_ID, liveEffort: true })
  await panel.settle()
})

test('no rendered text ever contains the literal word "undefined"', async () => {
  const panel = await openSettings()
  assert.doesNotMatch(textOf(panel.tree), /undefined/)
  panel.click(findButton(panel.tree, '聊天'))
  await panel.settle()
  assert.doesNotMatch(textOf(panel.tree), /undefined/)

  const broken = await boot({ fail: 'boom' })
  assert.doesNotMatch(textOf(broken.tree), /undefined/)
})

test('a freshly reloaded panel still reads transcripts from a host that has not restarted', async () => {
  // The host and the browser bundle are served separately, so there is a real
  // window where the page has the new panel and the process is still the old
  // one. The old payload put `messages` beside `group` (and `members` as bare
  // names); the new one puts the transcript inside the detail. Both must render,
  // because in that window "no transcript" is indistinguishable from "no
  // messages" — which is the failure this whole file exists to prevent.
  const legacyGroup = Object.assign({}, DETAIL[P_ID], { members: ['用户', '甲', '群管理'] })
  delete legacyGroup.messages
  const legacyGroupId = legacyGroup.id

  const panel = await mountPanel({
    source: SOURCE,
    fetchImpl: (record) => {
      if (record.method === 'POST') {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) })
      }
      const hasGroup = record.url.includes('group=')
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            ok: true,
            groups: GROUPS,
            knobs: KNOBS,
            // The OLD host shape, verbatim.
            ...(hasGroup ? { group: legacyGroup, messages: DETAIL[legacyGroupId].messages } : {}),
          }),
      })
    },
  })
  panel.render(panel.h(panel.componentFor('main'), {}))
  await panel.settle()
  panel.click(findButton(panel.tree, 'P群'))
  await panel.settle()

  assert.match(textOf(panel.tree), /P的第一条/, 'the old payload shape must still render its transcript')
  assert.doesNotMatch(textOf(panel.tree), /undefined/)

  // And the panel must NOT offer writes it cannot address: the old shape has no
  // member ids, so a row is shown and locked rather than sending a guessed id.
  panel.click(findButton(panel.tree, '设置'))
  await panel.settle()
  const settings = textOf(panel.tree)
  assert.match(settings, /群管理/, 'members given as bare names must still be named, not blank')
  assert.ok(settings.includes('重启 DSH 后可管理'), 'a locked row must say why it is locked')
  panel.clearRequests()
  const lockedRow = cardContaining(panel.tree, '群管理')
  assert.equal(findButton(lockedRow, '休眠'), undefined, 'a locked row must not offer a write')
  assert.equal(findButton(lockedRow, '移出'), undefined)
  assert.equal(panel.posts().length, 0)
})

test('the panel renders the REAL host read model, and a drag lands in the ledger', async () => {  // The other tests use a hand-written host stand-in, which cannot catch the two
  // halves disagreeing about the payload's SHAPE. This one wires the panel's own
  // fetch straight into the real registered route, so the fixture cannot drift.
  const host = await createHost()
  try {
    host.boot()
    const groupId = await host.newRoom('端到端群')
    const memberId = 'session-eeee1111-2222-3333-4444-555566667777'
    await host.post({ action: 'join', group: groupId, memberId, memberName: '端到端成员' })
    await host.post({ action: 'charter', group: groupId, charter: '端到端群规' })
    await host.post({ action: 'post', group: groupId, text: '端到端消息' })

    const panel = await mountPanel({
      source: SOURCE,
      fetchImpl: async (record) => {
        const response =
          record.method === 'POST' ? await host.post(record.body) : await host.call({ method: 'GET', url: record.url })
        return { ok: response.status === 200, status: response.status, json: async () => response.json }
      },
    })
    panel.render(panel.h(panel.componentFor('main'), {}))
    await panel.settle()
    assert.match(textOf(panel.tree), /端到端群/, 'the real room list must render')

    panel.click(findButton(panel.tree, '端到端群'))
    await panel.settle()
    const opened = textOf(panel.tree)
    assert.match(opened, /端到端消息/, 'the real transcript is inside the group detail, and the panel must read it there')
    assert.match(opened, /端到端群规/)

    panel.click(findButton(panel.tree, '设置'))
    await panel.settle()
    const settings = textOf(panel.tree)
    assert.match(settings, /端到端成员/)
    const slider = sliderOf(panel.tree)
    assert.ok(slider !== undefined)
    assert.equal(Number(slider.props.max), 4, "the REAL knob table must drive the slider's range")

    panel.change(slider, '4')
    await panel.settle()
    const afterDrag = await host.get(`?group=${groupId}`)
    assert.equal(afterDrag.json.group.defaultEffort, 'max', 'a slider drag from the browser must land in the ledger')
  } finally {
    host.cleanup()
  }
})

test('a theme token is only used where its VALUE fits the role', () => {
  // ⚠️ Lesson paid for on 2026-10-17, with the user staring at a broken panel:
  // a token's NAME is not evidence about its VALUE. Read the definitions out of
  // app.asar before using one:
  //   --dsw-alias-brand-primary = var(--dsw-static-neutral-bluish-1000)
  //       → a CONTRAST colour (near-black in light, near-white in dark), not an
  //         accent. As a "filled button" background it painted near-white blocks
  //         under `color:#fff` text: the 保存 button, the + and the selected
  //         segment became invisible.
  //   --dsw-alias-bg-layer-2 = var(--dsw-static-neutral-bluish-00)
  //       → pure WHITE in the light theme. As a chip background it turned every
  //         neutral surface into an opaque white slab.
  // So neutral surfaces stay translucent greys (they adapt to any background by
  // construction) and the accent stays the literal brand blue. Only the two
  // STATE colours are tokenised: the app itself writes
  // `color: var(--dsw-alias-state-error-primary)` for exactly that role.
  const FORBIDDEN = [
    '--dsw-alias-brand-primary',
    '--dsw-alias-bg-layer-1',
    '--dsw-alias-bg-layer-2',
    '--dsw-alias-bg-layer-3',
    '--dsw-alias-brand-',
    '--dsh-',
  ]
  for (const token of FORBIDDEN) {
    assert.ok(
      !SOURCE.includes(`var(${token}`),
      `${token} does not mean what it looks like — see the comment above before using it`,
    )
  }
  const ALLOWED = new Set(['--dsw-alias-state-error-primary', '--dsw-alias-state-warn-primary'])
  const used = [...SOURCE.matchAll(/var\((--[A-Za-z0-9-]+)/g)].map((match) => match[1])
  const unvetted = [...new Set(used)].filter((token) => !ALLOWED.has(token))
  assert.deepEqual(unvetted, [], `unvetted theme token(s): ${unvetted.join(', ')}`)
  // And the accent must still be a colour, not a token that might resolve to white.
  assert.ok(SOURCE.includes('#4d6bfe'), 'the brand accent must stay a literal colour')
})
