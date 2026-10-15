-- [편집 안내] 기존 auth.users UUID/권한/선수/콘텐츠/과거 이력을 그대로 둔 채 개인 계정을 확장합니다.
-- private 스키마는 Data API 노출 목록에 추가하지 않습니다. 이름/아이디 입력은 권한 근거가 아닙니다.
create table private.staff_accounts (
  user_id uuid primary key references auth.users(id) on delete restrict,
  username text not null unique check (username = lower(btrim(username)) and username ~ '^[a-z0-9][a-z0-9._-]{2,31}$'),
  real_name text not null check (length(btrim(real_name)) between 1 and 150 and real_name !~ '[[:cntrl:]]'),
  department text not null check (length(btrim(department)) between 1 and 200 and department !~ '[[:cntrl:]]'),
  approval_status text not null default 'pending' check (approval_status in ('pending','approved','rejected','suspended')),
  -- 전환 이전의 승인과 권한만 보존합니다. 이 플래그를 가입자 메타데이터에서 읽지 않습니다.
  legacy_account boolean not null default false,
  name_verified_by uuid references auth.users(id) on delete restrict,
  name_verified_at timestamptz,
  approved_by uuid references auth.users(id) on delete restrict,
  approved_at timestamptz,
  review_reason text,
  notice_accepted_at timestamptz not null,
  player_id uuid unique references public.players(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((name_verified_by is null) = (name_verified_at is null)),
  check (name_verified_by is null or name_verified_by <> user_id)
);
create index staff_accounts_status_idx on private.staff_accounts(approval_status,created_at);
create table private.staff_name_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references private.staff_accounts(user_id) on delete restrict,
  real_name text not null check (length(btrim(real_name)) between 1 and 150 and real_name !~ '[[:cntrl:]]'),
  reason text not null check (length(btrim(reason)) between 1 and 1000),
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  reviewed_by uuid references auth.users(id) on delete restrict,
  reviewed_at timestamptz,
  review_reason text,
  created_at timestamptz not null default now()
);
create unique index staff_name_requests_pending_idx on private.staff_name_requests(user_id) where status='pending';
-- 가입 예약과 반복 시도 키에는 비밀번호/토큰을 저장하지 않습니다. 예약 UUID는 서버만 취급합니다.
create table private.staff_auth_reservations (
  id uuid primary key default gen_random_uuid(), username text not null unique, email_lower text not null unique,
  real_name text not null, department text not null,
  created_at timestamptz not null default clock_timestamp(), expires_at timestamptz not null default clock_timestamp()+interval '15 minutes'
);
create index staff_auth_reservations_expiry_idx on private.staff_auth_reservations(expires_at);
create table private.staff_auth_rate_buckets (
  key_hash text not null check (key_hash ~ '^[0-9a-f]{64}$'), bucket text not null,
  window_start timestamptz not null, attempts integer not null,
  primary key(key_hash,bucket,window_start)
);
create index staff_auth_rate_expiry_idx on private.staff_auth_rate_buckets(window_start);
do $$ declare tbl text; begin
  foreach tbl in array array['staff_accounts','staff_name_requests','staff_auth_reservations','staff_auth_rate_buckets'] loop
    execute format('alter table private.%I enable row level security',tbl);
    execute format('revoke all on private.%I from public,anon,authenticated,service_role',tbl);
    execute format('create policy deny_client_access on private.%I for all to anon,authenticated using(false) with check(false)',tbl);
  end loop;
end $$;

-- 매 요청마다 현재 DB 상태를 확인하므로 JWT 안의 오래된 역할/수정 가능한 user_metadata를 사용하지 않습니다.
create function private.staff_role_for(p_user_id uuid) returns text language sql stable security definer set search_path='' as $$
 select r.role from public.admin_roles r left join private.staff_accounts a on a.user_id=r.user_id
 where r.user_id=p_user_id and r.active and
 (a.user_id is null or (a.approval_status='approved' and (a.legacy_account or exists(select 1 from auth.users u where u.id=r.user_id and u.email_confirmed_at is not null))))
$$;
revoke all on function private.staff_role_for(uuid) from public,anon,authenticated;
create or replace function private.current_role() returns text language sql stable security definer set search_path='' as $$
 select private.staff_role_for(auth.uid())
$$;

create function private.staff_username(p_username text) returns text language plpgsql immutable security invoker set search_path='' as $$
declare value text:=lower(btrim(p_username)); begin
 if value is null or value !~ '^[a-z0-9][a-z0-9._-]{2,31}$' then raise exception 'invalid_username' using errcode='22023'; end if;
 return value;
