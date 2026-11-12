// lib/fake-postgrest.test.harness.ts
// A small in-memory PostgREST for tests of code that reads through a Supabase
// client (lib/client-search, lib/hub-working-clients). Not a test file itself.
//
// Real filter semantics for the handful of operators the search uses, and a
// log of every filter applied per table — so a test can ask both "what came
// back" and "was the fence on that read".
export type Call = { table: string; filters: string[] }
export function fakeDb(tables: Record<string, any[]>) {
  const calls: Call[] = []
  const from = (table: string) => {
    const call: Call = { table, filters: [] }
    calls.push(call)
    let rows = [...(tables[table] || [])]
    let wantCount = false
    let head = false
    let limitN: number | null = null
    let rangeFT: [number, number] | null = null
    const orders: Array<{ col: string; asc: boolean; nullsLast?: boolean }> = []
    const b: any = {
      select(_cols: string, opts?: any) { if (opts?.count) wantCount = true; if (opts?.head) head = true; return b },
      gt(col: string, v: any) { call.filters.push(`gt:${col}:${v}`); rows = rows.filter(r => r[col] != null && (typeof r[col] === 'number' || typeof v === 'number' ? Number(r[col]) > Number(v) : String(r[col]) > String(v))); return b },
      eq(col: string, v: any) { call.filters.push(`eq:${col}:${v}`); rows = rows.filter(r => String(r[col]) === String(v)); return b },
      in(col: string, vs: any[]) { call.filters.push(`in:${col}`); const s = new Set(vs.map(String)); rows = rows.filter(r => s.has(String(r[col]))); return b },
      is(col: string, v: any) { call.filters.push(`is:${col}:${v}`); rows = rows.filter(r => (r[col] ?? null) === v); return b },
      not(col: string, op: string, v: any) { call.filters.push(`not:${col}:${op}:${v}`); rows = rows.filter(r => !(r[col] === v)); return b },
      gte(col: string, v: any) { call.filters.push(`gte:${col}:${v}`); rows = rows.filter(r => r[col] != null && String(r[col]) >= String(v)); return b },
      lt(col: string, v: any) { call.filters.push(`lt:${col}:${v}`); rows = rows.filter(r => r[col] != null && String(r[col]) < String(v)); return b },
      neq(col: string, v: any) { call.filters.push(`neq:${col}:${v}`); rows = rows.filter(r => r[col] !== v); return b },
      lte(col: string, v: any) { call.filters.push(`lte:${col}:${v}`); rows = rows.filter(r => new Date(r[col]).getTime() <= new Date(v).getTime()); return b },
      ilike(col: string, pattern: string) {
        call.filters.push(`ilike:${col}:${pattern}`)
        const needle = pattern.replace(/^%|%$/g, '').replace(/\\(.)/g, '$1').toLowerCase()
        rows = rows.filter(r => String(r[col] || '').toLowerCase().includes(needle)); return b
      },
      or(clause: string) {
        call.filters.push(`or:${clause}`)
        const blank = clause.match(/^(email|phone)\.is\.null,\1\.eq\.$/)
        // the browse cursor: name.gt."X",and(name.eq."X",id.gt.ID),name.is.null
        const cursor = clause.match(/^name\.gt\."((?:[^"\\]|\\.)*)",and\(name\.eq\."(?:[^"\\]|\\.)*",id\.gt\.([0-9a-zA-Z-]+)\),name\.is\.null$/)
        if (cursor) {
          const name = cursor[1].replace(/\\(.)/g, '$1'), id = cursor[2]
          rows = rows.filter(r => r.name == null || String(r.name) > name || (String(r.name) === name && String(r.id) > id))
        } else if (blank) {
          rows = rows.filter(r => r[blank[1]] == null || r[blank[1]] === '')
        } else if (table === 'leads') {
          // name.ilike."*term*",email.ilike."*term*",phone.ilike."*term*"
          const m = clause.match(/^name\.ilike\."\*(.*)\*",email\.ilike\."\*(.*)\*",phone\.ilike\."\*(.*)\*"$/)
          if (!m) throw new Error(`unparsed or clause: ${clause}`)
          // undo the PostgREST quoting, then the LIKE escaping
          const needle = m[1].replace(/\\(.)/g, '$1').replace(/\\(.)/g, '$1').toLowerCase()
          rows = rows.filter(r => ['name', 'email', 'phone'].some(f => String(r[f] || '').toLowerCase().includes(needle)))
        } else if (table === 'lookups') {
          const loc = clause.split('location_id.eq.')[1]
          rows = rows.filter(r => r.location_id == null || r.location_id === loc)
        }
        return b
      },
      order(col: string, o?: any) { orders.push({ col, asc: o?.ascending !== false, nullsLast: o?.nullsFirst === false }); return b },
      limit(n: number) { limitN = n; return b },
      range(f: number, t: number) { rangeFT = [f, t]; return b },
      then(res: any, rej: any) {
        const sorted = [...rows].sort((x, y) => {
          for (const o of orders) {
            if (o.nullsLast && (x[o.col] == null) !== (y[o.col] == null)) return x[o.col] == null ? 1 : -1
            const a = x[o.col] ?? '', c = y[o.col] ?? ''
            if (a !== c) return (a < c ? -1 : 1) * (o.asc ? 1 : -1)
          }
          return 0
        })
        const count = sorted.length
        let out = sorted
        if (rangeFT) out = out.slice(rangeFT[0], rangeFT[1] + 1)
        if (limitN != null) out = out.slice(0, limitN)
        return Promise.resolve({ data: head ? null : out, error: null, count: wantCount ? count : null }).then(res, rej)
      },
    }
    return b
  }
  return { db: { from }, calls }
}
