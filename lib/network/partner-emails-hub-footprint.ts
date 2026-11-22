// lib/network/partner-emails-hub-footprint.ts
// ─────────────────────────────────────────────────────────────
// Partner emails, slice 3 (2026-11-22) changed components/BeeHub.jsx on
// purpose: the Partner emails group on the Emails screen, the partner tags in
// the step editor, partner words on the rows, the partner masters in the
// admin master editor. Several older tests pin BeeHub.jsx by fingerprint
// ("this slice changed nothing else"). They take the click-away pass back out
// first (click-away-footprint.ts); they now take THIS slice back out too, by
// these exact pieces — each must be present exactly once, and the file with
// all of them put back is byte for byte origin/main f115e0ee. So ANY other
// change to BeeHub.jsx still fails those tests.
//
// Generated from the diff, never edited by hand: [what is there now, what
// main had].
// ─────────────────────────────────────────────────────────────

export const PARTNER_EMAILS_SLICE3_HUB_PIECES: [string, string][] = [
  ["// Partner emails (slice 3): the partner sequences, and the partner set of tags.\nimport { isPartnerPathKey, PARTNER_SEQUENCES } from '@/lib/partner-sequences'\nimport { PARTNER_MERGE_TAGS, PARTNER_MERGE_TAG_GROUPS } from '@/lib/partner-merge-tags'\n",
   ""],
  ["// RAIL A — a path's email steps, inline-first. Used for the default\n// organizing/moving path (group one), for the fixed returning-client path (the\n// \"past client\" group) and, since partner emails slice 3, for each partner\n// sequence — same row shape, same controls.\nexport function dripEmailRows({ pathSteps = {}, templates = [], pathKey = null }) {\n    const key = pathKey\n",
   "export function buildEmailList({ pathSteps = {}, templates = [], pathKey = null, returningPathKey = null }) {\n  // RAIL A — a path's email steps, inline-first. Used for the default\n  // organizing/moving path (group one) and for the fixed returning-client\n  // path (the \"past client\" group) — same row shape, same controls.\n  const dripRowsFor = (key) => {\n"],
  ["}\n\nexport function buildEmailList({ pathSteps = {}, templates = [], pathKey = null, returningPathKey = null }) {\n  const dripRowsFor = (key) => dripEmailRows({ pathSteps, templates, pathKey: key })\n",
   "  }\n"],
  ["          <span style={{ color:ET.mutedFg }}>after {isPartnerPathKey(row.pathKey) ? 'you start it' : row.pathKey && RETURNING_PATH_KEYS.includes(row.pathKey) ? 'they get back in touch' : 'their enquiry arrives'}</span>\n",
   "          <span style={{ color:ET.mutedFg }}>after {row.pathKey && RETURNING_PATH_KEYS.includes(row.pathKey) ? 'they get back in touch' : 'their enquiry arrives'}</span>\n"],
  ["          {timingLocked && <p style={{ margin:0, fontSize:'11px', color:muted }}>{isPartnerPathKey(row.pathKey) ? 'Fixed — sends when you start it' : 'Fixed — automatic reply'}</p>}\n",
   "          {timingLocked && <p style={{ margin:0, fontSize:'11px', color:muted }}>Fixed — automatic reply</p>}\n"],
  ["          {paused && <p style={{ margin:'4px 0 0', fontSize:'11px', color:muted }}>Paused — no {isPartnerPathKey(row.pathKey) ? 'partner' : 'client'} gets this one until you start it again.</p>}\n",
   "          {paused && <p style={{ margin:'4px 0 0', fontSize:'11px', color:muted }}>Paused — no client gets this one until you start it again.</p>}\n"],
  ["// The same rule for a partner sequence (the save route refuses it the same way).\nexport const PARTNER_FIRST_EMAIL_NOTE = 'Can’t be removed — it’s the email a partner gets the moment you start them on it.'\n",
   ""],
  ["  // The database refuses to throw away a location's copy of a partner sequence\n  // while a partner is partway through it (migrations/partner_emails.sql).\n  if (/partner_progress_active/.test(msg)) {\n    const n = Number((/partner_progress_active: (\\d+)/.exec(msg) || [])[1])\n    return `${n > 1 ? `${n} partners are` : 'a partner is'} still partway through these emails, so your version can’t be thrown away yet. Once they’ve finished (or you’ve stopped them), you can go back to the Bee Organized wording. Nothing was changed.`\n  }\n",
   ""],
  ["// audience (partner emails, slice 3): 'client' (every caller before, and the\n// default) or 'partner' — the SAME list, rows, controls, Read dialog and\n// actions, showing the two partner sequences instead of the client groups.\nexport function EmailsList({ pathSteps, templates, generalDefault, moveDefault, masterSteps = {}, actions = null, sendConfig = {}, view: viewProp = null, onViewChange = null, followupsOff = false, sending = true, locationId = null, preview = null, moving = null, audience = 'client' }) {\n  const partnerMode = audience === 'partner'\n",
   "export function EmailsList({ pathSteps, templates, generalDefault, moveDefault, masterSteps = {}, actions = null, sendConfig = {}, view: viewProp = null, onViewChange = null, followupsOff = false, sending = true, locationId = null, preview = null, moving = null }) {\n"],
  ["    () => partnerMode\n      ? { newLead: [], returning: [], afterJob: [] }\n      : buildEmailList({ pathSteps, templates, pathKey: activePathKey, returningPathKey }),\n    [pathSteps, templates, activePathKey, returningPathKey, partnerMode])\n  // One group per partner sequence, each the same drip rows a client\n  // sequence has (dripEmailRows); the first email of each is \"always first\".\n  const partnerGroups = React.useMemo(\n    () => partnerMode\n      ? PARTNER_SEQUENCES.map(sq => ({\n          ...sq,\n          rows: dripEmailRows({ pathSteps, templates, pathKey: sq.pathKey })\n            .map((r, i) => ({ ...r, fixedNote: i === 0 ? 'always first' : null })),\n        }))\n      : [],\n    [pathSteps, templates, partnerMode])\n",
   "    () => buildEmailList({ pathSteps, templates, pathKey: activePathKey, returningPathKey }),\n    [pathSteps, templates, activePathKey, returningPathKey])\n"],
  ["  const groups = partnerMode\n    ? Object.fromEntries(partnerGroups.map(g => [g.pathKey, g.rows]))\n    : { new: withNotes, returning, job: afterJob }\n  const firstGroupId = partnerMode ? PARTNER_SEQUENCES[0].pathKey : 'new'\n",
   "  const groups = { new: withNotes, returning, job: afterJob }\n"],
  ["    if (r.rail === 'drip' && Number(r.order) === 1) return isPartnerPathKey(r.pathKey) ? PARTNER_FIRST_EMAIL_NOTE : groupId === 'returning' ? 'Can’t be removed — it tells a returning client we got their message.' : FIRST_EMAIL_ALWAYS_SENDS_NOTE\n",
   "    if (r.rail === 'drip' && Number(r.order) === 1) return groupId === 'returning' ? 'Can’t be removed — it tells a returning client we got their message.' : FIRST_EMAIL_ALWAYS_SENDS_NOTE\n"],
  ["    const groupOpen = collapsed[id] === undefined ? id === firstGroupId : !collapsed[id]\n",
   "    const groupOpen = collapsed[id] === undefined ? id === 'new' : !collapsed[id]\n"],
  ["  const allRows = partnerMode ? partnerGroups.flatMap(g => g.rows) : [...withNotes, ...returning, ...afterJob]\n",
   "  const allRows = [...withNotes, ...returning, ...afterJob]\n"],
  ["  const readModal = open && (\n    <EmailReadModal rows={openRows} index={open.index}\n      onClose={() => setOpen(null)}\n      onStep={i => setOpen(o => ({ ...o, index: Math.max(0, Math.min(openRows.length - 1, i)) }))}\n      onEdit={canEdit ? () => { const r = openRows[open.index]; setOpen(null); actions.edit(r) } : null}\n      onReset={canReset(openRows[open.index]) ? () => { const r = openRows[open.index]; setOpen(null); actions.reset(r) } : null}\n      resetBlockedReason={noCounterpartFor(openRows[open.index]) || resetBlockedFor(openRows[open.index])}\n      blockedReason={blockedFor(openRows[open.index])}\n      sending={sending} locationId={locationId} preview={preview} cfg={sendConfig} />\n  )\n  if (partnerMode) return (\n    <div data-partner-emails style={{ fontFamily:EF.ui }}>\n      <div style={{ marginBottom:'20px', display:'flex', flexWrap:'wrap', gap:'8px' }}>\n        <ETag tone=\"shared\">🐝 {allRows.length - ownCount} use Bee Organized wording</ETag>\n        <ETag tone=\"own\">{ownCount} in your own words</ETag>\n      </div>\n      {partnerGroups.map(g => (\n        <Group key={g.pathKey} id={g.pathKey} title={g.name}\n          count={g.rows.length}\n          note={PARTNER_GROUP_NOTES[g.pathKey]}\n          rows={g.rows}\n          add={actions && actions.add ? () => actions.add(g.pathKey) : null} />\n      ))}\n      {readModal}\n    </div>\n  )\n",
   ""],
  ["        rows={afterJob} />\n      {readModal}\n    </div>\n",
   "        rows={afterJob} />\n      {open && (\n        <EmailReadModal rows={openRows} index={open.index}\n          onClose={() => setOpen(null)}\n          onStep={i => setOpen(o => ({ ...o, index: Math.max(0, Math.min(openRows.length - 1, i)) }))}\n          onEdit={canEdit ? () => { const r = openRows[open.index]; setOpen(null); actions.edit(r) } : null}\n          onReset={canReset(openRows[open.index]) ? () => { const r = openRows[open.index]; setOpen(null); actions.reset(r) } : null}\n          resetBlockedReason={noCounterpartFor(openRows[open.index]) || resetBlockedFor(openRows[open.index])}\n          blockedReason={blockedFor(openRows[open.index])}\n          sending={sending} locationId={locationId} preview={preview} cfg={sendConfig} />\n      )}\n    </div>\n"],
  ["}\n\n// The words under each partner sequence's heading (partner emails, slice 3).\nexport const PARTNER_GROUP_NOTES = {\n  'partner-introduction': 'Counted from the day you start a partner on it. Any partner can be started on it, whatever their level.',\n  'partner-power-introduction': 'Sent when you start a partner on it. Any partner can be started on it, whatever their level.',\n",
   ""],
  ["      // The client sequences, and (partner emails, slice 3) this location's\n      // own copies of the partner sequences — the same rows, asked for\n      // separately because every other screen gets client sequences only.\n      // A failed partner read never stops the client emails loading.\n      const [r, rp] = await Promise.all([\n        fetch(`/api/locations/${realLocId}/drip-paths`, { credentials: 'include' }),\n        fetch(`/api/locations/${realLocId}/drip-paths?audience=partner`, { credentials: 'include' }).catch(() => null),\n      ])\n",
   "      const r = await fetch(`/api/locations/${realLocId}/drip-paths`, { credentials: 'include' })\n"],
  ["      const jp = rp && rp.ok ? await rp.json().catch(() => null) : null\n      const paths = [\n        ...(Array.isArray(j?.paths) ? j.paths : []),\n        ...(Array.isArray(jp?.paths) ? jp.paths.filter(p => isPartnerPathKey(p.path_key)) : []),\n      ]\n",
   "      const paths = Array.isArray(j?.paths) ? j.paths : []\n"],
  ["    // The client masters, plus (partner emails, slice 3) the partner masters —\n    // the same rows and steps, asked for separately (?audience=partner). A\n    // failed partner read leaves the client masters exactly as they were.\n    Promise.all([\n      fetch('/api/drip-paths/masters', { credentials: 'include' })\n        .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))),\n      fetch('/api/drip-paths/masters?audience=partner', { credentials: 'include' })\n        .then(r => r.ok ? r.json() : null).catch(() => null),\n    ])\n      .then(([j, jp]) => {\n",
   "    fetch('/api/drip-paths/masters', { credentials: 'include' })\n      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))\n      .then(j => {\n"],
  ["        const list = [\n          ...(Array.isArray(j?.masters) ? j.masters : []),\n          ...(Array.isArray(jp?.masters) ? jp.masters.filter(m => isPartnerPathKey(m.path_key)) : []),\n        ]\n        const map = {}\n",
   "        const list = Array.isArray(j?.masters) ? j.masters : []\n        const map = {}\n"],
  ["  // A partner email's preview (partner emails, slice 3): the partner tags only,\n  // filled for a sample partner, as lib/partner-merge-tags.ts fills them for a\n  // send. Client tags in a partner email stay blank, as they would when sent.\n  function partnerPreviewValues() {\n    const ownerName = [settings.profile.firstName, settings.profile.lastName].filter(Boolean).join(' ')\n    return {\n      partner_name: 'Taylor',\n      location_owner_name: ownerName,\n      location_name: settings.location.name,\n      location_phone: settings.location.phone,\n      service_area: [settings.location.city, settings.location.state].filter(Boolean).join(', '),\n      rate_per_hour: settings.location.ratePerHour,\n      reviews_link: settings.location.reviewsLink,\n    }\n  }\n\n  // pathKey: the sequence being edited — a partner sequence gets the partner\n  // tags, the partner preview and the partner wording; every other editor is\n  // exactly as before.\n  function emailsEditorProps(pathKey = null) {\n",
   "  function emailsEditorProps() {\n"],
  ["    const partner = isPartnerPathKey(pathKey)\n",
   ""],
  ["      ...(partner ? { audience: 'partner' } : {}),\n",
   ""],
  ["      preview: { style: es.style, values: partner ? partnerPreviewValues() : emailsPreviewValues(), signature: signatureFromData(emailSig.data), postalAddress: emailSettings.postalAddress || null },\n",
   "      preview: { style: es.style, values: emailsPreviewValues(), signature: signatureFromData(emailSig.data), postalAddress: emailSettings.postalAddress || null },\n"],
  ["              {/* ── Partner emails (slice 3, 2026-11-22). Kevin: treated exactly\n                  like every other email — the SAME list, rows, Read dialog,\n                  editor, Customize and put-the-wording-back, timing, add,\n                  remove, pause and \"Send me a test\" as the client emails\n                  above. Nothing here sends to a partner: a partner is only\n                  ever put on one by hand, from their contact (a later slice). */}\n              <ESection id=\"partner-emails\" eyebrow=\"Partner emails\" title=\"Emails to your referral partners\"\n                intro=\"Two sequences you can start any partner on, from their contact. They go out on their own, in this order, counted from the day you start them.\">\n                <EmailsList\n                  audience=\"partner\"\n                  pathSteps={pathSteps}\n                  templates={templates}\n                  masterSteps={masterSteps}\n                  actions={realLocId ? { edit: emailsRowEdit, reset: emailsRowReset, add: openAddEmail, editTiming: emailsRowEditTiming, remove: openRemoveEmail, restore: emailsRowRestore, pause: emailsRowPause } : null}\n                  sendConfig={sendCfg}\n                  sending={senderAddressSet}\n                  locationId={realLocId}\n                  preview={{ style: es.style, values: partnerPreviewValues(), signature: signatureFromData(emailSig.data), postalAddress: emailSettings.postalAddress || null }}\n                />\n              </ESection>\n\n",
   ""],
  ["          // A partner sequence is offered a blank email only: every ready-made\n          // template is written to a client.\n          templates={isPartnerPathKey(addEmailState.pathKey) ? [] : templates}\n",
   "          templates={templates}\n"],
  ["            {...emailsEditorProps(addEmailState.pathKey)}\n",
   "            {...emailsEditorProps()}\n"],
  ["          pathName={isPartnerPathKey(forkConfirm.pathId)\n            ? ((PARTNER_SEQUENCES.find(sq => sq.pathKey === forkConfirm.pathId) || {}).name || 'these emails')\n            : (PATH_STYLES.find(st => forkConfirm.pathId.endsWith(st.id.replace('path-',''))) || {}).label || 'these emails'}\n",
   "          pathName={(PATH_STYLES.find(st => forkConfirm.pathId.endsWith(st.id.replace('path-',''))) || {}).label || 'these emails'}\n"],
  ["          {...emailsEditorProps(stepContentEditor.pathId)}\n",
   "          {...emailsEditorProps()}\n"],
  ["    // Partner emails (slice 3): the partner masters too, the same rows and the\n    // same editor, listed after the client ones.\n    Promise.all([\n      fetch('/api/drip-paths/masters', { credentials: 'include' })\n        .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))),\n      fetch('/api/drip-paths/masters?audience=partner', { credentials: 'include' })\n        .then(r => r.ok ? r.json() : null).catch(() => null),\n    ])\n      .then(([j, jp]) => {\n",
   "    fetch('/api/drip-paths/masters', { credentials: 'include' })\n      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))\n      .then(j => {\n"],
  ["        const list = [\n          ...(Array.isArray(j?.masters) ? j.masters : []),\n          ...(Array.isArray(jp?.masters) ? jp.masters.filter(m => isPartnerPathKey(m.path_key)) : []),\n        ]\n        // Sort: Organizing A→D, then Moving A→D, then Returning A→D, then the partner sequences\n        const order = ['organizing-a','organizing-b','organizing-c','organizing-d','moving-a','moving-b','moving-c','moving-d', ...RETURNING_PATH_KEYS, ...PARTNER_SEQUENCES.map(sq => sq.pathKey)]\n",
   "        const list = Array.isArray(j?.masters) ? j.masters : []\n        // Sort: Organizing A→D, then Moving A→D, then Returning A→D\n        const order = ['organizing-a','organizing-b','organizing-c','organizing-d','moving-a','moving-b','moving-c','moving-d', ...RETURNING_PATH_KEYS]\n"],
  ["                  <span style={{ fontSize:'18px' }}>{isPartnerPathKey(path.path_key) ? '🤝' : path.path_key.startsWith('moving') ? '📦' : '🏠'}</span>\n",
   "                  <span style={{ fontSize:'18px' }}>{path.path_key.startsWith('moving') ? '📦' : '🏠'}</span>\n"],
  ["                          <button onClick={()=>setEditing({ step, pathKey: path.path_key })} style={{ marginLeft:'auto', padding:'4px 10px', background:'#1a2e2b', border:'none', borderRadius:'7px', fontSize:'11px', fontFamily:'inherit', color:'white', cursor:'pointer' }}>Edit</button>\n",
   "                          <button onClick={()=>setEditing({ step })} style={{ marginLeft:'auto', padding:'4px 10px', background:'#1a2e2b', border:'none', borderRadius:'7px', fontSize:'11px', fontFamily:'inherit', color:'white', cursor:'pointer' }}>Edit</button>\n"],
  ["          // A partner master: the partner tags (slice 3).\n          audience={isPartnerPathKey(editing.pathKey) ? 'partner' : 'client'}\n",
   ""],
  ["// audience (partner emails, slice 3): 'partner' offers the partner tags only\n// (lib/partner-merge-tags.ts) and words the hints for a partner; everything\n// else is this same editor.\nexport function DripPathStepEditor({ step, onSave, onClose, links = null, alignReady = false, bodyReady = false, preview = null, isNew = false, startButton = null, audience = 'client' }) {\n  const forPartner = audience === 'partner'\n  const tagSet = forPartner ? { tags: PARTNER_MERGE_TAGS, groups: PARTNER_MERGE_TAG_GROUPS } : null\n",
   "export function DripPathStepEditor({ step, onSave, onClose, links = null, alignReady = false, bodyReady = false, preview = null, isNew = false, startButton = null }) {\n"],
  ["      <p style={{ ...eHintStyle, margin:'0 0 12px' }}>Details in double braces, like <code>{forPartner ? '{{partner_name}}' : '{{first_name}}'}</code>, are filled in for each {forPartner ? 'partner' : 'client'}. {draft.rich ? 'Pick one from Merge tags, above the message.' : 'Pick one from the list under the message.'}</p>\n",
   "      <p style={{ ...eHintStyle, margin:'0 0 12px' }}>Details in double braces, like <code>{'{{first_name}}'}</code>, are filled in for each client. {draft.rich ? 'Pick one from Merge tags, above the message.' : 'Pick one from the list under the message.'}</p>\n"],
  ["          <RichMessage {...draft.editor} links={links} onFocus={tags.clear} onInsertTag={t => tags.insert(t)} {...(tagSet ? { tags: tagSet.tags, tagGroups: tagSet.groups } : {})} />\n",
   "          <RichMessage {...draft.editor} links={links} onFocus={tags.clear} onInsertTag={t => tags.insert(t)} />\n"],
  ["        <MergeTagPicker onInsert={t => { if (!tags.insert(t)) setBody(b => b + t) }} {...(tagSet ? { tags: tagSet.tags, groups: tagSet.groups } : {})} />\n",
   "        <MergeTagPicker onInsert={t => { if (!tags.insert(t)) setBody(b => b + t) }} />\n"],
  ["          <span style={eLabelStyle}>{forPartner ? 'Delay (days after you start a partner on it)' : 'Delay (days after the lead comes in)'}</span>\n",
   "          <span style={eLabelStyle}>Delay (days after the lead comes in)</span>\n"],
  ["          <span style={eHintStyle}>{forPartner ? 'Step 1 is 0: it sends the moment you start a partner on it.' : 'Step 1 is usually 0 (fires immediately on new lead). Masters default to 0 / 5 / 30 days.'}</span>\n",
   "          <span style={eHintStyle}>Step 1 is usually 0 (fires immediately on new lead). Masters default to 0 / 5 / 30 days.</span>\n"],
]

/** BeeHub.jsx with partner emails slice 3 taken back out. Throws if a piece is missing or doubled. */
export function withoutPartnerEmailsSlice3(src: string): string {
  let s = src
  for (const [piece, back] of PARTNER_EMAILS_SLICE3_HUB_PIECES) {
    const n = s.split(piece).length - 1
    if (n !== 1) throw new Error(`BeeHub.jsx: a partner emails slice 3 piece ${JSON.stringify(piece.slice(0, 60))} appears ${n} times, expected 1`)
    s = s.split(piece).join(back)
  }
  return s
}