end $$;
create function private.staff_validate_identity(p_real_name text,p_department text,p_notice boolean) returns void language plpgsql immutable security invoker set search_path='' as $$
begin
 if coalesce(p_notice,false)=false or p_real_name is null or length(btrim(p_real_name)) not between 1 and 150 or p_real_name ~ '[[:cntrl:]]'
 or p_department is null or length(btrim(p_department)) not between 1 and 200 or p_department ~ '[[:cntrl:]]' then raise exception 'invalid_identity' using errcode='22023'; end if;
end $$;

-- 서비스 키만 부를 수 있는 아이디→현재 Auth 이메일 변환입니다. 공개 조회 경로를 제공하지 않습니다.
create function private.staff_auth_identity(p_username text) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('user_id',a.user_id,'email',u.email,'approval_status',a.approval_status)
 from private.staff_accounts a join auth.users u on u.id=a.user_id where a.username=private.staff_username(p_username)
$$;
create function private.staff_auth_rate_limit(p_key_hash text,p_bucket text,p_limit integer,p_window_seconds integer) returns boolean
language plpgsql security definer set search_path='' as $$
declare used integer; window_at timestamptz; begin
 if p_key_hash !~ '^[0-9a-f]{64}$' or p_key_hash is null or length(p_bucket) not between 1 and 80 or p_bucket is null
 or p_limit is null or p_limit not between 1 and 10000 or p_window_seconds is null or p_window_seconds not between 1 and 86400 then raise exception 'invalid_rate_bucket' using errcode='22023'; end if;
 window_at:=to_timestamp(floor(extract(epoch from clock_timestamp())/p_window_seconds)*p_window_seconds);
 insert into private.staff_auth_rate_buckets(key_hash,bucket,window_start,attempts) values(p_key_hash,p_bucket,window_at,1)
 on conflict(key_hash,bucket,window_start) do update set attempts=private.staff_auth_rate_buckets.attempts+1 returning attempts into used;
 -- 이 임시 제한 데이터는 감사 이력이 아닙니다. 48시간 경과한 버킷만 정리합니다.
 delete from private.staff_auth_rate_buckets where window_start<clock_timestamp()-interval '48 hours';
 return used<=p_limit;
end $$;
create function private.staff_auth_reserve(p_username text,p_email text,p_real_name text,p_department text,p_notice_accepted boolean) returns uuid
language plpgsql security definer set search_path='' as $$
declare uname text:=private.staff_username(p_username); mail text:=lower(btrim(p_email)); reservation uuid; begin
 perform private.staff_validate_identity(p_real_name,p_department,p_notice_accepted);
 if mail is null or length(mail)>254 or mail !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' then raise exception 'invalid_email' using errcode='22023'; end if;
 -- enroll/reserve/finalize가 같은 잠금을 사용합니다. UNIQUE 제약도 최종 방어선으로 유지합니다.
 perform pg_advisory_xact_lock(hashtextextended('staff-username:'||uname,7142303));
 delete from private.staff_auth_reservations where expires_at<clock_timestamp();
 if exists(select 1 from private.staff_accounts where username=uname) or exists(select 1 from auth.users where lower(email)=mail) then raise exception 'registration_unavailable' using errcode='23505'; end if;
 insert into private.staff_auth_reservations(username,email_lower,real_name,department) values(uname,mail,btrim(p_real_name),btrim(p_department)) returning id into reservation;
 return reservation;
end $$;
create function private.staff_auth_finalize(p_reservation uuid,p_user_id uuid) returns void language plpgsql security definer set search_path='' as $$
declare reservation private.staff_auth_reservations; begin
 select * into reservation from private.staff_auth_reservations where id=p_reservation for update;
 if reservation.id is null or reservation.expires_at<clock_timestamp() then raise exception 'registration_unavailable'; end if;
 perform pg_advisory_xact_lock(hashtextextended('staff-username:'||reservation.username,7142303));
 -- 기존 이메일 가입의 난독화 응답을 새 계정으로 오인해 연결하지 않습니다.
 if not exists(select 1 from auth.users where id=p_user_id and lower(email)=reservation.email_lower and created_at>=reservation.created_at and email_confirmed_at is null)
 or exists(select 1 from public.admin_roles where user_id=p_user_id) then raise exception 'registration_unavailable'; end if;
 insert into private.staff_accounts(user_id,username,real_name,department,notice_accepted_at)
 values(p_user_id,reservation.username,reservation.real_name,reservation.department,clock_timestamp());
 delete from private.staff_auth_reservations where id=p_reservation;
