// lib/realtime-broadcast.ts
// ─────────────────────────────────────────────────────────────
// Server-side Realtime BROADCAST — a signal the server sends directly to
// everyone watching a location, independent of postgres_changes.
//
// WHY THIS EXISTS. A transferred lead never appeared for the receiving
// location until a reload. postgres_changes carries row changes, but for an
// UPDATE Supabase must be able to show the row to the subscriber in BOTH its
// old and new state before it will deliver (Supabase's own Postgres Changes
// troubleshooting guide names this trap). Our leads SELECT policy is
// location-scoped, so before the move the lead sits at a location the
// receiving user cannot see, and the event never arrives.
//
// CORRECT EVEN IF THAT DIAGNOSIS IS WRONG. This path does not depend on why
// the row event went missing — the server says "this lead moved" straight to
// the destination, so the card appears whatever postgres_changes did or did
// not do. That property is the whole reason to prefer it over widening the
// leads policy, which would grant owners permanent read access to other
// locations' leads to fix a transient delivery question.
//
// IT DOES NOT REPLACE postgres_changes. Both paths end in the same refetch
// and the same merge, which dedupes by id, so a lead named by both signals
// renders one card.
//
// A SIGNAL, NEVER DATA. The payload carries ids only. The topic is PUBLIC —
// anyone who knows a location uuid could subscribe — so nothing that reaches
// it may be private: a listener learns "some lead moved" and a uuid, and can
// do nothing with it. Reading the lead still goes through GET /api/leads/:id,
// which enforces the location check server-side. If we ever want to put real
// content on a broadcast, it must move to a PRIVATE channel first, which
// needs Realtime Authorization (an RLS policy on realtime.messages) and a
// setAuth() call on the client.
//
// REST, not a websocket. Sending over the client library means opening a
// socket from a serverless function and waiting for it to join; the documented
// REST endpoint is one fire-and-forget POST, which is the right shape for an
// API route that has already done its real work.
// ─────────────────────────────────────────────────────────────

// Every Hive client subscribes to `location:<its own locFilter>` — a location
// uuid, or the literal 'all' for corporate/admin views, which is why 'all' is
// a topic in its own right rather than something a client has to enumerate.
export const locationTopic = (locationUuid: string) => `location:${locationUuid}`
export const ALL_LOCATIONS_TOPIC = locationTopic('all')

// The one broadcast event this module sends today.
export const LEAD_MOVED_EVENT = 'lead_moved'

export type LeadMovedPayload = {
  leadId: string
  fromLocationUuid: string | null
  toLocationUuid: string
}

/**
 * Tell both ends of a transfer — and the all-locations view — that a lead
 * moved. Best-effort by contract: the transfer itself has already committed
 * before this runs, so a failed broadcast must never fail the request. The
 * caller logs and carries on; the lead is still correct in the database and a
 * reload still shows it.
 *
 * Returns true when Realtime accepted the messages, false otherwise, so the
 * caller can record a warning without having to know the transport.
 */
export async function broadcastLeadMoved(payload: LeadMovedPayload): Promise<boolean> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.error('[broadcast] lead_moved skipped: supabase env missing')
    return false
  }

  // Three topics, one request: the origin (so the row leaves), the
  // destination (so the card arrives), and the all-locations view (which
  // holds the unrouted transfer queue and would otherwise never see a
  // loc_other lead leave it). Deduped so a no-op move can't send twice.
  const topics = Array.from(new Set([
    payload.fromLocationUuid ? locationTopic(payload.fromLocationUuid) : null,
    locationTopic(payload.toLocationUuid),
    ALL_LOCATIONS_TOPIC,
  ].filter(Boolean) as string[]))

  try {
    const res = await fetch(`${url}/realtime/v1/api/broadcast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: key },
      body: JSON.stringify({
        messages: topics.map(topic => ({ topic, event: LEAD_MOVED_EVENT, payload })),
      }),
    })
    if (!res.ok) {
      console.error(`[broadcast] lead_moved failed: HTTP ${res.status}`)
      return false
    }
    return true
  } catch (err: any) {
    console.error('[broadcast] lead_moved threw:', err?.message || String(err))
    return false
  }
}
