// lib/deleted-job-replacement.ts
// ─────────────────────────────────────────────────────────────
// THE LIVE REPLACEMENT CHECK (2026-09-27) — before a job deletion closes a
// deal, ask Jobber whether that client still has other work.
//
// Kevin's 2026-08-29 rule closes a deal Lost ('job_deleted') when every job
// on it is deleted and nothing was invoiced. The repair for the 55 asked
// Jobber first ("just close them if they are not in jobber"); the webhook
// didn't. This is the same question, asked in the webhook: it runs only
// when the derivation says the deal would close, costs one to three Jobber
// reads, and never waits.
//
// WHY THIS IS ONLY HALF THE ANSWER. Measured on the 56 real deletions: of
// 28 jobs made for the same person within a week of a deletion, 19 were made
// AFTER it — mostly 1–10 minutes later, some 16 hours to 5 days later. A
// check at the moment of deletion cannot see those, and no wait short
// enough for a webhook would. So the other half lives in lib/engagements.ts
// (reopenIfClosedByJobDeletion + the rule-4 fallback): a job that arrives
// later for that client reopens the deal the deletion closed. This check
// catches the remade-then-deleted order; the reopen catches deleted-then-
// remade. Neither holds a request open.
//
// Unreadable is not "gone": if Jobber can't be asked (no client id, no
// token, an error), the deal is NOT closed. It stays where it was — the same
// as before 2026-08-29 — and the sync_log says why.
// ─────────────────────────────────────────────────────────────

import { supabaseService } from './supabase-service'
import { encodeJobberId, extractJobberId } from './jobber-import'
import { findReplacementJobs, isDeletedJob } from '@/components/hive/shared/jobDeleted'

const CLIENT_JOBS_Q = `query($id:EncodedId!){client(id:$id){id jobs(first:100){nodes{id jobNumber jobStatus createdAt}}}}`
const QUOTE_CLIENT_Q = `query($id:EncodedId!){quote(id:$id){client{id}}}`
const REQUEST_CLIENT_Q = `query($id:EncodedId!){request(id:$id){client{id}}}`

export type DeletedJobCloseCheck =
  | { confirmed: true; reason: string }
  | { confirmed: false; reason: string; replacements?: Array<{ id: string; jobNumber?: any; jobStatus?: any; createdAt?: any }> }

/**
 * May this deal close because its jobs were deleted? True only when Jobber
 * was asked and the client has no job that could be the work remade
 * (findReplacementJobs — the rule the repair uses).
 */
export async function deletedJobCloseConfirmed(args: {
  clientId: string
  jobs: Array<{ jobber_job_id?: string | null; status?: string | null; created_at?: string | null }>
  quotes?: Array<{ jobber_quote_id?: string | null }>
  serviceRequests?: Array<{ jobber_request_id?: string | null }>
}): Promise<DeletedJobCloseCheck> {
  try {
    const { data: lead } = await supabaseService
      .from('leads')
      .select('jobber_client_id, location_id')
      .eq('id', args.clientId)
      .maybeSingle()
    const slug = (lead as any)?.location_id as string | undefined
    if (!slug) return { confirmed: false, reason: 'no location for this person — Jobber not asked' }
    const { jobberGraphQL } = await import('./jobber')
    const ask = async (q: string, v: Record<string, any>) => {
      try { return await jobberGraphQL(slug, q, v) } catch (e: any) { return { errors: [{ message: e?.message || String(e) }] } as any }
    }

    // The Jobber client: the person's stored id, else through the deal's
    // own quote or request (some people were never stamped).
    let clientId: string | null = (lead as any)?.jobber_client_id ?? null
    for (const q of (args.quotes || []).filter(q => q.jobber_quote_id)) {
      if (clientId) break
      const r = await ask(QUOTE_CLIENT_Q, { id: encodeJobberId('Quote', String(q.jobber_quote_id)) })
      clientId = extractJobberId(r?.data?.quote?.client?.id) ?? null
    }
    for (const s of (args.serviceRequests || []).filter(s => s.jobber_request_id)) {
      if (clientId) break
      const r = await ask(REQUEST_CLIENT_Q, { id: encodeJobberId('Request', String(s.jobber_request_id)) })
      clientId = extractJobberId(r?.data?.request?.client?.id) ?? null
    }
    if (!clientId) return { confirmed: false, reason: 'no Jobber client found to ask' }

    const r = await ask(CLIENT_JOBS_Q, { id: encodeJobberId('Client', clientId) })
    if (r?.errors?.length || !r?.data?.client) {
      return { confirmed: false, reason: `Jobber could not be read: ${r?.errors?.[0]?.message || 'client not returned'}` }
    }
    const clientJobs = (r.data.client.jobs?.nodes || []).map((n: any) => ({ ...n, id: extractJobberId(n.id) }))
    const deleted = args.jobs.filter(isDeletedJob)
    const since = deleted.map(j => j.created_at).filter(Boolean).sort()[0] ?? null
    const replacements = findReplacementJobs({
      clientJobs,
      deletedJobberIds: deleted.map(j => j.jobber_job_id).filter(Boolean) as string[],
      deletedCreatedAt: since,
      onThisDeal: args.jobs.filter(j => !isDeletedJob(j)).map(j => j.jobber_job_id).filter(Boolean) as string[],
    })
    if (replacements.length) {
      return { confirmed: false, reason: `client still has ${replacements.length} possible replacement job(s) in Jobber`, replacements }
    }
    return { confirmed: true, reason: `client has no other live job in Jobber (${clientJobs.length} job(s), none a replacement)` }
  } catch (err: any) {
    return { confirmed: false, reason: `check failed: ${err?.message || String(err)}` }
  }
}
