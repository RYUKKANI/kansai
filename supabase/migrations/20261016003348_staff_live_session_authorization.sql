-- [편집 안내] 비밀번호 변경/로그아웃 뒤 남은 access JWT로 내부 업무를 계속하지 못하게 합니다.
-- 네이티브 Auth의 세션 UUID와 현재 사용자 정지를 매 요청 확인하며 기존 계정/역할/이력은 수정하지 않습니다.
create function private.live_staff_session() returns uuid
language plpgsql stable security definer set search_path='' as $$
declare actor uuid:=auth.uid(); sid uuid; begin
 if actor is null then return null; end if;
 begin sid:=nullif(auth.jwt()->>'session_id','')::uuid;
 exception when invalid_text_representation then return null; end;
 if sid is null then return null; end if;
 if not exists(
   select 1 from auth.sessions s join auth.users u on u.id=s.user_id
   where s.id=sid and s.user_id=actor
     and (s.not_after is null or s.not_after>clock_timestamp())
     and (u.banned_until is null or u.banned_until<=clock_timestamp())
 ) then return null; end if;
 return sid;
end $$;
revoke all on function private.live_staff_session() from public,anon,authenticated,service_role;

-- staff_role_for(UUID)는 예약 발행과 마지막 Owner 수 계산의 서버 경로이므로 세션을 요구하지 않습니다.
-- 브라우저 RLS/업무 RPC가 사용하는 current_role()에만 현재 호출자의 세션 경계를 추가합니다.
create or replace function private.current_role() returns text
language sql stable security definer set search_path='' as $$
 select case when private.live_staff_session() is not null then private.staff_role_for(auth.uid()) else null end
$$;

-- 예전 본인 역할 행 정책은 auth.uid()만으로 읽혔습니다. 정지/회수된 JWT의 별도 조회도 닫습니다.
alter policy roles_read on public.admin_roles using (
 (select private.current_role()) is not null
 and (user_id=(select auth.uid()) or (select private.current_role())='owner')
);

create or replace function private.require_live_owner() returns uuid
language plpgsql stable security definer set search_path='' as $$
declare actor uuid:=auth.uid(); sid uuid:=private.live_staff_session(); session_aal text; begin
 if actor is null or sid is null or private.current_role() is distinct from 'owner' then raise exception 'live_owner_required' using errcode='42501'; end if;
 select s.aal::text into session_aal from auth.sessions s where s.id=sid and s.user_id=actor;
 if exists(select 1 from auth.mfa_factors f where f.user_id=actor and f.status::text='verified')
 and (auth.jwt()->>'aal' is distinct from 'aal2' or session_aal is distinct from 'aal2') then raise exception 'owner_mfa_required' using errcode='42501'; end if;
 return sid;
end $$;

-- 대기자의 본인 상태 조회/기존 계정 전환도 유효한 세션이 필요합니다. 역할은 요구하지 않아
-- 정상 로그인한 승인 대기자는 자신의 상태를 확인할 수 있습니다.

create or replace function private.office_account_state() returns jsonb language plpgsql stable security definer set search_path='' as $$
declare a private.staff_accounts; role_now text; begin
 if private.live_staff_session() is null then raise exception 'authentication_required' using errcode='42501'; end if;
 select * into a from private.staff_accounts where user_id=auth.uid(); role_now:=private.current_role();
 return jsonb_build_object('user_id',auth.uid(),'username',a.username,'real_name',a.real_name,'department',a.department,
 'approval_status',case when a.user_id is null and role_now is null then 'pending' when a.user_id is null then 'legacy' else a.approval_status end,'role',role_now,'active',role_now is not null,
 'identity_enrolled',a.user_id is not null and not a.profile_enrollment_pending,
 'approved_real_name',case when a.name_verified_at is not null then a.real_name else null end,
 'legacy',role_now is not null and (a.user_id is null or (a.legacy_account and a.profile_enrollment_pending)),
 'legacy_account',coalesce(a.legacy_account,a.user_id is null and role_now is not null),
 'email_confirmation_required',coalesce(a.email_confirmation_required,not private.is_manual_staff_signup(auth.uid())),
 'email_verification_status',case when coalesce(a.email_confirmation_required,not private.is_manual_staff_signup(auth.uid()))=false then 'not_required' when exists(select 1 from auth.users where id=auth.uid() and email_confirmed_at is not null) then 'verified' else 'pending' end,
 'email_confirmed',coalesce(a.email_confirmation_required,not private.is_manual_staff_signup(auth.uid())) and exists(select 1 from auth.users where id=auth.uid() and email_confirmed_at is not null),
 'name_verified_at',a.name_verified_at,'name_verified_by',a.name_verified_by,'name_verified_by_name',(select v.real_name from private.staff_accounts v where v.user_id=a.name_verified_by and v.name_verified_at is not null),'review_reason',a.review_reason,
 'name_request',(select to_jsonb(q) from (select id,real_name,status,reason,created_at,review_reason from private.staff_name_requests where user_id=auth.uid() order by created_at desc limit 1) q));
