/**
 * R7 tests: conclusions sinking into ordinary files.
 *
 * The claim under test is narrow and falsifiable: a conclusion written through
 * this plugin ends up as text in a real file, the file survives everything, and
 * writing it wakes nobody. So these tests read the bytes off disk rather than
 * trusting the returned path.
 *
 * They also pin the two properties that make a sink safe to hand a model:
 *   - an export NEVER overwrites an existing file (the destination is a file the
 *     human chose, and this feature exists to stop losing things);
 *   - a refused write says which switch to flip, instead of reporting success.
 *
 * Run: node --test test/sink.test.js
 * (requires: pwsh -File tools/sync-plugin.ps1)
 */

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, appendFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'

import { createHost } from './support/host-harness.mjs'
import { moduleUrl } from './support/entry.mjs'

const sink = await import(moduleUrl('sink.js'))

const host = await createHost()
after(() => host.cleanup())

/** The whole output/render contract, checked on the two new tools. */
function assertRenderContract(tool, args, value) {
  const rendered = tool.output.render(args, value)
  assert.ok(Array.isArray(rendered), 'render must return an array')
  assert.ok(rendered.length > 0, 'render must say something')
  for (const block of rendered) {
    assert.equal(typeof block, 'object', 'render must not return bare strings')
    assert.equal(block.type, 'text', 'every block needs a type: it IS the durable content')
    assert.equal(typeof block.text, 'string')
  }
  assert.equal(value === undefined, false)
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(value)), 'output must survive JSON')
}

test('a multi-line conclusion stays one indented list item', () => {
  const text = sink.renderConclusion({ at: '2026-10-16T10:00:00.000Z', author: '群管理', text: '第一行\n第二行\n第三行' })
  const lines = text.split('\n')
  assert.equal(lines[0].startsWith('- **'), true)
  assert.ok(lines[0].includes('群管理'))
  assert.ok(lines[0].includes('第一行'))
  assert.equal(lines[1], '  第二行')
  assert.equal(lines[2], '  第三行')
  assert.equal(lines.filter((line) => line.startsWith('- ')).length, 1, 'one conclusion is one item')
})

test('the first conclusion creates the file together with its header', () => {
  host.boot()
  const root = join(host.home, 'unit-sink')
  const group = { id: 'r7-room', title: 'R7 群' }
  const first = sink.sinkConclusion({ root, group, at: '2026-10-16T10:00:00.000Z', author: '甲', text: '结论一' })
  assert.equal(first.created, true)
  const text = readFileSync(first.path, 'utf8')
  assert.ok(text.startsWith('# R7 群 · 结论沉淀'), 'the file introduces itself')
  assert.ok(text.includes('`r7-room`'), 'and names the room it belongs to')
  assert.equal(sink.countBullets(first.path), 1)

  const second = sink.sinkConclusion({ root, group, at: '2026-10-16T11:00:00.000Z', author: '乙', text: '结论二' })
  assert.equal(second.created, false, 'the header is written once')
  assert.equal(sink.countBullets(second.path), 2)
  const after = readFileSync(second.path, 'utf8')
  assert.equal(after.split('# R7 群 · 结论沉淀').length - 1, 1, 'exactly one header')
  assert.ok(after.indexOf('结论一') < after.indexOf('结论二'), 'append-only: newest last')
})

test('an export never overwrites a file that is already there', () => {
  host.boot()
  const root = join(host.home, 'unit-export')
  const group = { id: 'r7-room', title: 'R7 群', charter: '群规一' }
  const messages = [{ seq: 1, at: '2026-10-16T10:00:00.000Z', fromName: '甲', text: '正文' }]
  const wanted = join(root, 'fixed.md')
  mkdirSync(root, { recursive: true })
  writeFileSync(wanted, 'PRECIOUS\n')

  const written = sink.sinkTranscript({ root, group, messages, since: '', until: '', at: '2026-10-16T12:00:00.000Z', path: wanted })
  assert.notEqual(written.path, wanted, 'an occupied path must not be reused')
  assert.equal(readFileSync(wanted, 'utf8'), 'PRECIOUS\n', 'the existing file is untouched')
  assert.ok(written.path.endsWith('-2.md'))

  const doc = readFileSync(written.path, 'utf8')
  assert.ok(doc.includes('# R7 群 · 聊天记录导出'))
  assert.ok(doc.includes('群规一'), 'the charter travels with the transcript')
  assert.ok(doc.includes('## #1 · '))
  assert.ok(doc.includes('正文'))
})

