// lib/zip-territory-sheet.ts
// ─────────────────────────────────────────────────────────────
// The ONE mapping from the corporate territory spreadsheet
// (Territory Zip Codes_2026.xlsx, sheet "Zip Codes" — one column per
// location, zips down each column) to Bee Hub location NAMES.
//
// migrations/location_zips.sql carries the same mapping as a VALUES list and
// joins it to public.locations on name; lib/beta-zip-territory-sheet.test.ts
// pins the two against each other and pins every one of the 54 columns here.
// An import that silently drops a location is the failure this file exists to
// prevent, so there is no default: every column is named, and a column with no
// Bee Hub location is an explicit `null`, never an omission.
//
// null = NO BEE HUB LOCATION. Kevin's ruling (30 Sep 2026): those zips are
// UNKNOWN until he says otherwise — they are not loaded, so they route to
// loc_other like any unmatched zip. Do not invent a location for them.
//
// The sheet header "Lafayette " carries a trailing space; keys here are
// trimmed, and the migration generator trimmed them the same way.
// ─────────────────────────────────────────────────────────────

export const SHEET_TO_BEE_HUB: Readonly<Record<string, string | null>> = {
  // ── names that differ (15) ──
  'Boston North Suburbs': 'Boston',
  'Connecticut': 'Connecticut Shoreline',
  'Ft. Lauderdale': 'Fort Lauderdale',
  'Las Vegas-Summerlin': 'Las Vegas',
  'N. Houston': 'North Houston',
  'Northern Colorado': 'North Colorado',
  'Northern Jersey Shore': 'North Jersey',
  'Northern VA': 'Nova',
  'Northwest AR': 'Northwest Arkansas',
  'Philadelphia Western Suburbs': 'Philadelphia Suburbs',
  'SF Bay': 'San Francisco',
  'SW Austin': 'Southwest Austin',
  'Sioux Falls, SD': 'Sioux Falls',
  'South OC': 'South Orange County',
  'West St. Louis': 'West St Louis',

  // ── no Bee Hub location (2) — unknown, not loaded ──
  'Central AR': null,
  'South Valley': null,

  // ── same name in both (37) ──
  'Carmel': 'Carmel',
  'Central Austin': 'Central Austin',
  'Central Denver': 'Central Denver',
  'Chattanooga': 'Chattanooga',
  'Dallas': 'Dallas',
  'Denver': 'Denver',
  'Greensboro': 'Greensboro',
  'Houston': 'Houston',
  'Kansas City': 'Kansas City',
  'Katy': 'Katy',
  'Lafayette': 'Lafayette',
  'Lake Norman': 'Lake Norman',
  'Lincoln': 'Lincoln',
  'Miami': 'Miami',
  'New Braunfels': 'New Braunfels',
  'New Orleans': 'New Orleans',
  'North Pittsburgh': 'North Pittsburgh',
  'Northwest Austin': 'Northwest Austin',
  'Oklahoma City': 'Oklahoma City',
  'Omaha': 'Omaha',
  'Orlando': 'Orlando',
  'Palm Beach': 'Palm Beach',
  'Peoria': 'Peoria',
  'Portland': 'Portland',
  'Reno': 'Reno',
  'Rhode Island': 'Rhode Island',
  'San Antonio': 'San Antonio',
  'San Diego': 'San Diego',
  'Sarasota': 'Sarasota',
  'Scottsdale': 'Scottsdale',
  'Seattle': 'Seattle',
  'South Charlotte': 'South Charlotte',
  'Southeast Nashville': 'Southeast Nashville',
  'Temecula': 'Temecula',
  'Tulsa': 'Tulsa',
  'West Denver': 'West Denver',
  'West Raleigh': 'West Raleigh',
}

// Raw entries per sheet column as exported (duplicates within a column
// included). 1,608 in all; the migration's per-column VALUES counts are pinned
// against these so a regenerated migration cannot quietly lose rows.
export const SHEET_COLUMN_ENTRY_COUNTS: Readonly<Record<string, number>> = {
  'Boston North Suburbs': 16, 'Carmel': 13, 'Central AR': 23, 'Central Austin': 9,
  'Central Denver': 17, 'Chattanooga': 34, 'Connecticut': 26, 'Dallas': 27,
  'Denver': 32, 'Ft. Lauderdale': 21, 'Greensboro': 16, 'Houston': 25,
  'Kansas City': 41, 'Katy': 14, 'Lafayette': 28, 'Lake Norman': 6,
  'Las Vegas-Summerlin': 14, 'Lincoln': 48, 'Miami': 135, 'N. Houston': 24,
  'New Braunfels': 13, 'New Orleans': 17, 'North Pittsburgh': 31, 'Northern Colorado': 28,
  'Northern Jersey Shore': 24, 'Northern VA': 36, 'Northwest AR': 15, 'Northwest Austin': 8,
  'Oklahoma City': 27, 'Omaha': 74, 'Orlando': 38, 'Palm Beach': 17,
  'Peoria': 43, 'Philadelphia Western Suburbs': 29, 'Portland': 43, 'Reno': 15,
  'Rhode Island': 91, 'SF Bay': 39, 'SW Austin': 10, 'San Antonio': 17,
  'San Diego': 79, 'Sarasota': 15, 'Scottsdale': 25, 'Seattle': 90,
  'Sioux Falls, SD': 43, 'South Charlotte': 6, 'South OC': 25, 'South Valley': 22,
  'Southeast Nashville': 10, 'Temecula': 17, 'Tulsa': 37, 'West Denver': 31,
  'West Raleigh': 11, 'West St. Louis': 13,
}

// Sheet entries deliberately NOT loaded, with why. Each is left out by the
// migration generator and named in the migration header; the pin test checks
// that the migration carries (raw count − these) for each column.
//
// Dallas "7507": four digits in a column of 75xxx zips — a typo, not a lost
// leading zero. Re-padded it would be 07507 (Haledon, New Jersey) and route NJ
// leads to Dallas. Left out until Kevin says what it should be. Every other
// four-digit value is in Rhode Island, Boston North Suburbs or Northern Jersey
// Shore, where the zero really was lost.
export const EXCLUDED_SHEET_ENTRIES: ReadonlyArray<{ sheet: string; raw: string; why: string }> = [
  { sheet: 'Dallas', raw: '7507', why: 'typo in a 75xxx column; padding would make it a New Jersey zip' },
]
