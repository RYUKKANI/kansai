-- [편집 안내] 유일한 기존 총괄에게 타인 총괄 확인자가 없는 초기 전환만 별도로 기록합니다.
-- '초기 총괄 등록'은 정부 신원 확인이나 다른 사람의 실명 확인을 뜻하지 않습니다.
-- 기존 사람 확인자는 소급 생성하지 않고, 앞으로의 정상 확인/정정에는 기존 타인 심사를 유지합니다.
alter table private.staff_accounts add column name_verification_source text
  check (name_verification_source in ('staff_review','initial_owner_setup'));
alter table private.staff_accounts drop constraint staff_accounts_check;
alter table private.staff_accounts add constraint staff_accounts_name_verification_check check (
  case
    when name_verification_source is null then (name_verified_by is null)=(name_verified_at is null)
    when name_verification_source='staff_review' then name_verified_by is not null and name_verified_at is not null
    else name_verified_by is null and name_verified_at is not null and legacy_account and not profile_enrollment_pending
  end
);

-- 단 하나의 최초 전환 증거입니다. 당시 아이디는 보관하되 이후 아이디 변경의 조건으로 쓰지 않습니다.
-- 실제 요청 참조/이름은 private 원장에만 보관하고 일반 명부·감사 API에는 복제하지 않습니다.
create table private.initial_owner_identity_setup (
  singleton boolean primary key default true check (singleton),
  user_id uuid not null unique references private.staff_accounts(user_id) on delete restrict,
  username_at_setup text not null,
  real_name_at_setup text not null,
  setup_at timestamptz not null,
  notice_acknowledgment text not null check (notice_acknowledgment='delegated_account_holder_request'),
  request_reference text not null check (length(btrim(request_reference)) between 1 and 200 and request_reference !~ '[[:cntrl:]]'),
  reason text not null check (length(btrim(reason)) between 1 and 1000 and reason !~ '[[:cntrl:]]')
);
alter table private.initial_owner_identity_setup enable row level security;
revoke all on private.initial_owner_identity_setup from public,anon,authenticated,service_role;
create policy deny_client_access on private.initial_owner_identity_setup for all to anon,authenticated using(false) with check(false);
create function private.reject_initial_owner_setup_rewrite() returns trigger
language plpgsql security invoker set search_path='' as $$
begin raise exception 'initial_owner_setup_immutable' using errcode='42501'; end $$;
revoke all on function private.reject_initial_owner_setup_rewrite() from public,anon,authenticated,service_role;
create trigger initial_owner_setup_immutable before update or delete on private.initial_owner_identity_setup
  for each row execute function private.reject_initial_owner_setup_rewrite();
create trigger initial_owner_setup_no_truncate before truncate on private.initial_owner_identity_setup
  for each statement execute function private.reject_initial_owner_setup_rewrite();

-- 기존 RPC는 새 출처를 받지 않습니다. 타인 확인이 실제로 기록되면 기존 확인자/시각에 따라
-- staff_review가 되고, 확인자 없는 초기 이름은 단일 원장의 정확한 이름·시각과 일치해야 합니다.
create function private.guard_name_verification_source() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.name_verified_by is not null then
    new.name_verification_source:='staff_review';
  elsif new.name_verified_at is null then
    new.name_verification_source:=null;
  elsif new.name_verification_source is distinct from 'initial_owner_setup'
    or not exists(select 1 from private.initial_owner_identity_setup s where s.user_id=new.user_id
      and s.real_name_at_setup=new.real_name and s.setup_at=new.name_verified_at)
  then raise exception 'initial_owner_setup_proof_required' using errcode='42501';
  end if;
  return new;
end $$;
revoke all on function private.guard_name_verification_source() from public,anon,authenticated,service_role;
create trigger guard_name_verification_source before insert or update on private.staff_accounts
  for each row execute function private.guard_name_verification_source();

