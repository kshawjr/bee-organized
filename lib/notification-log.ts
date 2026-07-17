// lib/notification-log.ts
// The outbound-mail notebook's WRITER. One row per recipient per send —
// see migrations/notification_log.sql for the table + the grain rationale.
//
// CONTRACT — this module is subordinate to the send. It NEVER throws, NEVER
// returns anything a caller could branch on, and NEVER alters a caller's
// return value. The notebook is an observer: failing to write down that we
// sent an email must not stop us from sending it. Every failure mode —
// constraint violation, missing table (pre-migration), dead network, thrown
// client — collapses to a console.warn and a swallowed void.
//
// Modeled on lib/sync-log.ts, with the same two-layer guard:
//   1) supabase-js does NOT throw on insert failure — it resolves { error }.
//      Unchecked, a rejected row vanishes silently.
//   2) …but the client itself CAN throw (missing env, malformed payload), so
//      the whole body sits inside try/catch too.
//
// PRE-MIGRATION SAFETY. Until notification_log.sql runs, every insert here
// comes back with a PostgREST "relation \"notification_log\" does not exist"
// error. That lands on the { error } branch → warn → return. This is the
// mechanism that lets the logging code ship before the table exists; it is
// pinned by lib/notification-log-fire-safety.test.ts, not just asserted here.

import { supabaseService } from './supabase-service'

export type NotificationChannel = 'email' | 'slack'
export type NotificationSendStatus = 'accepted' | 'failed' | 'zero_recipients'

// The context a caller threads through sendEmailDirect. Lead notifications
// carry all of it; invites/magic-links/drips carry some or none. Every field
// is optional and lands as NULL — an invite row with no lead_id is correct,
// not incomplete.
export interface NotificationContext {
  lead_id?: string | null
  lead_name?: string | null
  location_id?: string | null
  location_slug?: string | null
  // Descriptive label — 'lead_notification' | 'invite' | 'magic_link' | 'drip'.
  // The column carries NO check constraint: a new caller inventing a new kind
  // must never have its row rejected.
  email_kind?: string | null
}

export interface LogNotificationArgs extends NotificationContext {
  channel: NotificationChannel
  send_status: NotificationSendStatus
  // ONE address. A multi-recipient send calls this once per recipient, all
  // rows sharing resend_message_id (see the migration's grain note).
  recipient?: string | null
  subject?: string | null
  resend_message_id?: string | null
  error?: string | null
}

export async function logNotification(args: LogNotificationArgs): Promise<void> {
  try {
    const { error } = await supabaseService.from('notification_log').insert({
      lead_id: args.lead_id ?? null,
      lead_name: args.lead_name ?? null,
      location_id: args.location_id ?? null,
      location_slug: args.location_slug ?? null,
      channel: args.channel,
      recipient: args.recipient ?? null,
      subject: args.subject ?? null,
      email_kind: args.email_kind ?? null,
      send_status: args.send_status,
      resend_message_id: args.resend_message_id ?? null,
      error: args.error ?? null,
      // delivery_status / delivery_updated_at are Half B's to write. Omitted
      // entirely (not set to null) so this module keeps working against a
      // schema where those columns don't exist yet — the sync-log
      // landed_status idiom.
    })
    if (error) console.warn('[notification-log] insert failed:', error.message)
  } catch (err) {
    console.warn('[notification-log] insert threw:', err)
  }
}

// ── Slack rail ────────────────────────────────────────────────────────────
// Slack has no equivalent of the resend layer to hook — postToSlack is called
// straight from the two lead routes — so this records a notifyNewLeadSlack
// outcome from the call site. Shared rather than inlined twice so the two
// sites can't drift.
//
// A SKIP IS NOT A SEND. notifyNewLeadSlack returns { skipped } for a location
// that never installed the Slack app (by far the common case) or whose columns
// predate the slack migration. Nothing was attempted, so nothing is recorded —
// otherwise every lead at every non-Slack location would mint a permanently
// unresolvable row and the Slack rail would read as broken rather than absent.
//
// delivery_status stays NULL on these rows FOREVER: there is no Slack delivery
// webhook, so unlike an email row it will never be filled in by Half B. Null
// here means "not applicable", not "pending".
export async function logSlackNotification(
  result: { ok: boolean; skipped?: string; error?: string },
  context: NotificationContext,
): Promise<void> {
  if (result.skipped) return
  await logNotification({
    ...context,
    channel: 'slack',
    send_status: result.ok ? 'accepted' : 'failed',
    error: result.error ?? null,
  })
}

// Fan a single Resend result out to one row per recipient. Sequential and
// awaited — volume is a handful of addresses, and Promise.all here would only
// add an unhandled-rejection surface to a module whose entire job is to not
// have one. Non-throwing by construction: logNotification already swallows.
export async function logNotificationFanout(
  recipients: string[],
  base: Omit<LogNotificationArgs, 'recipient'>,
): Promise<void> {
  for (const recipient of recipients) {
    await logNotification({ ...base, recipient })
  }
}
