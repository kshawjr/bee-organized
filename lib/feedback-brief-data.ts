// lib/feedback-brief-data.ts
//
// The read behind the daily feedback brief (issue 248 step 2).
//
// Reads EVERY row and lets lib/feedback-queues decide which are open, rather
// than filtering by status in the query. That is deliberate: issue 233 exists
// because two surfaces disagreed about what "open" means, and the fix was one
// function owning the definition. A `.not('status','in',...)` here would be a
// second copy of that definition living in a query string, free to drift.
//
// The brief is for Kevin and corporate, so internal items ARE included — this
// is the elevated read, the same posture as super_admin on the triage screen.
// The brief labels them; it does not hide them.
//
// Never throws. A brief that dies on a read hiccup is worse than a brief that
// reports it read nothing, because the cron would page instead of the queue
// being visible.

import { supabaseService } from './supabase-service'
import type { BriefItem } from './feedback-brief'

type Joined = {
  id: string
  type: string | null
  title: string | null
  description: string | null
  status: string | null
  created_at: string | null
  updated_at: string | null
  admin_response: string | null
  admin_response_at: string | null
  reply_seen_at: string | null
  is_internal?: boolean | null
  submitter?: { full_name?: string | null; first_name?: string | null; email?: string | null } | null
  location?: { name?: string | null } | null
}

const SELECT = `
  id, type, title, description, status, created_at, updated_at, admin_response, admin_response_at, reply_seen_at, is_internal,
  submitter:hub_users!user_id ( full_name, first_name, email ),
  location:locations!location_id ( name )
`

// Pre-migration safety, mirroring lib/feedback-internal's posture: if
// is_internal isn't there yet the select errors, and we retry without it. No
// row can be internal when the column doesn't exist, so the retry loses
// nothing. withInternalFallback is not reusable here because it wraps a
// FILTER on the column; this wraps naming it in a projection.
const SELECT_NO_INTERNAL = SELECT.replace(', is_internal', '')

const namesMissingInternal = (message: string | undefined) =>
  /is_internal/i.test(message || '')

export async function fetchFeedbackForBrief(): Promise<{
  items: BriefItem[]
  ok: boolean
  internalSupported: boolean
}> {
  const run = async (select: string) =>
    supabaseService.from('feedback_items').select(select).order('created_at', { ascending: true })

  try {
    let internalSupported = true
    let { data, error } = await run(SELECT)
    if (error && namesMissingInternal(error.message)) {
      internalSupported = false
      ;({ data, error } = await run(SELECT_NO_INTERNAL))
    }
    if (error || !data) {
      if (error) console.error('[feedback-brief] read failed', error.message)
      return { items: [], ok: false, internalSupported }
    }
    return { items: (data as unknown as Joined[]).map(shape), ok: true, internalSupported }
  } catch (err: any) {
    console.error('[feedback-brief] unexpected read error', err?.message || err)
    return { items: [], ok: false, internalSupported: true }
  }
}

function shape(row: Joined): BriefItem {
  const s = row.submitter
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    description: row.description,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    admin_response: row.admin_response,
    admin_response_at: row.admin_response_at,
    reply_seen_at: row.reply_seen_at,
    is_internal: row.is_internal ?? false,
    submitter: s?.full_name || s?.first_name || s?.email || null,
    location: row.location?.name || null,
  }
}
