-- ════════════════════════════════════════════════════════════════════
--  feedback_deletions — the trace a withdrawn report leaves behind.
--  Apply via the Supabase SQL editor. Kevin runs it; the code never does.
-- ════════════════════════════════════════════════════════════════════
--
-- WHY THIS EXISTS. An owner may now delete their own report, and the delete is
-- REAL — the feedback_items row is gone, its thread goes with it, every count,
-- queue, brief and analysis stops seeing it the moment it happens. Without this
-- table the entry would also vanish from the triage side mid-conversation with
-- nothing left to say it ever existed: a queue that was four is three, an item
-- someone had open stops saving, and nobody can tell a withdrawal from a bug.
-- This is the one line that says which it was.
--
-- THIS IS NOT A SOFT DELETE, and the shape is what makes that true:
--
--   · NO FOREIGN KEY to feedback_items. There is nothing to point at. The
--     column holds the id the row USED to have, as a plain uuid, so a log line
--     or an old email can still be matched up by hand.
--   · NO TITLE, NO DESCRIPTION, NO ATTACHMENTS, NO THREAD. Kevin's ruling, and
--     the principle behind it: THEIR WORDS GO, THE FACT OF IT STAYS. The title
--     is the person's own sentence, and keeping their sentence after they asked
--     us to delete it is the exact thing this feature exists to stop. An
--     earlier draft of this table kept it "so the trace is readable"; that was
--     the wrong trade and it is gone.
--   · SO WHAT IS A TRACE FOR? One thing: triage opening a conversation that
--     has vanished and needing to know it was withdrawn rather than lost. Who,
--     when, which location, which id, and whether we had replied answers that
--     completely — "Ankur Patel withdrew a bug report he filed on Aug 21" —
--     without naming the thing.
--   · NOTHING READS IT to rebuild an entry. It is an audit line, and the only
--     surface that ever shows it is the triage side.
--
-- had_reply IS THE PART THAT MATTERS ON THE TRIAGE SIDE. A withdrawn report we
-- never answered is housekeeping. A withdrawn report we DID answer means a
-- conversation ended from the other end, and that is worth a look.
--
-- FAILS SOFT UNTIL RUN. The delete route writes this row AFTER the entry is
-- gone and swallows every failure into a log line — a missing table must never
-- turn a successful delete into an error the owner sees, because the thing they
-- asked for has already happened. Until this migration runs, deleting works and
-- leaves a Vercel log line instead of a row.

create table if not exists public.feedback_deletions (
  id                uuid primary key default gen_random_uuid(),
  -- The id the feedback_items row had. NOT a foreign key — see the header.
  feedback_item_id  uuid not null,
  -- Who filed it, and where. Kept as real FKs: these rows still exist, and a
  -- deleted user or location should take their audit lines with them.
  user_id           uuid references public.hub_users(id) on delete cascade,
  location_id       uuid references public.locations(id) on delete set null,
  type              text,
  -- The entry's status and age at the moment it was withdrawn. Facts about the
  -- report, not a word of it: no title here, deliberately — see the header.
  status            text,
  item_created_at   timestamptz,
  -- Had the team said anything on it? See the header — this is the flag that
  -- separates housekeeping from a conversation ending from the other end.
  had_reply         boolean not null default false,
  -- Who pressed the button. Always the submitter today (the route allows
  -- nobody else), stored anyway so that stays checkable rather than assumed.
  deleted_by        uuid references public.hub_users(id) on delete set null,
  deleted_at        timestamptz not null default now()
);

create index if not exists feedback_deletions_deleted_at_idx
  on public.feedback_deletions (deleted_at desc);

create index if not exists feedback_deletions_item_idx
  on public.feedback_deletions (feedback_item_id);

comment on table public.feedback_deletions is
  'Audit line, one per report withdrawn by the person who filed it. NOT a soft delete — the feedback_items row and its thread are really gone. No title, no description, no attachments, no FK back: their words go, the fact of it stays. Written by DELETE /api/feedback/[id], read only by corp triage.';

-- ─── row-level security ──────────────────────────────────────────────
-- Nobody reads this through an anon/authed client. Every read the app makes
-- goes through the service role (which bypasses RLS), so the policy set is
-- deliberately empty: RLS on, no policies, no access. An owner must not be
-- able to enumerate what other owners have withdrawn.

alter table public.feedback_deletions enable row level security;
