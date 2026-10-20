// lib/cron-log-lines.ts
// ─────────────────────────────────────────────────────────────
// The one line each cron writes on EVERY run — even when there was nothing to
// do (Kevin, 20 Oct 2026). A cron that logs only when it acts looks exactly
// like a dead one from a log search: other-cards was taken for never having
// run, when it had been firing every 5 minutes. failure-alerts already did
// this ("quiet window — 0 alerts"); these are the rest.
//
// Pure — the routes call them right before they return. A route file may only
// export its handlers and config, so the words live here.
// ─────────────────────────────────────────────────────────────

export function otherCardsLine(r: { checked: number; retired: number; reposted: number; failed: number }): string {
  return `[cron other-cards] checked ${r.checked}, retired ${r.retired}, reposted ${r.reposted}` + (r.failed ? `, failed ${r.failed}` : '')
}

type SendCounts = { sent: number; skipped: number; failed: number; considered: number }
export function sendDripsLine(r: { drips: SendCounts; welcome: SendCounts; stage: SendCounts; held: number }): string {
  const part = (label: string, c: SendCounts) => `${label} ${c.sent} sent / ${c.skipped} skipped / ${c.failed} failed of ${c.considered}`
  return `[cron send-drips] ${part('drips', r.drips)}; ${part('welcome', r.welcome)}; ${part('stage', r.stage)}; held ${r.held}`
}

export function gmailSyncLine(r: { accountsEnabled: number; accountsSynced: number; accountsFailed: unknown[]; circuitOpen: unknown[]; skippedForTime: unknown[]; elapsedMs: number }): string {
  return `[cron gmail-sync] accounts ${r.accountsEnabled}, synced ${r.accountsSynced}, failed ${r.accountsFailed.length}, ` +
    `circuit open ${r.circuitOpen.length}, out of time ${r.skippedForTime.length}, ${r.elapsedMs}ms`
}

export function zohoTopupLine(r: { locations: number; planned: number; inserted: number; errors: number }): string {
  return `[cron zoho-recipient-topup] locations ${r.locations}, planned ${r.planned}, inserted ${r.inserted}, errors ${r.errors}`
}

export function importSweeperQuietLine(): string {
  return '[import-sweeper] checked 0, resumed 0 — no stalled imports'
}