end $$;
-- public 함수는 invoker wrapper이며 private의 권한 확인된 본체만 호출합니다.
create function public.staff_auth_identity(p_username text) returns jsonb language sql stable security invoker set search_path='' as $$select private.staff_auth_identity(p_username)$$;
create function public.staff_auth_rate_limit(p_key_hash text,p_bucket text,p_limit integer,p_window_seconds integer) returns boolean language sql security invoker set search_path='' as $$select private.staff_auth_rate_limit(p_key_hash,p_bucket,p_limit,p_window_seconds)$$;
create function public.staff_auth_reserve(p_username text,p_email text,p_real_name text,p_department text,p_notice_accepted boolean) returns uuid language sql security invoker set search_path='' as $$select private.staff_auth_reserve(p_username,p_email,p_real_name,p_department,p_notice_accepted)$$;
create function public.staff_auth_finalize(p_reservation uuid,p_user_id uuid) returns void language sql security invoker set search_path='' as $$select private.staff_auth_finalize(p_reservation,p_user_id)$$;
revoke all on function public.staff_auth_identity(text),public.staff_auth_rate_limit(text,text,integer,integer),public.staff_auth_reserve(text,text,text,text,boolean),public.staff_auth_finalize(uuid,uuid) from public,anon,authenticated;
revoke all on function private.staff_auth_identity(text),private.staff_auth_rate_limit(text,text,integer,integer),private.staff_auth_reserve(text,text,text,text,boolean),private.staff_auth_finalize(uuid,uuid) from public,anon,authenticated;
grant execute on function public.staff_auth_identity(text),public.staff_auth_rate_limit(text,text,integer,integer),public.staff_auth_reserve(text,text,text,text,boolean),public.staff_auth_finalize(uuid,uuid),private.staff_auth_identity(text),private.staff_auth_rate_limit(text,text,integer,integer),private.staff_auth_reserve(text,text,text,text,boolean),private.staff_auth_finalize(uuid,uuid) to service_role;

create function private.office_account_state() returns jsonb language plpgsql stable security definer set search_path='' as $$
declare a private.staff_accounts; role_now text; begin
 if auth.uid() is null then raise exception 'authentication_required' using errcode='42501'; end if;
 select * into a from private.staff_accounts where user_id=auth.uid(); role_now:=private.current_role();
 return jsonb_build_object('user_id',auth.uid(),'username',a.username,'real_name',a.real_name,'department',a.department,
 'approval_status',case when a.user_id is null then 'legacy' else a.approval_status end,'role',role_now,'active',role_now is not null,
 'identity_enrolled',a.user_id is not null,'approved_real_name',case when a.name_verified_at is not null then a.real_name else null end,'legacy',a.user_id is null and role_now is not null,'legacy_account',coalesce(a.legacy_account,a.user_id is null and role_now is not null),
 'email_confirmed',exists(select 1 from auth.users where id=auth.uid() and email_confirmed_at is not null),
 'name_verified_at',a.name_verified_at,'name_verified_by',a.name_verified_by,'name_verified_by_name',(select v.real_name from private.staff_accounts v where v.user_id=a.name_verified_by and v.name_verified_at is not null),'review_reason',a.review_reason,
 'name_request',(select to_jsonb(q) from (select id,real_name,status,reason,created_at,review_reason from private.staff_name_requests where user_id=auth.uid() order by created_at desc limit 1) q));
end $$;
create function private.office_enroll_identity(p_username text,p_real_name text,p_department text,p_notice_accepted boolean) returns jsonb language plpgsql security definer set search_path='' as $$
declare uname text:=private.staff_username(p_username); legacy public.admin_roles; begin
 if auth.uid() is null then raise exception 'authentication_required' using errcode='42501'; end if;
 perform private.staff_validate_identity(p_real_name,p_department,p_notice_accepted);
 perform pg_advisory_xact_lock(hashtextextended('staff-username:'||uname,7142303));
 if exists(select 1 from private.staff_auth_reservations where username=uname and expires_at>=clock_timestamp()) then raise exception 'username_unavailable' using errcode='23505'; end if;
 select * into legacy from public.admin_roles where user_id=auth.uid();
 insert into private.staff_accounts(user_id,username,real_name,department,approval_status,legacy_account,notice_accepted_at)
 values(auth.uid(),uname,btrim(p_real_name),btrim(p_department),case when legacy.user_id is null then 'pending' when legacy.active then 'approved' else 'suspended' end,legacy.user_id is not null,now());
 return private.office_account_state();
end $$;
create function public.office_account_state() returns jsonb language sql stable security invoker set search_path='' as $$select private.office_account_state()$$;
create function public.office_enroll_identity(p_username text,p_real_name text,p_department text,p_notice_accepted boolean) returns jsonb language sql security invoker set search_path='' as $$select private.office_enroll_identity(p_username,p_real_name,p_department,p_notice_accepted)$$;
revoke all on function private.office_account_state(),private.office_enroll_identity(text,text,text,boolean),public.office_account_state(),public.office_enroll_identity(text,text,text,boolean) from public,anon;
grant execute on function private.office_account_state(),private.office_enroll_identity(text,text,text,boolean),public.office_account_state(),public.office_enroll_identity(text,text,text,boolean) to authenticated;

