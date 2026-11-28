// app/api/mailchimp/webhook/route.ts
//
// FL-131: the address Mailchimp calls when someone joins a location's list
// (set up only on Test Location's list, by scripts/mailchimp-webhook-setup.mts,
// on Kevin's go). ?l=<location id>&k=<key> — the key is derived from that
// location's own connection (lib/mailchimp-webhook-key.ts).
//
//   GET  — Mailchimp checks the address answers when the notification is set
//          up. 200 only with a good key.
//   POST — Mailchimp's message (form-encoded). Only "subscribe" for this
//          location's own list is acted on. The message is a nudge, never
//          trusted: the ongoing sync reads everything again from Mailchimp
//          itself, for the whole location, exactly as the hourly sweep does.
//          A run that cannot finish answers 500, so Mailchimp tries again;
//          the sweep is there either way.
//
// Anything else — a location not open before roll-out, a bad key, another
// list — is turned away without saying which.

import { NextRequest, NextResponse } from 'next/server'
import { supabaseService } from '@/lib/supabase-service'
import { mailchimpOpenFor } from '@/lib/mailchimp-rollout'
import { mailchimpWebhookKeyMatches } from '@/lib/mailchimp-webhook-key'
import { runOngoing } from '@/lib/mailchimp-ongoing'

export const dynamic = 'force-dynamic'
export const fetchCache = 'force-no-store'

const NOPE = () => NextResponse.json({ error: 'not_found' }, { status: 404 })

async function allowed(req: NextRequest): Promise<{ id: string; listId: string } | null> {
  const id = req.nextUrl.searchParams.get('l') || ''
  const key = req.nextUrl.searchParams.get('k') || ''
  if (!mailchimpOpenFor(id)) return null
  const { data: loc, error } = await supabaseService.from('locations')
    .select('id, mailchimp_connected, mailchimp_access_token, mailchimp_list_id').eq('id', id).maybeSingle()
  if (error || !loc || !loc.mailchimp_connected || !loc.mailchimp_list_id) return null
  if (!mailchimpWebhookKeyMatches(key, loc.mailchimp_access_token, id)) return null
  return { id, listId: loc.mailchimp_list_id }
}

export async function GET(req: NextRequest) {
  return (await allowed(req)) ? NextResponse.json({ ok: true }) : NOPE()
}

export async function POST(req: NextRequest) {
  const who = await allowed(req)
  if (!who) return NOPE()
  let type = '', listId = ''
  try {
    const form = await req.formData()
    type = String(form.get('type') || '')
    listId = String(form.get('data[list_id]') || '')
  } catch { return NextResponse.json({ ok: true, ignored: 'unreadable' }) }
  if (type !== 'subscribe') return NextResponse.json({ ok: true, ignored: type || 'no_type' })
  if (listId !== who.listId) return NextResponse.json({ ok: true, ignored: 'other_list' })

  const r = await runOngoing(who.id, { trigger: 'webhook' })
  if (!r.ok) {
    if (r.reason === 'setup_not_finished') return NextResponse.json({ ok: true, ignored: 'setup_not_finished' })
    console.error('[mailchimp-webhook] run failed', { reason: r.reason })
    return NextResponse.json({ ok: false, reason: r.reason }, { status: 500 })
  }
  return NextResponse.json({ ok: true, created: r.created, greeted: r.greeted })
}
