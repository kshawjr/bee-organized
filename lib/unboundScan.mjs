// Unbound-identifier sweep.
//
// Parses a JS/JSX file (via vite's bundled parser — no new dependency) and
// resolves every identifier *reference* against the enclosing scope chain.
// Anything that resolves to neither a local binding nor a known global is
// reported. This is the class of bug `next build` cannot catch in .jsx files
// and source-pin tests cannot catch either (the string is present in the
// source; it just doesn't resolve at runtime) — see 1733156 (allOverview).
//
// Resolution is order-insensitive (bindings are collected before references
// are resolved), so hoisting is handled and TDZ is deliberately ignored:
// we detect "will throw ReferenceError when reached", not lint-grade style.

import { parseAst } from 'vite'

const GLOBALS = new Set([
  // ES builtins
  'undefined', 'NaN', 'Infinity', 'globalThis',
  'Object', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt',
  'Math', 'JSON', 'Date', 'RegExp', 'Promise', 'Proxy', 'Reflect', 'Intl',
  'Map', 'Set', 'WeakMap', 'WeakSet', 'WeakRef', 'FinalizationRegistry',
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError',
  'EvalError', 'URIError', 'AggregateError',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI',
  'escape', 'unescape', 'eval', 'structuredClone', 'queueMicrotask',
  'ArrayBuffer', 'SharedArrayBuffer', 'DataView', 'Atomics',
  'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array',
  'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array',
  'BigInt64Array', 'BigUint64Array',
  // timers / async
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback',
  'cancelIdleCallback',
  // browser
  'window', 'document', 'navigator', 'location', 'history', 'screen',
  'fetch', 'Headers', 'Request', 'Response', 'AbortController', 'AbortSignal',
  'URL', 'URLSearchParams', 'FormData', 'Blob', 'File', 'FileReader',
  'localStorage', 'sessionStorage', 'crypto', 'performance',
  'alert', 'confirm', 'prompt', 'getComputedStyle', 'matchMedia',
  'scrollTo', 'scrollBy', 'open', 'close', 'focus', 'blur',
  'atob', 'btoa', 'Event', 'CustomEvent', 'EventTarget',
  'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'TouchEvent', 'ClipboardEvent',
  'IntersectionObserver', 'ResizeObserver', 'MutationObserver',
  'Node', 'Element', 'HTMLElement', 'HTMLInputElement', 'SVGElement',
  'DocumentFragment', 'DOMParser', 'XMLSerializer', 'DOMRect',
  'Image', 'Audio', 'MediaQueryList', 'WebSocket', 'XMLHttpRequest',
  'Notification', 'MessageChannel', 'MessagePort', 'BroadcastChannel',
  'ClipboardItem', 'TextEncoder', 'TextDecoder', 'CSS', 'CustomElementRegistry',
  'customElements', 'ResizeObserverEntry', 'getSelection',
  // node / next server side
  'process', 'global', 'Buffer', 'console', '__dirname', '__filename',
  'require', 'module', 'exports',
])

function makeScope(parent, isFunctionScope) {
  return { parent, isFunctionScope, bindings: new Set() }
}

function functionScopeOf(scope) {
  let s = scope
  while (s && !s.isFunctionScope) s = s.parent
  return s || scope
}

/**
 * Scan source text for unbound identifier references.
 * @param {string} code   file contents
 * @param {string} file   file path (for report rows)
 * @returns {Array<{file: string, name: string, line: number, column: number}>}
 */
