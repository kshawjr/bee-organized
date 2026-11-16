// lib/testing/memory-db.ts
// A small in-memory stand-in for the Supabase client, for route tests. Tables
// are plain arrays on `db.tables`; every call is recorded on `db.calls`.
// It knows only what these tests need: select (with a count), eq / in / is,
// insert, update, upsert (ignoring duplicates on the named columns), delete,
// order, limit, single / maybeSingle, and rpc. Nothing outside a *.test file
// should import it.
//
// It does NOT know the real schema (a column that does not exist reads as
// undefined instead of failing), so anything proved here about what is
// WRITTEN was also run against a Postgres copy of production; see the tests
// that use it for where.

export type MemoryDb = {
  tables: Record<string, any[]>
  calls: { table: string; op: string; payload: any; filters: any[] }[]
  rpc: Record<string, (args: any, db: MemoryDb) => any>
  from: (table: string) => any
  client: { from: (table: string) => any; rpc: (fn: string, args: any) => Promise<{ data: any; error: any }> }
  writes: () => { table: string; op: string; payload: any; filters: any[] }[]
}

export function makeMemoryDb(tables: Record<string, any[]> = {}): MemoryDb {
  const db: MemoryDb = {
    tables, calls: [], rpc: {},
    from: (table: string) => builder(table),
    client: { from: (table: string) => builder(table), rpc: async (fn: string, args: any) => {
      db.calls.push({ table: `rpc:${fn}`, op: 'rpc', payload: args, filters: [] })
      const f = db.rpc[fn]
      return f ? { data: f(args, db), error: null } : { data: null, error: { message: `no such function ${fn}` } }
    } },
    writes: () => db.calls.filter((c) => c.op !== 'select'),
  }
  function builder(table: string) {
    const ctx: any = { table, op: 'select', payload: null, filters: [] as any[], opts: null, count: false, head: false, limit: null as number | null, order: null as any }
    const b: any = {}
    b.select = (_cols?: string, o?: any) => { if (o?.count) ctx.count = true; if (o?.head) ctx.head = true; return b }
    b.insert = (p: any) => { ctx.op = 'insert'; ctx.payload = p; return b }
    b.update = (p: any) => { ctx.op = 'update'; ctx.payload = p; return b }
    b.upsert = (p: any, o: any) => { ctx.op = 'upsert'; ctx.payload = p; ctx.opts = o; return b }
    b.delete = () => { ctx.op = 'delete'; return b }
    b.eq = (c: string, v: any) => { ctx.filters.push(['eq', c, v]); return b }
    b.is = (c: string, v: any) => { ctx.filters.push(['is', c, v]); return b }
    b.in = (c: string, v: any[]) => { ctx.filters.push(['in', c, v]); return b }
    b.or = (expr: string) => { ctx.filters.push(['or', expr]); return b }
    b.not = (c: string, op: string, v: any) => { ctx.filters.push(['not', c, op, v]); return b }
    b.order = (c: string, o?: any) => { ctx.order = [c, o?.ascending !== false]; return b }
    b.limit = (n: number) => { ctx.limit = n; return b }
    const match = (r: any) => ctx.filters.every((f: any) => {
      if (f[0] === 'eq') return r[f[1]] === f[2]
      if (f[0] === 'is') return (r[f[1]] ?? null) === f[2]
      if (f[0] === 'in') return f[2].includes(r[f[1]])
      if (f[0] === 'not') return f[2] === 'is' ? (r[f[1]] ?? null) !== f[3] : true
      if (f[0] === 'or') {
        // only the shape these routes use: location_id.is.null,location_id.eq.<id>
        const m = /location_id\.is\.null,location_id\.eq\.(.+)$/.exec(f[1])
        return m ? (r.location_id ?? null) === null || r.location_id === m[1] : true
      }
      return true
    })
    const run = () => {
      db.calls.push({ table, op: ctx.op, payload: ctx.payload, filters: ctx.filters })
      const rows = (db.tables[table] ||= [])
      if (ctx.op === 'insert') {
        const list = (Array.isArray(ctx.payload) ? ctx.payload : [ctx.payload]).map((p: any) => ({ id: p.id ?? `new-${rows.length + 1}`, ...p }))
        rows.push(...list); return { rows: list, count: list.length }
      }
      if (ctx.op === 'upsert') {
        const keys = String(ctx.opts?.onConflict || 'id').split(',').map((k) => k.trim())
        const added: any[] = []
        for (const p of Array.isArray(ctx.payload) ? ctx.payload : [ctx.payload]) {
          const there = rows.find((r) => keys.every((k) => r[k] === p[k]))
          if (there) { if (!ctx.opts?.ignoreDuplicates) Object.assign(there, p) } else { rows.push({ ...p }); added.push(p) }
        }
        return { rows: added, count: added.length }
      }
      const hit = rows.filter(match)
      if (ctx.op === 'update') { hit.forEach((r) => Object.assign(r, ctx.payload)); return { rows: hit, count: hit.length } }
      if (ctx.op === 'delete') { db.tables[table] = rows.filter((r) => !hit.includes(r)); return { rows: hit, count: hit.length } }
      let out = hit.slice()
      if (ctx.order) out.sort((a, z) => (a[ctx.order[0]] > z[ctx.order[0]] ? 1 : a[ctx.order[0]] < z[ctx.order[0]] ? -1 : 0) * (ctx.order[1] ? 1 : -1))
      if (ctx.limit != null) out = out.slice(0, ctx.limit)
      return { rows: out, count: hit.length }
    }
    const copy = (r: any) => (r == null ? r : JSON.parse(JSON.stringify(r)))
    b.single = async () => { const { rows } = run(); return rows[0] ? { data: copy(rows[0]), error: null } : { data: null, error: { message: 'no rows' } } }
    b.maybeSingle = async () => { const { rows } = run(); return { data: copy(rows[0] ?? null), error: null } }
    b.then = (res: any, rej: any) => { const { rows, count } = run(); return Promise.resolve({ data: ctx.head ? null : rows.map(copy), count: ctx.count ? count : null, error: null }).then(res, rej) }
    return b
  }
  return db
}
