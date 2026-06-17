-- Feedback items: bug reports + feature requests from any user
create table if not exists feedback_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references hub_users(id) on delete cascade,
  location_id uuid references locations(id) on delete set null,
  type text not null check (type in ('bug', 'feature')),
  title text not null,
  description text not null,
  status text not null default 'submitted'
    check (status in ('submitted', 'under_review', 'planned', 'in_progress', 'shipped', 'declined')),
  admin_response text,
  admin_response_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists feedback_items_user_idx on feedback_items(user_id, created_at desc);
create index if not exists feedback_items_status_idx on feedback_items(status, created_at desc);
create index if not exists feedback_items_location_idx on feedback_items(location_id);

-- updated_at trigger
create or replace function feedback_items_updated_at_trigger()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;

drop trigger if exists feedback_items_updated_at on feedback_items;
create trigger feedback_items_updated_at
  before update on feedback_items
  for each row execute function feedback_items_updated_at_trigger();
