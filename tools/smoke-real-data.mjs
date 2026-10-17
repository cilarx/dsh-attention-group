/**
 * End-to-end smoke test against a COPY of your real data.
 *
 * WHY THIS EXISTS. Unit tests build their own fixtures, so they prove the code
 * works on data the tests invented. This script proves it works on the data you
 * actually have: it copies `$DSH_HOME/attention-group` to a throwaway directory,
 * points the plugin at the copy, and walks every registered tool once, checking
 * the result of each step. Your real ledger is read-only — the script hashes it
 * before and after and fails if anything changed.
 *
 * It is also the pre-restart check: host-side code cannot be exercised through the
 * live runtime until DSH restarts, but it CAN be exercised like this.
 *
 * Usage:
 *   node tools/smoke-real-data.mjs                 # uses ~/.dsh/attention-group if present
 *   node tools/smoke-real-data.mjs --empty         # starts from an empty ledger instead
 *   node tools/smoke-real-data.mjs --keep          # do not delete the temp copy
 *
 * Needs no DSH: it loads the INSTALLED profile copy, so run `tools/sync-plugin.ps1`
 * first (or `tools/run-tests.ps1`, which syncs).
 */

import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

const args = new Set(process.argv.slice(2))
const profileRoot = join(process.env.USERPROFILE ?? homedir(), '.dsh', 'profiles', 'desktop')
const installed = join(profileRoot, 'node_modules', 'dsh-attention-group', 'src', 'index.js')
if (!existsSync(installed)) {
  console.error(`the installed plugin copy is missing:\n  ${installed}\nrun: pwsh -File tools/sync-plugin.ps1`)
  process.exit(2)
}

const realHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const realRoot = join(realHome, 'attention-group')

/** Hash every file under a directory, so "untouched" is checkable. */
function hashTree(dir) {
  if (!existsSync(dir)) return 'absent'
  const hash = createHash('sha256')
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else {
        hash.update(entry.name)
        hash.update(readFileSync(full))
      }
    }
  }
  walk(dir)
  return hash.digest('hex')
}

const before = hashTree(realRoot)
const tempHome = mkdtempSync(join(tmpdir(), 'attention-smoke-'))
const copyRoot = join(tempHome, 'attention-group')

if (args.has('--empty') || !existsSync(realRoot)) {
  mkdirSync(join(copyRoot, 'messages'), { recursive: true })
  console.log(`source: EMPTY ledger (${existsSync(realRoot) ? '--empty was passed' : `${realRoot} does not exist`})`)
} else {
  mkdirSync(copyRoot, { recursive: true })
  cpSync(realRoot, copyRoot, { recursive: true })
  const files = readdirSync(join(copyRoot, 'messages')).length
  console.log(`source: a COPY of ${realRoot} (${files} transcript file(s)) — your data is untouched`)
}

process.env.DSH_HOME = tempHome
const { apply } = await import(`file:///${installed.replace(/\\/g, '/')}`)

// ---------------------------------------------------------------------------
// A minimal Cordis context. No webServer and no sessionController: the point is
// to exercise the parts that must work on the thinnest possible deployment.
// ---------------------------------------------------------------------------
const tools = new Map()
const routes = []
const agents = new Map()
apply({
  tools: {
    register(definition) {
      tools.set(definition.name, definition)
      return () => tools.delete(definition.name)
    },
    get: (name) => tools.get(name),
  },
  agents: {
    get: (id) => agents.get(String(id)),
    list: () => [...agents.values()],
    resume: async () => {
      throw new Error('this smoke test never resumes a session')
    },
  },
  get: () => undefined,
  inject(names, cb) {
    if (names.includes('webServer')) {
      cb({
        webServer: {
          register(route) {
            routes.push(route)
            return () => {}
          },
        },
      })
    }
  },
})

