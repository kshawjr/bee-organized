// lib/test-memdb.ts — TEST-ONLY in-memory stand-in for the supabase-js query
// builder, so a route and the real webhook handlers can run end to end against
// ONE shared set of rows and a test can count what was written.
//
// Supports the shapes this repo's server code uses: select / insert / update /
// upsert(onConflict) / delete, eq / neq / is / in / not(in|is) / gt / gte / lt /
// lte / ilike / or(simple "a.eq.x,b.is.null"), order, limit, range, single,
// maybeSingle, count+head. Column projection is ignored (whole rows return).
// Not a database: no joins, no RLS, no constraints except an upsert's
// onConflict key. Import only from *.test.* files.

type Row = Record<string, any>
type Filter = (r: Row) => boolean

let seq = 0
const newId = () => `mem-${(++seq).toString().padStart(6, '0')}`

function parseList(v: string): string[] {
  return v.replace(/^\(|\)$/g, '').split(',').map(s => s.trim().replace(/^"|"$/g, ''))
}
function cmpEq(a: any, b: any) {
  if (a === null || a === undefined) return b === null || b === undefined
  return String(a) === String(b)
}

export function createMemDb(seed: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = {}
  for (const [t, rows] of Object.entries(seed)) tables[t] = rows.map(r => ({ ...r }))
  const writes: { table: string; op: string; rows: Row[] }[] = []
  const tbl = (t: string) => (tables[t] ??= [])

  function from(table: string) {
    let op: 'select' | 'insert' | 'update' | 'upsert' | 'delete' = 'select'
    let payload: any = null
    let onConflict: string | null = null
    let countMode = false
    let head = false
    let returning = false
    const filters: Filter[] = []
    let orderBy: { col: string; asc: boolean; nullsFirst?: boolean }[] = []
    let lim: number | null = null
    let rangeFrom: number | null = null
    let rangeTo: number | null = null

    const run = (): { data: any; error: any; count?: number } => {
      const rows = tbl(table)
      const match = (r: Row) => filters.every(f => f(r))
      if (op === 'insert' || op === 'upsert') {
        const list: Row[] = Array.isArray(payload) ? payload : [payload]
        const out: Row[] = []
        for (const raw of list) {
          const keys = onConflict ? onConflict.split(',').map(s => s.trim()) : null
          const hit = keys ? rows.find(r => keys.every(k => cmpEq(r[k], raw[k]))) : null
          if (op === 'upsert' && hit) {
            Object.assign(hit, raw)
            out.push(hit)
          } else {
            if (op === 'insert' && raw.id && rows.some(r => r.id === raw.id)) {
              return { data: null, error: { code: '23505', message: `duplicate key ${table}.id` } }
            }
            const row = { id: newId(), ...raw }
            rows.push(row)
            out.push(row)
          }
        }
        writes.push({ table, op, rows: out.map(r => ({ ...r })) })
        return { data: returning ? out.map(r => ({ ...r })) : null, error: null }
      }
      if (op === 'update') {
        const hit = rows.filter(match)
        hit.forEach(r => Object.assign(r, payload))
        writes.push({ table, op, rows: hit.map(r => ({ ...r })) })
        return { data: returning ? hit.map(r => ({ ...r })) : null, error: null }
      }
      if (op === 'delete') {
        const hit = rows.filter(match)
        tables[table] = rows.filter(r => !match(r))
        writes.push({ table, op, rows: hit })
        return { data: returning ? hit : null, error: null }
      }
      let out = rows.filter(match).map(r => ({ ...r }))
      for (const o of [...orderBy].reverse()) {
        out.sort((a, b) => {
          const av = a[o.col], bv = b[o.col]
          if (av == null && bv == null) return 0
          if (av == null) return o.nullsFirst ? -1 : 1
          if (bv == null) return o.nullsFirst ? 1 : -1
          return (av < bv ? -1 : av > bv ? 1 : 0) * (o.asc ? 1 : -1)
        })
      }
      const count = out.length
      if (rangeFrom != null) out = out.slice(rangeFrom, (rangeTo ?? out.length - 1) + 1)
      if (lim != null) out = out.slice(0, lim)
      return { data: head ? null : out, error: null, ...(countMode ? { count } : {}) }
    }

    const b: any = {
      select(_cols?: string, opts?: { count?: string; head?: boolean }) {
        if (op !== 'select') returning = true
        if (opts?.count) countMode = true
        if (opts?.head) head = true
        return b
      },
      insert(rows: any) { op = 'insert'; payload = rows; return b },
      upsert(rows: any, opts?: { onConflict?: string }) { op = 'upsert'; payload = rows; onConflict = opts?.onConflict ?? 'id'; return b },
      update(patch: any) { op = 'update'; payload = patch; return b },
      delete() { op = 'delete'; return b },
      eq(c: string, v: any) { filters.push(r => cmpEq(r[c], v)); return b },
      neq(c: string, v: any) { filters.push(r => !cmpEq(r[c], v)); return b },
      is(c: string, v: any) { filters.push(r => (v === null ? r[c] == null : r[c] === v)); return b },
      in(c: string, vs: any[]) { filters.push(r => vs.some(v => cmpEq(r[c], v))); return b },
      not(c: string, kind: string, v: any) {
        if (kind === 'in') { const l = parseList(String(v)); filters.push(r => !l.some(x => cmpEq(r[c], x))) }
        else if (kind === 'is') filters.push(r => (v === null ? r[c] != null : r[c] !== v))
        else if (kind === 'eq') filters.push(r => !cmpEq(r[c], v))
        return b
      },
      gt(c: string, v: any) { filters.push(r => r[c] != null && r[c] > v); return b },
      gte(c: string, v: any) { filters.push(r => r[c] != null && r[c] >= v); return b },
      lt(c: string, v: any) { filters.push(r => r[c] != null && r[c] < v); return b },
      lte(c: string, v: any) { filters.push(r => r[c] != null && r[c] <= v); return b },
      ilike(c: string, pat: string) {
        const re = new RegExp('^' + String(pat).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*') + '$', 'i')
        filters.push(r => r[c] != null && re.test(String(r[c])))
        return b
      },
      or(expr: string) {
        const parts = expr.split(',').map(p => p.trim()).filter(Boolean).map(p => {
          const [c, k, ...rest] = p.split('.')
          const v = rest.join('.')
          if (k === 'eq') return (r: Row) => cmpEq(r[c], v)
          if (k === 'is') return (r: Row) => (v === 'null' ? r[c] == null : String(r[c]) === v)
          if (k === 'ilike') return (r: Row) => r[c] != null && new RegExp('^' + v.replace(/%/g, '.*') + '$', 'i').test(String(r[c]))
          return (_r: Row) => false
        })
        filters.push(r => parts.some(f => f(r)))
        return b
      },
      order(col: string, opts?: { ascending?: boolean; nullsFirst?: boolean }) { orderBy.push({ col, asc: opts?.ascending !== false, nullsFirst: opts?.nullsFirst }); return b },
      limit(n: number) { lim = n; return b },
      range(a: number, z: number) { rangeFrom = a; rangeTo = z; return b },
      maybeSingle() {
        const r = run()
        if (r.error) return Promise.resolve(r)
        const d = Array.isArray(r.data) ? r.data : r.data == null ? [] : [r.data]
        return Promise.resolve({ data: d[0] ?? null, error: null })
      },
      single() {
        const r = run()
        if (r.error) return Promise.resolve(r)
        const d = Array.isArray(r.data) ? r.data : r.data == null ? [] : [r.data]
        return Promise.resolve(d.length === 1 ? { data: d[0], error: null } : { data: null, error: { message: `single: ${d.length} rows` } })
      },
      then(res: any, rej: any) { return Promise.resolve(run()).then(res, rej) },
    }
    return b
  }

  return {
    from,
    rpc: async () => ({ data: null, error: null }),
    tables,
    writes,
    rows: (t: string) => tbl(t).map(r => ({ ...r })),
    snapshot: () => JSON.parse(JSON.stringify(tables)),
  }
}
