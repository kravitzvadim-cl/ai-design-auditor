-- Foundation only. App integration, signup configuration and real-session tests
-- are separate release gates. Never grant beta access from user-editable metadata.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated;

create table public.app_members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.app_members enable row level security;
revoke all on public.app_members from public, anon, authenticated;
grant select on public.app_members to authenticated;
create policy member_reads_self on public.app_members for select to authenticated
  using (user_id = (select auth.uid()));

create function private.is_active_member() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.app_members where user_id = (select auth.uid()) and active);
$$;
revoke all on function private.is_active_member() from public, anon;
grant execute on function private.is_active_member() to authenticated;

create function private.accept_admin_invitation() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.invited_at is not null then
    insert into public.app_members(user_id) values (new.id);
  end if;
  return new;
end;
$$;
revoke all on function private.accept_admin_invitation() from public, anon, authenticated;
create trigger audit_accept_admin_invitation after insert on auth.users
for each row execute function private.accept_admin_invitation();

create table public.audit_projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (length(name) between 1 and 120),
  created_at timestamptz not null default now(),
  unique(id, owner_id)
);
alter table public.audit_projects enable row level security;
revoke all on public.audit_projects from public, anon, authenticated;
grant select, insert, update, delete on public.audit_projects to authenticated;
create policy owner_projects on public.audit_projects for all to authenticated
  using (owner_id = (select auth.uid()) and (select private.is_active_member()))
  with check (owner_id = (select auth.uid()) and (select private.is_active_member()));
create index audit_projects_owner on public.audit_projects(owner_id);

create table public.audit_records (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null,
  owner_id uuid not null default auth.uid(),
  kind text not null check (kind in ('source', 'system', 'target', 'job', 'report')),
  payload jsonb not null check (octet_length(payload::text) <= 8000000),
  created_at timestamptz not null default now(),
  foreign key (project_id, owner_id) references public.audit_projects(id, owner_id) on delete cascade
);
alter table public.audit_records enable row level security;
revoke all on public.audit_records from public, anon, authenticated;
grant select, insert, update, delete on public.audit_records to authenticated;
create policy owner_records on public.audit_records for all to authenticated
  using (owner_id = (select auth.uid()) and (select private.is_active_member()))
  with check (owner_id = (select auth.uid()) and (select private.is_active_member()));
create index audit_records_project on public.audit_records(project_id, owner_id);
create index audit_records_owner on public.audit_records(owner_id);

insert into storage.buckets(id, name, public, file_size_limit)
values ('audit-private', 'audit-private', false, 16000000);

-- Immutable files at user UUID / project UUID / generated filename. Project
-- existence is checked as text, so malformed paths fail closed without a cast.
create function private.owns_audit_file(object_name text) returns boolean
language sql stable security invoker set search_path = '' as $$
  select private.is_active_member()
    and split_part(object_name, '/', 1) = (select auth.uid())::text
    and exists (select 1 from public.audit_projects p
      where p.id::text = split_part(object_name, '/', 2)
        and p.owner_id = (select auth.uid()));
$$;
revoke all on function private.owns_audit_file(text) from public, anon;
grant execute on function private.owns_audit_file(text) to authenticated;
create policy owner_audit_file_read on storage.objects for select to authenticated
  using (bucket_id = 'audit-private' and private.owns_audit_file(name));
create policy owner_audit_file_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'audit-private' and private.owns_audit_file(name));
create policy owner_audit_file_delete on storage.objects for delete to authenticated
  using (bucket_id = 'audit-private' and private.owns_audit_file(name));
