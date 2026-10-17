/**
 * A minimal React + slots + fetch stand-in, so the BROWSER half can be tested.
 *
 * Why this exists (2026-10-16): the panel is the one part of this plugin no test
 * could reach. It only ever ran in a real browser, so every panel change needed
 * a human to look at it — and a genuinely broken panel (the route 404'd, and the
 * failure rendered as "还没有群") survived two debugging rounds precisely because
 * nothing could assert on it. The fix is not "look harder"; it is to make the
 * panel reachable from `node --test`.
 *
 * WHAT THIS IS HONEST ABOUT: it expands function components, runs hooks in
 * order, and collects effects. It does NOT implement reconciliation, keys,
 * context, portals, layout or CSS. So it can prove STRUCTURE and BEHAVIOUR —
 * which controls exist, what a click sends to the host — and it can prove
 * NOTHING about pixels. That is the intended trade: it replaces "ask the user to
 * look" with "run the test", and the user's look becomes a final confirmation
 * instead of the only feedback loop.
 *
 * Two documented deviations from React:
 *   - effects with no dependency list run ONCE per mount here; React re-runs
 *     them on every render. Nothing in this panel depends on that difference.
 *   - state updates do not schedule a re-render by themselves. Call `settle()`,
 *     which re-renders until no further effect wants to run.
 *
 * @module test/support/panel-harness
 */

/**
 * Build the React stand-in.
 *
 * @returns {object} `{ api, render, runEffects }`.
 */
function makeReact() {
  const state = new Map()
  const refs = new Map()
  const seenEffects = new Set()
  const deps = new Map()
  let pending = []
  let scopes = []
  let occurrence = new Map()

  function currentScope() {
    return scopes[scopes.length - 1]
  }

  function currentPath() {
    const scope = currentScope()
    return scope === undefined ? '' : scope.path
  }

  function createElement(type, props, ...children) {
    const merged = children.length > 0 ? children : props?.children === undefined ? [] : [].concat(props.children)
    return { type, key: props?.key, props: { ...props, children: merged.flat() } }
  }

  function useState(initial) {
    const scope = currentScope()
    const slot = `${scope.path}#${scope.cursor++}`
    if (!state.has(slot)) state.set(slot, typeof initial === 'function' ? initial() : initial)
    return [
      state.get(slot),
      (next) => {
        state.set(slot, typeof next === 'function' ? next(state.get(slot)) : next)
      },
    ]
  }

  function useRef(initial) {
    const scope = currentScope()
    const slot = `ref:${scope.path}#${scope.cursor++}`
    if (!refs.has(slot)) refs.set(slot, { current: initial })
    return refs.get(slot)
  }

  function useEffect(fn, list) {
    const scope = currentScope()
    const slot = `fx:${scope.path}#${scope.cursor++}`
    const previous = deps.get(slot)
    const changed =
      !seenEffects.has(slot) ||
      (list !== undefined &&
        (previous === undefined ||
          list.length !== previous.length ||
          list.some((value, index) => !Object.is(value, previous[index]))))
    if (changed) {
      seenEffects.add(slot)
      if (list !== undefined) deps.set(slot, [...list])
      pending.push(fn)
    }
  }

  function expand(node) {
    if (node === null || node === undefined || node === true || node === false) return null
    if (Array.isArray(node)) return node.map(expand).filter((child) => child !== null)
    if (typeof node === 'string' || typeof node === 'number') {
      return { type: '#text', text: String(node), props: {}, children: [] }
    }
    const props = node.props ?? {}
    if (typeof node.type === 'function') {
      const label = node.type.name || 'Component'
      const index = occurrence.get(label) ?? 0
      occurrence.set(label, index + 1)
      const path = `${currentPath()}/${label}[${index}]`
      scopes.push({ path, cursor: 0 })
      let out
      try {
        out = node.type(props)
      } finally {
        scopes.pop()
      }
      return expand(out)
    }
    return {
      type: node.type,
      key: node.key,
      props,
      children: (props.children ?? []).map(expand).filter((child) => child !== null),
    }
  }

  return {
    api: { createElement, useState, useEffect, useRef },
    /** Render an element tree, expanding every function component. */
    render(element) {
      occurrence = new Map()
      return expand(element)
    },
    /** Run the effects queued by the last render. Returns how many ran. */
    runEffects() {
      const batch = pending
      pending = []
      for (const fn of batch) fn()
      return batch.length
    },
  }
}

/** Depth-first visit of every node, including the root. */
export function walk(node, visit) {
  if (node === null || node === undefined) return
  visit(node)
  for (const child of node.children ?? []) walk(child, visit)
}

/** Every node matching `predicate`, in document order. */
export function findAll(node, predicate) {
  const out = []
  walk(node, (candidate) => {
    if (predicate(candidate)) out.push(candidate)
  })
  return out
}

/** All text under a node, concatenated. */
export function textOf(node) {
  let out = ''
  walk(node, (candidate) => {
    if (candidate.type === '#text') out += candidate.text
  })
  return out
}

/** The first `button` whose text contains `label`. */
export function findButton(node, label) {
  return findAll(node, (candidate) => candidate.type === 'button' && textOf(candidate).includes(label))[0]
}

/**
 * Mount the browser half in this process.
 *
 * @param {object} options - `{source, fetchImpl}`.
 * @returns {Promise<object>} the mounted panel and its test helpers.
 */
