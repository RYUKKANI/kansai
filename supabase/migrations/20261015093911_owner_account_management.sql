-- [편집 안내] 회원 관리는 현재 DB의 Owner + 실제 남아 있는 Auth 세션으로 제한합니다.
-- JWT의 role/user_metadata를 신뢰하지 않으며, 비밀번호 값은 이 스키마로 받거나 기록하지 않습니다.
create function private.require_live_owner() returns uuid language plpgsql stable security definer set search_path='' as $$
declare actor uuid:=auth.uid(); claims jsonb:=auth.jwt(); sid uuid; session_aal text; begin
 if actor is null or private.current_role() is distinct from 'owner' then raise exception 'live_owner_required' using errcode='42501'; end if;
 begin sid:=nullif(claims->>'session_id','')::uuid; exception when invalid_text_representation then raise exception 'live_owner_session_required' using errcode='42501'; end;
 select s.aal::text into session_aal from auth.sessions s where s.id=sid and s.user_id=actor and (s.not_after is null or s.not_after>clock_timestamp());
 if not found then raise exception 'live_owner_session_required' using errcode='42501'; end if;
 if exists(select 1 from auth.mfa_factors f where f.user_id=actor and f.status::text='verified')
 and (claims->>'aal' is distinct from 'aal2' or session_aal is distinct from 'aal2') then raise exception 'owner_mfa_required' using errcode='42501'; end if;
 return sid;
end $$;
revoke all on function private.require_live_owner() from public,anon,authenticated,service_role;

-- 레거시의 본인이 아직 제공하지 않은 소속/안내 확인은 채우지 않습니다. 이름만 먼저 입력해도
-- 프로필은 미완료이고 확인된 실명/명부 노출은 그대로 금지됩니다. 신규 신청의 필수 정보는 유지합니다.
alter table private.staff_accounts drop constraint staff_accounts_profile_enrollment_check;
alter table private.staff_accounts add constraint staff_accounts_profile_enrollment_check check (
 (profile_enrollment_pending and legacy_account and department is null and notice_accepted_at is null and name_verified_at is null and name_verified_by is null)
 or (not profile_enrollment_pending and real_name is not null and department is not null and notice_accepted_at is not null)
);
create or replace function private.guard_staff_account() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if tg_op='UPDATE' and (new.user_id<>old.user_id or new.legacy_account<>old.legacy_account or new.email_confirmation_required<>old.email_confirmation_required) then raise exception 'account_identity_immutable'; end if;
 if tg_op='UPDATE' and new.username<>old.username then perform private.require_live_owner(); end if;
 if tg_op='UPDATE' and not old.profile_enrollment_pending and new.profile_enrollment_pending then raise exception 'completed_identity_cannot_be_reset'; end if;
 if tg_op='DELETE' or (tg_op='UPDATE' and old.approval_status='approved' and new.approval_status<>'approved') then
   perform pg_advisory_xact_lock(7142301);
   if exists(select 1 from public.admin_roles where user_id=old.user_id and active and role='owner') and
     (select count(*) from public.admin_roles r where r.role='owner' and private.staff_role_for(r.user_id)='owner')<=1 then raise exception 'last_owner_cannot_be_removed'; end if;
 end if;
 if tg_op='DELETE' then return old; end if; new.updated_at:=now(); return new;
end $$;

-- 기존 승인/정지/실명 정정 RPC의 공통 진입점도 Owner 전용으로 좁힙니다. 자기 승인 금지는 유지합니다.
create or replace function private.assert_staff_reviewer(p_user_id uuid,p_role text) returns void language plpgsql stable security definer set search_path='' as $$
begin
 perform private.require_live_owner();
 if p_user_id=auth.uid() then raise exception 'self_review_forbidden' using errcode='42501'; end if;
 if p_role is not null and p_role not in ('owner','administrator','editor','coach') then raise exception 'invalid_role' using errcode='22023'; end if;