// ---------------------------------------------------------------------------
// Tiny check harness
// ---------------------------------------------------------------------------
let failed = 0
let passed = 0
const fail = (message) => {
  failed += 1
  console.log(`  FAIL  ${message}`)
}
const check = (condition, message) => {
  if (condition) {
    passed += 1
    console.log(`  ok    ${message}`)
  } else {
    fail(message)
  }
}
const section = (title) => console.log(`\n== ${title}`)

/** Run a tool and assert the whole output/render contract on the way through. */
async function call(name, args = {}, exec = {}) {
  const tool = tools.get(name)
  if (tool === undefined) throw new Error(`tool ${name} is not registered`)
  const value = await tool.execute(args, exec)
  if (tool.output?.render !== undefined) {
    const rendered = tool.output.render(args, value)
    if (!Array.isArray(rendered)) throw new Error(`${name}: render did not return an array`)
    for (const block of rendered) {
      if (block === null || typeof block !== 'object' || block.type !== 'text' || typeof block.text !== 'string') {
        throw new Error(`${name}: render returned a block that is not {type:'text',text}`)
      }
    }
    if (JSON.stringify(rendered).includes('undefined')) throw new Error(`${name}: render leaked the word undefined`)
  }
  if (value !== undefined) JSON.parse(JSON.stringify(value)) // must be lossless JSON
  return value
}

const receipt = (value, label) => {
  const rendered = tools.get(label).output.render({}, value)
  return rendered.map((block) => block.text).join('\n')
}

// ---------------------------------------------------------------------------
section('registry and diagnosis')
// ---------------------------------------------------------------------------
check(tools.size === 14, `14 tools registered (got ${tools.size})`)
check(routes.length === 1 && routes[0].path === '/attention-group', 'the panel route registered itself')

const probe = await call('attention_probe', {})
check(probe.groups >= 0, `attention_probe ran (${probe.groups} group(s), data root ${probe.dataRoot})`)
check(typeof probe.liveEffortControl === 'string', `probe explains live effort: "${probe.liveEffortControl}"`)
check(receipt(probe, 'attention_probe').includes('live effort control:'), 'and renders that line')

const existing = await call('attention_group_list', {})
check(Array.isArray(existing.groups), `group list read ${existing.groups.length} existing group(s) from your ledger`)

// ---------------------------------------------------------------------------
section('a room, and its knobs')
// ---------------------------------------------------------------------------
const peer = 'session-aaaa1111-2222-3333-4444-555566667777'

// The room is created BY the peer session, so the peer is a member from the
// start. That matters: `joinPolicy` defaults to `members`, which means an agent
// that is not in the room cannot add anyone — a refusal the next step relies on.
const created = await call('attention_group_create', { title: '冒烟测试群', charter: '冒烟群规：只做验收' }, { agent: { id: peer } })
check(created.ok === true, `created ${created.groupId}`)
const room = created.groupId

const joined = await call('attention_group_join', { groupId: room, memberId: peer, memberName: '验收员', subscribe: ['发布'] }, { agent: { id: peer } })
check(joined.ok === true, 'renamed the creator to 验收员')

// And this is the permission control doing its job, not a bug: an agent that is
// not in the room is refused, and the refusal names the policy.
const outsider = await call('attention_group_join', { groupId: room, memberId: 'session-dddd1111-2222-3333-4444-555566667777' }, { agent: { id: 'session-outsider-0000' } })
check(outsider.ok === false && /joinPolicy=members/.test(outsider.error), `a non-member cannot invite: "${String(outsider.error).slice(0, 70)}…"`)

const named = await call('attention_group_join', { groupId: room, memberId: 'room-admin', memberName: '群管理', kind: 'admin' }, { agent: { id: peer } })
check(named.ok === true, 'joined a name-only 群管理 (a name, not a process)')

// ---------------------------------------------------------------------------
section('routing: the point of the whole plugin')
// ---------------------------------------------------------------------------
const silent = await call('attention_send', { groupId: room, text: '今天天气不错' })
check(silent.silent === true && silent.recipients.length === 0, 'an irrelevant message routes to NOBODY (zero turns)')

