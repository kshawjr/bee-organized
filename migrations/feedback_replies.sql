-- migrations/feedback_replies.sql
--
-- THE CONVERSATION TABLE. Until now a feedback item could carry exactly one
-- reply (feedback_items.admin_response), each new reply OVERWROTE the last,
-- and nothing recorded who wrote it. This table holds the whole back-and-forth:
-- every reply, from either side, with its author and timestamp.
--
-- WHAT DOES NOT CHANGE: feedback_items.admin_response stays, and the triage
-- PATCH keeps writing it — it becomes a denormalized "latest team reply" that
-- every existing consumer (the owner screen's banner and unread logic, the
-- queue arithmetic in lib/feedback-queues, the email send rules, the seen
-- stamping) already reads correctly. The thread table adds history and
-- authorship on top; it does not replace the column.
--
-- NO BACKFILL, DELIBERATELY. The 47 legacy replies already in production stay
-- where they are (admin_response) — this migration writes no production data,
-- only DDL. The read side merges a legacy reply into the thread display
-- (lib/feedback-replies.buildFeedbackThread), so nothing an owner can see is
-- lost, and there is no guessing at authors for rows written before authorship
-- existed.
--
-- author_role IS A SNAPSHOT, not a join: 'team' when an elevated (corp) user
-- wrote it, 'owner' when the franchise side did. Roles can change later; what
-- the thread must remember is which VOICE the reply was written in at the time.
-- author_id still records exactly who, for the record.
--
-- RLS: enabled with NO policies — the same posture as feedback_items. All app
-- access goes through the service role (which bypasses RLS); the anon and
-- authenticated keys can touch nothing here. Visibility rules live in the API
-- routes, where they already exist for the items themselves.

create table if not exists public.feedback_replies (
  id uuid primary key default gen_random_uuid(),
  feedback_item_id uuid not null references public.feedback_items(id) on delete cascade,
  author_id uuid not null references public.hub_users(id),
  author_role text not null check (author_role in ('team', 'owner')),
  body text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now()
);

-- The one read pattern: all replies for an item, oldest first.
create index if not exists feedback_replies_item_created_idx
  on public.feedback_replies (feedback_item_id, created_at);

alter table public.feedback_replies enable row level security;