-- 기존 로그는 어떤 사람의 새 이름에도 소급 귀속하지 않습니다.
alter table public.audit_logs add column actor_name text, add column actor_name_status text not null default 'legacy_unknown',
 add column source text not null default 'legacy_unknown', add column executor text, add column requested_by uuid,
 add column action text, add column before_values jsonb not null default '{}', add column after_values jsonb not null default '{}', add column reason text;
-- 민감할 수 있는 본문/이름/연락처/선수 평가/건강 정보는 값 대신 변경 필드만 남깁니다.
create function private.audit_safe_values(p_row jsonb,p_fields text[]) returns jsonb language sql immutable security invoker set search_path='' as $$
 select coalesce(jsonb_object_agg(k,p_row->k),'{}'::jsonb) from unnest(p_fields) k
 where k=any(array['status','activity_status','position','jersey_number','display_order','featured','match_status','own_score','opponent_score','home_away','kickoff_at','starts_at','ends_at','session_status','is_public','profile_consent','photo_consent','consent_confirmed','category','role','active','approval_status','name_verified_at','approved_at','player_id','series_id','interval_weeks','occurrences','kind','album_id','published_at']) and p_row ? k
$$;
create function private.write_staff_audit(p_entity text,p_record_id text,p_action text,p_fields text[],p_before jsonb,p_after jsonb,p_reason text default null,p_operation text default null) returns void
language plpgsql security definer set search_path='' as $$
declare staff text:=private.current_role(); verified_name text; name_state text; begin
 if auth.uid() is not null then
   select real_name into verified_name from private.staff_accounts where user_id=auth.uid() and name_verified_at is not null;
   name_state:=case when verified_name is null then 'unverified' else 'verified' end;
 else name_state:='unknown'; end if;
 insert into public.audit_logs(actor_id,actor_role,actor_name,actor_name_status,entity,record_id,operation,action,changed_fields,before_values,after_values,reason,source,executor,requested_by)
 values(auth.uid(),staff,verified_name,name_state,p_entity,p_record_id,coalesce(p_operation,upper(p_action)),p_action,coalesce(p_fields,'{}'),
 private.audit_safe_values(coalesce(p_before,'{}'),p_fields),private.audit_safe_values(coalesce(p_after,'{}'),p_fields),nullif(btrim(p_reason),''),
 case when auth.uid() is not null then 'human' when current_setting('kansai.audit_source',true)='scheduled' then 'scheduled' else 'database_unattributed' end,
 case when auth.uid() is not null then 'authenticated_user' when current_setting('kansai.audit_source',true)='scheduled' then 'content_publisher' else session_user end,
 case when auth.uid() is not null then auth.uid() when current_setting('kansai.audit_source',true)='scheduled' then nullif(current_setting('kansai.audit_requestor',true),'')::uuid else null end);
end $$;
revoke all on function private.write_staff_audit(text,text,text,text[],jsonb,jsonb,text,text),private.audit_safe_values(jsonb,text[]) from public,anon,authenticated;
create or replace function private.capture_audit() returns trigger language plpgsql security definer set search_path='' as $$
declare before_row jsonb:=coalesce(to_jsonb(old),'{}'); after_row jsonb:=coalesce(to_jsonb(new),'{}'); fields text[]; action_name text:=lower(tg_op); begin
 if auth.uid() is not null and private.current_role() is null then raise exception 'active staff required'; end if;
 select array_agg(k order by k) into fields from (select jsonb_object_keys(before_row||after_row) k) keys where before_row->k is distinct from after_row->k and k<>'updated_at';
 if tg_op='UPDATE' and after_row->>'status'='published' and before_row->>'status' is distinct from 'published' then action_name:='publish';
 elsif tg_op='UPDATE' and before_row->>'status'='published' and after_row->>'status' is distinct from 'published' then action_name:='unpublish'; end if;
 perform private.write_staff_audit(tg_table_name,coalesce(after_row->>'id',after_row->>'player_id',after_row->>'user_id',before_row->>'id',before_row->>'player_id',before_row->>'user_id'),action_name,fields,before_row,after_row,null,tg_op);
 if tg_table_name in ('articles','public_player_profiles','fixtures','media_assets','media_albums','site_pages') and (before_row->>'status'='published' or after_row->>'status'='published') then update public.publication_state set version=version+1,changed_at=now() where id=1; end if;
 if tg_op='DELETE' then return old; end if; return new;
