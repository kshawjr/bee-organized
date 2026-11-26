// FL-75 slice 7: where "Bring people in from Mailchimp" is switched on.
// Test Location only (Kevin, 2026-11-26). Chattanooga is not touched; it gets
// this when Kevin adds it here. Safe to import from the browser: no database.
export const PULL_PILOT_LOCATIONS: readonly string[] = [
  'a8fe17f6-fd16-4ed3-8730-550a65d69ad6', // Test Location
]
export function pullAllowed(locationUuid: string | null | undefined): boolean {
  return !!locationUuid && PULL_PILOT_LOCATIONS.includes(locationUuid)
}
