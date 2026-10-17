// lib/assessment-type-record.ts
//
// Records the in-person/virtual choice of a Bee Hub send on our assessments
// row (assessments.assessment_type — migrations/assessment_type.sql).
//
// WHY THE SEND WRITES THE ROW ITSELF
//   Our assessments rows are a mirror the Jobber webhook builds from the
//   request, usually a few seconds AFTER the send has answered. An
//   "update where jobber_assessment_id = X" from the send would match nothing
//   most of the time and the choice would be lost. So the send writes the
//   mirror rows first, through the SAME upserts the webhook uses
//   (upsertServiceRequest → keyed on location+jobber_request_id;
//   upsertAssessment → keyed on service_request_id), then stamps the type.
//   Whichever lands first, both write the same two rows, and
//   upsertAssessment's payload never carries assessment_type, so the
//   webhook's later pass can't wipe it (pinned in assessment-type.test.ts).
//
//   Founding is untouched: the pre-written request row has no engagement, so
//   the webhook's ensureEngagementForServiceRequest founds (or adopts) exactly
//   as it does today. A send on a founded engagement passes the request row
//   it already pre-wrote and attached.
//
// Non-fatal by contract: the Jobber side has already succeeded. A failure
// here returns the reason for the caller to log; it never fails the send.

import { supabaseService } from '@/lib/supabase-service'
import { upsertServiceRequest, upsertAssessment } from '@/lib/jobber-import'
import { isAssessmentType } from '@/lib/assessment-type'

export async function recordSentAssessmentType(args: {
  assessmentType: unknown
  requestRec: any                 // requestCreate's request (id, title, client, property…)
  jobberAssessmentGlobalId: string
  startAtIso: string
  leadId: string
  locationSlug: string
  serviceRequestId?: string | null // already pre-written (founded-engagement send)
}): Promise<{ ok: true; assessmentRowId: string } | { ok: false; reason: string }> {
  const { assessmentType, requestRec, jobberAssessmentGlobalId, startAtIso, leadId, locationSlug } = args
  if (!isAssessmentType(assessmentType)) return { ok: false, reason: 'no assessment type on the send' }
  try {
    let srId = args.serviceRequestId || null
    if (!srId) {
      // The request now HAS an assessment: say so, so determineStage gives
      // the same SR stage the webhook's pass will (never a downgrade if the
      // webhook got here first).
      const sr = await upsertServiceRequest(
        { ...requestRec, _hasAssessment: true },
        leadId,
        locationSlug,
        { promoteLead: false },
      )
      srId = sr.id
    }
    const a = await upsertAssessment(
      { id: requestRec.id, assessment: { id: jobberAssessmentGlobalId, startAt: startAtIso } },
      srId!,
      leadId,
      locationSlug,
    )
    const { error } = await supabaseService
      .from('assessments')
      .update({ assessment_type: assessmentType })
      .eq('id', a.id)
    if (error) return { ok: false, reason: `assessment_type write: ${error.message}` }
    return { ok: true, assessmentRowId: a.id }
  } catch (err: any) {
    return { ok: false, reason: err?.message || String(err) }
  }
}
