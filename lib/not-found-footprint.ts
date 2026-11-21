// lib/not-found-footprint.ts
// ─────────────────────────────────────────────────────────────
// The 2026-11-21 pass ("not found, never forbidden", and a touchpoint's card
// must be its own client's card at the same location) changed files that
// older tests pin byte for byte. Those pins stay as they were: this takes
// exactly these lines back out first, so each pin still proves that NOTHING
// ELSE in those files changed. Apply it BEFORE the older footprints
// (click-away, owner-safe), which expect the text as it was before today.
//
// Every step must find its text exactly once, in order, or this throws.
// ─────────────────────────────────────────────────────────────

type Step = [string, string]
const STEPS: Record<string, Step[]> = {
  "app/api/companies/[id]/referrals/route.ts": [
    [
      "  if (!canReadLocation(caller, company.location_id)) {\n    return NextResponse.json({ error: 'company_not_found' }, { status: 404 })\n  }\n",
      "  if (!canReadLocation(caller, company.location_id)) {\n    return NextResponse.json({ error: 'forbidden' }, { status: 403 })\n  }\n"
    ],
    [
      "  // Anything the caller may not see answers exactly like a missing record\n  // (2026-11-21): a guessed id learns nothing, not even that it is real.\n",
      ""
    ]
  ],
  "app/api/companies/[id]/route.ts": [
    [
      "\n  const existing = await loadRow(id)\n  if (!existing) {\n    return NextResponse.json({ error: 'company_not_found' }, { status: 404 })\n  }\n  // Anything the caller may not see answers exactly like a missing record\n  // (2026-11-21): a guessed id learns nothing, not even that it is real.\n  if (!canReadLocation(caller, existing.location_id)) {\n    return NextResponse.json({ error: 'company_not_found' }, { status: 404 })\n  }\n  if (!canWriteLocation(caller, existing.location_id)) {\n    return NextResponse.json({ error: 'forbidden' }, { status: 403 })\n  }\n\n  const purge = request.nextUrl.searchParams.get('purge')\n",
      "\n  const existing = await loadRow(id)\n  if (!existing) {\n    return NextResponse.json({ error: 'company_not_found' }, { status: 404 })\n  }\n  if (!canWriteLocation(caller, existing.location_id)) {\n    return NextResponse.json({ error: 'forbidden' }, { status: 403 })\n  }\n\n  const purge = request.nextUrl.searchParams.get('purge')\n"
    ],
    [
      "    return NextResponse.json({ error: 'company_not_found' }, { status: 404 })\n  }\n  // Anything the caller may not see answers exactly like a missing record\n  // (2026-11-21): a guessed id learns nothing, not even that it is real.\n  if (!canReadLocation(caller, existing.location_id)) {\n",
      ""
    ],
    [
      "  if (!canReadLocation(caller, (data as any).location_id)) {\n    return NextResponse.json({ error: 'company_not_found' }, { status: 404 })\n  }\n",
      "  if (!canReadLocation(caller, (data as any).location_id)) {\n    return NextResponse.json({ error: 'forbidden' }, { status: 403 })\n  }\n"
    ],
    [
      "  // Anything the caller may not see answers exactly like a missing record\n  // (2026-11-21): a guessed id learns nothing, not even that it is real.\n",
      ""
    ]
  ],
  "app/api/companies/[id]/touchpoints/route.ts": [
    [
      "  if (!canReadLocation(caller, company.location_id)) {\n    return NextResponse.json({ error: 'company_not_found' }, { status: 404 })\n  }\n",
      "  if (!canReadLocation(caller, company.location_id)) {\n    return NextResponse.json({ error: 'forbidden' }, { status: 403 })\n  }\n"
    ],
    [
      "  // Anything the caller may not see answers exactly like a missing record\n  // (2026-11-21): a guessed id learns nothing, not even that it is real.\n",
      ""
    ]
  ],
  "app/api/companies/route.ts": [
    [
      "\n  // Anything the caller may not see answers exactly like a missing record\n  // (2026-11-21): a guessed id learns nothing, not even that it is real.\n  if (!canReadLocation(caller, locationId)) {\n    return NextResponse.json({ error: 'location_not_found' }, { status: 404 })\n  }\n  if (!canWriteLocation(caller, locationId)) {\n",
      "\n  if (!canWriteLocation(caller, locationId)) {\n"
    ],
    [
      "    return NextResponse.json({ error: 'location_not_found' }, { status: 404 })\n",
      "    return NextResponse.json({ error: 'forbidden' }, { status: 403 })\n"
    ],
    [
      "  // Anything the caller may not see answers exactly like a missing record\n  // (2026-11-21): a guessed id learns nothing, not even that it is real.\n",
      ""
    ]
  ],
  "app/api/lookups/[id]/route.ts": [
    [
      "      // Missing, or another location's own tag: not found (2026-11-21).\n      if (!row || !maySeeLookup(hubUser as any, row as any)) return NextResponse.json({ error: 'Lookup not found' }, { status: 404 })\n      if (!canManageLocationTag(hubUser as any, row as any)) {\n",
      "      if (!row || !canManageLocationTag(hubUser as any, row as any)) {\n"
    ],
    [
      "\n    const locationTagEditor = !corporate && canManageLocationTag(hubUser as any, row as any)\n",
      "\n    const corporate = hubUser.role === 'super_admin' || hubUser.role === 'admin'\n    const locationTagEditor = !corporate && canManageLocationTag(hubUser as any, row as any)\n"
    ],
    [
      "    const corporate = hubUser.role === 'super_admin' || hubUser.role === 'admin'\n    // Another location's own tag answers exactly like a missing one\n    // (2026-11-21): a guessed id learns nothing, not even that it is real.\n    if (!row || !maySeeLookup(hubUser as any, row as any)) return NextResponse.json({ error: 'Lookup not found' }, { status: 404 })\n",
      "    if (!row) return NextResponse.json({ error: 'Lookup not found' }, { status: 404 })\n"
    ],
    [
      "\n// Who may SEE a tag: corporate sees every one; anyone else sees corporate tags\n// (no location) and their own location's.\nconst maySeeLookup = (hubUser: { role: string; location_id: string | null }, row: { location_id: string | null }) =>\n  hubUser.role === 'super_admin' || hubUser.role === 'admin' || !row.location_id || row.location_id === hubUser.location_id\n",
      ""
    ]
  ],
  "app/api/lookups/route.ts": [
    [
      "        return NextResponse.json({ error: 'location_not_found' }, { status: 404 })\n",
      "        return NextResponse.json({ error: 'forbidden_wrong_location' }, { status: 403 })\n"
    ],
    [
      "      // Another location answers exactly like one that does not exist\n      // (2026-11-21): a guessed id learns nothing.\n",
      ""
    ]
  ],
  "app/api/network/import/route.ts": [
    [
      "  // Another location answers like one that does not exist, as every Network\n  // write route does (2026-11-21).\n  if (!mayReadNetworkLocation(caller, locationId)) return NextResponse.json({ error: 'location_not_found' }, { status: 404 })\n",
      "  if (!mayReadNetworkLocation(caller, locationId)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })\n"
    ]
  ],
  "app/api/network/list/route.ts": [
    [
      "    return NextResponse.json({ error: 'location_not_found' }, { status: 404 })\n",
      "    return NextResponse.json({ error: 'forbidden' }, { status: 403 })\n"
    ],
    [
      "  // Another location answers like one that does not exist, as every Network\n  // write route does (2026-11-21).\n",
      ""
    ]
  ],
  "app/api/network/nurturing/route.ts": [
    [
      "  // Another location answers like one that does not exist, as every Network\n  // write route does (2026-11-21).\n  if (!mayReadNetworkLocation(caller, locationId)) return NextResponse.json({ error: 'location_not_found' }, { status: 404 })\n",
      "  if (!mayReadNetworkLocation(caller, locationId)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })\n"
    ]
  ],
  "app/api/network/summary/route.ts": [
    [
      "      return NextResponse.json({ error: 'location_not_found' }, { status: 404 })\n",
      "      return NextResponse.json({ error: 'forbidden' }, { status: 403 })\n"
    ],
    [
      "    // Another location answers like one that does not exist (2026-11-21).\n",
      ""
    ]
  ],
  "app/api/partner-tags/route.ts": [
    [
      "  // A tag the caller may not see (another location's own tag) answers exactly\n  // like a missing one, before anything else is said about it (2026-11-21).\n  if (\n    tagDefError || !tagDef ||\n    (!isAdmin(auth.hubUser.role) && tagDef.location_id && tagDef.location_id !== auth.hubUser.location_id)\n  ) {\n",
      "  if (tagDefError || !tagDef) {\n"
    ],
    [
      "      return { error: NextResponse.json({ error: 'partner_not_found' }, { status: 404 }) }\n",
      "      return {\n        error: NextResponse.json({ error: 'forbidden_wrong_location' }, { status: 403 }),\n      }\n"
    ],
    [
      "  // Another location's contact answers exactly like one that does not exist\n  // (2026-11-21): a guessed id learns nothing, not even that it is real.\n",
      ""
    ]
  ],
  "app/api/partners/[id]/referrals/route.ts": [
    [
      "  if (!canReadLocation(caller, partner.location_id)) {\n    return NextResponse.json({ error: 'partner_not_found' }, { status: 404 })\n  }\n",
      "  if (!canReadLocation(caller, partner.location_id)) {\n    return NextResponse.json({ error: 'forbidden' }, { status: 403 })\n  }\n"
    ],
    [
      "  // Anything the caller may not see answers exactly like a missing record\n  // (2026-11-21): a guessed id learns nothing, not even that it is real.\n",
      ""
    ]
  ],
  "app/api/reminders/route.ts": [
    [
      "  // Anything the caller may not see answers exactly like a missing record\n  // (2026-11-21): a guessed id learns nothing, not even that it is real.\n  if (!canReadLocation(caller, locationUuid)) return NextResponse.json({ error: 'record_not_found' }, { status: 404 })\n",
      "  if (!canReadLocation(caller, locationUuid)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })\n"
    ]
  ],
  "app/api/touchpoints/route.ts": [
    [
      "    engagement_id: engagementId,\n",
      "    engagement_id:\n      typeof body.engagement_id === 'string' && body.engagement_id\n        ? body.engagement_id\n        : null,\n"
    ],
    [
      "      return NextResponse.json({ error: hasLead ? 'lead_not_found' : 'partner_not_found' }, { status: 404 })\n    }\n  }\n\n  // The card, when one is named, must be THIS client's card at THIS record's\n  // location (2026-11-21). The location comes from the records, never from\n  // what the browser sends: a card at another location, another client's\n  // card, or a card on a partner (partners have none) answers like a card\n  // that does not exist, and nothing is written.\n  const engagementId =\n    typeof body.engagement_id === 'string' && body.engagement_id ? body.engagement_id : null\n  if (engagementId) {\n    const { data: card } = await supabaseService\n      .from('engagements')\n      .select('id, client_id, location_uuid')\n      .eq('id', engagementId)\n      .maybeSingle()\n    if (!card || !hasLead || card.client_id !== lead_id || card.location_uuid !== subjectLocation) {\n      return NextResponse.json({ error: 'engagement_not_found' }, { status: 404 })\n",
      "      return NextResponse.json(\n        { error: 'forbidden_wrong_location' },\n        { status: 403 }\n      )\n"
    ],
    [
      "  // Location scoping. Another location's lead or partner answers exactly like\n  // one that does not exist (2026-11-21): a guessed id learns nothing, not\n  // even that it is real.\n",
      "  // Location scoping\n"
    ],
    [
      "//        leads/partners in their location. lite_user blocked. Anything the\n//        caller may not see answers 404, never 403 (2026-11-21). A card named\n//        in engagement_id must be the lead's own card at the lead's location.\n",
      "//        leads/partners in their location. lite_user blocked.\n"
    ]
  ]
}

export function withoutNotFoundFix(path: string, src: string): string {
  let out = src
  for (const [from, to] of STEPS[path] || []) {
    const n = out.split(from).length - 1
    if (n !== 1) throw new Error(`not-found-footprint: ${path} has its step ${n} times, expected once: ${from.slice(0, 60)}`)
    out = out.replace(from, to)
  }
  return out
}