export async function mountPanel({ source, fetchImpl }) {
  const react = makeReact()
  const requests = []
  const styleBlocks = []
  const registrations = []
  let captured = null

  const windowStub = {
    __ModuleLoader__: {
      load(mod) {
        captured = mod
      },
    },
  }

  const fetchStub = (url, init) => {
    const record = {
      url: String(url),
      method: init?.method ?? 'GET',
      body: undefined,
    }
    if (init?.body !== undefined) {
      try {
        record.body = JSON.parse(init.body)
      } catch {
        record.body = String(init.body)
      }
    }
    requests.push(record)
    return fetchImpl(record)
  }

  // The bundle is an expression statement calling the loader; running it with
  // these parameters in scope is exactly what the browser does, minus the DOM.
  const runner = new Function('window', 'fetch', 'setInterval', 'clearInterval', 'console', source)
  runner(windowStub, fetchStub, () => 0, () => {}, console)
  if (captured === null) throw new Error('the bundle never called window.__ModuleLoader__.load')

  const mod = captured.factory((specifier) => {
    if (specifier === 'react') return react.api
    throw new Error(`the bundle required an unexpected module: ${specifier}`)
  })

  const ctx = {
    slots: {
      inject(slotName, register) {
        const value = register()
        registrations.push({ slotName, value })
        return value
      },
      register(meta, Component) {
        return { meta, Component }
      },
    },
    styles: {
      insert(css) {
        styleBlocks.push(css)
      },
    },
    host: {
      async call() {
        throw new Error('the panel must use its own host route, not host.call')
      },
    },
  }

  if (Array.isArray(mod.inject) && mod.inject.length > 0) mod.apply(ctx)

  let tree = null
  let rootElement = null

  const panel = {
    id: captured.id,
    mod,
    registrations,
    styleBlocks,
    requests,
    /** The same `createElement` the bundle received, for building test trees. */
    h: react.api.createElement,
    get tree() {
      return tree
    },
    /** The registered component for a slot registration. */
    componentFor(slotName) {
      const found = registrations.find((row) => row.slotName === slotName)
      return found === undefined ? undefined : found.value.Component
    },
    metaFor(slotName) {
      const found = registrations.find((row) => row.slotName === slotName)
      return found === undefined ? undefined : found.value.meta
    },
    render(element) {
      if (element !== undefined) rootElement = element
      tree = react.render(rootElement)
      return tree
    },
    /**
     * Let queued effects run and re-render until nothing new wants to run.
     *
     * Two quiet passes are required, not one: a render can QUEUE an effect
     * (that is what `useEffect(..., [chosen])` does the moment a room is
     * opened), so stopping at the first empty batch would return a tree that
     * predates the load the click just asked for.
     */
    async settle(passes = 10) {
      let quiet = 0
      for (let index = 0; index < passes && quiet < 2; index += 1) {
        const ran = react.runEffects()
        await new Promise((resolve) => setTimeout(resolve, 0))
        panel.render()
        quiet = ran === 0 ? quiet + 1 : 0
      }
      return tree
    },
    /**
     * Interact, then re-render immediately — which is what React does when a
     * handler calls a state setter. Without this the NEXT handler looked up in
     * the tree would still be the closure from before the change.
     */
    click(node) {
      click(node)
      panel.render()
    },
    change(node, value) {
      change(node, value)
      panel.render()
    },
    press(node, key) {
      press(node, key)
      panel.render()
    },
    /**
     * Focus a node, then re-render.
     *
     * Some controls do their whole job on focus rather than on click — the
     * 「拉人」 session picker is one: focusing its box is what asks the host for
     * the list. Without this a test could not reach that request at all.
     */
    focus(node) {
      focus(node)
      panel.render()
    },
    /** The write payloads this panel sent, in order. */
    posts() {
      return requests.filter((row) => row.method === 'POST').map((row) => row.body)
    },
    lastPost() {
      const all = panel.posts()
      return all[all.length - 1]
    },
    clearRequests() {
      requests.length = 0
    },
  }

  return panel
}

/** Fire a click on a node, with the shape of a real React synthetic event. */
export function click(node) {
  if (node === undefined) throw new Error('click() got no node')
  if (typeof node.props.onClick !== 'function') throw new Error(`${node.type} has no onClick`)
  node.props.onClick({ preventDefault() {}, stopPropagation() {}, target: {} })
}

/** Type into a node, with the shape of a real React change event. */
export function change(node, value) {
  if (node === undefined) throw new Error('change() got no node')
  if (typeof node.props.onChange !== 'function') throw new Error(`${node.type} has no onChange`)
  node.props.onChange({ target: { value }, preventDefault() {}, stopPropagation() {} })
}

/** Press a key on a node. */
export function press(node, key) {
  if (node === undefined) throw new Error('press() got no node')
  if (typeof node.props.onKeyDown !== 'function') throw new Error(`${node.type} has no onKeyDown`)
  node.props.onKeyDown({ key, preventDefault() {}, stopPropagation() {}, target: {} })
}

/** Focus a node, with the shape of a real React synthetic focus event. */
export function focus(node) {
  if (node === undefined) throw new Error('focus() got no node')
  if (typeof node.props.onFocus !== 'function') throw new Error(`${node.type} has no onFocus`)
  node.props.onFocus({ preventDefault() {}, stopPropagation() {}, target: {} })
}
