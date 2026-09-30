// lib/notifications-live.ts
// ─────────────────────────────────────────────────────────────
// The per-location mute switch for Bee Hub's new-lead notifications.
// See migrations/notifications_live.sql for the column + the seed.
//
// WHY THIS EXISTS. Bee Hub's new-lead email + Slack fire on lead creation with
// no location gate. During the Zoho-parallel migration Zoho still notifies
// everyone, so an ungated Bee Hub = double notification for the 44 onboarding
// locations. All 44 have seeded recipients already, which is why "has
// recipients" can't be the gate — this flag is. Kevin flips locations live one
// at a time as they cut over.
//
// THE RULE (both must hold to send):
//   notifications_live = true  AND  the location resolves ≥1 recipient.
// This module owns the first half only. The second half stays where it already
// lives (resolveLeadRecipients / the Slack connection check).
//
// ── FAIL CLOSED ─────────────────────────────────────────────────────────────
// Every failure — missing column (pre-migration), unknown location, dead
// network, thrown client — resolves to live:false, i.e. DO NOT SEND. This is a
// deliberate choice between two unequal harms:
//
//   fail OPEN  → a half-migrated state double-notifies 44 franchisees. An email
//                that has left cannot be recalled, and the credibility cost
//                lands on the exact people this migration is trying not to
//                disturb.
//   fail CLOSED → a muted window delays an internal heads-up. The lead is NOT
//                lost: it is captured, enrolled in drip, and sitting in the
//                Inbox. The notification is late, not gone.
//
// The second is recoverable and the first isn't, so we take the second.
//
// THE COST, STATED PLAINLY: between deploying this code and running the
// migration, the column does not exist, so the 6 live locations read as muted
// and stop emailing. That window is real. It is closed by running
// migrations/notifications_live.sql (which adds the column AND seeds the 6 in
// one transaction) — ideally before or alongside the deploy, not after it.
// A read failure is logged loudly here precisely so that window is legible in
// the console rather than looking like "no leads came in".

// ── EXCEPT loc_other — never muted (2026-09-30) ─────────────────────────────
// loc_other is corporate's queue of leads no franchise holds (Leslie's). The
// migration left it muted "because Leslie is covered by Zoho"; the zip-only
// website form posts straight to Bee Hub, and once zip routing is the website's
// only door ~150 leads a month land there. A muted loc_other is a queue nobody
// is told about. It was switched on by hand in the database, and nothing but
// this line stops a hand switching it off again, so the rule lives in code:
// when the row says loc_other, the flag is not read. The double-notify worry
// that justified the flag is about franchise owners on Zoho — it does not apply
// to corporate's own queue.
//
// A read FAILURE still fails closed here: without the row we cannot tell
// loc_other from a Zoho location. That case is not silent — it writes a muted
// row, and lib/failure-alerts pages Kevin for any loc_other lead that reached
// nobody.

import { supabaseService } from './supabase-service'
import { LOC_OTHER_SLUG } from './hub-scope'

// Why the location isn't cleared to send. Threaded to the notification_log row
// so a muted location reads as INTENTIONALLY silent rather than broken — the
// distinction this whole feature turns on.
export type NotificationsLiveReason =
  // The flag is false. The normal, expected state for 45 of the 51 locations.
  | 'muted'
  // No location row for this id. Shouldn't happen (callers hold a location they
  // just read), so it's a real anomaly, not a mute.
  | 'location_not_found'
  // The read itself failed. Pre-migration this is the missing column, and it is
  // the state that silences the 6 live locations — see the cost note above.
  | 'read_failed'

export type NotificationsLiveVerdict = {
  live: boolean
  // Present only when the location is loc_other: live by rule, not by flag.
  // lib/lead-notification-email reads it to send the Bee Hub variant (the
  // button straight to the lead) — corporate works this queue in Bee Hub.
  unroutedQueue?: true
  reason?: NotificationsLiveReason
  // Present only on 'read_failed' — the underlying message, so a muted row in
  // the notebook says WHY rather than just "not live".
  error?: string
}

// Read one location's flag. Never throws: returns a verdict the caller logs and
// branches on. Its own isolated read, NOT a widening of any caller's existing
// location select — see the note on the call sites.
export async function resolveNotificationsLive(
  locationId: string,
): Promise<NotificationsLiveVerdict> {
  try {
    const { data, error } = await supabaseService
      .from('locations')
      .select('notifications_live, location_id')
      .eq('id', locationId)
      .maybeSingle()

    if (error) {
      // Pre-migration this is PostgREST's "column locations.notifications_live
      // does not exist". Loud, because while this fires every location is muted.
      console.error(
        `[notifications-live] read failed for location ${locationId} — muting (fail-closed): ${error.message}`,
      )
      return { live: false, reason: 'read_failed', error: error.message }
    }
    if (!data) {
      console.error(
        `[notifications-live] no location row for ${locationId} — muting (fail-closed)`,
      )
      return { live: false, reason: 'location_not_found' }
    }

    // loc_other: live whatever the flag says. See the header.
    if (data.location_id === LOC_OTHER_SLUG) return { live: true, unroutedQueue: true }

    // Coerced, not trusted: the column is NOT NULL in the schema, but a null
    // here (a stale PostgREST cache mid-migration) must read as muted, not as
    // truthy-by-accident.
    if (data.notifications_live === true) return { live: true }
    return { live: false, reason: 'muted' }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(
      `[notifications-live] read threw for location ${locationId} — muting (fail-closed): ${message}`,
    )
    return { live: false, reason: 'read_failed', error: message }
  }
}
