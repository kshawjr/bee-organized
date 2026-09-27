// lib/drip-step-editor-linked-template.test.tsx
//
// Lynette Ewy (Kansas City): "when I click edit, the body is blank … not the
// initial email." A drip step's wording lives EITHER on the step (inline
// subject/body) OR on a template the step points at (master_template_id, with
// the step's own subject/body NULL). The Emails list and Read view checked
// both; the step editor read only the step's own text, so a template-backed
// step opened with an empty subject and body.
//
// The fix: the editor opens with the step's own text, else its linked
// template's (stepEditorContent — the same lookup the list uses), and a save
// that leaves the wording alone keeps the template link (applyStepContentEdit).
//
// The shapes below are the real production rows as of 2026-09-26, in the form
// loadLocationPaths maps them to: Kansas City moving-c steps 1–2 and all six
// of Seattle's default steps point at the location's OWN templates (legacy_id
// NULL), so templateId falls back to the template uuid.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  stepEditorContent,
  applyStepContentEdit,
  linkedTemplateForStep,
  buildEmailList,
} from '@/components/BeeHub'

const KC_MOVE_INTRO = {
  dbId: '2317e195-25fd-444c-a719-8652b5799794', legacyId: null,
  name: 'KC Move Intro Email', subject: 'Thank you for reaching out!',
  body: 'Hello and thank you for reaching out about your move!\n\nWe would love to help.\n',
  isActive: true, isMaster: false, isOwnCustom: true,
}
const KC_MOVE_FOLLOW = {
  dbId: 'fb949a82-3257-4a82-88c7-fd645846c1b6', legacyId: null,
  name: 'KC Follow #1 Move Email', subject: 'Following up on your project',
  body: 'Just following up on your move.\n\nAny questions?',
  isActive: true, isMaster: false, isOwnCustom: true,
}

// A step as loadLocationPaths builds it from the DB row.
function stepFromDb(row: {
  id: string; step_order: number; delay_days: number
  subject: string | null; body: string | null; master_template_id: string | null
}) {
  return {
    id: `db_${row.id}`,
    dbId: row.id,
    order: row.step_order,
    name: row.subject || `Step ${row.step_order}`,
    type: 'email',
    delay: row.delay_days ? `${row.delay_days} days later` : 'Immediately',
    subject: row.subject,
    body: row.body,
    delay_days: row.delay_days,
    templateId: row.master_template_id,
    masterTemplateId: row.master_template_id,
    origin: 'master',
  }
}

const kcMove1 = stepFromDb({ id: 'kc-m1', step_order: 1, delay_days: 0, subject: null, body: null, master_template_id: KC_MOVE_INTRO.dbId })
const kcMove2 = stepFromDb({ id: 'kc-m2', step_order: 2, delay_days: 5, subject: null, body: null, master_template_id: KC_MOVE_FOLLOW.dbId })
const kcMove3 = stepFromDb({ id: 'kc-m3', step_order: 3, delay_days: 20, subject: 'Still interested?', body: 'Checking in one last time.', master_template_id: null })
// Kansas City organizing-a step 1 — its own text, no template.
const kcOrg1 = stepFromDb({ id: 'kc-o1', step_order: 1, delay_days: 0, subject: 'Thank you for reaching out to Bee Organized KC', body: 'Hello and thank you for reaching out about your organizing needs!', master_template_id: null })

const KC_TEMPLATES = [KC_MOVE_INTRO, KC_MOVE_FOLLOW]

