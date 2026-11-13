// lib/call-script.ts
//
// HOW A CALL SCRIPT IS HELD (Settings slice 5, 2026-11-13).
//
// A call script is a row in `templates` with type 'call'. That table also
// holds every email template, and it has ONE text column for the words:
// `body`. A script in the new look has more shape than that — when to use it,
// roughly how long it takes, and named stages (Open, Discover, Value, …).
//
// THE SHAPE LIVES IN `body`, AS PLAIN TEXT. No new columns. Why:
//   · `templates` is the table emails are sent from. 33 of its 37 rows are
//     email templates, which have no stages, no "when to use" and no
//     duration: three new columns would sit empty on every one of them, and
//     adding them means altering the table the sends read, for the sake of a
//     page that sends nothing.
//   · The three routes that create, edit and copy a template already carry
//     `body` whole. With the shape inside it, none of them changes: an
//     owner's create, edit and delete work exactly as they did.
//   · A script is only ever read by a person. Nothing filters, sorts or
//     counts by stage or by duration, so nothing needs them as columns.
//   · The text stays readable wherever else a body is shown as it is (the
//     master library in Admin › Content): it reads as a short outline, not
//     as code.
// What this costs: the shape is a convention, not something the database
// enforces. So the reader below never fails — text that follows no
// convention at all is one script with one unnamed stage, shown as written.
// That is exactly what the one script that existed before this slice is.
//
// THE CONVENTION
//
//   When to use: Within 5 minutes of a website lead
//   About: 4 min
//
//   ## Open
//   Hi {{first_name}}, this is {{owner_name}} with Bee Organized…
//
//   ## Discover
//   Tell me a little about the space…
//
//   · "When to use:" and "About: N min" are optional and only count at the
//     very top, before any other words.
//   · A line that is "## " and a name starts a stage. "## " was chosen
//     because nobody types it by accident; square brackets were not, because
//     people do write "[If available]" in a script (the old one does).
//   · Words before the first "## " line are a stage with no name.
//
// {{BRACES}} ARE NOT MERGE TAGS HERE. Nothing in this file reads, checks or
// fills them, and nothing may: they are blanks the person on the call fills
// in by saying the right name. A script is never sent to anyone.

export interface CallScriptStage {
  /** "Open", "Discover", … — empty for words that sit under no heading. */
  name: string
  text: string
}

export interface CallScript {
  /** When to use it, in the writer's words. Empty when not given. */
  when: string
  /** Rough length in minutes. null when not given. */
  mins: number | null
  stages: CallScriptStage[]
}

const WHEN_RE = /^when to use:\s*(.*)$/i
const ABOUT_RE = /^about:\s*~?\s*(\d{1,3})\s*min(?:ute)?s?\.?\s*$/i
const STAGE_RE = /^##\s+(.+?)\s*$/
// One leading space, then something the reader would otherwise act on.
const GUARDED_RE = /^ (##\s|when to use:|about:)/i

/** Minutes are a whole number from 1 to 120, or nothing. */
export function cleanMins(v: unknown): number | null {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? '').trim(), 10)
  if (!Number.isFinite(n)) return null
  const whole = Math.round(n)
  return whole >= 1 && whole <= 120 ? whole : null
}

/** Read a `body` into its shape. Never throws; any text is a script. */
export function parseCallScript(body: unknown): CallScript {
  const lines = String(body ?? '').replace(/\r\n?/g, '\n').split('\n')
  let when = ''
  let mins: number | null = null
  let i = 0

  // The two optional lines at the very top, in either order, once each.
  let sawWhen = false
  let sawAbout = false
  for (; i < lines.length; i++) {
    // Read from the first column: a line set in by a space is the writer's
    // own words (see serializeCallScript), not one of the two top lines.
    const line = lines[i].replace(/\s+$/, '')
    if (!line.trim()) continue
    const w = !sawWhen && WHEN_RE.exec(line)
    if (w) { when = w[1].trim(); sawWhen = true; continue }
    const a = !sawAbout && ABOUT_RE.exec(line)
    if (a) { mins = cleanMins(a[1]); sawAbout = true; continue }
    break
  }

  const stages: CallScriptStage[] = []
  let current: { name: string; lines: string[] } | null = null
  const close = () => {
    if (!current) return
    const text = current.lines.join('\n').trim()
    if (current.name || text) stages.push({ name: current.name, text })
    current = null
  }
  for (; i < lines.length; i++) {
    const m = STAGE_RE.exec(lines[i])
    if (m) { close(); current = { name: m[1].trim(), lines: [] }; continue }
    if (!current) current = { name: '', lines: [] }
    // A line the writer began with a space so it would NOT be read as a
    // stage heading (see serializeCallScript) gets its own words back.
    current.lines.push(GUARDED_RE.test(lines[i]) ? lines[i].slice(1) : lines[i])
  }
  close()

  return { when, mins, stages }
}

/** Write a shape back into the text `body` holds. The reverse of the reader. */
export function serializeCallScript(script: Partial<CallScript>): string {
  const out: string[] = []
  const when = String(script.when ?? '').replace(/\s+/g, ' ').trim()
  const mins = cleanMins(script.mins)
  if (when) out.push(`When to use: ${when}`)
  if (mins != null) out.push(`About: ${mins} min`)

  const stages = (script.stages ?? [])
    .map(s => ({ name: String(s?.name ?? '').replace(/\s+/g, ' ').trim(), text: String(s?.text ?? '').replace(/\r\n?/g, '\n').trim() }))
    .filter(s => s.name || s.text)

  stages.forEach((s, n) => {
    if (out.length) out.push('')
    // Words that would be mistaken for a stage heading, or (in an unnamed
    // first stage with nothing above it) for one of the two top lines, are
    // set in by one space so they read back as the writer's own words.
    const guardTop = n === 0 && !s.name && !when && mins == null
    const text = s.text.split('\n').map((line, k) => {
      if (STAGE_RE.test(line)) return ' ' + line
      if (guardTop && k === 0 && (WHEN_RE.test(line) || ABOUT_RE.test(line))) return ' ' + line
      return line
    }).join('\n')
    if (s.name) out.push(`## ${s.name}`)
    if (text) out.push(text)
  })

  return out.join('\n')
}

/** "Within 5 minutes of a website lead · ~4 min" — whichever parts exist. */
export function callScriptSummary(script: CallScript): string {
  return [script.when, script.mins != null ? `~${script.mins} min` : ''].filter(Boolean).join(' · ')
}

/** The stage names the five Bee Organized scripts use, offered when writing one. */
export const CALL_SCRIPT_STAGE_NAMES = ['Open', 'Discover', 'Value', 'Offer', 'Handle', 'Close'] as const