end $$;
-- 이력 원문이 별도 개인정보 조회 통로가 되지 않도록 업무별 접근을 다시 검사합니다.
create function private.can_read_audit(p_entity text) returns boolean language sql stable security definer set search_path='' as $$
 select case when private.current_role() in ('owner','administrator') then p_entity in ('admin_roles','staff_accounts','staff_name_requests','players','public_player_profiles','articles','fixtures','training_sessions','training_series','match_events','media_assets','media_albums','site_pages','club_events')
 when private.current_role()='editor' then p_entity in ('articles','media_assets','media_albums')
 when private.current_role()='coach' then p_entity in ('players','public_player_profiles','fixtures','training_sessions','training_series','match_events','club_events') else false end
$$;
revoke all on function private.can_read_audit(text) from public,anon;
grant execute on function private.can_read_audit(text) to authenticated;
drop policy audit_read on public.audit_logs;
create policy audit_read on public.audit_logs for select to authenticated using ((select private.can_read_audit(entity)));
revoke insert,update,delete on public.audit_logs from public,anon,authenticated;

-- 권한 변경은 검증하는 RPC로만 제공합니다. 예전 직접 CRUD API는 권한 회피 경로가 되지 않습니다.
revoke insert,update,delete on public.admin_roles from authenticated;
create or replace function private.guard_roles() returns trigger language plpgsql security definer set search_path='' as $$
declare staff text:=private.current_role(); target uuid:=case when tg_op='DELETE' then old.user_id else new.user_id end; begin
 perform pg_advisory_xact_lock(7142301);
 if auth.uid() is not null then
   if coalesce(staff,'') not in ('owner','administrator') then raise exception 'staff_management_required' using errcode='42501'; end if;
   if target=auth.uid() then raise exception 'self_access_change_forbidden' using errcode='42501'; end if;
   if staff='administrator' and ((tg_op<>'INSERT' and old.role in ('owner','administrator')) or (tg_op<>'DELETE' and new.role in ('owner','administrator'))) then raise exception 'role_grant_forbidden' using errcode='42501'; end if;
 end if;
 if tg_op in ('UPDATE','DELETE') and old.role='owner' and old.active and (tg_op='DELETE' or not new.active or new.role<>'owner') then
   if (select count(*) from public.admin_roles r where r.role='owner' and private.staff_role_for(r.user_id)='owner')<=1 then raise exception 'last_owner_cannot_be_removed'; end if;
 end if;
 if tg_op='DELETE' then return old; end if; return new;
end $$;
-- 상태 정지 경로에도 Owner 잠금을 사용합니다. 직접 DB 작업도 마지막 Owner 보호를 통과해야 합니다.
create function private.guard_staff_account() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if tg_op='UPDATE' and (new.user_id<>old.user_id or new.username<>old.username or new.legacy_account<>old.legacy_account) then raise exception 'account_identity_immutable'; end if;
 if tg_op='DELETE' or (tg_op='UPDATE' and old.approval_status='approved' and new.approval_status<>'approved') then
   perform pg_advisory_xact_lock(7142301);
   if exists(select 1 from public.admin_roles where user_id=old.user_id and active and role='owner') and
     (select count(*) from public.admin_roles r where r.role='owner' and private.staff_role_for(r.user_id)='owner')<=1 then raise exception 'last_owner_cannot_be_removed'; end if;
 end if;
 if tg_op='DELETE' then return old; end if; new.updated_at:=now(); return new;
end $$;
create trigger protect_staff_account before update or delete on private.staff_accounts for each row execute function private.guard_staff_account();
revoke all on function private.guard_staff_account() from public,anon,authenticated;

create function private.office_staff_directory() returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if private.current_role() is null then raise exception 'approved_staff_required' using errcode='42501'; end if;
 return coalesce((select jsonb_agg(jsonb_build_object('user_id',a.user_id,'real_name',a.real_name,'department',a.department,'activity_status',case when a.approval_status='approved' and r.active then 'active' else 'inactive' end) order by a.real_name,a.user_id)
 from private.staff_accounts a join public.admin_roles r on r.user_id=a.user_id where a.name_verified_at is not null and a.approval_status in ('approved','suspended')),'[]');
end $$;
create function private.office_staff_applications() returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if coalesce(private.current_role(),'') not in ('owner','administrator') then raise exception 'staff_management_required' using errcode='42501'; end if;
 return coalesce((select jsonb_agg(jsonb_build_object('user_id',a.user_id,'username',a.username,'real_name',a.real_name,'department',a.department,'approval_status',a.approval_status,'email_confirmed',u.email_confirmed_at is not null,'role',r.role,'active',r.active,'name_verified_at',a.name_verified_at,'name_verified_by',a.name_verified_by,'name_verified_by_name',(select v.real_name from private.staff_accounts v where v.user_id=a.name_verified_by and v.name_verified_at is not null),'created_at',a.created_at) order by a.created_at)
 from private.staff_accounts a join auth.users u on u.id=a.user_id left join public.admin_roles r on r.user_id=a.user_id),'[]');