// Seattle: all six default steps are template-backed.
const SEATTLE = [
  ['cd877b0e-1c66-4c74-963e-55f564a36757', 'Book a quick call - let’s plan your move, {{first_name}}', 0],
  ['20dfcd5a-f4e9-4b82-ab03-bc327ac641df', '{{first_name}} - a few ways to connect', 5],
  ['77ebf4f7-46a5-473c-9cc5-4a8d175b5e7d', '{{first_name}} - do you have time this week?', 30],
  ['a326d5cb-6dfd-4b32-9afb-0f629154611c', 'Book a complimentary Discovery Call', 0],
  ['59955ed5-ba2a-4837-b270-298b3e00b5a4', '{{first_name}} - let’s find a time', 5],
  ['5e31b19c-321d-4140-90d3-94e76a626826', "Still thinking about it? Let's chat.", 30],
] as const
const SEATTLE_TEMPLATES = SEATTLE.map(([id, subject], i) => ({
  dbId: id, legacyId: null, name: `Seattle ${i + 1}`, subject,
  body: `Seattle body ${i + 1}\n\n{{book_assessment_link}}`,
  isActive: true, isMaster: false, isOwnCustom: true,
}))
const SEATTLE_STEPS = SEATTLE.map(([id, , days], i) =>
  stepFromDb({ id: `sea-${i}`, step_order: (i % 3) + 1, delay_days: days, subject: null, body: null, master_template_id: id }))

describe('the step editor opens with the text the client receives', () => {
  it('a step whose text lives on a template opens with that template’s text (KC moving step 1)', () => {
    expect(stepEditorContent(kcMove1, KC_TEMPLATES)).toEqual({
      subject: KC_MOVE_INTRO.subject,
      body: KC_MOVE_INTRO.body,
    })
    expect(stepEditorContent(kcMove2, KC_TEMPLATES).body).toBe(KC_MOVE_FOLLOW.body)
  })

  it('a step with its own text opens with its own text, unchanged', () => {
    expect(stepEditorContent(kcOrg1, KC_TEMPLATES)).toEqual({ subject: kcOrg1.subject, body: kcOrg1.body })
    expect(stepEditorContent(kcMove3, KC_TEMPLATES)).toEqual({ subject: 'Still interested?', body: 'Checking in one last time.' })
  })

  it('a step’s own text wins over a template it also points at', () => {
    const both = { ...kcMove1, subject: 'Own subject', body: 'Own body' }
    expect(stepEditorContent(both, KC_TEMPLATES)).toEqual({ subject: 'Own subject', body: 'Own body' })
  })

  it('all six of Seattle’s steps open with their template’s text, none blank', () => {
    SEATTLE_STEPS.forEach((s, i) => {
      const c = stepEditorContent(s, SEATTLE_TEMPLATES)
      expect(c.subject).toBe(SEATTLE_TEMPLATES[i].subject)
      expect(c.body).toBe(SEATTLE_TEMPLATES[i].body)
      expect(c.body.trim()).not.toBe('')
    })
  })

  it('the editor and the Emails list agree on every Kansas City and Seattle step', () => {
    const kc = buildEmailList({ pathSteps: { 'moving-c': [kcMove1, kcMove2, kcMove3] }, templates: KC_TEMPLATES, pathKey: 'moving-c' })
    kc.newLead.forEach((row: any, i: number) => {
      const step = [kcMove1, kcMove2, kcMove3][i]
      expect(stepEditorContent(step, KC_TEMPLATES)).toEqual({ subject: row.subject, body: row.body })
    })
    const sea = buildEmailList({ pathSteps: { 'organizing-b': SEATTLE_STEPS.slice(3) }, templates: SEATTLE_TEMPLATES, pathKey: 'organizing-b' })
    sea.newLead.forEach((row: any, i: number) => {
      expect(stepEditorContent(SEATTLE_STEPS[3 + i], SEATTLE_TEMPLATES)).toEqual({ subject: row.subject, body: row.body })
      expect(row.body).not.toBe('')
    })
  })

  it('a step whose template cannot be found still opens empty rather than inventing text', () => {
    expect(stepEditorContent(kcMove1, [])).toEqual({ subject: '', body: '' })
    expect(linkedTemplateForStep(kcMove1, [])).toBeNull()
  })
})