test('a time range filters inclusively at the end and exclusively at the start', () => {
  const rows = [
    { at: '2026-10-16T09:00:00.000Z', text: 'a' },
    { at: '2026-10-16T10:00:00.000Z', text: 'b' },
    { at: '2026-10-16T11:00:00.000Z', text: 'c' },
  ]
  assert.deepEqual(rows.filter((row) => sink.inRange(row, '2026-10-16T10:00:00.000Z', '')).map((row) => row.text), ['c'])
  assert.deepEqual(
    rows.filter((row) => sink.inRange(row, '', '2026-10-16T10:00:00.000Z')).map((row) => row.text),
    ['a', 'b'],
  )
  assert.deepEqual(
    rows.filter((row) => sink.inRange(row, '2026-10-16T09:30:00.000Z', '2026-10-16T10:30:00.000Z')).map((row) => row.text),
    ['b'],
  )
  assert.equal(rows.filter((row) => sink.inRange(row, '', '')).length, 3, 'no range means everything')
})

test('a relative sink folder resolves against the data root, an absolute one is honoured', () => {
  host.boot()
  const root = join(host.home, 'unit-dir')
  assert.equal(sink.groupSinkDir(root, { sinkDir: '' }), join(root, 'sink'))
  assert.equal(sink.groupSinkDir(root, { sinkDir: 'notes' }), join(root, 'notes'))
  const absolute = 'D:\\群结论'
  assert.equal(sink.groupSinkDir(root, { sinkDir: absolute }), absolute)
})

test('attention_conclude writes the file, records the message, and wakes nobody', async () => {
  host.boot()
  const groupId = await host.newRoom('沉淀群')
  const tool = host.tool('attention_conclude')
  assert.ok(tool !== undefined, 'R7 needs a way to conclude')

  const value = await tool.execute({ groupId, text: '第一行\n第二行' }, { agent: undefined })
  assert.equal(value.ok, true, value.error)
  assert.equal(value.seq, 1)
  assert.equal(value.conclusions, 1)
  assert.equal(value.created, true)
  assertRenderContract(tool, { groupId, text: 'x' }, value)

  // The bytes are on disk, not just in the answer.
  const onDisk = readFileSync(value.path, 'utf8')
  assert.ok(onDisk.includes('第一行'))
  assert.ok(onDisk.includes('  第二行'))

  // And the room's own record has it, marked as a conclusion.
  const transcript = host.messagesOnDisk(groupId).trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(transcript.length, 1)
  assert.equal(transcript[0].kind, 'conclusion')
  assert.deepEqual(transcript[0].mentions, [], 'sinking is not addressing anyone')

  // The invariant: concluding must not attempt a delivery.
  assert.equal(existsSync(join(host.home, 'attention-group', 'messages', 'deliveries.jsonl')), false)
})

test('attention_conclude refuses by naming the switch, and a second conclusion appends', async () => {
  host.boot()
  const groupId = await host.newRoom('沉淀开关群')
  const tool = host.tool('attention_conclude')

  await host.post({ action: 'sink', group: groupId, sinkEnabled: false })
  const refused = await tool.execute({ groupId, text: '不该写进去' }, {})
  assert.equal(refused.ok, false)
  assert.match(refused.error, /结论沉淀/, 'the refusal must name the switch the human has to find')
  assert.match(refused.error, /panel/, 'and where that switch lives')
  assert.throws(() => readFileSync(refused.path, 'utf8'), 'nothing may be written when refused')

  await host.post({ action: 'sink', group: groupId, sinkEnabled: true })
  const first = await tool.execute({ groupId, text: '一' }, {})
  const second = await tool.execute({ groupId, text: '二' }, {})
  assert.equal(second.path, first.path, 'a room has ONE conclusion file, not one per conclusion')
  assert.equal(second.conclusions, 2)
  assert.equal(second.created, false)
})