end $$;
create or replace function private.guard_roles() returns trigger language plpgsql security definer set search_path='' as $$
declare target uuid:=case when tg_op='DELETE' then old.user_id else new.user_id end; begin
 perform pg_advisory_xact_lock(7142301);
 if auth.uid() is not null then
   perform private.require_live_owner();
   if target=auth.uid() then raise exception 'self_access_change_forbidden' using errcode='42501'; end if;
 end if;
 if tg_op in ('UPDATE','DELETE') and old.role='owner' and old.active and (tg_op='DELETE' or not new.active or new.role<>'owner') then
   if (select count(*) from public.admin_roles r where r.role='owner' and private.staff_role_for(r.user_id)='owner')<=1 then raise exception 'last_owner_cannot_be_removed'; end if;
 end if;
 if tg_op='DELETE' then return old; end if; return new;
end $$;
create or replace function private.office_staff_applications() returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 perform private.require_live_owner();
 return coalesce((select jsonb_agg(jsonb_build_object('user_id',a.user_id,'username',a.username,'real_name',a.real_name,'department',a.department,'approval_status',a.approval_status,'email_confirmation_required',a.email_confirmation_required,'email_verification_status',case when not a.email_confirmation_required then 'not_required' when u.email_confirmed_at is not null then 'verified' else 'pending' end,'email_confirmed',a.email_confirmation_required and u.email_confirmed_at is not null,'role',r.role,'active',r.active,'name_verified_at',a.name_verified_at,'name_verified_by',a.name_verified_by,'name_verified_by_name',(select v.real_name from private.staff_accounts v where v.user_id=a.name_verified_by and v.name_verified_at is not null),'created_at',a.created_at) order by a.created_at)
 from private.staff_accounts a join auth.users u on u.id=a.user_id left join public.admin_roles r on r.user_id=a.user_id),'[]');
end $$;
create or replace function private.office_staff_name_requests() returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 perform private.require_live_owner();
 return coalesce((select jsonb_agg(to_jsonb(q) order by q.created_at) from (select r.id,r.user_id,a.real_name as current_real_name,r.real_name,r.reason,r.status,r.created_at,r.review_reason from private.staff_name_requests r join private.staff_accounts a on a.user_id=r.user_id) q),'[]');
