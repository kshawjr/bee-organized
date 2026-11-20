// lib/network/route-access.ts
// ─────────────────────────────────────────────────────────────
// Network & Nurture — WHO MAY DO WHAT, ON THE SERVER, once Network is open to
// them. Every Network route asks this file and nothing else.
//
// TWO QUESTIONS, ALWAYS IN THIS ORDER:
//   1. The gate (lib/network/access.ts maySeeNewNetwork): may this role see
//      the new Network at all? Today: super admins only. THIS FILE DOES NOT
//      WIDEN IT. Kevin un-greys Network as its own decision.
//   2. This file: for the location the RECORD belongs to, may this person read
//      it, write it, or see every location?
// Behind the closed gate question 2 only ever meets a super admin, who may do
// everything. It is built and tested now so that the day the gate widens,
// owners land on rules that were already proven.
//
// THE LOCATION COMES FROM THE RECORD, NEVER FROM THE BROWSER. A route that is
// handed an id reads the row first and asks about the row's own location. A
// location named in a request body is only ever the location the work is
// done at; it is checked here, and the work then stays inside it (bulk
// actions re-read every row and refuse one from anywhere else).
//
// ANOTHER LOCATION'S RECORD IS "NOT FOUND", not "forbidden": an owner who
// guesses an id learns nothing, not even that it exists.
//
// THE ROLES (hub_users.role):
//   super_admin  everything, every location
//   admin        CORPORATE: one account, tied to no location. Reads AND
//                changes every location's Network (Kevin, 2026-11-20: "give
//                them the same write access they would need to fix a
//                location's Network data"). Like everywhere else in Bee Hub, a
//                paused location does not stop corporate. The All locations
//                overview stays a report: it has no way to change anything,
//                for anyone.
//   owner        own location: read and write
//   manager      own location: read and write (the same as lib/crm canWriteLocation)
//   lite_user    own location: read only. The ONE exception is a follow-up,
//                which is a reminder to yourself and changes nothing about the
//                person (Kevin, 2026-11-20): mayRemindNetworkLocation, the same
//                rule as the shared Reminders page (/api/reminders).
//   anything else: nothing
// A PAUSED or inactive location is read-only for everyone below super admin:
// writes also pass lib/read-only-access readOnlyWriteBlock, the guard the
// shared lead-tags route uses.
// ─────────────────────────────────────────────────────────────

import type { Caller } from '../crm'

// Kevin's ruling (2026-11-20, answer B): corporate can change Network records.
export const CORPORATE_MAY_WRITE_NETWORK = true

const OWN_LOCATION_READERS = new Set(['owner', 'manager', 'lite_user'])
const OWN_LOCATION_WRITERS = new Set(['owner', 'manager'])

type Who = Pick<Caller, 'role' | 'locationId'>

const same = (a: unknown, b: unknown) =>
  typeof a === 'string' && typeof b === 'string' && a !== '' && a.toLowerCase() === b.toLowerCase()

/** May see every location at once (the All locations list, the overview). Never an owner. */
export function maySeeAllNetworkLocations(who: Who): boolean {
  return who.role === 'super_admin' || who.role === 'admin'
}

/** May read Network records that belong to this location. */
export function mayReadNetworkLocation(who: Who, locationUuid: unknown): boolean {
  if (typeof locationUuid !== 'string' || !locationUuid) return false
  if (maySeeAllNetworkLocations(who)) return true
  return OWN_LOCATION_READERS.has(who.role) && same(who.locationId, locationUuid)
}

/** May change Network records that belong to this location (before the paused-location guard). */
export function mayWriteNetworkLocation(who: Who, locationUuid: unknown): boolean {
  if (typeof locationUuid !== 'string' || !locationUuid) return false
  if (who.role === 'super_admin') return true
  if (who.role === 'admin') return CORPORATE_MAY_WRITE_NETWORK
  return OWN_LOCATION_WRITERS.has(who.role) && same(who.locationId, locationUuid)
}

/**
 * The answer a write route gives for a record at `locationUuid`:
 *   'ok'         go on (then the paused-location guard)
 *   'not_found'  the caller may not even read it: answer exactly as for a missing id
 *   'read_only'  the caller may read it but not change it: 403
 */
export function networkWriteVerdict(who: Who, locationUuid: unknown): 'ok' | 'not_found' | 'read_only' {
  if (mayWriteNetworkLocation(who, locationUuid)) return 'ok'
  return mayReadNetworkLocation(who, locationUuid) ? 'read_only' : 'not_found'
}

/**
 * May set a follow-up (a reminder) on a Network person at this location.
 * A reminder is a note to yourself, not a change to the person, so this is
 * the READ rule: anyone who may read the person may remind themselves about
 * them, read-only seats and paused locations included. It matches
 * /api/reminders (canReadLocation); lib/network/rulings-2026-11-20.test.ts
 * drives both routes and pins that they agree.
 */
export function mayRemindNetworkLocation(who: Who, locationUuid: unknown): boolean {
  return mayReadNetworkLocation(who, locationUuid)
}

export const READ_ONLY_ANSWER = { error: 'forbidden_read_only' } as const
