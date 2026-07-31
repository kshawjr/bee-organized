-- ════════════════════════════════════════════════════════════════════
--  Feedback record context — adds the nullable `context` column that lets a
--  feedback item point back at the record it was filed from (e.g. the
--  "Report a problem with this client" menu item on a client profile).
--  Extends migrations/feedback_items.sql + feedback_items_attachments.sql.
-- ════════════════════════════════════════════════════════════════════
--
-- HELD: run this by hand (Kevin). Until it runs, the app degrades gracefully —
-- POST /api/feedback catches the missing-column error and re-inserts WITHOUT
-- context, so reports still file (see lib/feedback-context.ts insertFeedbackRow).
--
-- PRIVACY (issue 110a): context stores IDS ONLY — no names, emails, or phones.
-- The reader resolves lead_id → the live record. The server whitelists the keys
-- below (lib/feedback-context.ts buildSafeContext) so nothing else lands here.
--
-- context shape (all string values; any subset may be present):
--   {
--     "kind":        "client",               -- record type (extensible)
--     "lead_id":     "<uuid>",               -- the record; resolve name/contact from this
--     "location_id": "<uuid>",               -- the record's franchise (non-PII; aids triage scoping)
--     "screen":      "Clients",              -- friendly screen the user was on
--     "path":        "/clients/<uuid>",      -- deep link to reopen the exact record
--     "origin":      "client_profile_menu"   -- which affordance filed it
--   }

alter table feedback_items
  add column if not exists context jsonb;

-- Triage groups reports by the record they came from ("everything filed about
-- this client"), so index the lead_id we look them up by. Partial: only rows
-- that actually carry a context pointer.
create index if not exists feedback_items_context_lead_idx
  on feedback_items ((context->>'lead_id'))
  where context is not null;
