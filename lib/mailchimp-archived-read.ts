// lib/mailchimp-archived-read.ts
//
// (2026-11-26, the guided set-up) Who is ARCHIVED in a Mailchimp list, by
// address — READ ONLY, GET only. Used by the "Who goes over to Mailchimp"
// screen so its big number leaves out people the sending code will never send
// (the sending code reads the same thing again for itself, right before
// it sends). The token is only ever put in the Authorization header.

import { emailKey } from './mailchimp-rules'

type FetchLike = (url: string, init: { method: 'GET'; headers: Record<string, string>; cache: 'no-store' }) => Promise<{ status: number; text(): Promise<string> }>

// (2026-11-26, the guided set-up) Mailchimp's archived contacts at this list,
// by address. GET only. Mailchimp
// leaves archived contacts out of an ordinary member read, so without this
// they look "new to Mailchimp". null = could not be read in full.
export async function readArchivedAddresses(a: { token: string; serverPrefix: string; listId: string; fetchImpl?: FetchLike; sleep?: (ms: number) => Promise<void> }): Promise<Set<string> | null> {
  const doFetch: FetchLike = a.fetchImpl || ((url, init) => fetch(url, init) as any)
  const sleep = a.sleep || ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const keys = new Set<string>()
  for (let offset = 0; ; offset += 1000) {
    const url = `https://${a.serverPrefix}.api.mailchimp.com/3.0/lists/${encodeURIComponent(a.listId)}/members?status=archived&count=1000&offset=${offset}&fields=total_items,members.email_address`
    let body: any = null
    for (let attempt = 0; ; attempt++) {
      let res: any
      try { res = await doFetch(url, { method: 'GET', headers: { Authorization: `Bearer ${a.token}` }, cache: 'no-store' }) } catch { res = null }
      if (res && res.status >= 200 && res.status < 300) { try { body = JSON.parse(await res.text()) } catch { body = null } break }
      if (attempt < 2 && (!res || res.status === 429 || res.status >= 500)) { await sleep(1000 * 2 ** attempt); continue }
      return null
    }
    const rows = Array.isArray(body?.members) ? body.members : null
    const total = Number(body?.total_items)
    if (!rows || !Number.isFinite(total)) return null
    for (const m of rows) { const k = emailKey(m?.email_address); if (k) keys.add(k) }
    if (!rows.length || offset + rows.length >= total) return keys
  }
}