-- 출처는 제한된 상태 enum이라 감사 상세에 보존해도 됩니다. 이름/연락처/요청 원문 등
-- 민감 값의 기존 제외 규칙은 그대로 유지하면서 초기 등록→타인 확인 전환을 구분합니다.
create or replace function private.audit_safe_values(p_row jsonb,p_fields text[]) returns jsonb
language sql immutable security invoker set search_path='' as $$
  select coalesce(jsonb_object_agg(k,p_row->k),'{}'::jsonb) from unnest(p_fields) k
  where k=any(array['status','activity_status','position','jersey_number','display_order','featured','match_status','own_score','opponent_score','home_away','kickoff_at','starts_at','ends_at','session_status','is_public','profile_consent','photo_consent','consent_confirmed','category','role','active','approval_status','name_verified_at','name_verification_source','approved_at','player_id','series_id','interval_weeks','occurrences','kind','album_id','published_at']) and p_row ? k
$$;

-- 초기 전환은 사용자 JWT로 한 수동 작업처럼 기록하지 않습니다. 변경 행과 같은 트랜잭션의
-- AFTER 트리거가 실제 실행 주체·명시적 요청자를 구분하며 비밀/이름/요청 원문 값은 남기지 않습니다.
create or replace function private.capture_identity_audit() returns trigger
language plpgsql security definer set search_path='' as $$
declare before_row jsonb:=coalesce(to_jsonb(old),'{}'); after_row jsonb:=coalesce(to_jsonb(new),'{}'); fields text[];
begin
  select array_agg(k order by k) into fields from (select jsonb_object_keys(before_row||after_row) k) keys
    where before_row->k is distinct from after_row->k and k<>'updated_at';
  if tg_table_name='staff_accounts' and tg_op='UPDATE'
    and after_row->>'name_verification_source'='initial_owner_setup'
    and (before_row->'name_verification_source' is distinct from after_row->'name_verification_source'
      or before_row->'name_verified_at' is distinct from after_row->'name_verified_at')
  then
    insert into public.audit_logs(actor_id,actor_role,actor_name,actor_name_status,entity,record_id,operation,action,
      changed_fields,before_values,after_values,reason,source,executor,requested_by)
    values(null,null,null,'system','staff_accounts',after_row->>'user_id','INITIAL_OWNER_SETUP','initial_owner_identity_initialized',
      fields,
      jsonb_build_object('profile_enrollment_pending',before_row->'profile_enrollment_pending','name_verification_source',before_row->'name_verification_source'),
      jsonb_build_object('profile_enrollment_pending',false,'name_verification_source','initial_owner_setup','name_verified_at',after_row->'name_verified_at'),
      'Initial legacy Owner registration with delegated account-holder notice acknowledgment; not independent identity verification',
      'initial_owner_setup','ai_assisted_database_maintenance',(after_row->>'user_id')::uuid);
  else
    perform private.write_staff_audit(tg_table_name,coalesce(after_row->>'id',after_row->>'user_id',before_row->>'id',before_row->>'user_id'),
      lower(tg_op),fields,before_row,after_row,null,tg_op);
  end if;
  if tg_op='DELETE' then return old; end if; return new;
end $$;

