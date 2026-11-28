// app/api/leads/[id]/mailchimp-choice/route.ts
//
// POST /api/leads/:id/mailchimp-choice — FL-137 (Kevin, 2026-11-28).
// Send to Jobber's "Add to Mailchimp" box, saved once the send has worked:
//   { choice: 'in' | 'out' }   ticked → 'in', and the one-person add runs;
//                              unticked → 'out', nothing is sent.
// Only for someone already sent to Jobber: while they are still a request
// (an open enquiry) they are never sent to Mailchimp, and the add refuses
// them again on its own (addOneLeadToMailchimp, 'still_an_enquiry').
// Only where Mailchimp is open (Test Location before roll-out): elsewhere
// the box is not shown and this saves nothing.
//
// Auth: a logged-in hub user; owners only at their own location (someone
// else's person is simply not found); read-only users and paused locations
// are refused before any write.

import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { isAdmin } from '@/lib/auth'
import { readOnlyWriteBlock } from '@/lib/read-only-access'
import { mailchimpOpenFor } from '@/lib/mailchimp-rollout'
import { saveMailchimpChoice } from '@/lib/nurture-choice'
import { sendChosenToMailchimp } from '@/lib/nurture-mailchimp'

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const { data: hubUser } = await supabase.from('hub_users').select('id, role, location_id').eq('id', user.id).single()
  if (!hubUser) return NextResponse.json({ error: 'no_hub_user_profile' }, { status: 403 })

  let body: any = {}
  try { body = await req.json() } catch { /* empty */ }
  const choice = body?.choice
  if (choice !== 'in' && choice !== 'out') return NextResponse.json({ error: 'bad_request' }, { status: 400 })

  const { data: lead } = await supabaseService.from('leads').select('id, location_uuid, jobber_request_id, jobber_job_id').eq('id', id).maybeSingle()
  if (!lead || (!isAdmin(hubUser.role) && hubUser.location_id !== lead.location_uuid)) {
    return NextResponse.json({ error: 'lead_not_found' }, { status: 404 })
  }
  const roBlock = await readOnlyWriteBlock(hubUser, lead.location_uuid)
  if (roBlock) return roBlock
  if (!mailchimpOpenFor(lead.location_uuid)) return NextResponse.json({ ok: true, saved: false, reason: 'not_open' })
  // The box belongs to Send to Jobber: nobody is sent before they have been.
  if (!lead.jobber_request_id && !lead.jobber_job_id) return NextResponse.json({ error: 'not_sent_to_jobber' }, { status: 409 })

  const saved = await saveMailchimpChoice(id, choice, 'send_to_jobber', hubUser.id)
  if (!saved) return NextResponse.json({ error: 'not_saved' }, { status: 500 })
  const mailchimp = choice === 'in' ? await sendChosenToMailchimp(id, lead.location_uuid) : null
  return NextResponse.json({ ok: true, saved: true, choice, mailchimp })
}
