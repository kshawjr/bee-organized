// scripts/ts-alias-hook.mjs
//
// Lets a plain .mjs script import this repo's TypeScript directly.
//
// WHY THIS EXISTS. scripts/backfill-property-drift.mjs has to call the REAL
// planDriftAddress — the same function the Jobber webhook calls — because a
// backfill with its own copy of "is this address already known" would write
// the duplicates the webhook refuses to write. That function lives in
// lib/property-drift.ts, and Node needs two small things to load it:
//
//   1. TYPE STRIPPING — Node runs .ts natively (no build, no tsx, no new
//      dependency). Nothing to do here; it is on by default.
//   2. RESOLUTION — two things Node does not do on its own:
//        · the "@/..." path alias from tsconfig, which points at the repo root
//        · extensionless imports ("./lead-address"), which TypeScript allows
//          and Node's ESM resolver does not
//
// So this is a resolver hook and nothing more. It adds no transform, no cache
// and no behaviour; if it ever needs to do more than find a file, that is a
// sign the script is reaching too far into the app and should stop.
//
// Scoped deliberately: the alias only rewrites specifiers that start with
// "@/", and the extension retry only fires for a resolution that already
// failed. A bare package import is passed through untouched, so nothing here
// can shadow a real dependency.

import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'

const EXTENSIONS = ['.ts', '.tsx', '/index.ts', '/index.tsx', '.js', '.mjs']

/**
 * @param {string} rootDir absolute path the "@/" alias resolves to (repo root)
 */
export function installTsResolver(rootDir) {
  if (typeof registerHooks !== 'function') {
    throw new Error(
      `this script needs Node with module.registerHooks() — you are on ${process.version}. ` +
        'Node 22.15+ or 23.5+ has it.',
    )
  }
  const root = pathToFileURL(rootDir.endsWith('/') ? rootDir : rootDir + '/').href

  registerHooks({
    resolve(specifier, context, nextResolve) {
      const spec = specifier.startsWith('@/') ? root + specifier.slice(2) : specifier
      try {
        return nextResolve(spec, context)
      } catch (err) {
        if (err?.code !== 'ERR_MODULE_NOT_FOUND' && err?.code !== 'ERR_UNSUPPORTED_DIR_IMPORT') throw err
        // Only ever retry something that is already a path — never a bare
        // package specifier, which must keep failing loudly if it is missing.
        const isPath = spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('file:')
        if (!isPath) throw err
        for (const ext of EXTENSIONS) {
          try {
            return nextResolve(spec + ext, context)
          } catch {
            /* try the next extension */
          }
        }
        throw err
      }
    },
  })
}