describe('saving from the step editor', () => {
  it('saving without changing the text keeps the template link and stores no text on the step', () => {
    const shown = stepEditorContent(kcMove1, KC_TEMPLATES)
    const next = applyStepContentEdit(kcMove1, { subject: shown.subject.trim() || null, body: shown.body, delay_days: 0 }, KC_TEMPLATES)
    expect(next.masterTemplateId).toBe(KC_MOVE_INTRO.dbId)
    expect(next.templateId).toBe(KC_MOVE_INTRO.dbId)
    expect(next.subject).toBeNull()
    expect(next.body).toBeNull()
  })

  it('changing only the delay keeps the template link and moves the delay', () => {
    const shown = stepEditorContent(kcMove2, KC_TEMPLATES)
    const next = applyStepContentEdit(kcMove2, { subject: shown.subject, body: shown.body, delay_days: 7 }, KC_TEMPLATES)
    expect(next.masterTemplateId).toBe(KC_MOVE_FOLLOW.dbId)
    expect(next.body).toBeNull()
    expect(next.delay_days).toBe(7)
    expect(next.delay).toBe('7 days later')
  })

  it('saving changed text stores it on the step and drops the template link', () => {
    const next = applyStepContentEdit(kcMove1, { subject: 'Thanks for getting in touch!', body: 'New wording.', delay_days: 0 }, KC_TEMPLATES)
    expect(next.subject).toBe('Thanks for getting in touch!')
    expect(next.body).toBe('New wording.')
    expect(next.masterTemplateId).toBeNull()
    expect(next.templateId).toBeNull()
  })

  it('changing only the subject counts as a change', () => {
    const shown = stepEditorContent(kcMove1, KC_TEMPLATES)
    const next = applyStepContentEdit(kcMove1, { subject: 'Different subject', body: shown.body, delay_days: 0 }, KC_TEMPLATES)
    expect(next.subject).toBe('Different subject')
    expect(next.body).toBe(KC_MOVE_INTRO.body)
    expect(next.masterTemplateId).toBeNull()
  })

  it('a step with its own text saves its new text, as before', () => {
    const next = applyStepContentEdit(kcOrg1, { subject: kcOrg1.subject, body: 'Edited body', delay_days: 0 }, KC_TEMPLATES)
    expect(next.body).toBe('Edited body')
    expect(next.masterTemplateId).toBeNull()
  })

  it('the template itself is never changed by a save', () => {
    const before = JSON.stringify(KC_TEMPLATES)
    applyStepContentEdit(kcMove1, { subject: 'x', body: 'y', delay_days: 0 }, KC_TEMPLATES)
    expect(JSON.stringify(KC_TEMPLATES)).toBe(before)
  })
})

// The component is not exported, so the wiring is pinned on the source: the
// mount must fill the editor through stepEditorContent (not step.body alone),
// the save must go through applyStepContentEdit, and the empty-body refusal
// must still be there.
describe('wiring in components/BeeHub.jsx', () => {
  const src = readFileSync(join(__dirname, '..', 'components', 'BeeHub.jsx'), 'utf8')
  const mountStart = src.indexOf('{stepContentEditor&&(')
  const mount = src.slice(mountStart, src.indexOf('/>', mountStart))

  it('the editor mount fills itself through stepEditorContent', () => {
    expect(mountStart).toBeGreaterThan(-1)
    expect(mount).toContain('stepEditorContent(stepContentEditor.step, templates)')
    expect(mount).not.toMatch(/body:\s*stepContentEditor\.step\.body/)
  })

  it('the save goes through applyStepContentEdit', () => {
    const save = src.slice(src.indexOf('async function saveStepContent'), src.indexOf('await commitSteps(pathId, nextSteps)'))
    expect(save).toContain('applyStepContentEdit(s, patch, templates)')
  })

  it('saving an empty body is still refused', () => {
    const editor = src.slice(src.indexOf('function DripPathStepEditor'), src.indexOf('function DripPathStepEditor') + 2000)
    expect(editor).toContain("if (!body || !body.trim())")
    expect(editor).toContain('The email body can’t be empty.')
  })
})