end $$;

create or replace function private.office_enroll_identity(p_username text,p_real_name text,p_department text,p_notice_accepted boolean) returns jsonb language plpgsql security definer set search_path='' as $$
declare uname text:=private.staff_username(p_username); legacy public.admin_roles; account private.staff_accounts; begin
 if private.live_staff_session() is null then raise exception 'authentication_required' using errcode='42501'; end if;
 perform private.staff_validate_identity(p_real_name,p_department,p_notice_accepted);
 perform pg_advisory_xact_lock(hashtextextended('staff-username:'||uname,7142303));
 select * into account from private.staff_accounts where user_id=auth.uid() for update;
 if account.user_id is not null then
   if not account.legacy_account or not account.profile_enrollment_pending then raise exception 'identity_already_enrolled' using errcode='23505'; end if;
   if account.username<>uname then raise exception 'account_identity_immutable' using errcode='23505'; end if;
   update private.staff_accounts set real_name=btrim(p_real_name),department=btrim(p_department),notice_accepted_at=now(),profile_enrollment_pending=false where user_id=auth.uid();
 else
   if exists(select 1 from private.staff_auth_reservations where username=uname and expires_at>=clock_timestamp()) then raise exception 'username_unavailable' using errcode='23505'; end if;
   select * into legacy from public.admin_roles where user_id=auth.uid();
   if legacy.user_id is null then raise exception 'legacy_staff_enrollment_only' using errcode='42501'; end if;
   insert into private.staff_accounts(user_id,username,real_name,department,approval_status,legacy_account,notice_accepted_at)
   values(auth.uid(),uname,btrim(p_real_name),btrim(p_department),case when legacy.user_id is null then 'pending' when legacy.active then 'approved' else 'suspended' end,legacy.user_id is not null,now());
 end if;
 return private.office_account_state();
end $$;

-- 사용자 JWT가 없는 서비스 claim도 저장된 실제 Owner의 플랫폼 정지를 다시 확인합니다.
create or replace function private.staff_auth_owner_password_claim(p_operation_id uuid,p_actor_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare operation private.staff_owner_password_operations; session_aal text; begin
 perform pg_advisory_xact_lock(7142301);
 perform pg_advisory_xact_lock(hashtextextended('staff-owner-password:'||p_operation_id::text,7142305));
 select * into operation from private.staff_owner_password_operations where operation_id=p_operation_id for update;
 if operation.operation_id is null or p_actor_id is null or operation.actor_id<>p_actor_id or operation.state<>'requested' or operation.expires_at<clock_timestamp() then raise exception 'owner_password_operation_unavailable' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(hashtextextended('staff-owner-password-target:'||operation.target_user_id::text,7142306));
 if exists(select 1 from private.staff_owner_password_operations where target_user_id=operation.target_user_id and state='executing' and operation_id<>p_operation_id) then raise exception 'target_password_operation_in_progress' using errcode='42501'; end if;
 if private.staff_role_for(operation.actor_id) is distinct from 'owner' or not exists(select 1 from auth.users u where u.id=operation.actor_id and (u.banned_until is null or u.banned_until<=clock_timestamp())) then raise exception 'live_owner_required' using errcode='42501'; end if;
 select s.aal::text into session_aal from auth.sessions s where s.id=operation.session_id and s.user_id=operation.actor_id and (s.not_after is null or s.not_after>clock_timestamp());
 if not found then raise exception 'live_owner_session_required' using errcode='42501'; end if;
 if exists(select 1 from auth.mfa_factors f where f.user_id=operation.actor_id and f.status::text='verified')
 and (operation.actor_aal<>'aal2' or session_aal is distinct from 'aal2') then raise exception 'owner_mfa_required' using errcode='42501'; end if;
 if not exists(select 1 from private.staff_accounts where user_id=operation.target_user_id) then raise exception 'mapped_account_required' using errcode='42501'; end if;
 update private.staff_owner_password_operations set state='executing',claimed_at=clock_timestamp() where operation_id=p_operation_id returning * into operation;
 return private.owner_password_operation_result(operation);
end $$;
