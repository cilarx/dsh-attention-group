/**
 * Where the plugin under test actually lives.
 *
 * Tests prefer the **installed profile copy**: that is the artifact DSH loads, and
 * a contract test is worth more against the real thing than against a source tree
 * that merely resembles it.
 *
 * But a fresh clone has no profile, and "the test suite cannot run at all" is a bad
 * first experience for a repository whose whole point is being installable. So
 * there is a fallback to this source tree, and it works because
 * `node_modules/@deepseek-ai/dsh-tools` is a committed development shim — see
 * `.gitignore`, where that one directory is deliberately re-included.
 *
 * `usingInstalled` and `describeSource()` exist so a suite can SAY which copy it
 * got. Silently testing the wrong artifact is the failure mode this file is here
 * to prevent: three separate files used to compute the installed path by hand, and
 * path logic that is duplicated is path logic that drifts.
 *
 * @module dsh-attention-group/test/support/entry
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
/** The repository root (this file lives in `<repo>/test/support`). */
export const repoRoot = dirname(dirname(here))

const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
/** The desktop profile, which is where a developer installs this plugin. */
export const profileRoot = join(home, '.dsh', 'profiles', 'desktop')
const installedSrc = join(profileRoot, 'node_modules', 'dsh-attention-group', 'src')
const sourceSrc = join(repoRoot, 'src')

/** True when the tests are running against the installed copy rather than the tree. */
export const usingInstalled = existsSync(join(installedSrc, 'index.js'))

/** The `src/` directory under test. */
export const srcDir = usingInstalled ? installedSrc : sourceSrc

/** The plugin's host entry point. */
export const entry = join(srcDir, 'index.js')

/** The plugin's browser half. */
export const clientEntry = join(srcDir, 'client.js')

/**
 * A `file://` URL for one module in the copy under test.
 *
 * Use this instead of string-joining a path: the previous hand-rolled version
 * pasted a backslash and then replaced separators, which only worked on Windows.
 *
 * @param {string} name - file name inside `src/`, e.g. `'sink.js'`.
 * @returns {string} an importable URL.
 */
export function moduleUrl(name) {
  return pathToFileURL(join(srcDir, name)).href
}

/** A one-line description of the artifact under test, for failure messages. */
export function describeSource() {
  return usingInstalled
    ? `the installed profile copy (${srcDir})`
    : `this source tree (${srcDir}) — no DSH profile was found, so the dev shim is doing the resolution`
}