const dry = await call('attention_send', { groupId: room, text: '@验收员 看一下' })
check(dry.recipients.length === 1 && dry.recipients[0].reason === 'mention', 'a mention routes to exactly one member')
check(dry.woken === false, 'and a dry run wakes nobody')

const banned = await call('attention_send', { groupId: room, text: '@群管理 在吗' })
const adminRow = banned.recipients.find((row) => row.reason === 'mention')
check(adminRow?.delivered === false, 'an @mention of a name-only member is recorded, never resumed')

// ---------------------------------------------------------------------------
section('R7 conclusions, R9 digest, and export')
// ---------------------------------------------------------------------------
const conclusion = await call('attention_conclude', { groupId: room, text: '冒烟结论：全链路可用' })
check(conclusion.ok === true && existsSync(conclusion.path), `conclusion sunk to ${conclusion.path}`)
check(readFileSync(conclusion.path, 'utf8').includes('冒烟结论'), 'and the bytes are really there')

const digest = await call('attention_digest', { groupId: room, range: 'today' })
check(digest.total >= 3, `digest covered ${digest.total} message(s) with no model and no wake-up`)
check(digest.text.includes('发言人：'), 'and reports who spoke')

const exported = await call('attention_export', { groupId: room })
check(exported.messages === exported.total, `exported all ${exported.messages} message(s)`)
const twice = await call('attention_export', { groupId: room, path: exported.path })
check(twice.path !== exported.path, 'a second export to the same path did NOT overwrite the first')
check(readFileSync(exported.path, 'utf8').length > 0, 'and the first export is still intact')

// ---------------------------------------------------------------------------
section('R10 liaisons, directed and loop-proof')
// ---------------------------------------------------------------------------
const second = await call('attention_group_create', { title: '冒烟测试群B' })
const linked = await call('attention_link', { groupId: room, to: second.groupId, mode: 'conclusion' })
check(linked.ok === true && linked.links.length === 1, `linked ${room} → ${second.groupId} carrying conclusions only`)

const relayed = await call('attention_conclude', { groupId: room, text: '这条结论应该被转发' })
check(relayed.relayed.some((row) => row.relayed === true), 'a conclusion was relayed onward')

const back = await call('attention_link', { groupId: second.groupId, to: room, mode: 'all' })
check(back.ok === true, 'built the return link that would create a loop')
const echo = await call('attention_send', { groupId: second.groupId, text: '回声测试' })
const refused = echo.relayed.find((row) => row.relayed === false)
check(refused !== undefined && /loop refused/.test(refused.reason), `the loop was refused: ${refused?.reason ?? 'NO REFUSAL'}`)

// ---------------------------------------------------------------------------
section('R9 asking the room manager to summarise')
// ---------------------------------------------------------------------------
const asked = await call('attention_summarize', { groupId: room, range: 'today' })
check(asked.ok === true && asked.summarizerName === '群管理', 'picked the room\'s own admin')
check(asked.delivered === false, 'and woke nobody, because waking is two switches')
check(typeof asked.request === 'string' && asked.request.includes('摘录开始'), 'and the digest travelled inside the request')

// The write-back half of the manual summary button: the runtime cannot read the
// answer a woken member writes, so the manager hands it back through this tool.
const recorded = await call('attention_record_summary', { groupId: room, text: '冒烟：这段历史已被摘要。' })
check(recorded.ok === true && recorded.summaries === 1, `attention_record_summary stored a snapshot (covers ${recorded.covered} message(s), up to #${recorded.upToSeq})`)
const refusedSummary = await call('attention_record_summary', { groupId: room, text: '' })
check(refusedSummary.ok === false && /text is required/.test(refusedSummary.error), 'and an empty summary is refused by naming the field')

