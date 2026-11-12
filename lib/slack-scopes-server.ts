// lib/slack-scopes-server.ts
// The server half of lib/slack-scopes.ts: storing a correction Slack itself
// gave us. Kept apart so the shared file stays free of any database client.
//
// Called by lib/engagement-bees.ts (making a job's channel, adding or removing
// a bee, and the sweep) whenever a channel call comes back
// { ok:false, error:'missing_scope' }, so a workspace that removed the app or
// its permission reads as not-ready again and the owner sees the reconnect
// line, instead of Bee Hub believing a grant that is no longer there.
//
// Fail-soft by design: a failed read or write is logged (never with a token —
// this file never selects one) and reported back; it never throws into the
// caller's own request.

import { supabaseService } from '@/lib/supabase-service'
import { scopesAfterMissingScope } from '@/lib/slack-scopes'

export type MissingScopeResult =
  | { corrected: false; reason: 'not_missing_scope' | 'read_failed' | 'write_failed' | 'not_set_up_yet' }
  | { corrected: true; slack_scopes: string }

const columnMissing = (msg: string | undefined) =>
  !!msg && /slack_scopes/.test(msg) && /does not exist|schema cache/i.test(msg)

export async function recordSlackMissingScope(
  locationUuid: string,
  slackResponse: unknown,
): Promise<MissingScopeResult> {
  // Not a missing_scope answer → nothing to correct, no read at all.
  if (scopesAfterMissingScope(null, slackResponse) === null) {
    return { corrected: false, reason: 'not_missing_scope' }
  }

  try {
    const { data, error: readErr } = await supabaseService
      .from('locations')
      .select('slack_scopes')
      .eq('id', locationUuid)
      .maybeSingle()
    if (readErr) {
      if (columnMissing(readErr.message)) return { corrected: false, reason: 'not_set_up_yet' }
      console.error('[slack-scopes] read failed for', locationUuid, '—', readErr.message)
      return { corrected: false, reason: 'read_failed' }
    }

    const next = scopesAfterMissingScope((data as any)?.slack_scopes ?? null, slackResponse) ?? ''
    const { error: writeErr } = await supabaseService
      .from('locations')
      .update({ slack_scopes: next })
      .eq('id', locationUuid)
    if (writeErr) {
      if (columnMissing(writeErr.message)) return { corrected: false, reason: 'not_set_up_yet' }
      console.error('[slack-scopes] write failed for', locationUuid, '—', writeErr.message)
      return { corrected: false, reason: 'write_failed' }
    }
    return { corrected: true, slack_scopes: next }
  } catch (e: any) {
    console.error('[slack-scopes] correction failed for', locationUuid, '—', String(e?.message || e))
    return { corrected: false, reason: 'write_failed' }
  }
}
