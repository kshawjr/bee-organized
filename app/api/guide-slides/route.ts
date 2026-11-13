// app/api/guide-slides/route.ts
//
// GET and POST /api/guide-slides — CLOSED 2026-11-13.
//
// GET listed the Quick Start Guide's slides; POST saved them, and a save WIPED the
// guide_slides table and wrote the new set in its place. The Quick Start Guide is retired
// (its slides were out of date and are being replaced with help videos): the
// viewer and the editor are deleted, so nothing in Bee Hub calls this any
// more. Kevin is keeping the rows — 15 of them — to write the videos from.
// With no screen left to serve, the only thing this route could still do was
// destroy them, so it refuses, for everyone.
//
// 410 Gone, not 403: nobody is being told they lack permission. The answer is
// the same whoever asks and is given before anything is read — not the
// request, not the session, not the database — the same way /api/help-chat
// and /api/tags/own were closed.
//
// THE ROWS ARE NOT TOUCHED. Nothing here, and no migration, deletes from
// guide_slides. The page load (app/_hub-page.tsx) still reads the table
// directly; it never came through this route.
//
// TO REOPEN: the route as it was is in git at 722aaa0.

import { NextResponse } from 'next/server'

const CLOSED = {
  error: 'guide_slides_closed',
  message: 'The Quick Start Guide is retired. Its slides are kept, but they can no longer be read or changed here.',
}

export async function GET() {
  return NextResponse.json(CLOSED, { status: 410 })
}

export async function POST() {
  return NextResponse.json(CLOSED, { status: 410 })
}