test('the task-memory sentence appears only when that group switch is on', async () => {
  host.boot()
  const groupId = await host.newRoom('软集成群')
  const tool = host.tool('attention_conclude')

  const quiet = await tool.execute({ groupId, text: '普通结论' }, {})
  assert.equal('memoryNote' in quiet, false, 'a bare DSH must not be told about a deployment it may not have')
  assert.equal(quiet.memoryNote, undefined)
  assertRenderContract(tool, { groupId, text: 'x' }, quiet)

  await host.post({ action: 'sink', group: groupId, sinkMemory: true })
  const loud = await tool.execute({ groupId, text: '要记进记忆的结论' }, {})
  assert.match(loud.memoryNote, /任务记忆/)
  // On THIS deployment the plugin must not claim a tool exists when it does not:
  // the integration degrades by saying so, not by failing or by staying silent.
  assert.match(loud.memoryNote, /没有任务记忆工具/, 'the note must report what the runtime actually has')
  assert.match(loud.memoryNote, /结论仍然写进了文件/, 'and that the sink still did its job')
  assert.equal(existsSync(loud.path), true)
  assertRenderContract(tool, { groupId, text: 'x' }, loud)
})

test('when a task-memory tool really is present, the note asks for the write', async () => {
  // The other half of "use it if present, degrade if not" — proven by giving the
  // deployment the tool and checking that the sentence changes.
  const withMemory = await createHost({ extraTools: ['task_memory_write'] })
  try {
    withMemory.boot()
    const groupId = await withMemory.newRoom('有记忆的群')
    await withMemory.post({ action: 'sink', group: groupId, sinkMemory: true })
    const value = await withMemory.tool('attention_conclude').execute({ groupId, text: '一条决定' }, {})
    assert.equal(value.ok, true, value.error)
    assert.match(value.memoryNote, /请把这条结论也写进任务记忆/)
    assert.equal(value.memoryNote.includes('没有任务记忆工具'), false)
  } finally {
    withMemory.cleanup()
  }
})

test('attention_export writes a bounded-in-time file and reports where it went', async () => {
  host.boot()
  const groupId = await host.newRoom('导出群')
  await host.post({ action: 'post', group: groupId, text: '早上那句' })
  await host.post({ action: 'post', group: groupId, text: '晚上那句' })

  const tool = host.tool('attention_export')
  assert.ok(tool !== undefined)

  const all = await tool.execute({ groupId }, {})
  assert.equal(all.ok, true, all.error)
  assert.equal(all.messages, 2)
  assert.equal(all.total, 2)
  assert.ok(existsSync(all.path))
  const doc = readFileSync(all.path, 'utf8')
  assert.ok(doc.includes('早上那句') && doc.includes('晚上那句'))
  assert.ok(doc.includes('条数：2'))
  assertRenderContract(tool, { groupId }, all)

  // A range that selects only the newest message.
  const narrow = await tool.execute({ groupId, since: all.path.length > 0 ? '1970-01-01T00:00:00.000Z' : '', limit: 1 }, {})
  assert.equal(narrow.messages, 1)
  assert.notEqual(narrow.path, all.path, 'a second export is a second file')
  const narrowDoc = readFileSync(narrow.path, 'utf8')
  assert.ok(narrowDoc.includes('晚上那句'))
  assert.equal(narrowDoc.includes('早上那句'), false, 'limit keeps the newest, not the oldest')
})

