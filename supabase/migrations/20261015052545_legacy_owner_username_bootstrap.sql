-- [편집 안내] 실명/소속/안내 확인이 아직 제공되지 않은 기존 Owner의 아이디만 연결하는 예외입니다.
-- 비밀번호는 변경하지 않습니다. 신규 신청자의 필수 정보나 승인/자기 실명 확인 금지를 완화하지 않습니다.
alter table private.staff_accounts
  alter column real_name drop not null,
  alter column department drop not null,
  alter column notice_accepted_at drop not null,
  add column profile_enrollment_pending boolean not null default false,
  add constraint staff_accounts_profile_enrollment_check check (
    (profile_enrollment_pending and legacy_account and real_name is null and department is null
      and notice_accepted_at is null and name_verified_at is null and name_verified_by is null)
    or (not profile_enrollment_pending and real_name is not null and department is not null and notice_accepted_at is not null)
  );

-- 완료된 프로필을 빈 초기 상태로 되돌려 필수 정보/동의를 우회할 수 없습니다.
create or replace function private.guard_staff_account() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if tg_op='UPDATE' and (new.user_id<>old.user_id or new.username<>old.username or new.legacy_account<>old.legacy_account) then raise exception 'account_identity_immutable'; end if;
 if tg_op='UPDATE' and not old.profile_enrollment_pending and new.profile_enrollment_pending then raise exception 'completed_identity_cannot_be_reset'; end if;
 if tg_op='DELETE' or (tg_op='UPDATE' and old.approval_status='approved' and new.approval_status<>'approved') then
   perform pg_advisory_xact_lock(7142301);
   if exists(select 1 from public.admin_roles where user_id=old.user_id and active and role='owner') and
     (select count(*) from public.admin_roles r where r.role='owner' and private.staff_role_for(r.user_id)='owner')<=1 then raise exception 'last_owner_cannot_be_removed'; end if;
 end if;
 if tg_op='DELETE' then return old; end if; new.updated_at:=now(); return new;
end $$;

-- 서비스 전용 한정 경로: 실제 활성 Owner만 지정할 수 있고 역할/이름/동의 인자를 받지 않습니다.
-- 전환 대상 UUID는 운영자가 읽기 전용 대조 후 별도 바인딩하며 공개 가입/로그인 요청에 연결하지 않습니다.
create function private.staff_auth_bootstrap_owner(p_user_id uuid,p_username text) returns jsonb language plpgsql security definer set search_path='' as $$
declare uname text:=private.staff_username(p_username); account private.staff_accounts; begin
 perform pg_advisory_xact_lock(7142301);
 if p_user_id is null or private.staff_role_for(p_user_id) is distinct from 'owner' then raise exception 'existing_active_owner_required' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(hashtextextended('staff-username:'||uname,7142303));
 select * into account from private.staff_accounts where user_id=p_user_id for update;
 if account.user_id is not null then
   if not account.legacy_account or account.username<>uname then raise exception 'existing_identity_cannot_be_rebound' using errcode='23505'; end if;
   -- 안전한 재시도만 허용하고 이미 제공한 실명/동의나 확인 결과는 건드리지 않습니다.
   return jsonb_build_object('user_id',account.user_id,'username',account.username,'identity_enrolled',not account.profile_enrollment_pending,'legacy_account',true);
 end if;
 if exists(select 1 from private.staff_auth_reservations where username=uname and expires_at>=clock_timestamp()) then raise exception 'username_unavailable' using errcode='23505'; end if;
 insert into private.staff_accounts(user_id,username,real_name,department,approval_status,legacy_account,notice_accepted_at,profile_enrollment_pending)
 values(p_user_id,uname,null,null,'approved',true,null,true);
 return jsonb_build_object('user_id',p_user_id,'username',uname,'identity_enrolled',false,'legacy_account',true);
