// app/api/network/contacts/[id]/sequences/route.ts
//
// Partner emails, slice 5 (2026-11-23): a partner's email sequences, from
// their Network contact sheet.
//
//   GET     which sequences can be started (each with its emails and timing),
//           where this partner is on each, and whether they can be emailed
//   POST    { pathKey, confirmed: true }  start them on a sequence (from the
//           first email; a finished or stopped one starts again from the
//           first email)
//   DELETE  { pathKey, confirmed: true }  stop them on it: nothing more is sent
//
// The browser names a sequence by its key, never by an id; which copy is
// used is decided on the server (lib/network/partner-sequence-start.ts).
//
// WHO: the Network gate (lib/network/access.ts), then the PARTNER's own
// location (lib/network/route-access.ts), never one sent by the browser:
//   GET     may read Network at that location
//   POST    may change Network there, and the location is not read-only
//           (readOnlyWriteBlock: a paused location's owner cannot start)
//   DELETE  may change Network there. A paused location's owner CAN stop:
//           stopping only ever sends less.
// Another location's contact is answered exactly like a missing one (404).

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { loadCaller } from '@/lib/crm'
import { readOnlyWriteBlock } from '@/lib/read-only-access'
import { maySeeNewNetwork } from '@/lib/network/access'
import { mayReadNetworkLocation, networkWriteVerdict, READ_ONLY_ANSWER } from '@/lib/network/route-access'
import { partnerSequencesView, startPartnerSequence, stopPartnerSequence } from '@/lib/network/partner-sequence-start'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// A stale "not unsubscribed" must never be read from Next's Data Cache.
export const fetchCache = 'force-no-store'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const notFound = () => NextResponse.json({ error: 'contact_not_found' }, { status: 404 })

async function gate() {
  const supabase = await createServerSupabaseClient()
  const caller = await loadCaller(supabase)
  if (!caller) return { caller: null, refuse: NextResponse.json({ error: 'unauthorized' }, { status: 401 }) }
  if (!maySeeNewNetwork(caller.role)) return { caller: null, refuse: NextResponse.json({ error: 'forbidden' }, { status: 403 }) }
  return { caller, refuse: null }
}

async function partnerRow(id: string) {
  const { data, error } = await supabaseService.from('partners').select('id, location_id, deleted_at, network_types').eq('id', id).maybeSingle()
  if (error) return { error: NextResponse.json({ error: error.message }, { status: 500 }) }
  if (!data || (data as any).deleted_at) return { error: notFound() }
  return { row: data as { id: string; location_id: string } }
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { caller, refuse } = await gate()
  if (!caller) return refuse
  const { id } = await params
  if (!UUID.test(id)) return notFound()
  const p = await partnerRow(id)
  if (!p.row) return p.error
  if (!mayReadNetworkLocation(caller, p.row.location_id)) return notFound()
  const view = await partnerSequencesView(id, p.row.location_id)
  if ('error' in view) return NextResponse.json({ error: view.error }, { status: 500 })
  return NextResponse.json(view)
}

async function writeCheck(req: NextRequest, id: string, start: boolean) {
  const { caller, refuse } = await gate()
  if (!caller) return { refuse }
  if (!UUID.test(id)) return { refuse: notFound() }
  let body: any
  try { body = await req.json() } catch { return { refuse: NextResponse.json({ error: 'invalid_json_body' }, { status: 400 }) } }
  const p = await partnerRow(id)
  if (!p.row) return { refuse: p.error }
  const may = networkWriteVerdict(caller, p.row.location_id)
  if (may === 'not_found') return { refuse: notFound() }
  if (may === 'read_only') return { refuse: NextResponse.json(READ_ONLY_ANSWER, { status: 403 }) }
  if (start) {
    const blocked = await readOnlyWriteBlock({ role: caller.role }, p.row.location_id)
    if (blocked) return { refuse: blocked }
  }
  // Nothing starts or stops without the screen's yes.
  if (body?.confirmed !== true) return { refuse: NextResponse.json({ error: 'confirmation_required' }, { status: 400 }) }
  return { caller, body, row: p.row }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const w = await writeCheck(req, id, true)
  if (!w.caller) return w.refuse
  // Only the key is read from the body: an id sent with it is ignored.
  const r = await startPartnerSequence({ partnerId: id, pathKey: w.body?.pathKey, startedBy: w.caller.userId })
  if (!r.ok) return NextResponse.json({ error: r.error, reason: r.reason ?? null }, { status: r.status })
  return NextResponse.json({ started: true, restarted: r.restarted, usedCopy: r.usedCopy, firstEmail: r.firstEmail })
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const w = await writeCheck(req, id, false)
  if (!w.caller) return w.refuse
  const r = await stopPartnerSequence({ partnerId: id, pathKey: w.body?.pathKey })
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status })
  return NextResponse.json({ stopped: true })
}