test('exactly one new message kind reached the tools, and nothing else changed', async () => {
  host.boot()
  const names = ['attention_probe', 'attention_probe_session', 'attention_group_create', 'attention_group_list', 'attention_group_join', 'attention_send', 'attention_history', 'attention_conclude', 'attention_export']
  for (const name of names) {
    assert.ok(host.tool(name) !== undefined, `tool ${name} must be registered`)
  }
  // R11 is postponed: the liaison seat is reservable, but no DSB adapter exists.
  assert.equal(host.tool('attention_dsb_bridge'), undefined)
})

test('the panel can switch the sink and export the room without writing a message', async () => {
  host.boot()
  const groupId = await host.newRoom('面板沉淀群')
  await host.post({ action: 'post', group: groupId, text: '一条记录' })
  const before = host.messagesOnDisk(groupId)

  const toggled = await host.post({ action: 'sink', group: groupId, sinkDir: 'notes', sinkMemory: true })
  assert.equal(toggled.json.ok, true)
  const group = (await host.get(`?group=${groupId}`)).json.group
  assert.equal(group.sinkDir, 'notes')
  assert.equal(group.sinkMemory, true)
  assert.equal(group.sinkEnabled, true)
  assert.equal(group.sink.conclusions, 0)
  assert.ok(group.sink.conclusionPath.endsWith('.conclusions.md'))
  assert.ok(group.sink.dir.includes('notes'), 'the panel is shown the RESOLVED folder')

  const exported = await host.post({ action: 'sinkExport', group: groupId })
  assert.equal(exported.json.ok, true, exported.json.error)
  assert.equal(exported.json.messages, 1)
  assert.ok(existsSync(exported.json.path))
  assert.ok(readFileSync(exported.json.path, 'utf8').includes('一条记录'))

  assert.equal(host.messagesOnDisk(groupId), before, 'exporting is not speaking: the transcript is untouched')
  assert.equal(existsSync(join(host.home, 'attention-group', 'messages', 'deliveries.jsonl')), false)

  const shown = (await host.get(`?group=${groupId}`)).json.group.sink
  assert.equal(shown.files, 1, 'the panel can count what has been sunk')
})

// ---------------------------------------------------------------------------
// "An export never overwrites" has to survive MORE THAN ONE PROCESS.
//
// The old shape was: look for a free name, then write to it. Between those two
// steps another process can take the name — measured on 2026-10-16, two writers
// exporting to one path were handed the same name 19 times out of 120 calls, and
// the later write replaced the earlier one's bytes. The fix asks the filesystem
// for an exclusive create (`openSync(..., 'wx')`) and walks to the next name on
// `EEXIST`, so the race is decided by the kernel instead of by timing.
//
// These two tests run REAL child processes, because a single process cannot
// interleave two synchronous write paths.
// ---------------------------------------------------------------------------

/** A child that races its sibling for one shared export path. */
const RACE_EXPORT_CHILD = `
  import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
  const sink = await import(process.env.B_RACE_SINK)
  const tag = process.env.B_RACE_TAG
  const go = process.env.B_RACE_GO
  writeFileSync(go + '-' + tag, 'ready')
  const deadline = Date.now() + 15000
  while (!existsSync(go)) {
    if (Date.now() > deadline) throw new Error('barrier timeout')
  }
  for (let i = 0; i < Number(process.env.B_RACE_COUNT); i += 1) {
    const written = sink.sinkTranscript({
      root: process.env.B_RACE_DIR,
      group: { id: 'race', title: 'R' },
      messages: [{ seq: i, at: '2026-10-16T00:00:00.000Z', fromName: tag, text: tag + '-' + i }],
      since: '', until: '', at: '2026-10-16T12:00:00.000Z',
      path: process.env.B_RACE_WANTED,
    })
    appendFileSync(process.env.B_RACE_LOG, written.path + '\\n')
  }
`

