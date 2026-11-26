// lib/mailchimp-connection-write.ts
//
// FL-75 slice 6 (2026-11-26): THE ONLY PLACE the Mailchimp connection on a
// location is written — the account (token, server prefix, account name,
// connected flag) and the audience (list id). Every route that changes them
// calls one of the three functions below; none writes those columns itself.
// lib/beta-mailchimp-connection-clears.test.ts scans the whole app and fails if
// any other file does.
//
// WHY. The first-sync confirmation is the guard built after the Chattanooga
// incident (19 people added to an audience without anyone meaning it). It is
// asked until locations.mailchimp_first_sync_at is set. If that date survived
// a change of audience, the NEW audience would get no confirmation at all. A
// review of who goes to one audience is not a review of who goes to another,
// so mailchimp_review_done_at goes too. Both dates are cleared IN THE SAME
// UPDATE as the change itself, so there is no moment where the new connection
// exists with the old dates.
//
//   saveAudience     a DIFFERENT audience id → id, name and both dates cleared
//                    the SAME id saved again → the name only; nothing cleared
//   saveConnection   connect / reconnect (even to the same audience) → cleared
//   clearConnection  disconnect → cleared
//
// HOW "DIFFERENT" IS TOLD FROM "THE SAME AGAIN": by the database, in one
// statement. The clearing update only matches the row when its stored
// mailchimp_list_id is empty or not equal to the new id
// (WHERE id = … AND (mailchimp_list_id IS NULL OR mailchimp_list_id <> new)).
// If it matched nothing, the id was already the same, and a second update
// that only matches mailchimp_list_id = new sets the name. No read-then-write,
// so two presses at once cannot slip a change past the clear.
//
// WHAT THIS CANNOT STOP: a change made outside the app (SQL in the Supabase
// editor, a script). Only a database trigger closes that, and that needs a
// migration.

import { supabaseService } from './supabase-service'

// Mailchimp audience ids are short letters and digits ("1ca3539eea"). Anything
// else is refused rather than put into a filter.
const LIST_ID = /^[A-Za-z0-9_-]{1,64}$/

type Before = { listId: string | null; listName: string | null; hadProgress: boolean }

// What was there, for the owner's message only. The decision to clear is made
// by the update itself, never by this read.
async function before(db: any, locationUuid: string): Promise<Before> {
  const r = await db.from('locations')
    .select('mailchimp_list_id, mailchimp_list_name, mailchimp_review_done_at, mailchimp_first_sync_at')
    .eq('id', locationUuid).maybeSingle()
  const d: any = r?.error ? null : r?.data
  return {
    listId: d?.mailchimp_list_id ?? null,
    listName: d?.mailchimp_list_name ?? null,
    hadProgress: !!(d?.mailchimp_review_done_at || d?.mailchimp_first_sync_at),
  }
}

export type AudienceSaved =
  | { ok: true; changed: boolean; progressReset: boolean; previousName: string | null }
  | { ok: false; error: 'bad_list_id' | 'save_failed' | 'location_not_found' }

export async function saveAudience(locationUuid: string, chosen: { id: string; name: string }, deps: { db?: any; now?: () => Date } = {}): Promise<AudienceSaved> {
  const db = deps.db || supabaseService
  if (!LIST_ID.test(chosen.id)) return { ok: false, error: 'bad_list_id' }
  const at = (deps.now ? deps.now() : new Date()).toISOString()
  const was = await before(db, locationUuid)

  // A different audience (or none before): the id, the name, and BOTH dates
  // cleared, in one statement that only matches when the id really differs.
  const change = await db.from('locations')
    .update({
      mailchimp_list_id: chosen.id,
      mailchimp_list_name: chosen.name,
      mailchimp_review_done_at: null,
      mailchimp_first_sync_at: null,
      updated_at: at,
    })
    .eq('id', locationUuid)
    .or(`mailchimp_list_id.is.null,mailchimp_list_id.neq.${chosen.id}`)
    .select('id')
  if (change?.error) return { ok: false, error: 'save_failed' }
  if ((change?.data || []).length === 1) {
    return { ok: true, changed: true, progressReset: was.hadProgress, previousName: was.listId ? was.listName : null }
  }

  // The same audience saved again: its name may have changed in Mailchimp;
  // nothing else is touched.
  const same = await db.from('locations')
    .update({ mailchimp_list_name: chosen.name, updated_at: at })
    .eq('id', locationUuid)
    .eq('mailchimp_list_id', chosen.id)
    .select('id')
  if (same?.error) return { ok: false, error: 'save_failed' }
  if ((same?.data || []).length !== 1) return { ok: false, error: 'location_not_found' }
  return { ok: true, changed: false, progressReset: false, previousName: null }
}

export type ConnectionSaved = { ok: true; progressReset: boolean } | { ok: false; error: string }

// Connect, or connect again — even to the same account and audience. A new
// connection is not the one the review and first sync were made under.
export async function saveConnection(locationUuid: string, account: { accessToken: string; serverPrefix: string; accountName: string | null }, deps: { db?: any; now?: () => Date } = {}): Promise<ConnectionSaved> {
  const db = deps.db || supabaseService
  const at = (deps.now ? deps.now() : new Date()).toISOString()
  const was = await before(db, locationUuid)
  const res = await db.from('locations')
    .update({
      mailchimp_access_token: account.accessToken,
      mailchimp_server_prefix: account.serverPrefix,
      mailchimp_account_name: account.accountName || null,
      mailchimp_connected: true,
      mailchimp_connected_at: at,
      mailchimp_review_done_at: null,
      mailchimp_first_sync_at: null,
      updated_at: at,
    })
    .eq('id', locationUuid)
  if (res?.error) return { ok: false, error: String(res.error.message || 'save_failed') }
  return { ok: true, progressReset: was.hadProgress }
}

// Disconnect: the account, the audience, Kevin's switch (always toward off),
// and both dates.
export async function clearConnection(locationUuid: string, deps: { db?: any; now?: () => Date } = {}): Promise<ConnectionSaved> {
  const db = deps.db || supabaseService
  const at = (deps.now ? deps.now() : new Date()).toISOString()
  const was = await before(db, locationUuid)
  const res = await db.from('locations')
    .update({
      mailchimp_access_token: null,
      mailchimp_server_prefix: null,
      mailchimp_account_name: null,
      mailchimp_list_id: null,
      mailchimp_list_name: null,
      mailchimp_connected: false,
      mailchimp_connected_at: null,
      mailchimp_sync_live: false,
      mailchimp_review_done_at: null,
      mailchimp_first_sync_at: null,
      updated_at: at,
    })
    .eq('id', locationUuid)
  if (res?.error) return { ok: false, error: String(res.error.message || 'disconnect_failed') }
  return { ok: true, progressReset: was.hadProgress }
}
