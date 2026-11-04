create table public.beta_access_requests (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  name text not null check (char_length(name) between 1 and 100),
  email text not null unique check (char_length(email) <= 254),
  use_case text not null check (char_length(use_case) between 1 and 1000),
  status text not null default 'pending' check (status in ('pending', 'approved', 'declined'))
);

alter table public.beta_access_requests enable row level security;
revoke all on public.beta_access_requests from public, anon, authenticated;
create index beta_access_requests_created_at_idx on public.beta_access_requests (created_at);

create function public.request_beta_access(p_name text, p_email text, p_use_case text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  request_name text := btrim(p_name);
  request_email text := lower(btrim(p_email));
  request_use_case text := btrim(p_use_case);
begin
  if request_name is null or char_length(request_name) not between 1 and 100
    or request_email is null or char_length(request_email) > 254
    or request_email !~ '^[^[:space:]@]+@[^[:space:]@.]+(\.[^[:space:]@.]+)+$'
    or request_use_case is null or char_length(request_use_case) not between 1 and 1000 then
    raise exception using errcode = '22023', message = 'Invalid request details';
  end if;

  -- Keep the hourly limit correct even when visitors submit concurrently.
  perform pg_catalog.pg_advisory_xact_lock(184236975, 1);
  if exists (select 1 from public.beta_access_requests where email = request_email) then
    return;
  end if;
  if (select count(*) from public.beta_access_requests where created_at > now() - interval '1 hour') >= 40 then
    raise exception using errcode = 'PT429', message = 'Please try again later';
  end if;

  insert into public.beta_access_requests (name, email, use_case)
  values (request_name, request_email, request_use_case);
end;
$$;

revoke all on function public.request_beta_access(text, text, text) from public;
grant execute on function public.request_beta_access(text, text, text) to anon, authenticated;
