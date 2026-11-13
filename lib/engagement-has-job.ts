// lib/engagement-has-job.ts
// ─────────────────────────────────────────────────────────────
// A CHANNEL IS FOR A JOB, NOT A REQUEST (2026-11-12).
//
// "Has a job" means: at least one row in `jobs` attached to this deal, with
// a Jobber job id, that is not deleted. It is the SAME test the crew mirror
// uses to find the jobs whose visits it reads (lib/jobber-crew-mirror.ts) —
// on purpose: a channel is only worth making where the mirror has something
// to fill it from. A deal with no such job has no visits, so no crew, ever;
// its channel would hold the owner and nothing else, and the job card would
// be spent before there was a job to describe.
//
// NOT the stage name. A stage is a label that people and several code paths
// move by hand (a deal can sit at "Job in Progress" with its only job
// deleted, or at "Quote" with a job already made in Jobber); the job row is
// the fact. The first two channels ever made in production by hand were on
// deals at Request with no job at all.
//
//   true      it has one
//   false     it has none
//   'unknown' the read failed — callers treat that as NO (fail closed)
// One read, no write. Used by createJobChannel (lib/engagement-bees.ts — the
// one function the Slack mark's route and automatic channels both call) and
// by the panel's data route, so the screen and the server agree.
// ─────────────────────────────────────────────────────────────
import { isDeletedJob } from '@/components/hive/shared/jobDeleted'

type Db = { from: (table: string) => any }

export async function engagementHasJob(db: Db, engagementId: string): Promise<boolean | 'unknown'> {
  try {
    const { data, error } = await db.from('jobs').select('jobber_job_id, status').eq('engagement_id', engagementId).not('jobber_job_id', 'is', null)
    if (error) { console.warn('[engagement-has-job] jobs not read for', engagementId, '—', error.message); return 'unknown' }
    return ((data || []) as any[]).some(j => !isDeletedJob(j))
  } catch (e: any) {
    console.warn('[engagement-has-job] jobs not read for', engagementId, '—', e?.name || 'error')
    return 'unknown'
  }
}
