// lib/live-job-reopen-footprint.ts
// ─────────────────────────────────────────────────────────────
// The live-job-on-closed-card fix (2026-11-21) added lines to two files that
// older tests pin byte for byte (bees-row, twin-cards, client-files-tab).
// Those pins stay as they were: this takes exactly the new lines back out
// first, so each pin still proves that NOTHING ELSE in those files changed.
//
// Every step must find its text exactly once, or this throws: a file that
// moves on without updating these steps fails loudly instead of being
// fingerprinted wrongly.
// ─────────────────────────────────────────────────────────────

type Step = [string, string]
const STEPS: Record<string, Step[]> = {
  'lib/jobber-webhook-handlers.ts': [
    ['  reopenIfClosedByJobDeletion,\n  reopenIfMachineClosedForLiveJob,\n', '  reopenIfClosedByJobDeletion,\n'],
    ["      // A live job on a card a machine closed (stale at import, quote\n      // archived): reopen it (Kevin, 2026-11-21). A person's close and a Won\n      // are never touched (lib/live-job-on-closed-card.ts).\n      await reopenIfMachineClosedForLiveJob(engId)\n", ''],
  ],
  'components/hive/ClientProfile.jsx': [
    ["import { NEW_JOB_NOTE } from '@/lib/live-job-on-closed-card'\n", ''],
    ['  // A card with a new job in Jobber (ruling 2, 2026-11-21) is never folded\n  // away under "Show more closed": it is the one row the owner must see.\n  const closedVisible = showClosed ? closed : closed.filter((e, i) => i < 2 || e.new_job_in_jobber)\n', '  const closedVisible = showClosed ? closed : closed.slice(0, 2)\n'],
    ["opacity: e.new_job_in_jobber ? 1 : 0.65 }}>", 'opacity: 0.65 }}>'],
    ['          {closed.length > closedVisible.length && (', '          {closed.length > 2 && !showClosed && ('],
    ['              Show {closed.length - closedVisible.length} more closed', '              Show {closed.length - 2} more closed'],
    ["                {/* Ruling 2 (2026-11-21): a person closed this card and Jobber\n                    has a live job made after that. Bee Hub never reopens it on\n                    its own; the Reopen beside the row is the one tap. */}\n                {e.new_job_in_jobber && (\n                  <span data-new-job-note=\"1\" role=\"status\" style={{ fontSize: '12px', fontWeight: 600, color: T.state.warning.fg, paddingLeft: '20px' }}>\n                    {NEW_JOB_NOTE}{!readOnly ? ' Reopen the card if they are back.' : ''}\n                  </span>\n                )}\n", ''],
  ],
}

export function withoutLiveJobReopen(path: string, src: string): string {
  let out = src
  for (const [from, to] of STEPS[path] || []) {
    const n = out.split(from).length - 1
    if (n !== 1) throw new Error(`live-job-reopen-footprint: ${path} has its step ${n} times, expected once: ${from.slice(0, 60)}`)
    out = out.replace(from, to)
  }
  return out
}