// ---------------------------------------------------------------------------
section('U3 effort: recorded, never applied behind your back')
// ---------------------------------------------------------------------------
const effort = await call('attention_effort', { groupId: room, effort: 'high' })
check(effort.ok === true && effort.liveRequested === false, 'the room knob was recorded')
const liveAttempt = await call('attention_effort', { groupId: room, effort: 'low', live: true })
check(liveAttempt.liveApplied === false && typeof liveAttempt.reason === 'string', `live apply refused with a reason: "${String(liveAttempt.reason).slice(0, 60)}…"`)

// ---------------------------------------------------------------------------
section('history, and the same read path a session would use')
// ---------------------------------------------------------------------------
const history = await call('attention_history', { groupId: room, limit: 5 }, { agent: { id: peer } })
check(Array.isArray(history.messages) && history.messages.length > 0, `read back ${history.messages.length} message(s)`)
check(existsSync(join(copyRoot, 'messages', `${room}.jsonl`)), 'the transcript is a JSONL file on disk')

const probed = await call('attention_probe_session', { sessionId: peer })
check(typeof probed.live === 'boolean' && typeof probed.wouldDo === 'string', `a session probe answers without waking anything (live=${probed.live}, wouldDo="${String(probed.wouldDo).slice(0, 40)}…")`)
check(probed.resumeAttempted === false, 'and it did not resume anything')

// ---------------------------------------------------------------------------
section('the wake-up audit is the third witness')
// ---------------------------------------------------------------------------
const auditFile = join(copyRoot, 'messages', 'deliveries.jsonl')
const auditLines = existsSync(auditFile)
  ? readFileSync(auditFile, 'utf8').trim().split('\n').filter((line) => line.length > 0)
  : []
console.log(`  note  ${auditLines.length} delivery record(s) — every attempt, delivered or not`)

// ---------------------------------------------------------------------------
section('the panel\'s 「拉人」 picker')
// ---------------------------------------------------------------------------
/** Drive the panel route exactly the way the browser does, and parse the answer. */
async function panelGet(url) {
  return new Promise((resolve, reject) => {
    const req = Readable.from([Buffer.from('')])
    req.method = 'GET'
    req.url = url
    let text = ''
    const res = {
      writeHead() {},
      end(chunk) {
        if (chunk !== undefined) text += String(chunk)
        try {
          resolve(JSON.parse(text))
        } catch (error) {
          reject(error)
        }
      },
    }
    Promise.resolve(routes[0].handler(req, res)).catch(reject)
  })
}
// This smoke context is the thinnest possible deployment: no `sessionQuery`. That
// is exactly the case that must DEGRADE HONESTLY — the picker may not answer
// 「没有会话」 for a deployment that simply cannot list sessions (c7).
const picker = await panelGet('/attention-group?candidates=1')
check(picker.ok === false && /sessionQuery/.test(String(picker.error)), 'without sessionQuery the picker refuses, naming the missing service')
const plainPanel = await panelGet('/attention-group')
check(plainPanel.ok === true && Array.isArray(plainPanel.groups), 'and the ordinary panel read still returns the room list')

// ---------------------------------------------------------------------------
section('the ledger survived')
// ---------------------------------------------------------------------------
mkdirSync(join(copyRoot, 'messages'), { recursive: true })
const groupCount = JSON.parse(readFileSync(join(copyRoot, 'groups.json'), 'utf8')).groups.length
check(groupCount >= 3, `the copy now holds ${groupCount} rooms, written atomically`)

// ---------------------------------------------------------------------------
const after = hashTree(realRoot)
console.log('')
if (before === after) {
  console.log(`YOUR DATA IS UNTOUCHED (${realRoot} hash ${before.slice(0, 12)}…)`)
  passed += 1
} else {
  fail(`YOUR DATA CHANGED: ${before.slice(0, 12)}… -> ${after.slice(0, 12)}…`)
}

if (args.has('--keep')) console.log(`temp copy kept at ${tempHome}`)
else rmSync(tempHome, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
