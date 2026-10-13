-- 실제 간사이 DB에서 실행하는 권한 검증. 모든 테스트 행과 이력은 마지막 ROLLBACK으로 취소합니다.
begin;
select set_config('request.jwt.claim.sub','',true), set_config('request.jwt.claims','{}',true);
insert into auth.users(id,email,raw_user_meta_data) values
 ('00000000-0000-4000-8000-000000000001','rls-owner@example.invalid','{}'),
 ('00000000-0000-4000-8000-000000000002','rls-admin@example.invalid','{}'),
 ('00000000-0000-4000-8000-000000000003','rls-editor@example.invalid','{}'),
 ('00000000-0000-4000-8000-000000000004','rls-coach@example.invalid','{}'),
 ('00000000-0000-4000-8000-000000000005','rls-outsider@example.invalid','{"role":"owner"}');
insert into public.admin_roles(user_id,email,role) values
 ('00000000-0000-4000-8000-000000000001','rls-owner@example.invalid','owner'),
 ('00000000-0000-4000-8000-000000000002','rls-admin@example.invalid','administrator'),
 ('00000000-0000-4000-8000-000000000003','rls-editor@example.invalid','editor'),
 ('00000000-0000-4000-8000-000000000004','rls-coach@example.invalid','coach');

set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000003',true);
insert into public.articles(slug,title,summary,body,cover_alt,status) values
 ('rls-test-draft','RLS TEST ONLY','test','test','test','draft'),
 ('rls-test-public','RLS TEST ONLY','test','test','test','published');
do $$ begin
  begin insert into public.players(internal_name) values('RLS TEST ONLY');
    raise exception 'editor unexpectedly wrote player data';
  exception when insufficient_privilege then null; end;
  begin insert into public.admin_roles(user_id,email,role) values('00000000-0000-4000-8000-000000000005','rls-outsider@example.invalid','owner');
    raise exception 'editor unexpectedly assigned a role';
  exception when insufficient_privilege then null;
    when raise_exception then if sqlerrm not like '%owner role required%' then raise; end if; end;
end $$;

set local role anon;
select set_config('request.jwt.claim.sub','',true);
do $$ begin
  if (select count(*) from public.articles where slug='rls-test-draft') <> 0 then raise exception 'draft exposed'; end if;
  if (select count(*) from public.articles where slug='rls-test-public') <> 1 then raise exception 'public article unavailable'; end if;
  begin perform id from public.players; raise exception 'internal player data exposed'; exception when insufficient_privilege then null; end;
  begin perform player_id from private.player_contacts; raise exception 'contacts exposed'; exception when insufficient_privilege then null; end;
  begin perform approved_by from public.public_player_profiles; raise exception 'approval identities exposed'; exception when insufficient_privilege then null; end;
  begin insert into public.articles(slug,title) values('rls-test-anon','test'); raise exception 'anonymous write allowed'; exception when insufficient_privilege then null; end;
end $$;

set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000005',true);
do $$ begin
  begin insert into public.articles(slug,title) values('rls-test-outsider','test'); raise exception 'metadata escalation allowed'; exception when insufficient_privilege then null; end;
end $$;

select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000004',true);
insert into public.players(id,internal_name) values('00000000-0000-4000-8000-000000000101','RLS TEST ONLY');
insert into public.public_player_profiles(player_id,slug,display_name,position,status) values('00000000-0000-4000-8000-000000000101','rls-test-player','RLS TEST ONLY','GK','pending');
insert into public.training_sessions(title,starts_at) values('RLS TEST ONLY',now());
insert into public.fixtures(opponent) values('RLS TEST ONLY');
do $$ begin
  begin update public.public_player_profiles set status='published' where slug='rls-test-player';
    raise exception 'coach unexpectedly approved profile';
  exception when raise_exception then if sqlerrm not like '%approval requires%' then raise; end if; end;
  begin insert into public.articles(slug,title) values('rls-test-coach','test'); raise exception 'coach unexpectedly wrote article'; exception when insufficient_privilege then null; end;
end $$;

select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000002',true);
do $$ begin
  begin update public.public_player_profiles set status='published' where slug='rls-test-player';
    raise exception 'profile published without consent';
  exception when raise_exception then if sqlerrm not like '%profile consent%' then raise; end if; end;
end $$;
update public.players set profile_consent=true where id='00000000-0000-4000-8000-000000000101';
update public.public_player_profiles set status='published' where slug='rls-test-player';
do $$ begin
  begin update public.public_player_profiles set slug='rls-test-changed' where slug='rls-test-player';
    raise exception 'published profile URL changed';
  exception when raise_exception then if sqlerrm not like '%URL is immutable%' then raise; end if; end;
end $$;
set local role anon;
select set_config('request.jwt.claim.sub','',true);
do $$ begin if (select count(*) from public.public_player_profiles where slug='rls-test-player') <> 1 then raise exception 'approved profile unavailable'; end if; end $$;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000004',true);
update public.players set profile_consent=false where id='00000000-0000-4000-8000-000000000101';
set local role anon;
select set_config('request.jwt.claim.sub','',true);
do $$ begin if (select count(*) from public.public_player_profiles where slug='rls-test-player') <> 0 then raise exception 'withdrawn profile exposed'; end if; end $$;
reset role;
rollback;
select 'Real database permission checks passed; all test data rolled back.' as verification;
