/**
 * Boot the REAL host half against a throwaway data root, and drive its route.
 *
 * This exists so both panel test files exercise the same artifact:
 *   - `panel-host.test.js` drives the route directly and reads the ledger off
 *     disk;
 *   - `panel-client.test.js` feeds the route's OWN responses to the browser half,
 *     so the panel is rendered from real host output rather than from a fixture
 *     somebody wrote by hand.
 *
 * That second use is the point. A hand-written fixture cannot catch the host and
 * the panel disagreeing about where the transcript lives — and on 2026-10-16 they
 * did disagree (`messages` at the top level vs inside `group`), which in a browser
 * is simply "this room is empty".
 *
 * @module test/support/host-harness
 */

import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { entry as pluginEntry, describeSource, usingInstalled } from './entry.mjs'

export { profileRoot } from './entry.mjs'

/** The module under test. Kept as a named export because suites refer to it. */
export const installedEntry = pluginEntry

/**
 * Load the plugin and return a handle that can boot it repeatedly.
 *
 * @param {object} [options]
 *   - `extraTools`: tool names to pretend the deployment already has, so a soft
 *     integration can be tested in both of its states rather than only the one
 *     this machine happens to be in.
 *   - `liveSessions`: session ids that should look LIVE, so a delivery can be
 *     observed end-to-end. Everything they receive is captured in
 *     `handle.delivered` — the only way to assert WHAT a woken member is told,
 *     which is the whole point of several features.
 *   - `withSessionController`: mount a recording `sessionController`, the service
 *     `@deepseek-ai/dsh-web-app` provides and a headless deployment does not.
 *     Every `selectModel` call lands in `handle.effortCalls`. Left out by
 *     default, so the "no such service" path is the one most tests exercise.
 * @returns {Promise<object>} host handle.
 */