end $$;
create function private.assert_staff_reviewer(p_user_id uuid,p_role text) returns void language plpgsql stable security definer set search_path='' as $$
declare staff text:=private.current_role(); target_role text; begin
 if auth.uid() is null or coalesce(staff,'') not in ('owner','administrator') then raise exception 'staff_management_required' using errcode='42501'; end if;
 if p_user_id=auth.uid() then raise exception 'self_review_forbidden' using errcode='42501'; end if;
 if p_role is not null and p_role not in ('owner','administrator','editor','coach') then raise exception 'invalid_role' using errcode='22023'; end if;
 select role into target_role from public.admin_roles where user_id=p_user_id;
 if staff='administrator' and (p_role in ('owner','administrator') or target_role in ('owner','administrator')) then raise exception 'role_grant_forbidden' using errcode='42501'; end if;
end $$;
create function private.office_review_staff(p_user_id uuid,p_decision text,p_role text,p_reason text) returns void language plpgsql security definer set search_path='' as $$
declare a private.staff_accounts; begin
 perform pg_advisory_xact_lock(7142301);
 perform private.assert_staff_reviewer(p_user_id,p_role);
 if p_decision is null or p_decision not in ('approved','rejected') or length(btrim(coalesce(p_reason,''))) not between 1 and 1000 then raise exception 'invalid_review' using errcode='22023'; end if;
 select * into a from private.staff_accounts where user_id=p_user_id for update;
 if a.user_id is null or a.approval_status<>'pending' then raise exception 'pending_application_required'; end if;
 if p_decision='approved' then
   if p_role is null or not exists(select 1 from auth.users where id=p_user_id and email_confirmed_at is not null) then raise exception 'email_confirmation_and_role_required'; end if;
   update private.staff_accounts set approval_status='approved',name_verified_by=auth.uid(),name_verified_at=now(),approved_by=auth.uid(),approved_at=now(),review_reason=p_reason where user_id=p_user_id;
   insert into public.admin_roles(user_id,email,role,active) select id,email,p_role,true from auth.users where id=p_user_id
   on conflict(user_id) do update set role=excluded.role,active=true;
 else update private.staff_accounts set approval_status='rejected',approved_by=auth.uid(),approved_at=now(),review_reason=p_reason where user_id=p_user_id; end if;
 perform private.write_staff_audit('staff_accounts',p_user_id::text,'application_'||p_decision,array['approval_status','role','name_verified_at'],to_jsonb(a),jsonb_build_object('approval_status',p_decision,'role',p_role,'name_verified_at',case when p_decision='approved' then now() else null end),p_reason);
end $$;
create function private.office_set_staff_access(p_user_id uuid,p_role text,p_active boolean,p_reason text) returns void language plpgsql security definer set search_path='' as $$
declare a private.staff_accounts; previous_role text; previous_active boolean; begin
 perform pg_advisory_xact_lock(7142301);
 perform private.assert_staff_reviewer(p_user_id,p_role);
 if p_role is null or p_active is null or length(btrim(coalesce(p_reason,''))) not between 1 and 1000 then raise exception 'invalid_access_change' using errcode='22023'; end if;
 select role,active into previous_role,previous_active from public.admin_roles where user_id=p_user_id for update;
 if previous_role is null then raise exception 'existing_role_required'; end if;
 select * into a from private.staff_accounts where user_id=p_user_id for update;
 if a.user_id is not null and a.approval_status not in ('approved','suspended') then raise exception 'approval_required'; end if;
 update public.admin_roles set role=p_role,active=p_active where user_id=p_user_id;
 update private.staff_accounts set approval_status=case when p_active then 'approved' else 'suspended' end,review_reason=p_reason where user_id=p_user_id;
 perform private.write_staff_audit('staff_accounts',p_user_id::text,'access_changed',array['role','active','approval_status'],jsonb_build_object('role',previous_role,'active',previous_active,'approval_status',a.approval_status),jsonb_build_object('role',p_role,'active',p_active,'approval_status',case when p_active then 'approved' else 'suspended' end),p_reason);
end $$;
create function private.office_verify_staff_identity(p_user_id uuid,p_real_name text,p_reason text) returns void language plpgsql security definer set search_path='' as $$
declare a private.staff_accounts; begin
 perform pg_advisory_xact_lock(7142301);
 perform private.assert_staff_reviewer(p_user_id,null);
 select * into a from private.staff_accounts where user_id=p_user_id for update;
 if a.user_id is null or a.approval_status<>'approved' or a.name_verified_at is not null or a.real_name is distinct from btrim(p_real_name) or length(btrim(coalesce(p_reason,''))) not between 1 and 1000 then raise exception 'identity_verification_invalid'; end if;
 update private.staff_accounts set name_verified_by=auth.uid(),name_verified_at=now() where user_id=p_user_id;
 perform private.write_staff_audit('staff_accounts',p_user_id::text,'identity_verified',array['name_verified_at'],to_jsonb(a),jsonb_build_object('name_verified_at',now()),p_reason);
