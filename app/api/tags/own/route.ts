// app/api/tags/own/route.ts
//
// GET /api/tags/own?location_id=<uuid> — CLOSED 2026-11-13 (Settings slice 3).
//
// It listed a location's OWN tags (switched on and off), each with how many
// people carry it, for Settings › Tags (2026-10-16). That screen is closed
// while tags are rebuilt as their own project (a master list where each tag
// knows what kind of record it belongs to). This route served that screen and
// nothing else — its one caller was components/hive/OwnTagsSettings.jsx,
// which nothing mounts any more — so it refuses, for everyone, rather than
// sit open behind a page that is gone.
//
// 410 Gone, not 403: nobody is being told they lack permission. The answer is
// the same whoever asks and is given before anything is read, so it says
// nothing about any location.
//
// NOT closed, because other screens use them:
//   · /api/lead-tags, /api/partner-tags — putting a tag on a client or a
//     Network contact and taking it off (the Tags row on a record)
//   · /api/lookups — making a tag from that row's "+ Tag", and corporate's
//     Configure tab
//   · /api/tags/delete — corporate's Retired tags panel also calls it
//
// TO REOPEN: the read this route did (lookups by location, counted against
// lead_tags and partner_tags, with promoted copies marked) is in git at
// affc44b, the commit before this one.

import { NextResponse } from 'next/server'

export async function GET() {
  return NextResponse.json(
    {
      error: 'tags_settings_closed',
      message: 'Settings › Tags is closed while tags are being rebuilt. You can still add and remove tags on a client or a Network contact.',
    },
    { status: 410 },
  )
}
