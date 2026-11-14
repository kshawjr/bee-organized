// components/hive/shared/twinCards.js
// ─────────────────────────────────────────────────────────────
// TWO OPEN CARDS FOR ONE CLIENT — the flag, and the "Close as duplicate" gate.
//
// WHY (reported by an owner at New Braunfels, 14 Oct 2026): she sent a lead to
// Jobber, and a day later a second request was made for the same client in
// Jobber. The second request founded its own card and the quote, the job and
// the invoice all landed there. She was looking at the first card, which
// stayed empty for five weeks. 38 clients at 18 locations since 1 August.
//
// Nothing is merged and nothing is stored. The flag is WORKED OUT, every time
// a card is opened, from the client's own cards — so it can never be stale,
// and it goes away by itself the moment it stops being true.
//
// THE RULE — an older card O and a newer card N are a pair only when ALL hold:
//   · same client, and both cards are at the same location;
//   · both are open (neither Closed Won nor Closed Lost);
//   · N was founded by a Jobber request (a card somebody made by hand on
//     purpose is their decision, not a surprise);
//   · O had no quote, job or invoice when N was founded. A client with work
//     under way who asks for something new is REPEAT BUSINESS, not a twin,
//     and is never flagged;
//   · they do not BOTH have a quote, job or invoice now. Work on both cards
//     means two real jobs — the flag goes, and stays gone.
//
// NO TIME LIMIT, on purpose. A limit would hide exactly the card that has sat
// longest, and the flag only ever states a fact the owner can check: two
// cards are open, and here is which one has the work. Run uncapped against
// production on 13 Nov 2026 the rule matched 10 pairs out of 2,216 open
// cards, none more than 30 days apart.
//
// "WORK" is a quote, a job or an invoice row on the card (any status), or
// money invoiced. A request or an assessment is not work: every twin has a
// request, and an assessment is a visit, not a decision to do the job.
//
// CLOSE AS DUPLICATE is offered on a card only when that card has no work and
// its pair has some. The server makes the same check again from its own
// records (app/api/engagements/[id]/close-duplicate) — this file only decides
// what to show.
// ─────────────────────────────────────────────────────────────

// The closed_reason a duplicate close writes. Its own word, so a report can
// tell "this was never a second job" from a job that was lost.
export const DUPLICATE_CARD_REASON = 'duplicate_card'
export const DUPLICATE_CARD_LABEL = 'Duplicate card'
export const CLOSE_AS_DUPLICATE_ACTION = 'Close as duplicate'
export const OPEN_OTHER_CARD_ACTION = 'Open the other card'
// Shown under the line straight after the one tap, and only there: the tap
// has no "are you sure", so the card says how to take it back. Not part of
// the stored note — a card opened later already shows Reopen in its menu.
export const DUPLICATE_REOPEN_HINT = 'If that was wrong, Reopen in the ··· menu brings it back.'

const TERMINAL = ['Closed Won', 'Closed Lost']
const isOpen = (c) => !!c && !TERMINAL.includes(c.stage)
const ms = (s) => {
  const n = s ? Date.parse(s) : NaN
  return Number.isFinite(n) ? n : null
}

// 'invoice' | 'job' | 'quote' | null — the furthest record the card holds.
export function workKindOf(card) {
  if (!card) return null
  const w = card.work
  if (w === 'invoice' || w === 'job' || w === 'quote') return w
  if (Number(card.total_invoiced || 0) !== 0) return 'invoice'
  return null
}

function isPair(older, newer) {
  if (!isOpen(older) || !isOpen(newer)) return false
  if (!older.location_uuid || older.location_uuid !== newer.location_uuid) return false
  if (newer.founded_by !== 'request') return false
  const newerAt = ms(newer.created_at)
  const olderAt = ms(older.created_at)
  if (newerAt == null || olderAt == null) return false // no dates: never guess
  // The older card already had work when the newer one arrived: repeat business.
  const firstWork = ms(older.first_work_at)
  if (workKindOf(older) && (firstWork == null || firstWork <= newerAt)) return false
  // Real work on both: two jobs.
  if (workKindOf(older) && workKindOf(newer)) return false
  return true
}

