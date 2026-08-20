// lib/gmail-cron.ts
//
// Gmail sync step 5 — the scheduled CALLER. It adds no engine logic:
// syncMailbox is reused exactly as-is (its sync_enabled gate still holds
// even for rows this selector misses, and the history cursor still only
// advances on complete runs — which is what makes skipping safe here).
//
// Accounts run SEQUENTIALLY — Gmail rate limits are per-project, and a
// fan-out across 50 mailboxes would trip them.
//
// One account throwing must not abort the run: the error lands in that
// row's last_error / error_count and the loop continues. error_count
// >= CIRCUIT_BREAKER_THRESHOLD opens the circuit — the account is
// skipped without a Gmail call until the count is reset, so a mailbox
// failing every 5 minutes forever cannot bury a real failure.
//
// Report and logs carry COUNTS and account ids only — never email
// addresses, subjects, or bodies.

import { syncMailbox as defaultSyncMailbox, GmailSyncReport } from './gmail-sync'
import { supabaseService } from './supabase-service'

export const CIRCUIT_BREAKER_THRESHOLD = 10
// Overall run fits Vercel's 60s: hard budget 55s, no new account starts
// past 45s, and each account gets a slice so one slow mailbox cannot
// starve the rest.
export const CRON_TOTAL_BUDGET_MS = 55_000
export const CRON_START_CUTOFF_MS = 45_000
export const CRON_PER_ACCOUNT_BUDGET_MS = 20_000

export interface GmailCronAccountResult {
  accountId: string
  ok: boolean
  mode: GmailSyncReport['mode']
  capHit: boolean
  cursorAdvanced: boolean
  messagesScanned: number
  threadsWritten: number
  messagesWritten: number
  attachmentsWritten: number
}

export interface GmailCronReport {
  ran: boolean
  accountsEnabled: number
  accountsSynced: number
  accountsFailed: string[]
  circuitOpen: string[]
  skippedForTime: string[]
  results: GmailCronAccountResult[]
  elapsedMs: number
}

// Test seam only.
export interface GmailCronDeps {
  supabase?: any
  syncMailbox?: typeof defaultSyncMailbox
}

export interface GmailCronOptions {
  totalBudgetMs?: number
  startCutoffMs?: number
  perAccountBudgetMs?: number
  deps?: GmailCronDeps
}

export async function runScheduledGmailSync(opts: GmailCronOptions = {}): Promise<GmailCronReport> {
  const start = Date.now()
  const supabase = opts.deps?.supabase ?? supabaseService
  const sync = opts.deps?.syncMailbox ?? defaultSyncMailbox
  const totalBudgetMs = opts.totalBudgetMs ?? CRON_TOTAL_BUDGET_MS
  const startCutoffMs = opts.startCutoffMs ?? CRON_START_CUTOFF_MS
  const perAccountBudgetMs = opts.perAccountBudgetMs ?? CRON_PER_ACCOUNT_BUDGET_MS
  const elapsed = () => Date.now() - start

  // Oldest-synced first (nulls first), so accounts starved by a previous
  // time cutoff are at the front of the next run.
  const { data: accounts, error } = await supabase
    .from('email_accounts')
    .select('id, error_count, last_error')
    .eq('sync_enabled', true)
    .order('last_synced_at', { ascending: true, nullsFirst: true })
  if (error) {
    throw new Error(`gmail-cron email_accounts select failed: ${error.message}`)
  }

  const report: GmailCronReport = {
    ran: true,
    accountsEnabled: accounts?.length ?? 0,
    accountsSynced: 0,
    accountsFailed: [],
    circuitOpen: [],
    skippedForTime: [],
    results: [],
    elapsedMs: 0,
  }
  if (!accounts || accounts.length === 0) {
    report.elapsedMs = elapsed()
    return report
  }

  for (const account of accounts) {
    const accountId = String(account.id)
    if ((account.error_count ?? 0) >= CIRCUIT_BREAKER_THRESHOLD) {
      report.circuitOpen.push(accountId)
      continue
    }
    // Not an error: the cursor only advances on success, so the next
    // run picks these up (and the ordering puts them first).
    if (elapsed() > startCutoffMs) {
      report.skippedForTime.push(accountId)
      continue
    }
    const budget = Math.min(perAccountBudgetMs, totalBudgetMs - elapsed())
    try {
      const result = await sync(accountId, { timeBudgetMs: budget })
      report.accountsSynced++
      report.results.push({
        accountId,
        ok: true,
        mode: result.mode,
        capHit: result.capHit,
        cursorAdvanced: result.cursorAdvancedTo !== null,
        messagesScanned: result.messagesScanned,
        threadsWritten: result.threadsWritten,
        messagesWritten: result.messagesWritten,
        attachmentsWritten: result.attachmentsWritten,
      })
      if ((account.error_count ?? 0) !== 0 || account.last_error) {
        const { error: resetErr } = await supabase
          .from('email_accounts')
          .update({ error_count: 0, last_error: null, updated_at: new Date().toISOString() })
          .eq('id', accountId)
        if (resetErr) {
          // A failed reset shouldn't fail the run; surface via the row next time.
          console.error('[gmail-cron] error_count reset failed for account', accountId)
        }
      }
    } catch (err: any) {
      report.accountsFailed.push(accountId)
      report.results.push({
        accountId,
        ok: false,
        mode: null,
        capHit: false,
        cursorAdvanced: false,
        messagesScanned: 0,
        threadsWritten: 0,
        messagesWritten: 0,
        attachmentsWritten: 0,
      })
      // last_error may quote a Gmail/PostgREST diagnostic (never a
      // subject or body); it lives only on the account's own row.
      const message = String(err?.message ?? err).slice(0, 500)
      const { error: markErr } = await supabase
        .from('email_accounts')
        .update({
          last_error: message,
          error_count: (account.error_count ?? 0) + 1,
          updated_at: new Date().toISOString(),
        })
        .eq('id', accountId)
      if (markErr) {
        console.error('[gmail-cron] error mark failed for account', accountId)
      }
    }
  }

  report.elapsedMs = elapsed()
  return report
}