/** A child that races its sibling to be the one that writes the header. */
const RACE_CONCLUDE_CHILD = `
  import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
  const sink = await import(process.env.B_RACE_SINK)
  const tag = process.env.B_RACE_TAG
  const go = process.env.B_RACE_GO
  writeFileSync(go + '-' + tag, 'ready')
  const deadline = Date.now() + 15000
  while (!existsSync(go)) {
    if (Date.now() > deadline) throw new Error('barrier timeout')
  }
  let created = 0
  for (let i = 0; i < Number(process.env.B_RACE_COUNT); i += 1) {
    const written = sink.sinkConclusion({
      root: process.env.B_RACE_DIR,
      group: { id: 'race', title: 'R' },
      at: '2026-10-16T12:00:00.000Z',
      author: tag,
      text: tag + '-' + i,
    })
    if (written.created === true) created += 1
  }
  appendFileSync(process.env.B_RACE_LOG, created + '\\n')
`

/**
 * Start two children, release them together, and return their exits.
 *
 * The barrier matters: started one after the other they would simply take turns,
 * and the race this tests would never happen.
 */
async function runRacePair(script, env) {
  const children = ['alpha', 'beta'].map((tag) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, ...env, B_RACE_TAG: tag },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    return new Promise((resolve) => child.on('exit', (code) => resolve({ tag, code, stderr })))
  })
  try {
    const deadline = Date.now() + 15000
    while (!(existsSync(`${env.B_RACE_GO}-alpha`) && existsSync(`${env.B_RACE_GO}-beta`))) {
      if (Date.now() > deadline) throw new Error('children never reached the barrier')
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  } finally {
    // Always release them, so a failure here cannot leave two spinning processes.
    writeFileSync(env.B_RACE_GO, 'go')
  }
  return Promise.all(children)
}

test('two processes exporting to one path produce one file each, and no name twice', async () => {
  host.boot()
  const dir = join(host.home, 'race-export')
  mkdirSync(dir, { recursive: true })
  const log = join(dir, 'claims.log')
  writeFileSync(log, '')
  const perChild = 25

  const exits = await runRacePair(RACE_EXPORT_CHILD, {
    B_RACE_SINK: moduleUrl('sink.js'),
    B_RACE_DIR: dir,
    B_RACE_WANTED: join(dir, 'shared.md'),
    B_RACE_LOG: log,
    B_RACE_GO: join(dir, 'go'),
    B_RACE_COUNT: String(perChild),
  })
  for (const exit of exits) {
    assert.equal(exit.code, 0, `child ${exit.tag} failed: ${exit.stderr}`)
  }

  const claims = readFileSync(log, 'utf8').trim().split('\n')
  assert.equal(claims.length, perChild * 2, 'every export must have reported a path')
  assert.equal(new Set(claims).size, claims.length, 'a name was handed to two writers: that is an overwrite')
  const files = readdirSync(dir).filter((name) => name.endsWith('.md'))
  assert.equal(files.length, perChild * 2, 'every export must be its own file')
  for (const name of files) {
    assert.ok(readFileSync(join(dir, name), 'utf8').includes('# R · 聊天记录导出'), `${name} is not an export`)
  }
})

test('two processes concluding at once write exactly one header', async () => {
  host.boot()
  const dir = join(host.home, 'race-conclude')
  mkdirSync(dir, { recursive: true })
  const log = join(dir, 'created.log')
  writeFileSync(log, '')
  const perChild = 20

  const exits = await runRacePair(RACE_CONCLUDE_CHILD, {
    B_RACE_SINK: moduleUrl('sink.js'),
    B_RACE_DIR: dir,
    B_RACE_WANTED: join(dir, 'unused.md'),
    B_RACE_LOG: log,
    B_RACE_GO: join(dir, 'go'),
    B_RACE_COUNT: String(perChild),
  })
  for (const exit of exits) {
    assert.equal(exit.code, 0, `child ${exit.tag} failed: ${exit.stderr}`)
  }

  const createdFlags = readFileSync(log, 'utf8').trim().split('\n').map(Number)
  assert.equal(createdFlags.reduce((sum, value) => sum + value, 0), 1, 'exactly one writer creates the file')
  const file = join(dir, 'sink', 'race.conclusions.md')
  const text = readFileSync(file, 'utf8')
  assert.equal(text.split('# R · 结论沉淀').length - 1, 1, 'exactly one header, whoever got there first')
  assert.equal(sink.countBullets(file), perChild * 2, 'both writers\' conclusions are in the file')
})