// cards: every card this client has, each
//   { id, client_id, title, stage, created_at, founded_by, location_uuid,
//     total_invoiced, work, first_work_at }
// Returns null (no flag) or what the card being looked at should say.
export function findTwinCard(cards, viewedId) {
  const list = (cards || []).filter(c => c && c.id)
  const me = list.find(c => c.id === viewedId)
  if (!me || !isOpen(me)) return null
  const meAt = ms(me.created_at)
  const partners = list.filter(c => {
    if (c.id === me.id) return false
    const cAt = ms(c.created_at)
    if (cAt == null || meAt == null || cAt === meAt) return false
    return cAt > meAt ? isPair(me, c) : isPair(c, me)
  })
  if (partners.length === 0) return null
  // More than one (three requests in a row): the one with the work first,
  // then the one made closest in time to this card.
  partners.sort((a, b) =>
    (workKindOf(b) ? 1 : 0) - (workKindOf(a) ? 1 : 0) ||
    Math.abs(ms(a.created_at) - meAt) - Math.abs(ms(b.created_at) - meAt))
  const other = partners[0]
  const thisWork = workKindOf(me)
  const otherWork = workKindOf(other)
  return {
    // How many open cards are in on this, the one being looked at included.
    // Almost always 2; three requests in a row make 3 (seen live, San Diego).
    count: partners.length + 1,
    other: {
      id: other.id,
      client_id: other.client_id ?? me.client_id ?? null,
      title: other.title ?? null,
      stage: other.stage,
      created_at: other.created_at ?? null,
    },
    thisWork,
    otherWork,
    // 'empty'  — this card has nothing, the work is on the other
    // 'worked' — this card has the work, the other has nothing
    // 'neither'— no quote or job on either yet
    role: !thisWork && otherWork ? 'empty' : thisWork && !otherWork ? 'worked' : 'neither',
    canCloseAsDuplicate: !thisWork && !!otherWork,
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
// "Oct 23" — the day the other card was opened, which is how an owner tells
// two cards with the same title apart. UTC, so the server's note and the
// card's sentence can never name different days.
export function twinDay(iso, withYear = false) {
  const n = ms(iso)
  if (n == null) return null
  const d = new Date(n)
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}${withYear ? `, ${d.getUTCFullYear()}` : ''}`
}

const COUNT_WORDS = { 2: 'Two', 3: 'Three', 4: 'Four', 5: 'Five' }

// The words an owner reads. firstName is the client's; without one the
// sentence still reads ("this client").
export function twinFlagText(twin, firstName) {
  if (!twin) return null
  const who = (firstName || '').trim() || 'this client'
  const day = twinDay(twin.other.created_at)
  const opened = day ? `, opened ${day},` : ''
  const n = twin.count > 2 ? twin.count : 2
  const many = n > 2
  const headline = `${COUNT_WORDS[n] || n} cards are open for ${who}.`
  if (twin.role === 'empty') {
    return {
      headline,
      body:
        `The ${twin.otherWork} is on ${many ? 'another' : 'the other'} card${opened.replace(/,$/, '')}. ` +
        `This card has no quote, job or invoice on it. ` +
        `If they are the same job, close this one as a duplicate. Nothing changes in Jobber.`,
    }
  }
  if (twin.role === 'worked') {
    return {
      headline,
      body:
        `This is the card with the ${twin.thisWork}. ` +
        `${many ? 'Another' : 'The other'} card${opened} has no quote, job or invoice on it. ` +
        `If they are the same job, open that card and close it as a duplicate.`,
    }
  }
  return {
    headline,
    body:
      (many
        ? `This one, and ${n - 1} more. None of them has a quote or a job yet. ` +
          `When you quote one of them in Jobber, that card fills in and the others can be closed as duplicates.`
        : `This one, and another${day ? ` opened ${day}` : ''}. Neither has a quote or a job yet. ` +
          `When you quote one of them in Jobber, that card fills in and the other can be closed as a duplicate.`),
  }
}

// What the card says straight after the one tap, and what the close writes
// as its note (the server builds the note with this same function).
export function duplicateClosedLine(otherWork, otherCreatedAt) {
  const day = twinDay(otherCreatedAt, true)
  return `Closed as a duplicate. The ${otherWork || 'work'} is on this client's other card${day ? `, opened ${day}` : ''}.`
}