end $$;
create function private.office_request_name_change(p_real_name text,p_reason text) returns void language plpgsql security definer set search_path='' as $$
declare request_id uuid; begin
 if auth.uid() is null or private.current_role() is null then raise exception 'approved_staff_required' using errcode='42501'; end if;
 if p_real_name is null or length(btrim(p_real_name)) not between 1 and 150 or p_real_name ~ '[[:cntrl:]]' or length(btrim(coalesce(p_reason,''))) not between 1 and 1000 then raise exception 'invalid_name_request' using errcode='22023'; end if;
 insert into private.staff_name_requests(user_id,real_name,reason) values(auth.uid(),btrim(p_real_name),p_reason) returning id into request_id;
 perform private.write_staff_audit('staff_name_requests',request_id::text,'name_change_requested',array['real_name'],'{}','{}',null);
end $$;
create function private.office_staff_name_requests() returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if coalesce(private.current_role(),'') not in ('owner','administrator') then raise exception 'staff_management_required' using errcode='42501'; end if;
 return coalesce((select jsonb_agg(to_jsonb(q) order by q.created_at) from (select r.id,r.user_id,a.real_name as current_real_name,r.real_name,r.reason,r.status,r.created_at,r.review_reason from private.staff_name_requests r join private.staff_accounts a on a.user_id=r.user_id) q),'[]');
end $$;
create function private.office_review_name_change(p_request_id uuid,p_approve boolean,p_reason text) returns void language plpgsql security definer set search_path='' as $$
declare req private.staff_name_requests; begin
 perform pg_advisory_xact_lock(7142301);
 select * into req from private.staff_name_requests where id=p_request_id for update;
 if req.id is null then raise exception 'name_request_not_found'; end if;
 perform private.assert_staff_reviewer(req.user_id,null);
 if req.status<>'pending' or p_approve is null or length(btrim(coalesce(p_reason,''))) not between 1 and 1000 then raise exception 'invalid_name_review' using errcode='22023'; end if;
 if p_approve then update private.staff_accounts set real_name=req.real_name,name_verified_by=auth.uid(),name_verified_at=now() where user_id=req.user_id and approval_status='approved';
 if not found then raise exception 'approved_staff_required'; end if; end if;
 update private.staff_name_requests set status=case when p_approve then 'approved' else 'rejected' end,reviewed_by=auth.uid(),reviewed_at=now(),review_reason=p_reason where id=req.id;
 perform private.write_staff_audit('staff_name_requests',req.id::text,case when p_approve then 'name_change_approved' else 'name_change_rejected' end,array['real_name','status'],to_jsonb(req),jsonb_build_object('status',case when p_approve then 'approved' else 'rejected' end),p_reason);
end $$;
create function public.office_staff_directory() returns jsonb language sql stable security invoker set search_path='' as $$select private.office_staff_directory()$$;
create function public.office_staff_applications() returns jsonb language sql stable security invoker set search_path='' as $$select private.office_staff_applications()$$;
create function public.office_review_staff(p_user_id uuid,p_decision text,p_role text,p_reason text) returns void language sql security invoker set search_path='' as $$select private.office_review_staff(p_user_id,p_decision,p_role,p_reason)$$;
create function public.office_set_staff_access(p_user_id uuid,p_role text,p_active boolean,p_reason text) returns void language sql security invoker set search_path='' as $$select private.office_set_staff_access(p_user_id,p_role,p_active,p_reason)$$;
create function public.office_verify_staff_identity(p_user_id uuid,p_real_name text,p_reason text) returns void language sql security invoker set search_path='' as $$select private.office_verify_staff_identity(p_user_id,p_real_name,p_reason)$$;
create function public.office_request_name_change(p_real_name text,p_reason text) returns void language sql security invoker set search_path='' as $$select private.office_request_name_change(p_real_name,p_reason)$$;
create function public.office_staff_name_requests() returns jsonb language sql stable security invoker set search_path='' as $$select private.office_staff_name_requests()$$;
create function public.office_review_name_change(p_request_id uuid,p_approve boolean,p_reason text) returns void language sql security invoker set search_path='' as $$select private.office_review_name_change(p_request_id,p_approve,p_reason)$$;
-- 명시적인 EXECUTE 허용 목록: private의 그 외 helper/trigger는 직접 호출할 수 없습니다.
do $$ declare f record; begin
 for f in select p.oid::regprocedure as signature,n.nspname,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private') and p.proname in ('office_staff_directory','office_staff_applications','office_review_staff','office_set_staff_access','office_verify_staff_identity','office_request_name_change','office_staff_name_requests','office_review_name_change') loop
   execute format('revoke all on function %s from public,anon',f.signature);
   execute format('grant execute on function %s to authenticated',f.signature);
 end loop;
