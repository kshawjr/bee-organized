// lib/us-states.ts
// ─────────────────────────────────────────────────────────────
// US state codes, two ways in:
//   • STATE_BY_FIPS — the Census two-digit state number (the first two digits
//     of a county GEOID) → the USPS code. The zip_coords load uses it to give
//     each zip its state from the Census zip-to-county file.
//   • normalizeStateCode — whatever a lead typed in its state field ("CA",
//     "ca ", "California", "Calif."-style is NOT guessed) → the USPS code, or
//     null when it can't be read with certainty.
// The 50 states, DC, Puerto Rico and the four inhabited territories.
// ─────────────────────────────────────────────────────────────

export const STATE_BY_FIPS: Readonly<Record<string, string>> = {
  '01': 'AL', '02': 'AK', '04': 'AZ', '05': 'AR', '06': 'CA', '08': 'CO', '09': 'CT',
  '10': 'DE', '11': 'DC', '12': 'FL', '13': 'GA', '15': 'HI', '16': 'ID', '17': 'IL',
  '18': 'IN', '19': 'IA', '20': 'KS', '21': 'KY', '22': 'LA', '23': 'ME', '24': 'MD',
  '25': 'MA', '26': 'MI', '27': 'MN', '28': 'MS', '29': 'MO', '30': 'MT', '31': 'NE',
  '32': 'NV', '33': 'NH', '34': 'NJ', '35': 'NM', '36': 'NY', '37': 'NC', '38': 'ND',
  '39': 'OH', '40': 'OK', '41': 'OR', '42': 'PA', '44': 'RI', '45': 'SC', '46': 'SD',
  '47': 'TN', '48': 'TX', '49': 'UT', '50': 'VT', '51': 'VA', '53': 'WA', '54': 'WV',
  '55': 'WI', '56': 'WY',
  '60': 'AS', '66': 'GU', '69': 'MP', '72': 'PR', '78': 'VI',
}

const NAME_TO_CODE: Readonly<Record<string, string>> = {
  'alabama': 'AL', 'alaska': 'AK', 'arizona': 'AZ', 'arkansas': 'AR', 'california': 'CA',
  'colorado': 'CO', 'connecticut': 'CT', 'delaware': 'DE', 'district of columbia': 'DC',
  'washington dc': 'DC', 'washington d.c.': 'DC', 'florida': 'FL', 'georgia': 'GA',
  'hawaii': 'HI', 'idaho': 'ID', 'illinois': 'IL', 'indiana': 'IN', 'iowa': 'IA',
  'kansas': 'KS', 'kentucky': 'KY', 'louisiana': 'LA', 'maine': 'ME', 'maryland': 'MD',
  'massachusetts': 'MA', 'michigan': 'MI', 'minnesota': 'MN', 'mississippi': 'MS',
  'missouri': 'MO', 'montana': 'MT', 'nebraska': 'NE', 'nevada': 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', 'ohio': 'OH', 'oklahoma': 'OK',
  'oregon': 'OR', 'pennsylvania': 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', 'tennessee': 'TN', 'texas': 'TX', 'utah': 'UT', 'vermont': 'VT',
  'virginia': 'VA', 'washington': 'WA', 'west virginia': 'WV', 'wisconsin': 'WI',
  'wyoming': 'WY', 'american samoa': 'AS', 'guam': 'GU', 'northern mariana islands': 'MP',
  'puerto rico': 'PR', 'virgin islands': 'VI', 'us virgin islands': 'VI',
}

const CODES = new Set(Object.values(STATE_BY_FIPS))

// "CA" / " ca " / "California" / "new  york" → the code. Anything else —
// blank, an abbreviation like "Calif.", a city, a foreign region — is null:
// a guessed state would make a wrong "state disagrees" warning.
export function normalizeStateCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim().replace(/\s+/g, ' ')
  if (!s) return null
  const upper = s.toUpperCase()
  if (upper.length === 2 && CODES.has(upper)) return upper
  return NAME_TO_CODE[s.toLowerCase()] ?? null
}