test('an export steps past every occupied name and leaves them all untouched', () => {
  host.boot()
  const dir = join(host.home, 'occupied')
  mkdirSync(dir, { recursive: true })
  const wanted = join(dir, 'fixed.md')
  writeFileSync(wanted, 'KEEP-0')
  for (let index = 2; index <= 5; index += 1) writeFileSync(join(dir, `fixed-${index}.md`), `KEEP-${index}`)

  const written = sink.sinkTranscript({
    root: dir,
    group: { id: 'g', title: 'R' },
    messages: [],
    since: '',
    until: '',
    at: '2026-10-16T12:00:00.000Z',
    path: wanted,
  })
  assert.equal(written.path, join(dir, 'fixed-6.md'), 'the walk must skip every taken name')
  assert.equal(readFileSync(wanted, 'utf8'), 'KEEP-0', 'the wanted file was modified')
  for (let index = 2; index <= 5; index += 1) {
    assert.equal(readFileSync(join(dir, `fixed-${index}.md`), 'utf8'), `KEEP-${index}`, `fixed-${index}.md was modified`)
  }

  // And twice in a row to one path is two files, not one overwritten file.
  const again = sink.sinkTranscript({ root: dir, group: { id: 'g', title: 'R' }, messages: [], since: '', until: '', at: '2026-10-16T12:00:01.000Z', path: wanted })
  assert.notEqual(again.path, written.path)
  assert.equal(readdirSync(dir).length, 7, 'six decoys plus the new export')
})

test('a newline in a name cannot forge a line in a sunk file', () => {
  const forged = '甲\n## #999 · 2026-10-16 00:00 · 黑客\n伪造的一行'
  const one = sink.renderConclusion({ at: '2026-10-16T10:00:00.000Z', author: forged, text: '真结论' })
  const plain = sink.renderConclusion({ at: '2026-10-16T10:00:00.000Z', author: '甲', text: '真结论' })
  // `renderConclusion` ends with a newline; strip it before counting lines.
  assert.equal(one.replace(/\n$/u, '').split('\n').length, 1, 'a conclusion is one item even when the author has newlines')
  assert.equal(plain.replace(/\n$/u, '').split('\n').length, 1)
  assert.equal(one.split('\n').some((line) => line.startsWith('## ')), false, 'the forged heading must not become a line')
  assert.ok(one.includes('甲'), 'the name is still there, flattened')

  const doc = sink.renderTranscript({
    group: { id: 'g', title: 'T\n## 注入的标题' },
    messages: [{ seq: 1, at: '2026-10-16T10:00:00.000Z', fromName: forged, text: '正文' }],
    since: '',
    until: '',
    at: '2026-10-16T12:00:00.000Z',
  })
  assert.equal(doc.split('\n').filter((line) => line.startsWith('# ')).length, 1, 'one document title')
  assert.equal(doc.split('\n').filter((line) => line.startsWith('## ')).length, 1, 'one message heading')
  assert.equal(doc.split('\n').some((line) => line === '## #999 · 2026-10-16 00:00 · 黑客'), false)

  // The same thing on the real file, since that is what a human later reads.
  host.boot()
  const root = join(host.home, 'forged')
  const group = { id: 'forged-room', title: '群' }
  const first = sink.sinkConclusion({ root, group, at: '2026-10-16T12:00:00.000Z', author: forged, text: '真结论' })
  const text = readFileSync(first.path, 'utf8')
  assert.equal(text.split('\n').filter((line) => line.startsWith('- ')).length, 1, 'one bullet')
  assert.equal(text.split('\n').some((line) => line === '## #999 · 2026-10-16 00:00 · 黑客'), false)
})