-- 공개/서비스 RPC를 추가하지 않습니다. 실제 DB 유지보수 역할만 명시적 요청에 따라 한 번
-- 실행하며 UUID·기존 이름·현재 역할·플랫폼 정지·유효 세션을 다시 검사합니다. JWT를 위조하지 않습니다.
create function private.initialize_legacy_owner_identity(
  p_user_id uuid,p_expected_username text,p_expected_real_name text,p_notice_accepted boolean,p_request_reference text,p_reason text
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare account private.staff_accounts; stamp timestamptz;
begin
  if current_user<>'postgres' or auth.uid() is not null then
    raise exception 'database_maintenance_required' using errcode='42501';
  end if;
  perform pg_advisory_xact_lock(7142301);
  if exists(select 1 from private.initial_owner_identity_setup) then
    raise exception 'initial_owner_setup_already_used' using errcode='42501';
  end if;
  if p_notice_accepted is distinct from true
    or p_request_reference is null or length(btrim(p_request_reference)) not between 1 and 200 or p_request_reference ~ '[[:cntrl:]]'
    or p_reason is null or length(btrim(p_reason)) not between 1 and 1000 or p_reason ~ '[[:cntrl:]]'
  then raise exception 'explicit_initial_owner_request_required' using errcode='22023'; end if;
  select * into account from private.staff_accounts where user_id=p_user_id for update;
  stamp:=clock_timestamp();
  if account.user_id is null or not account.legacy_account or account.approval_status<>'approved'
    or account.name_verified_at is not null or account.name_verified_by is not null or account.name_verification_source is not null
    or account.real_name is null or account.real_name is distinct from p_expected_real_name
    or account.username is distinct from p_expected_username
    or private.staff_role_for(p_user_id) is distinct from 'owner'
    or (select count(*) from public.admin_roles where active and role='owner')<>1
    or not exists(select 1 from public.admin_roles where user_id=p_user_id and active and role='owner')
    or not exists(select 1 from auth.users u where u.id=p_user_id and (u.banned_until is null or u.banned_until<=stamp))
    or not exists(select 1 from auth.sessions s where s.user_id=p_user_id and (s.not_after is null or s.not_after>stamp))
  then raise exception 'sole_legacy_owner_setup_unavailable' using errcode='42501'; end if;
  insert into private.initial_owner_identity_setup(user_id,username_at_setup,real_name_at_setup,setup_at,notice_acknowledgment,request_reference,reason)
    values(p_user_id,account.username,account.real_name,stamp,'delegated_account_holder_request',btrim(p_request_reference),btrim(p_reason));
  update private.staff_accounts set department=coalesce(department,''),notice_accepted_at=coalesce(notice_accepted_at,stamp),
    profile_enrollment_pending=false,name_verification_source='initial_owner_setup',name_verified_at=stamp
    where user_id=p_user_id;
  return jsonb_build_object('user_id',p_user_id,'name_verification_source','initial_owner_setup','name_verified_at',stamp,'name_verified_by',null,'profile_enrollment_pending',false);
end $$;
revoke all on function private.initialize_legacy_owner_identity(uuid,text,text,boolean,text,text) from public,anon,authenticated,service_role;

-- 초기 등록 뒤 실제 다른 총괄이 생기면 같은 이름도 정식 타인 확인으로 전환할 수 있습니다.
-- 본인 확인 금지와 이미 완료된 일반 확인의 중복 거절은 그대로 유지합니다.
create or replace function private.office_verify_staff_identity(p_user_id uuid,p_real_name text,p_reason text) returns void
language plpgsql security definer set search_path='' as $$
declare a private.staff_accounts;
begin
  perform pg_advisory_xact_lock(7142301);
  perform private.assert_staff_reviewer(p_user_id,null);
  select * into a from private.staff_accounts where user_id=p_user_id for update;
  if a.user_id is null or a.approval_status<>'approved' or a.profile_enrollment_pending
    or (a.name_verified_at is not null and a.name_verification_source is distinct from 'initial_owner_setup')
    or a.real_name is distinct from btrim(p_real_name) or length(btrim(coalesce(p_reason,''))) not between 1 and 1000
  then raise exception 'identity_verification_invalid'; end if;
  update private.staff_accounts set name_verified_by=auth.uid(),name_verified_at=now() where user_id=p_user_id;
  perform private.write_staff_audit('staff_accounts',p_user_id::text,'identity_verified',array['name_verified_at','name_verification_source'],
    to_jsonb(a),jsonb_build_object('name_verified_at',now(),'name_verification_source','staff_review'),p_reason);
end $$;

-- 본인 상태·총괄의 명부/계정 조회만 출처를 받습니다. 원장과 요청 원문은 반환하지 않습니다.
create or replace function private.office_account_state() returns jsonb language plpgsql stable security definer set search_path='' as $$
declare a private.staff_accounts; role_now text; nominal_grade text; edit_mode text; begin
 if private.live_staff_session() is null then raise exception 'authentication_required' using errcode='42501'; end if;
 select * into a from private.staff_accounts where user_id=auth.uid();
 role_now:=private.current_role();
 select private.member_grade(role) into nominal_grade from public.admin_roles where user_id=auth.uid();
 edit_mode:=case when a.user_id is null or role_now is null then 'unavailable' when a.name_verified_at is not null then 'review_required' else 'unverified_edit' end;
 return jsonb_build_object('user_id',auth.uid(),'username',a.username,'real_name',a.real_name,'department',a.department,'requested_grade',a.requested_grade,'member_grade',nominal_grade,'player_id',a.player_id,
 'approval_status',case when a.user_id is null and role_now is null then 'pending' when a.user_id is null then 'legacy' else a.approval_status end,'role',role_now,'active',role_now is not null,
 'identity_enrolled',a.user_id is not null and not a.profile_enrollment_pending,'profile_enrollment_pending',coalesce(a.profile_enrollment_pending,role_now is not null),
 'name_edit_mode',edit_mode,'can_edit_real_name',edit_mode='unverified_edit','approved_real_name',case when a.name_verified_at is not null then a.real_name else null end,
 'legacy',role_now is not null and (a.user_id is null or (a.legacy_account and a.profile_enrollment_pending)), 'legacy_account',coalesce(a.legacy_account,a.user_id is null and role_now is not null),
 'email_confirmation_required',coalesce(a.email_confirmation_required,not private.is_manual_staff_signup(auth.uid())),
 'email_verification_status',case when coalesce(a.email_confirmation_required,not private.is_manual_staff_signup(auth.uid()))=false then 'not_required' when exists(select 1 from auth.users where id=auth.uid() and email_confirmed_at is not null) then 'verified' else 'pending' end,
 'email_confirmed',coalesce(a.email_confirmation_required,not private.is_manual_staff_signup(auth.uid())) and exists(select 1 from auth.users where id=auth.uid() and email_confirmed_at is not null),
 'name_verification_source',a.name_verification_source,'name_verified_at',a.name_verified_at,'name_verified_by',a.name_verified_by,'name_verified_by_name',(select v.real_name from private.staff_accounts v where v.user_id=a.name_verified_by and v.name_verified_at is not null),'review_reason',a.review_reason,
 'name_request',(select to_jsonb(q) from (select id,real_name,status,reason,created_at,review_reason from private.staff_name_requests where user_id=auth.uid() order by created_at desc,id desc limit 1) q));
end $$;

create or replace function private.office_staff_applications() returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 perform private.require_live_owner();
 return coalesce((select jsonb_agg(jsonb_build_object('user_id',a.user_id,'username',a.username,'real_name',a.real_name,'department',a.department,'requested_grade',a.requested_grade,'player_id',a.player_id,
 'profile_enrollment_pending',a.profile_enrollment_pending,'approval_status',a.approval_status,'email_confirmation_required',a.email_confirmation_required,'email_verification_status',case when not a.email_confirmation_required then 'not_required' when u.email_confirmed_at is not null then 'verified' else 'pending' end,'email_confirmed',a.email_confirmation_required and u.email_confirmed_at is not null,
 'role',private.member_grade(r.role),'active',coalesce(r.active,false),'name_verification_source',a.name_verification_source,'name_verified_at',a.name_verified_at,'name_verified_by',a.name_verified_by,'name_verified_by_name',(select v.real_name from private.staff_accounts v where v.user_id=a.name_verified_by and v.name_verified_at is not null),'created_at',a.created_at) order by a.created_at)
 from private.staff_accounts a join auth.users u on u.id=a.user_id left join public.admin_roles r on r.user_id=a.user_id),'[]');
end $$;

create or replace function private.office_owner_account(p_user_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb; begin
 perform private.require_live_owner();
 select jsonb_build_object('user_id',a.user_id,'username',a.username,'real_name',a.real_name,'department',a.department,'requested_grade',a.requested_grade,'player_id',a.player_id,'password_is_set',coalesce(u.encrypted_password,'')<>'',
 'approval_status',a.approval_status,'role',private.member_grade(r.role),'member_grade',private.member_grade(r.role),'active',coalesce(r.active,false),'name_verification_source',a.name_verification_source,'name_verified_at',a.name_verified_at,'name_verified_by',a.name_verified_by,
 'profile_enrollment_pending',a.profile_enrollment_pending,'can_edit_real_name',a.user_id<>auth.uid() or a.name_verified_at is null)
 into result from private.staff_accounts a join auth.users u on u.id=a.user_id left join public.admin_roles r on r.user_id=a.user_id where a.user_id=p_user_id;
 if result is null then raise exception 'mapped_account_required' using errcode='42501'; end if;
 return result;
end $$;
