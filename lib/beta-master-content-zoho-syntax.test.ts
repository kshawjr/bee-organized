// Zoho-residue guard — master email content may not contain:
//   1. ${...}            Zoho's export merge syntax. renderTemplate
//                        (lib/resend.ts) substitutes ONLY {{var}}; a ${...}
//                        would land as literal text in a sent email.
//   2. crm.zoho.com      dead links into the retired Zoho CRM.
//   3. unresolvable tags {{anything}} outside the RenderContext key set —
//                        renderTemplate replaces unknown keys with '' so a
//                        typo'd tag silently vanishes from the email.
//
// The 7/24 scout verified the seeds AND the prod drip_paths /
// drip_path_steps / templates rows (masters, corp templates, and location
// copies) clean on all three counts — this pins the repo side of that
// state so none of the classes can reappear through a seed edit or a new
// content migration.
//
// Deliberately separate from beta-drip-canspam-tripwire.test.ts: that
// suite pins a CAN-SPAM classification with a redo-the-assessment update
// protocol. These are plain syntax invariants — the only legitimate fix
// is converting/removing the offender (vocabulary map:
// docs/bee_organized_email_content.md).
//
// Scope caveat (same as the tripwire): repo tests can't reach the DB.
// Location-owned clones/templates live only in prod — the scout verified
// them clean on 7/24; re-check by hand if content is ever bulk-imported.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..')

// Every migration that seeds email content (subjects/bodies) belongs here.
const CONTENT_SEEDS = [
  'migrations/seed_master_drip_paths.sql', // 24 master drip steps + 7 standalone templates
  'migrations/drips_infrastructure.sql', // Gen 1 master_templates seed (quarantined but still repo source)
]

// The send-time RenderContext keys (ctx in lib/drip-send.ts, mirrored by
// buildPreviewVars in lib/preview-vars.js). A tag outside this set renders
// as ''. Adding a real new variable means adding it to ctx + preview-vars
// first, then here.
const RENDER_CONTEXT_KEYS = new Set([
  'first_name',
  'organizer_name',
  'location_name',
  'phone',
  'booking_link',
  'service_area',
  'owner_name',
  'owner_first_name',
  'owner_booking_link',
  'location_owner_name',
  'rate_per_hour',
  'location_phone',
  'book_assessment_link',
  'reviews_link',
])

// The seeds dollar-quote bodies with $tpl$ … $tpl$. The delimiter itself
// creates a false "${" when a body opens with "{{" ($tpl${{first_name}}),
// so strip the delimiter tokens before scanning. SQL comment lines are
// excluded — they legitimately mention {{variables}} as prose.
const DOLLAR_QUOTE_TAG = /\$tpl\$/g
const SQL_COMMENT = /^\s*--/

type Offense = { file: string; line: number; text: string; why: string }

function sweep(rel: string): Offense[] {
  const offenders: Offense[] = []
  const lines = readFileSync(join(ROOT, rel), 'utf8').split('\n')
  lines.forEach((raw, i) => {
    if (SQL_COMMENT.test(raw)) return
    const line = raw.replace(DOLLAR_QUOTE_TAG, '')
    if (line.includes('${')) {
      offenders.push({ file: rel, line: i + 1, text: raw.trim(), why: 'Zoho ${...} merge syntax' })
    }
    if (/crm\.zoho\.com/i.test(line)) {
      offenders.push({ file: rel, line: i + 1, text: raw.trim(), why: 'dead crm.zoho.com link' })
    }
    for (const m of line.matchAll(/\{\{(\w+)\}\}/g)) {
      if (!RENDER_CONTEXT_KEYS.has(m[1])) {
        offenders.push({
          file: rel,
          line: i + 1,
          text: raw.trim(),
          why: `{{${m[1]}}} is not a RenderContext key — renders as empty string`,
        })
      }
    }
  })
  return offenders
}

describe('Zoho-residue guard — master content seeds', () => {
  for (const rel of CONTENT_SEEDS) {
    it(`${rel} has no \${...}, no crm.zoho.com, no unresolvable {{tag}}`, () => {
      const offenders = sweep(rel).map((o) => `${o.file}:${o.line} [${o.why}] ${o.text}`)
      expect(
        offenders,
        'Zoho residue found in seeded email content. Convert it using the ' +
          'vocabulary map in docs/bee_organized_email_content.md (and if no ' +
          '{{tag}} equivalent exists, raise it — do not invent one).',
      ).toEqual([])
    })
  }
})