end $$;
create or replace function private.office_staff_application_contact(p_user_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare contact_email text; begin
 perform private.require_live_owner();
 if p_user_id=auth.uid() then raise exception 'owner_contact_review_required' using errcode='42501'; end if;
 select u.email into contact_email from private.staff_accounts a join auth.users u on u.id=a.user_id where a.user_id=p_user_id and a.approval_status='pending' and not a.email_confirmation_required;
 if contact_email is null then raise exception 'pending_manual_application_required' using errcode='42501'; end if;
 return jsonb_build_object('user_id',p_user_id,'email',contact_email,'email_confirmation_required',false,'email_verification_status','not_required');
end $$;

-- 요청 UUID의 존재 여부도 Owner 확인 이후에 조회합니다.
create or replace function private.office_review_name_change(p_request_id uuid,p_approve boolean,p_reason text) returns void language plpgsql security definer set search_path='' as $$
declare req private.staff_name_requests; begin
 perform pg_advisory_xact_lock(7142301);
 perform private.require_live_owner();
 select * into req from private.staff_name_requests where id=p_request_id for update;
 if req.id is null then raise exception 'name_request_not_found'; end if;
 perform private.assert_staff_reviewer(req.user_id,null);
 if req.status<>'pending' or p_approve is null or length(btrim(coalesce(p_reason,''))) not between 1 and 1000 then raise exception 'invalid_name_review' using errcode='22023'; end if;
 if p_approve then update private.staff_accounts set real_name=req.real_name,name_verified_by=auth.uid(),name_verified_at=now() where user_id=req.user_id and approval_status='approved';
 if not found then raise exception 'approved_staff_required'; end if; end if;
 update private.staff_name_requests set status=case when p_approve then 'approved' else 'rejected' end,reviewed_by=auth.uid(),reviewed_at=now(),review_reason=p_reason where id=req.id;
 perform private.write_staff_audit('staff_name_requests',req.id::text,case when p_approve then 'name_change_approved' else 'name_change_rejected' end,array['real_name','status'],to_jsonb(req),jsonb_build_object('status',case when p_approve then 'approved' else 'rejected' end),p_reason);
end $$;

create function private.office_owner_account(p_user_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb; begin
 perform private.require_live_owner();
 -- 네이티브 해시의 존재 여부만 SQL 안에서 계산합니다. 해시/이메일 자체는 결과에 포함하지 않습니다.
 select jsonb_build_object('user_id',a.user_id,'username',a.username,'real_name',a.real_name,'password_is_set',coalesce(u.encrypted_password,'')<>'',
 'approval_status',a.approval_status,'role',r.role,'active',coalesce(r.active,false),'name_verified_at',a.name_verified_at,'name_verified_by',a.name_verified_by,
 'profile_enrollment_pending',a.profile_enrollment_pending,'can_edit_real_name',a.user_id<>auth.uid() or a.name_verified_at is null)
 into result from private.staff_accounts a join auth.users u on u.id=a.user_id left join public.admin_roles r on r.user_id=a.user_id where a.user_id=p_user_id;
 if result is null then raise exception 'mapped_account_required' using errcode='42501'; end if;
 return result;
end $$;
create function private.office_owner_update_identity(p_user_id uuid,p_username text,p_real_name text,p_reason text) returns jsonb language plpgsql security definer set search_path='' as $$
declare uname text; oldname text; newname text:=nullif(btrim(p_real_name),''); account private.staff_accounts; lockname text; begin
 perform pg_advisory_xact_lock(7142301);
 perform private.require_live_owner();
 uname:=private.staff_username(p_username);
 if length(btrim(coalesce(p_reason,''))) not between 1 and 1000 then raise exception 'identity_change_reason_required' using errcode='22023'; end if;
 if p_real_name is not null and (newname is null or length(newname)>150 or p_real_name ~ '[[:cntrl:]]') then raise exception 'invalid_real_name' using errcode='22023'; end if;
 select username into oldname from private.staff_accounts where user_id=p_user_id;
 if oldname is null then raise exception 'mapped_account_required' using errcode='42501'; end if;
 -- 두 아이디를 정렬하여 잠그고 가입 예약과도 같은 잠금 키를 사용합니다. UNIQUE도 최종 방어선입니다.
 for lockname in select distinct n from unnest(array[oldname,uname]) n order by n loop
   perform pg_advisory_xact_lock(hashtextextended('staff-username:'||lockname,7142303));
 end loop;
 select * into account from private.staff_accounts where user_id=p_user_id for update;
 if exists(select 1 from private.staff_auth_reservations where username=uname and expires_at>=clock_timestamp()) then raise exception 'username_unavailable' using errcode='23505'; end if;
 if exists(select 1 from private.staff_accounts where username=uname and user_id<>p_user_id) then raise exception 'username_unavailable' using errcode='23505'; end if;
 if newname is null and account.real_name is not null then raise exception 'real_name_cannot_be_erased' using errcode='22023'; end if;
 if newname is distinct from account.real_name and p_user_id=auth.uid() and account.name_verified_at is not null then raise exception 'self_verified_name_requires_review' using errcode='42501'; end if;
 if uname=account.username and newname is not distinct from account.real_name then return private.office_owner_account(p_user_id); end if;
 if newname is distinct from account.real_name then
   -- 직접 정정 뒤에 이전 신청이 승인되어 덮어쓰이지 않도록 같은 트랜잭션에서 닫습니다.
   update private.staff_name_requests set status='rejected',reviewed_by=auth.uid(),reviewed_at=now(),review_reason='Superseded by Owner identity correction: '||btrim(p_reason) where user_id=p_user_id and status='pending';
 end if;
 update private.staff_accounts set username=uname,real_name=newname,
 name_verified_by=case when newname is distinct from account.real_name and p_user_id<>auth.uid() and not account.profile_enrollment_pending then auth.uid() else name_verified_by end,
 name_verified_at=case when newname is distinct from account.real_name and p_user_id<>auth.uid() and not account.profile_enrollment_pending then now() else name_verified_at end
 where user_id=p_user_id;
 perform private.write_staff_audit('staff_accounts',p_user_id::text,'owner_identity_updated',
 array_remove(array[case when uname<>account.username then 'username' end,case when newname is distinct from account.real_name then 'real_name' end],null),to_jsonb(account),jsonb_build_object('username',uname,'real_name',newname),p_reason);
 return private.office_owner_account(p_user_id);
end $$;

-- 네이티브 Auth와 감사 DB는 별도 트랜잭션입니다. 한 번 claim한 요청은 재실행하지 않고,
-- 결과를 잃으면 uncertain으로 취급합니다. 운영자가 새 요청을 판단해야 합니다.
create table private.staff_owner_password_operations (
 operation_id uuid primary key,
 actor_id uuid not null references auth.users(id) on delete restrict,
 target_user_id uuid not null references private.staff_accounts(user_id) on delete restrict,
 session_id uuid not null,
 actor_name text,
 actor_name_status text not null check(actor_name_status in ('verified','unverified')),
 actor_aal text not null,
 reason text not null check(length(btrim(reason)) between 1 and 1000),
 state text not null default 'requested' check(state in ('requested','executing','succeeded','failed','uncertain')),
 requested_at timestamptz not null default clock_timestamp(),
 expires_at timestamptz not null,
 claimed_at timestamptz,
 completed_at timestamptz,
 check((state='requested')=(claimed_at is null)),
 check((state in ('succeeded','failed','uncertain'))=(completed_at is not null))
);
alter table private.staff_owner_password_operations enable row level security;
revoke all on private.staff_owner_password_operations from public,anon,authenticated,service_role;
create policy deny_client_access on private.staff_owner_password_operations for all to anon,authenticated using(false) with check(false);
create index staff_owner_password_actor_idx on private.staff_owner_password_operations(actor_id,requested_at desc);
-- 서로 다른 탭/요청 UUID도 같은 계정의 네이티브 변경을 동시에 실행하지 못합니다.
create unique index staff_owner_password_executing_idx on private.staff_owner_password_operations(target_user_id) where state='executing';

create function private.owner_password_operation_result(p_operation private.staff_owner_password_operations) returns jsonb language sql immutable security invoker set search_path='' as $$
 select jsonb_build_object('operation_id',p_operation.operation_id,'target_user_id',p_operation.target_user_id,'actor_id',p_operation.actor_id,'state',p_operation.state,'expires_at',p_operation.expires_at)
$$;
create function private.write_owner_password_audit(p_operation private.staff_owner_password_operations,p_state text) returns void language plpgsql security definer set search_path='' as $$
begin
 insert into public.audit_logs(actor_id,actor_role,actor_name,actor_name_status,requested_by,entity,record_id,operation,action,changed_fields,before_values,after_values,reason,source,executor)
 values(p_operation.actor_id,'owner',p_operation.actor_name,p_operation.actor_name_status,p_operation.actor_id,'staff_accounts',p_operation.target_user_id::text,'OWNER_PASSWORD_RESET','owner_password_reset_'||p_state,
 case when p_state='succeeded' then array['password'] when p_state='requested' then array['password_reset_requested'] else array['password_reset_attempt'] end,
 '{}','{}',p_operation.reason||'; operation_id='||p_operation.operation_id::text,'owner_password_reset',case when p_state='requested' then 'authenticated_user' else 'staff_auth_edge_function' end);
end $$;
create function private.office_owner_begin_password_reset(p_user_id uuid,p_operation_id uuid,p_reason text) returns jsonb language plpgsql security definer set search_path='' as $$
declare sid uuid; operation private.staff_owner_password_operations; actor_name text; amr_time numeric; now_epoch numeric:=extract(epoch from clock_timestamp()); begin
 perform pg_advisory_xact_lock(7142301);
 sid:=private.require_live_owner();
 if p_user_id is null or p_operation_id is null or length(btrim(coalesce(p_reason,''))) not between 1 and 1000 then raise exception 'invalid_owner_password_request' using errcode='22023'; end if;
 -- iat는 토큰 갱신으로 새로워집니다. 서명 검증된 AMR의 실제 인증 시각만 사용합니다.
 if jsonb_typeof(auth.jwt()->'amr')='array' then
   select max((v->>'timestamp')::numeric) into amr_time from jsonb_array_elements(auth.jwt()->'amr') v
   where v->>'method' in ('password','otp','magiclink','totp','webauthn') and jsonb_typeof(v->'timestamp')='number'
     and (v->>'timestamp')::numeric between now_epoch-900 and now_epoch+60;
 end if;
 if amr_time is null then raise exception 'fresh_owner_authentication_required' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(hashtextextended('staff-owner-password:'||p_operation_id::text,7142305));
 select * into operation from private.staff_owner_password_operations where operation_id=p_operation_id for update;
 if operation.operation_id is not null then
   if operation.actor_id<>auth.uid() or operation.target_user_id<>p_user_id or operation.reason<>btrim(p_reason) then raise exception 'owner_password_operation_mismatch' using errcode='42501'; end if;
   return private.owner_password_operation_result(operation);
 end if;
 if not exists(select 1 from private.staff_accounts where user_id=p_user_id) then raise exception 'mapped_account_required' using errcode='42501'; end if;
 select real_name into actor_name from private.staff_accounts where user_id=auth.uid() and name_verified_at is not null;
 insert into private.staff_owner_password_operations(operation_id,actor_id,target_user_id,session_id,actor_name,actor_name_status,actor_aal,reason,expires_at)
 values(p_operation_id,auth.uid(),p_user_id,sid,actor_name,case when actor_name is null then 'unverified' else 'verified' end,coalesce(auth.jwt()->>'aal','aal1'),btrim(p_reason),least(clock_timestamp()+interval '5 minutes',to_timestamp(amr_time::double precision)+interval '15 minutes')) returning * into operation;
 perform private.write_owner_password_audit(operation,'requested');
 return private.owner_password_operation_result(operation);
end $$;
create function private.staff_auth_owner_password_claim(p_operation_id uuid,p_actor_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare operation private.staff_owner_password_operations; session_aal text; begin
 perform pg_advisory_xact_lock(7142301);
 perform pg_advisory_xact_lock(hashtextextended('staff-owner-password:'||p_operation_id::text,7142305));
 select * into operation from private.staff_owner_password_operations where operation_id=p_operation_id for update;
 if operation.operation_id is null or p_actor_id is null or operation.actor_id<>p_actor_id or operation.state<>'requested' or operation.expires_at<clock_timestamp() then raise exception 'owner_password_operation_unavailable' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(hashtextextended('staff-owner-password-target:'||operation.target_user_id::text,7142306));
 if exists(select 1 from private.staff_owner_password_operations where target_user_id=operation.target_user_id and state='executing' and operation_id<>p_operation_id) then raise exception 'target_password_operation_in_progress' using errcode='42501'; end if;
 if private.staff_role_for(operation.actor_id) is distinct from 'owner' then raise exception 'live_owner_required' using errcode='42501'; end if;
 select s.aal::text into session_aal from auth.sessions s where s.id=operation.session_id and s.user_id=operation.actor_id and (s.not_after is null or s.not_after>clock_timestamp());
 if not found then raise exception 'live_owner_session_required' using errcode='42501'; end if;
 if exists(select 1 from auth.mfa_factors f where f.user_id=operation.actor_id and f.status::text='verified')
 and (operation.actor_aal<>'aal2' or session_aal is distinct from 'aal2') then raise exception 'owner_mfa_required' using errcode='42501'; end if;
 if not exists(select 1 from private.staff_accounts where user_id=operation.target_user_id) then raise exception 'mapped_account_required' using errcode='42501'; end if;
 update private.staff_owner_password_operations set state='executing',claimed_at=clock_timestamp() where operation_id=p_operation_id returning * into operation;
 return private.owner_password_operation_result(operation);
end $$;
create function private.staff_auth_owner_password_finish(p_operation_id uuid,p_actor_id uuid,p_state text) returns void language plpgsql security definer set search_path='' as $$
declare operation private.staff_owner_password_operations; begin
 if p_state is null or p_state not in ('succeeded','failed','uncertain') then raise exception 'invalid_owner_password_outcome' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended('staff-owner-password:'||p_operation_id::text,7142305));
 select * into operation from private.staff_owner_password_operations where operation_id=p_operation_id for update;
 if operation.operation_id is null or p_actor_id is null or operation.actor_id<>p_actor_id then raise exception 'owner_password_operation_mismatch' using errcode='42501'; end if;
 if operation.state=p_state then return; end if;
 if operation.state<>'executing' then raise exception 'owner_password_operation_already_finished' using errcode='42501'; end if;
 -- 본인 비밀번호 변경으로 세션이 지워져도 이미 시도한 외부 결과는 정확하게 기록합니다.
 update private.staff_owner_password_operations set state=p_state,completed_at=clock_timestamp() where operation_id=p_operation_id returning * into operation;
 perform private.write_owner_password_audit(operation,p_state);
end $$;

create function public.office_owner_account(p_user_id uuid) returns jsonb language sql stable security invoker set search_path='' as $$select private.office_owner_account(p_user_id)$$;
create function public.office_owner_update_identity(p_user_id uuid,p_username text,p_real_name text,p_reason text) returns jsonb language sql security invoker set search_path='' as $$select private.office_owner_update_identity(p_user_id,p_username,p_real_name,p_reason)$$;
create function public.office_owner_begin_password_reset(p_user_id uuid,p_operation_id uuid,p_reason text) returns jsonb language sql security invoker set search_path='' as $$select private.office_owner_begin_password_reset(p_user_id,p_operation_id,p_reason)$$;
create function public.staff_auth_owner_password_claim(p_operation_id uuid,p_actor_id uuid) returns jsonb language sql security invoker set search_path='' as $$select private.staff_auth_owner_password_claim(p_operation_id,p_actor_id)$$;
create function public.staff_auth_owner_password_finish(p_operation_id uuid,p_actor_id uuid,p_state text) returns void language sql security invoker set search_path='' as $$select private.staff_auth_owner_password_finish(p_operation_id,p_actor_id,p_state)$$;
revoke all on function private.owner_password_operation_result(private.staff_owner_password_operations),private.write_owner_password_audit(private.staff_owner_password_operations,text) from public,anon,authenticated,service_role;
revoke all on function private.office_owner_account(uuid),public.office_owner_account(uuid),private.office_owner_update_identity(uuid,text,text,text),public.office_owner_update_identity(uuid,text,text,text),private.office_owner_begin_password_reset(uuid,uuid,text),public.office_owner_begin_password_reset(uuid,uuid,text) from public,anon,service_role;
grant execute on function private.office_owner_account(uuid),public.office_owner_account(uuid),private.office_owner_update_identity(uuid,text,text,text),public.office_owner_update_identity(uuid,text,text,text),private.office_owner_begin_password_reset(uuid,uuid,text),public.office_owner_begin_password_reset(uuid,uuid,text) to authenticated;
revoke all on function private.staff_auth_owner_password_claim(uuid,uuid),public.staff_auth_owner_password_claim(uuid,uuid),private.staff_auth_owner_password_finish(uuid,uuid,text),public.staff_auth_owner_password_finish(uuid,uuid,text) from public,anon,authenticated;
grant execute on function private.staff_auth_owner_password_claim(uuid,uuid),public.staff_auth_owner_password_claim(uuid,uuid),private.staff_auth_owner_password_finish(uuid,uuid,text),public.staff_auth_owner_password_finish(uuid,uuid,text) to service_role;
