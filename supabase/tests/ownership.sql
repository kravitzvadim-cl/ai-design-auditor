-- Run against an empty/controlled staging database. All fixtures roll back.
-- Exercises database roles/RLS, not real Auth sessions or Storage HTTP delivery.
begin;
insert into auth.users(id, email, invited_at) values
 ('10000000-0000-4000-8000-000000000001', 'alice@example.invalid', now()),
 ('10000000-0000-4000-8000-000000000002', 'bob@example.invalid', now()),
 ('10000000-0000-4000-8000-000000000003', 'not-invited@example.invalid', null);
insert into public.audit_projects(id,owner_id,name) values
 ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','Alice fixture'),
 ('20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000002','Bob fixture');
insert into public.audit_records(id,project_id,owner_id,kind,payload) values
 ('30000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','source','{}'),
 ('30000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000002','source','{}');
insert into storage.objects(bucket_id,name) values
 ('audit-private','10000000-0000-4000-8000-000000000001/20000000-0000-4000-8000-000000000001/fixture.txt'),
 ('audit-private','10000000-0000-4000-8000-000000000002/20000000-0000-4000-8000-000000000002/fixture.txt');

set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
do $$
declare affected integer;
begin
 if (select count(*) from public.audit_projects) <> 1 then raise exception 'Project read isolation failed'; end if;
 if (select count(*) from public.audit_records) <> 1 then raise exception 'Record read isolation failed'; end if;
 if (select count(*) from storage.objects where bucket_id='audit-private') <> 1 then raise exception 'File read isolation failed'; end if;
 if private.owns_audit_file('10000000-0000-4000-8000-000000000001/not-a-project/fixture.txt') then raise exception 'Invalid file project accepted'; end if;
 update public.audit_projects set name='Forbidden' where id='20000000-0000-4000-8000-000000000002';
 get diagnostics affected=row_count;
 if affected <> 0 then raise exception 'Cross-user update succeeded'; end if;
 begin
  insert into public.audit_projects(owner_id,name) values ('10000000-0000-4000-8000-000000000002','Forbidden');
  raise exception 'Cross-user insert succeeded';
 exception when insufficient_privilege then null; end;
 begin
  insert into public.audit_records(project_id,kind,payload) values ('20000000-0000-4000-8000-000000000002','source','{}');
  raise exception 'Foreign project record accepted';
 exception when foreign_key_violation then null; end;
 begin
  update public.app_members set active=true;
  raise exception 'Member could change access';
 exception when insufficient_privilege then null; end;
end;
$$;

select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000003', true);
do $$ begin
 if private.is_active_member() then raise exception 'Signup received invite access'; end if;
 if (select count(*) from public.audit_projects) <> 0 then raise exception 'Non-invite read allowed'; end if;
 begin
  insert into public.audit_projects(name) values ('Forbidden');
  raise exception 'Non-invite write allowed';
 exception when insufficient_privilege then null; end;
end; $$;

reset role;
update public.app_members set active=false where user_id='10000000-0000-4000-8000-000000000001';
set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
do $$ begin
 if private.is_active_member() then raise exception 'Revocation not enforced'; end if;
 if (select count(*) from public.audit_projects) <> 0 then raise exception 'Revoked project access'; end if;
 if (select count(*) from public.audit_records) <> 0 then raise exception 'Revoked record access'; end if;
 if (select count(*) from storage.objects where bucket_id='audit-private') <> 0 then raise exception 'Revoked file access'; end if;
end; $$;

set local role anon;
do $$ begin
 if has_table_privilege(current_user,'public.audit_projects','SELECT') then raise exception 'Anonymous project grant'; end if;
 if has_table_privilege(current_user,'public.audit_records','SELECT') then raise exception 'Anonymous record grant'; end if;
 if has_table_privilege(current_user,'public.app_members','INSERT') then raise exception 'Anonymous membership grant'; end if;
 if (select count(*) from storage.objects where bucket_id='audit-private') <> 0 then raise exception 'Anonymous file access'; end if;
end; $$;
rollback;
select 'PASS: ownership, membership, revocation and anonymous RLS assertions; fixtures rolled back' as result;