end $$;
revoke all on function private.assert_staff_reviewer(uuid,text),private.staff_username(text),private.staff_validate_identity(text,text,boolean) from public,anon,authenticated;

-- 예약 발행은 확인된 승인자와 실제 실행기(시스템)를 구분합니다. 취소된 권한은 실행 시 재확인합니다.
create or replace function private.publish_due_content() returns integer language plpgsql security definer set search_path='' as $$
declare job private.content_releases; content jsonb; staff text; affected integer:=0; begin
 if not (select publisher_enabled from private.office_automation_settings where id=1) then return 0; end if;
 perform pg_advisory_xact_lock(7142302);
 for job in select * from private.content_releases where state='queued' and scheduled_at<=now() order by scheduled_at limit 100 for update skip locked loop
  begin
   staff:=private.staff_role_for(job.approved_by);
   if coalesce(staff,'') not in ('owner','administrator','editor') or (job.entity='site_pages' and staff='editor') then raise exception 'approval_no_longer_valid'; end if;
   execute format('select to_jsonb(t) from public.%I t where id::text=$1 for update',job.entity) into content using job.record_id;
   if content is null or (content->>'updated_at')::timestamptz is distinct from job.expected_updated_at then raise exception 'content_changed'; end if;
   perform set_config('kansai.audit_source','scheduled',true); perform set_config('kansai.audit_requestor',job.approved_by::text,true);
   execute format('update public.%I set status=''published'',published_at=$1 where id::text=$2',job.entity) using job.scheduled_at,job.record_id;
   update private.content_releases set state='published',last_error=null,completed_at=now() where entity=job.entity and record_id=job.record_id;
   affected:=affected+1;
  exception when others then update private.content_releases set state='failed',last_error='validation_or_approval_failed',completed_at=now() where entity=job.entity and record_id=job.record_id;
  end;
 end loop;
 perform set_config('kansai.audit_source','',true); perform set_config('kansai.audit_requestor','',true);
 return affected;
end $$;

create or replace function private.office_capabilities() returns jsonb language sql stable security definer set search_path='' as $$
 select case when auth.uid() is not null and private.current_role() is not null then
 jsonb_build_object('schedule',true,'content',true,'staff_identity',true,'publisher',(select publisher_enabled from private.office_automation_settings where id=1)) else '{}'::jsonb end
$$;
-- RLS와 같은 업무별 범위를 적용한 페이지 단위 조회만 제공합니다.
create function public.office_staff_audit(p_limit integer default 50,p_before_id bigint default null) returns jsonb language sql stable security invoker set search_path='' as $$
 select coalesce(jsonb_agg(to_jsonb(q) order by q.id desc),'[]'::jsonb) from
 (select * from public.audit_logs where (p_before_id is null or id<p_before_id) order by id desc limit greatest(1,least(coalesce(p_limit,50),100))) q
$$;
revoke all on function public.office_staff_audit(integer,bigint) from public,anon;
grant execute on function public.office_staff_audit(integer,bigint) to authenticated;

-- private 자료는 클라이언트 DML이 금지되어 있습니다. 가입 서비스/직접 관리 SQL의 변경도
-- 실제 사람을 추측하지 않고 동일 트랜잭션 안에 기록합니다. 승인 RPC의 의미 있는 기록도 별도로 유지합니다.
create function private.capture_identity_audit() returns trigger language plpgsql security definer set search_path='' as $$
declare before_row jsonb:=coalesce(to_jsonb(old),'{}'); after_row jsonb:=coalesce(to_jsonb(new),'{}'); fields text[]; begin
 select array_agg(k order by k) into fields from (select jsonb_object_keys(before_row||after_row) k) keys where before_row->k is distinct from after_row->k and k<>'updated_at';
 perform private.write_staff_audit(tg_table_name,coalesce(after_row->>'id',after_row->>'user_id',before_row->>'id',before_row->>'user_id'),lower(tg_op),fields,before_row,after_row,null,tg_op);
 if tg_op='DELETE' then return old; end if; return new;
end $$;
revoke all on function private.capture_identity_audit() from public,anon,authenticated;
create trigger audit_identity after insert or update or delete on private.staff_accounts for each row execute function private.capture_identity_audit();
create trigger audit_name_request after insert or update or delete on private.staff_name_requests for each row execute function private.capture_identity_audit();
