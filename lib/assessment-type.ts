// lib/assessment-type.ts
//
// In-person vs virtual assessments — the one place the values, the starting
// choice on the Send to Jobber screen, and the note Jobber receives live.
//
// Stored in two columns (migrations/assessment_type.sql):
//   locations.default_assessment_type — the location's default (Settings)
//   assessments.assessment_type       — what was chosen when Bee Hub sent it;
//                                       NULL = not recorded (made in Jobber, or
//                                       sent before this shipped)
// The Jobber import/webhook (upsertAssessment) never writes the second one.

export const ASSESSMENT_TYPES = ['in-person', 'virtual'] as const
export type AssessmentType = (typeof ASSESSMENT_TYPES)[number]

export function isAssessmentType(v: unknown): v is AssessmentType {
  return v === 'in-person' || v === 'virtual'
}

// The send screen's starting choice: the client's own type, else the
// location default, else in-person. Anything that isn't a real type (null,
// a typo, an old value) is skipped, never shown.
export function resolveAssessmentType(
  clientType: unknown,
  locationDefault: unknown,
): AssessmentType {
  if (isAssessmentType(clientType)) return clientType
  if (isAssessmentType(locationDefault)) return locationDefault
  return 'in-person'
}

// Jobber AssessmentCreateInput.instructions — the only place the field team
// sees the type. In-person sends nothing (undefined → the key is left out),
// so an in-person send is byte-for-byte what it was before.
export const VIRTUAL_ASSESSMENT_INSTRUCTIONS = 'Virtual assessment — no site visit required.'

export function assessmentInstructions(type: unknown): string | undefined {
  return type === 'virtual' ? VIRTUAL_ASSESSMENT_INSTRUCTIONS : undefined
}
