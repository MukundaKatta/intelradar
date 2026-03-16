-- IntelRadar: Full database schema with RLS policies
-- Requires pgvector extension for embedding storage

-- ─── Extensions ───
create extension if not exists "uuid-ossp";
create extension if not exists "vector";
create extension if not exists "pg_trgm"; -- for fuzzy text search

-- ─── Enums ───
create type plan_tier as enum ('free', 'pro', 'enterprise');
create type member_role as enum ('owner', 'admin', 'member', 'viewer');
create type signal_type as enum (
  'website_change', 'pricing_change', 'job_posting', 'news_mention',
  'blog_post', 'social_media', 'product_launch', 'feature_update',
  'tech_stack_change', 'leadership_change', 'funding_round',
  'partnership', 'acquisition'
);
create type signal_severity as enum ('low', 'medium', 'high', 'critical');
create type alert_channel_type as enum ('email', 'slack', 'discord', 'webhook');
create type alert_status as enum ('sent', 'failed', 'pending');

-- ─── Workspaces ───
create table workspaces (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  slug text not null unique,
  owner_id uuid not null references auth.users(id) on delete cascade,
  plan plan_tier not null default 'free',
  stripe_customer_id text,
  stripe_subscription_id text,
  max_competitors int not null default 3,
  max_monitors int not null default 5,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_workspaces_owner on workspaces(owner_id);
create index idx_workspaces_slug on workspaces(slug);

-- ─── Workspace Members ───
create table workspace_members (
  id uuid primary key default uuid_generate_v4(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role member_role not null default 'member',
  invited_email text,
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  unique(workspace_id, user_id)
);

create index idx_wm_workspace on workspace_members(workspace_id);
create index idx_wm_user on workspace_members(user_id);

-- ─── Competitors ───
create table competitors (
  id uuid primary key default uuid_generate_v4(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null,
  domain text not null,
  logo_url text,
  description text,
  website_url text not null,
  linkedin_url text,
  twitter_handle text,
  crunchbase_url text,
  industry text,
  employee_count_range text,
  funding_stage text,
  tags text[] not null default '{}',
  monitoring_enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_competitors_workspace on competitors(workspace_id);
create index idx_competitors_domain on competitors(domain);

-- ─── Signals ───
create table signals (
  id uuid primary key default uuid_generate_v4(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  competitor_id uuid not null references competitors(id) on delete cascade,
  type signal_type not null,
  severity signal_severity not null default 'low',
  title text not null,
  summary text not null,
  raw_data jsonb not null default '{}',
  source_url text,
  source_name text not null,
  ai_analysis text,
  significance_score int not null default 50 check (significance_score between 0 and 100),
  embedding vector(1536),
  is_read boolean not null default false,
  created_at timestamptz not null default now()
);

create index idx_signals_workspace on signals(workspace_id);
create index idx_signals_competitor on signals(competitor_id);
create index idx_signals_type on signals(type);
create index idx_signals_severity on signals(severity);
create index idx_signals_created on signals(created_at desc);
create index idx_signals_score on signals(significance_score desc);
create index idx_signals_embedding on signals using ivfflat (embedding vector_cosine_ops) with (lists = 100);

-- ─── Intelligence Briefs ───
create table intelligence_briefs (
  id uuid primary key default uuid_generate_v4(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  title text not null,
  period_start timestamptz not null,
  period_end timestamptz not null,
  executive_summary text not null,
  key_findings jsonb not null default '[]',
  competitor_summaries jsonb not null default '[]',
  strategic_recommendations text[] not null default '{}',
  market_trends text[] not null default '{}',
  raw_markdown text not null,
  created_at timestamptz not null default now()
);

create index idx_briefs_workspace on intelligence_briefs(workspace_id);
create index idx_briefs_period on intelligence_briefs(period_start, period_end);

-- ─── Battlecards ───
create table battlecards (
  id uuid primary key default uuid_generate_v4(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  competitor_id uuid not null references competitors(id) on delete cascade,
  title text not null,
  overview text not null,
  strengths text[] not null default '{}',
  weaknesses text[] not null default '{}',
  pricing_comparison jsonb,
  key_differentiators text[] not null default '{}',
  common_objections jsonb not null default '[]',
  win_strategies text[] not null default '{}',
  talk_track text not null default '',
  last_updated_signals text[] not null default '{}',
  version int not null default 1,
  raw_markdown text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_battlecards_workspace on battlecards(workspace_id);
create index idx_battlecards_competitor on battlecards(competitor_id);

-- ─── Alert Rules ───
create table alert_rules (
  id uuid primary key default uuid_generate_v4(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null,
  description text,
  competitor_ids uuid[] not null default '{}',
  signal_types signal_type[] not null default '{}',
  min_severity signal_severity not null default 'medium',
  min_significance_score int not null default 50,
  channels jsonb not null default '[]',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_alerts_workspace on alert_rules(workspace_id);

-- ─── Alert History ───
create table alert_history (
  id uuid primary key default uuid_generate_v4(),
  alert_rule_id uuid not null references alert_rules(id) on delete cascade,
  signal_id uuid not null references signals(id) on delete cascade,
  channel_type alert_channel_type not null,
  status alert_status not null default 'pending',
  error_message text,
  sent_at timestamptz not null default now()
);

create index idx_alert_history_rule on alert_history(alert_rule_id);
create index idx_alert_history_signal on alert_history(signal_id);

-- ─── Pricing Snapshots ───
create table pricing_snapshots (
  id uuid primary key default uuid_generate_v4(),
  competitor_id uuid not null references competitors(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  plans jsonb not null default '[]',
  raw_html text,
  screenshot_url text,
  captured_at timestamptz not null default now()
);

create index idx_pricing_competitor on pricing_snapshots(competitor_id);
create index idx_pricing_captured on pricing_snapshots(captured_at desc);

-- ─── Job Postings ───
create table job_postings (
  id uuid primary key default uuid_generate_v4(),
  competitor_id uuid not null references competitors(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  title text not null,
  department text,
  location text,
  description text,
  url text not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  is_active boolean not null default true
);

create index idx_jobs_competitor on job_postings(competitor_id);
create index idx_jobs_active on job_postings(is_active) where is_active = true;

-- ─── Website Snapshots ───
create table website_snapshots (
  id uuid primary key default uuid_generate_v4(),
  competitor_id uuid not null references competitors(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  url text not null,
  content_hash text not null,
  text_content text not null,
  diff_from_previous text,
  captured_at timestamptz not null default now()
);

create index idx_snapshots_competitor on website_snapshots(competitor_id);
create index idx_snapshots_hash on website_snapshots(content_hash);

-- ═══════════════════════════════════════════════
-- Row Level Security Policies
-- ═══════════════════════════════════════════════

alter table workspaces enable row level security;
alter table workspace_members enable row level security;
alter table competitors enable row level security;
alter table signals enable row level security;
alter table intelligence_briefs enable row level security;
alter table battlecards enable row level security;
alter table alert_rules enable row level security;
alter table alert_history enable row level security;
alter table pricing_snapshots enable row level security;
alter table job_postings enable row level security;
alter table website_snapshots enable row level security;

-- Helper function: check if user is a member of a workspace
create or replace function is_workspace_member(ws_id uuid)
returns boolean as $$
  select exists (
    select 1 from workspace_members
    where workspace_id = ws_id
      and user_id = auth.uid()
      and accepted_at is not null
  );
$$ language sql security definer stable;

-- Helper function: check if user is admin or owner of workspace
create or replace function is_workspace_admin(ws_id uuid)
returns boolean as $$
  select exists (
    select 1 from workspace_members
    where workspace_id = ws_id
      and user_id = auth.uid()
      and role in ('owner', 'admin')
      and accepted_at is not null
  );
$$ language sql security definer stable;

-- Workspaces: owner can do everything, members can read
create policy "workspace_select" on workspaces for select
  using (is_workspace_member(id) or owner_id = auth.uid());

create policy "workspace_insert" on workspaces for insert
  with check (owner_id = auth.uid());

create policy "workspace_update" on workspaces for update
  using (is_workspace_admin(id));

create policy "workspace_delete" on workspaces for delete
  using (owner_id = auth.uid());

-- Workspace Members
create policy "wm_select" on workspace_members for select
  using (is_workspace_member(workspace_id) or user_id = auth.uid());

create policy "wm_insert" on workspace_members for insert
  with check (is_workspace_admin(workspace_id));

create policy "wm_update" on workspace_members for update
  using (is_workspace_admin(workspace_id));

create policy "wm_delete" on workspace_members for delete
  using (is_workspace_admin(workspace_id) or user_id = auth.uid());

-- Competitors
create policy "competitors_select" on competitors for select
  using (is_workspace_member(workspace_id));

create policy "competitors_insert" on competitors for insert
  with check (is_workspace_member(workspace_id));

create policy "competitors_update" on competitors for update
  using (is_workspace_admin(workspace_id));

create policy "competitors_delete" on competitors for delete
  using (is_workspace_admin(workspace_id));

-- Signals
create policy "signals_select" on signals for select
  using (is_workspace_member(workspace_id));

create policy "signals_update" on signals for update
  using (is_workspace_member(workspace_id));

-- Intelligence Briefs
create policy "briefs_select" on intelligence_briefs for select
  using (is_workspace_member(workspace_id));

-- Battlecards
create policy "battlecards_select" on battlecards for select
  using (is_workspace_member(workspace_id));

-- Alert Rules
create policy "alerts_select" on alert_rules for select
  using (is_workspace_member(workspace_id));

create policy "alerts_insert" on alert_rules for insert
  with check (is_workspace_member(workspace_id));

create policy "alerts_update" on alert_rules for update
  using (is_workspace_admin(workspace_id));

create policy "alerts_delete" on alert_rules for delete
  using (is_workspace_admin(workspace_id));

-- Alert History
create policy "alert_history_select" on alert_history for select
  using (
    exists (
      select 1 from alert_rules ar
      where ar.id = alert_history.alert_rule_id
        and is_workspace_member(ar.workspace_id)
    )
  );

-- Pricing Snapshots
create policy "pricing_select" on pricing_snapshots for select
  using (is_workspace_member(workspace_id));

-- Job Postings
create policy "jobs_select" on job_postings for select
  using (is_workspace_member(workspace_id));

-- Website Snapshots
create policy "snapshots_select" on website_snapshots for select
  using (is_workspace_member(workspace_id));

-- ─── Updated-at triggers ───
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger trg_workspaces_updated before update on workspaces
  for each row execute function update_updated_at();

create trigger trg_competitors_updated before update on competitors
  for each row execute function update_updated_at();

create trigger trg_battlecards_updated before update on battlecards
  for each row execute function update_updated_at();

create trigger trg_alert_rules_updated before update on alert_rules
  for each row execute function update_updated_at();

-- ─── Auto-add owner as workspace member on workspace creation ───
create or replace function auto_add_owner_member()
returns trigger as $$
begin
  insert into workspace_members (workspace_id, user_id, role, accepted_at)
  values (new.id, new.owner_id, 'owner', now());
  return new;
end;
$$ language plpgsql security definer;

create trigger trg_workspace_auto_member after insert on workspaces
  for each row execute function auto_add_owner_member();