export function scanSource(code, file) {
  const ast = parseAst(code, { lang: file.endsWith('.jsx') || file.endsWith('.tsx') ? 'jsx' : 'js' })

  const moduleScope = makeScope(null, true)
  const references = [] // { name, scope, start }

  // Line lookup for reports.
  const lineStarts = [0]
  for (let i = 0; i < code.length; i++) if (code[i] === '\n') lineStarts.push(i + 1)
  function loc(start) {
    let lo = 0, hi = lineStarts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (lineStarts[mid] <= start) lo = mid
      else hi = mid - 1
    }
    return { line: lo + 1, column: start - lineStarts[lo] + 1 }
  }

  function bind(scope, name) {
    scope.bindings.add(name)
  }

  // Bind every identifier in a declaration pattern; walk any embedded
  // expressions (defaults, computed keys) as references in `scope`.
  function bindPattern(node, scope, kind) {
    if (!node) return
    switch (node.type) {
      case 'Identifier':
        bind(kind === 'var' ? functionScopeOf(scope) : scope, node.name)
        return
      case 'ObjectPattern':
        for (const p of node.properties) {
          if (p.type === 'RestElement') bindPattern(p.argument, scope, kind)
          else {
            if (p.computed) walk(p.key, scope)
            bindPattern(p.value, scope, kind)
          }
        }
        return
      case 'ArrayPattern':
        for (const el of node.elements) if (el) bindPattern(el, scope, kind)
        return
      case 'AssignmentPattern':
        bindPattern(node.left, scope, kind)
        walk(node.right, scope)
        return
      case 'RestElement':
        bindPattern(node.argument, scope, kind)
        return
      default:
        // e.g. MemberExpression in for-in left without declaration
        walk(node, scope)
    }
  }

  function walkFunction(node, scope) {
    const fnScope = makeScope(scope, true)
    if (node.type !== 'ArrowFunctionExpression') {
      bind(fnScope, 'arguments')
      if (node.id && node.type === 'FunctionExpression') bind(fnScope, node.id.name)
    }
    for (const param of node.params) bindPattern(param, fnScope, 'param')
    walk(node.body, fnScope)
  }

  function jsxRootIdentifier(nameNode) {
    let n = nameNode
    while (n && n.type === 'JSXMemberExpression') n = n.object
    return n && n.type === 'JSXIdentifier' ? n : null
  }

  function walkEach(list, scope) {
    for (const n of list) if (n) walk(n, scope)
  }

  function walk(node, scope) {
    if (!node || typeof node.type !== 'string') return
    switch (node.type) {
      case 'Program': {
        walkEach(node.body, scope)
        return
      }
      case 'ImportDeclaration': {
        for (const s of node.specifiers) bind(moduleScope, s.local.name)
        return
      }
      case 'ExportNamedDeclaration': {
        if (node.declaration) walk(node.declaration, scope)
        if (!node.source) {
          for (const s of node.specifiers) {
            if (s.local?.type === 'Identifier') references.push({ name: s.local.name, scope, start: s.local.start })
          }
        }
        return
      }
      case 'ExportDefaultDeclaration':
        walk(node.declaration, scope)
        return
      case 'ExportAllDeclaration':
        return
      case 'VariableDeclaration': {
        for (const d of node.declarations) {
          bindPattern(d.id, scope, node.kind)
          if (d.init) walk(d.init, scope)
        }
        return
      }
      case 'FunctionDeclaration': {
        if (node.id) bind(scope, node.id.name)
        walkFunction(node, scope)
        return
      }
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        walkFunction(node, scope)
        return
      case 'ClassDeclaration':
      case 'ClassExpression': {
        const clsScope = makeScope(scope, false)
        if (node.id) {
          bind(node.type === 'ClassDeclaration' ? scope : clsScope, node.id.name)
        }
        if (node.superClass) walk(node.superClass, clsScope)
        walk(node.body, clsScope)
        return
      }
      case 'ClassBody':
        walkEach(node.body, scope)
        return
      case 'MethodDefinition':
      case 'PropertyDefinition': {
        if (node.computed) walk(node.key, scope)
        if (node.value) walk(node.value, scope)
        return
      }
      case 'StaticBlock': {
        const s = makeScope(scope, true)
        walkEach(node.body, s)
        return
      }
      case 'BlockStatement': {
        const s = makeScope(scope, false)
        walkEach(node.body, s)
        return
      }
      case 'ForStatement': {
        const s = makeScope(scope, false)
        if (node.init) walk(node.init, s)
        if (node.test) walk(node.test, s)
        if (node.update) walk(node.update, s)
        walk(node.body, s)
        return
      }
      case 'ForInStatement':
      case 'ForOfStatement': {
        const s = makeScope(scope, false)
        walk(node.left, s)
        walk(node.right, s)
        walk(node.body, s)
        return
      }
      case 'SwitchStatement': {
        walk(node.discriminant, scope)
        const s = makeScope(scope, false)
        for (const c of node.cases) {
          if (c.test) walk(c.test, s)
          walkEach(c.consequent, s)
        }
        return
      }
      case 'CatchClause': {
        const s = makeScope(scope, false)
        if (node.param) bindPattern(node.param, s, 'let')
        // walk body statements directly in the catch scope
        walkEach(node.body.body, s)
        return
      }
      case 'MemberExpression': {
        walk(node.object, scope)
        if (node.computed) walk(node.property, scope)
        return
      }
      case 'Property': {
        if (node.computed) walk(node.key, scope)
        walk(node.value, scope)
        return
      }
      case 'LabeledStatement':
        walk(node.body, scope)
        return
      case 'BreakStatement':
      case 'ContinueStatement':
      case 'MetaProperty':
      case 'Literal':
      case 'JSXText':
      case 'JSXEmptyExpression':
      case 'EmptyStatement':
      case 'DebuggerStatement':
      case 'Super':
      case 'ThisExpression':
      case 'PrivateIdentifier':
        return
      case 'UnaryExpression': {
        // `typeof x` on an undeclared x does not throw — skip the direct identifier.
        if (node.operator === 'typeof' && node.argument.type === 'Identifier') return
        walk(node.argument, scope)
        return
      }
      case 'Identifier': {
        references.push({ name: node.name, scope, start: node.start })
        return
      }
      // ---- JSX ----
      case 'JSXElement': {
        const root = jsxRootIdentifier(node.openingElement.name)
        // Lowercase single identifiers are intrinsic tags (<div>), not references.
        if (root && (node.openingElement.name.type === 'JSXMemberExpression' || /^[A-Z_$]/.test(root.name))) {
          references.push({ name: root.name, scope, start: root.start })
        }
        for (const attr of node.openingElement.attributes) {
          if (attr.type === 'JSXSpreadAttribute') walk(attr.argument, scope)
          else if (attr.value) walk(attr.value, scope)
        }
        walkEach(node.children, scope)
        return
      }
      case 'JSXFragment':
        walkEach(node.children, scope)
        return
      case 'JSXExpressionContainer':
      case 'JSXSpreadChild':
        walk(node.expression, scope)
        return
      default: {
        // Generic recursion for everything else (calls, binary ops, templates,
        // spread, sequence, conditional, chain, await, yield, tagged templates…)
        for (const key of Object.keys(node)) {
          if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue
          const v = node[key]
          if (Array.isArray(v)) walkEach(v, scope)
          else if (v && typeof v === 'object') walk(v, scope)
        }
      }
    }
  }

  walk(ast, moduleScope)

  const out = []
  for (const ref of references) {
    let s = ref.scope, found = false
    while (s) {
      if (s.bindings.has(ref.name)) { found = true; break }
      s = s.parent
    }
    if (!found && !GLOBALS.has(ref.name)) {
      const { line, column } = loc(ref.start)
      out.push({ file, name: ref.name, line, column })
    }
  }
  return out
}
