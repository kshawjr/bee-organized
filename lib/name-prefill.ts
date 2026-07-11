// Onboarding profile prefill — splits a stored full name into form fields.
// The invite pipeline stores only full_name (pending_invites → hub_users at
// accept; first_name/last_name stay null until the user saves their profile),
// so the profile step derives its prefill from the full name.
//
// Rules:
// - first word → firstName, EVERYTHING else → lastName, so multi-word last
//   names survive ("Mary Jo Van Der Berg" → "Mary" / "Jo Van Der Berg")
// - email-shaped input means full_name never existed (page.tsx falls back to
//   email for display) → no prefill; the form shows its placeholders
// - 'there' is the OnboardingScreen default prop, not a name → no prefill
export function splitNameForPrefill(fullName?: string | null): { firstName: string; lastName: string } {
  const raw = (fullName || '').trim()
  if (!raw || raw === 'there' || raw.includes('@')) return { firstName: '', lastName: '' }
  const parts = raw.split(/\s+/)
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') }
}