export async function createHost(options = {}) {
  const extraTools = Array.isArray(options.extraTools) ? options.extraTools : []
  const liveIds = new Set(Array.isArray(options.liveSessions) ? options.liveSessions.map(String) : [])
  const withSessionController = options.withSessionController === true
  const sessionRoutes = options.sessionRoutes ?? {}
  const effortCalls = []
  const delivered = []
  if (!existsSync(pluginEntry)) {
    throw new Error(`the plugin entry is missing: ${pluginEntry}`)
  }
  const { apply } = await import(`file:///${pluginEntry.replace(/\\/g, '/')}`)

  const homes = []
  let home = ''
  let route = null
  let tools = new Map()
  // The deployment's real route registry, including its duplicate guard: the
  // host's `webServer.register` THROWS on a second registration of the same
  // exact path (`webserver: duplicate exact route`). Modelling the throw is what
  // turns "a re-activated child fiber must not lose the panel" into a test.
  let registrations = []
  // Every `ctx.inject` callback, kept so a test can re-activate the child fiber
  // the way Cordis does when a dependency is re-composed.
  let injects = []
  // Every runtime prompt context the plugin published. A test drives it exactly
  // the way the harness does: `definition.text({ agent: { session: { id } } })`.
  let promptContexts = []

  // The deployment's real `webServer` face, hoisted out of `reboot()` so that
  // `reactivate()` can hand the SAME service object back to the child fiber.
  const webServer = {
    register(definition) {
      const clash = registrations.some(
        (row) => row.kind === definition.kind && row.path === definition.path,
      )
      if (clash) throw new Error(`webserver: duplicate ${definition.kind} route "${definition.path}"`)
      registrations.push(definition)
      route = definition
      return () => {
        const index = registrations.indexOf(definition)
        if (index >= 0) registrations.splice(index, 1)
        if (route === definition) route = null
      }
    },
  }

  /** A fresh data root plus a freshly applied plugin, as a restart would give. */
  function boot() {
    home = mkdtempSync(join(tmpdir(), 'attention-host-'))
    homes.push(home)
    return reboot()
  }

  /** Re-apply the plugin against the SAME data root: an upgrade or a restart. */
  function reboot() {
    process.env.DSH_HOME = home
    route = null
    // A reboot disposes the previous plugin instance, and Cordis runs its
    // disposers: the old route is gone before the new apply runs.
    registrations = []
    injects = []
    promptContexts = []
    tools = new Map()
    for (const name of extraTools) {
      tools.set(name, {
        name,
        description: 'stand-in for a tool this deployment is supposed to have',
        parameters: {},
        output: { schema: {} },
        execute: async () => ({ ok: true }),
      })
    }
    const ctx = {
      tools: {
        register(definition) {
          tools.set(definition.name, definition)
          return () => tools.delete(definition.name)
        },
        // The real registry has this, and the soft memory integration asks it
        // whether a tool exists before promising anything.
        get(name) {
          return tools.get(name)
        },
      },
      agents: {
        get(id) {
          if (!liveIds.has(String(id))) return undefined
          return {
            id: String(id),
            status: 'idle',
            followup(message) {
              delivered.push({ sessionId: String(id), message })
            },
          }
        },
        // A panel action that tries to wake anybody is a bug, so make it loud.
        // Tests that DO expect a delivery declare the target live instead.
        resume: () => {
          throw new Error('a panel action tried to resume a session')
        },
      },
      get(name) {
        // `sessionQuery.readSession` is how the plugin learns a session's own
        // provider/model — both when cold-resuming it and when changing its effort
        // in place. Supplying it here is what lets those two paths be tested
        // without a real session log on disk.
        if (name === 'sessionQuery' && Object.keys(sessionRoutes).length > 0) {
          return {
            async readSession(sessionId) {
              const route = sessionRoutes[String(sessionId)]
              if (route === undefined) return { events: [] }
              return { events: [{ type: 'request/header', data: { header: { config: route } } }] }
            },
          }
        }
        return undefined
      },
      inject(names, cb) {
        if (names.includes('webServer')) {
          injects.push(cb)
          cb({ webServer })
        }
        if (names.includes('systemPrompt')) {
          // The real child scope has `effect`; a stub that runs the callback and
          // returns its disposer is enough to prove registration and release.
          cb({
            systemPrompt: {
              context(definition) {
                promptContexts.push(definition)
                return () => {
                  const index = promptContexts.indexOf(definition)
                  if (index >= 0) promptContexts.splice(index, 1)
                }
              },
            },
            effect(callback) {
              return callback()
            },
          })
        }
        // A deployment without `sessionController` never calls back at all — which
        // is what a headless tree looks like, and the state most tests should be
        // in.
        if (names.includes('sessionController') && withSessionController) {
          cb({
            sessionController: {
              async selectModel(request) {
                effortCalls.push(request)
                return {}
              },
            },
          })
        }
      },
    }
    apply(ctx)
  }

  /**
   * Re-run each `ctx.inject` callback, as Cordis does when a dependency is
   * re-composed or the web entry reloads. The plugin must treat that as
   * idempotent — measured on 0.2.1-rc.1: the second activation threw
   * `duplicate exact route`, the panel survived on the FIRST registration, and
   * only the diagnostic knew, so it reported a healthy panel as failed.
   */
  function reactivate() {
    for (const cb of injects) cb({ webServer })
  }

  /** Drive the real handler with a request, and parse what it wrote back. */
  async function call(options = {}) {
    if (route === null) throw new Error('the panel route was never registered')
    const { method = 'GET', url = '/attention-group', body } = options
    const req = Readable.from([Buffer.from(body === undefined ? '' : JSON.stringify(body))])
    req.method = method
    req.url = url
    const out = { status: 0, headers: null, text: '' }
    const res = {
      writeHead(status, headers) {
        out.status = status
        out.headers = headers
      },
      end(chunk) {
        if (chunk !== undefined) out.text += String(chunk)
      },
    }
    await route.handler(req, res)
    return { status: out.status, headers: out.headers, json: out.text.length === 0 ? undefined : JSON.parse(out.text) }
  }

  const get = (query) => call({ method: 'GET', url: `/attention-group${query ?? ''}` })
  const post = (body) => call({ method: 'POST', body })

  /** The ledger as it exists on disk — the durability witness, not the response. */
  function ledgerOnDisk() {
    return JSON.parse(readFileSync(join(home, 'attention-group', 'groups.json'), 'utf8'))
  }

  /** The transcript file for one room, or '' when it was never written. */
  function messagesOnDisk(groupId) {
    const file = join(home, 'attention-group', 'messages', `${groupId}.jsonl`)
    return existsSync(file) ? readFileSync(file, 'utf8') : ''
  }

  /** Create a room through the panel and return its id. */
  async function newRoom(title) {
    const response = await post({ action: 'create', title })
    if (response.status !== 200) throw new Error(`create failed: ${response.text}`)
    return response.json.groupId
  }

  return {
    boot,
    reboot,
    reactivate,
    call,
    get,
    post,
    newRoom,
    ledgerOnDisk,
    messagesOnDisk,
    writeFileSync,
    /** Everything delivered to a declared-live session, oldest first. */
    delivered,
    /** Every `sessionController.selectModel` call, oldest first. */
    effortCalls,
    get home() {
      if (home.length === 0) {
        // Without this, `join(host.home, 'x')` silently yields a RELATIVE path and
        // a test writes into the repository instead of a temp folder. Measured:
        // exactly that happened on 2026-10-16, and it also made a later run see a
        // stale file and fail for the wrong reason. Loud beats silent.
        throw new Error('host.home is empty: call host.boot() before using the data root')
      }
      return home
    },
    get route() {
      return route
    },
    /** How many route registrations are live right now (must never exceed 1). */
    get routeCount() {
      return registrations.length
    },
    /** Runtime prompt contexts the plugin published, in registration order. */
    get promptContexts() {
      return promptContexts
    },
    tool(name) {
      return tools.get(name)
    },
    cleanup() {
      for (const dir of homes) rmSync(dir, { recursive: true, force: true })
    },
  }
}