end $$;
create function public.staff_auth_bootstrap_owner(p_user_id uuid,p_username text) returns jsonb language sql security invoker set search_path='' as $$select private.staff_auth_bootstrap_owner(p_user_id,p_username)$$;
revoke all on function private.staff_auth_bootstrap_owner(uuid,text),public.staff_auth_bootstrap_owner(uuid,text) from public,anon,authenticated;
grant execute on function private.staff_auth_bootstrap_owner(uuid,text),public.staff_auth_bootstrap_owner(uuid,text) to service_role;

create or replace function private.office_account_state() returns jsonb language plpgsql stable security definer set search_path='' as $$
declare a private.staff_accounts; role_now text; begin
 if auth.uid() is null then raise exception 'authentication_required' using errcode='42501'; end if;
 select * into a from private.staff_accounts where user_id=auth.uid(); role_now:=private.current_role();
 return jsonb_build_object('user_id',auth.uid(),'username',a.username,'real_name',a.real_name,'department',a.department,
 'approval_status',case when a.user_id is null then 'legacy' else a.approval_status end,'role',role_now,'active',role_now is not null,
 'identity_enrolled',a.user_id is not null and not a.profile_enrollment_pending,
 'approved_real_name',case when a.name_verified_at is not null then a.real_name else null end,
 'legacy',role_now is not null and (a.user_id is null or (a.legacy_account and a.profile_enrollment_pending)),
 'legacy_account',coalesce(a.legacy_account,a.user_id is null and role_now is not null),
 'email_confirmed',exists(select 1 from auth.users where id=auth.uid() and email_confirmed_at is not null),
 'name_verified_at',a.name_verified_at,'name_verified_by',a.name_verified_by,'name_verified_by_name',(select v.real_name from private.staff_accounts v where v.user_id=a.name_verified_by and v.name_verified_at is not null),'review_reason',a.review_reason,
 'name_request',(select to_jsonb(q) from (select id,real_name,status,reason,created_at,review_reason from private.staff_name_requests where user_id=auth.uid() order by created_at desc limit 1) q));
end $$;

create or replace function private.office_enroll_identity(p_username text,p_real_name text,p_department text,p_notice_accepted boolean) returns jsonb language plpgsql security definer set search_path='' as $$
declare uname text:=private.staff_username(p_username); legacy public.admin_roles; account private.staff_accounts; begin
 if auth.uid() is null then raise exception 'authentication_required' using errcode='42501'; end if;
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
   insert into private.staff_accounts(user_id,username,real_name,department,approval_status,legacy_account,notice_accepted_at)
   values(auth.uid(),uname,btrim(p_real_name),btrim(p_department),case when legacy.user_id is null then 'pending' when legacy.active then 'approved' else 'suspended' end,legacy.user_id is not null,now());
 end if;
 return private.office_account_state();
end $$;

-- 빈 프로필 Owner도 기존 업무는 유지하지만 실명 정정은 본인 프로필/안내 확인 이후에 신청합니다.
create or replace function private.office_request_name_change(p_real_name text,p_reason text) returns void language plpgsql security definer set search_path='' as $$
declare request_id uuid; begin
 if auth.uid() is null or private.current_role() is null then raise exception 'approved_staff_required' using errcode='42501'; end if;
 if not exists(select 1 from private.staff_accounts where user_id=auth.uid() and not profile_enrollment_pending) then raise exception 'identity_enrollment_required'; end if;
 if p_real_name is null or length(btrim(p_real_name)) not between 1 and 150 or p_real_name ~ '[[:cntrl:]]' or length(btrim(coalesce(p_reason,''))) not between 1 and 1000 then raise exception 'invalid_name_request' using errcode='22023'; end if;
 insert into private.staff_name_requests(user_id,real_name,reason) values(auth.uid(),btrim(p_real_name),p_reason) returning id into request_id;
 perform private.write_staff_audit('staff_name_requests',request_id::text,'name_change_requested',array['real_name'],'{}','{}',null);
end $$;
