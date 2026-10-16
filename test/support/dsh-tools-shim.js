/**
 * Local resolution shim for `@deepseek-ai/dsh-tools`, used ONLY by this
 * package's own tests.
 *
 * Why it exists: DSH's in-box packages resolve from
 * `~/.dsh/profiles/node_modules`, and Node resolves imports from a module's real
 * path. This package lives outside the profile during development, so importing
 * `@deepseek-ai/dsh-tools` from here fails with ERR_MODULE_NOT_FOUND — the exact
 * wall `tools/sync-plugin.ps1` documents for the live loader.
 *
 * The shim is a faithful stand-in for the parts this plugin uses, and it is
 * deliberately narrow: a test that passes here proves the plugin's own contract
 * (lossless JSON in, strings out), not that DSH's real `defineTool` accepts it.
 * The live smoke test against the installed copy is what proves that.
 *
 * @module dsh-attention-group/test/support/dsh-tools-shim
 */

import { createRequire } from 'node:module'

/** Load the real implementation when it is resolvable, so tests use the truth. */
function loadReal() {
  for (const base of [
    joinMaybe(process.env.DSH_HOME, 'profiles', 'desktop', 'package.json'),
    joinMaybe(process.env.USERPROFILE, '.dsh', 'profiles', 'desktop', 'package.json'),
  ]) {
    if (base === undefined) continue
    try {
      const require = createRequire(base)
      return require('@deepseek-ai/dsh-tools')
    } catch {
      // try the next anchor
    }
  }
  return undefined
}

function joinMaybe(...parts) {
  if (parts.some((part) => typeof part !== 'string' || part.length === 0)) return undefined
  return parts.join('/')
}

const real = loadReal()

/**
 * Validate and echo a tool definition.
 *
 * Mirrors the documented contract: a definition needs a name, a description, a
 * parameters object, and an execute function. Validation that DSH performs is
 * NOT reproduced here on purpose — a shim that silently accepts more than the
 * real thing would hide bugs instead of finding them.
 *
 * @param {object} definition - the tool definition.
 * @returns {object} the same definition.
 */
export function defineTool(definition) {
  if (real?.defineTool !== undefined) return real.defineTool(definition)
  if (definition === null || typeof definition !== 'object') throw new TypeError('defineTool needs an object')
  if (typeof definition.name !== 'string' || definition.name.length === 0) throw new TypeError('tool needs a name')
  if (typeof definition.description !== 'string' || definition.description.length === 0) {
    throw new TypeError(`tool ${definition.name} needs a description`)
  }
  if (typeof definition.execute !== 'function') throw new TypeError(`tool ${definition.name} needs execute`)
  return definition
}

/** Whether the shim fell back to its own stub instead of the real package. */
export const usingRealPackage = real?.defineTool !== undefined
