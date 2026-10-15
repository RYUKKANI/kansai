-- [편집 안내] 공개 Auth의 Confirm Email 설정은 유지합니다. 새 포털 가입만 신뢰한 서버가
-- 네이티브 Auth 계정을 이메일 확인 없이 준비하고, 실제 내부 권한은 Owner 승인으로 결정합니다.
-- Auth의 email_confirmed_at 자동 설정은 메일 소유 확인 증거가 아니므로 별도 정책을 보존합니다.
alter table private.staff_accounts add column email_confirmation_required boolean not null default true;
alter table private.staff_auth_reservations add column email_confirmation_required boolean not null default true;

-- Auth Admin 생성과 같은 요청에서 넣은 app_metadata만 사용합니다. 사용자 수정 가능한
-- user_metadata나 아직 확정되지 않은 브라우저의 가입 응답은 정책 근거가 아닙니다.
create function private.is_manual_staff_signup(p_user_id uuid) returns boolean language sql stable security definer set search_path='' as $$
 select coalesce((select raw_app_meta_data->>'staff_signup_policy'='manual_approval_no_email_v1' from auth.users where id=p_user_id),false)
$$;
revoke all on function private.is_manual_staff_signup(uuid) from public,anon,authenticated,service_role;


-- 다섯 인자 계약은 기존의 메일 확인 필요 정책을 유지합니다. 여섯 인자 계약에는 DEFAULT를
-- 두지 않아 PostgREST가 기존 다섯 인자 요청을 모호하게 해석하지 않도록 합니다.
create function private.staff_auth_reserve(p_username text,p_email text,p_real_name text,p_department text,p_notice_accepted boolean,p_email_confirmation_required boolean) returns uuid
language plpgsql security definer set search_path='' as $$
declare uname text:=private.staff_username(p_username); mail text:=lower(btrim(p_email)); reservation uuid; begin
 perform private.staff_validate_identity(p_real_name,p_department,p_notice_accepted);
 if p_email_confirmation_required is null then raise exception 'email_policy_required' using errcode='22023'; end if;
 if mail is null or length(mail)>254 or mail !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' then raise exception 'invalid_email' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended('staff-username:'||uname,7142303));
 delete from private.staff_auth_reservations where expires_at<clock_timestamp();
 if exists(select 1 from private.staff_accounts where username=uname) or exists(select 1 from auth.users where lower(email)=mail) then raise exception 'registration_unavailable' using errcode='23505'; end if;
 insert into private.staff_auth_reservations(username,email_lower,real_name,department,email_confirmation_required)
 values(uname,mail,btrim(p_real_name),btrim(p_department),p_email_confirmation_required) returning id into reservation;
 return reservation;
end $$;
create or replace function private.staff_auth_reserve(p_username text,p_email text,p_real_name text,p_department text,p_notice_accepted boolean) returns uuid
language sql security invoker set search_path='' as $$select private.staff_auth_reserve(p_username,p_email,p_real_name,p_department,p_notice_accepted,true)$$;
create function public.staff_auth_reserve(p_username text,p_email text,p_real_name text,p_department text,p_notice_accepted boolean,p_email_confirmation_required boolean) returns uuid
language sql security invoker set search_path='' as $$select private.staff_auth_reserve(p_username,p_email,p_real_name,p_department,p_notice_accepted,p_email_confirmation_required)$$;
revoke all on function private.staff_auth_reserve(text,text,text,text,boolean),private.staff_auth_reserve(text,text,text,text,boolean,boolean),public.staff_auth_reserve(text,text,text,text,boolean,boolean) from public,anon,authenticated;
grant execute on function private.staff_auth_reserve(text,text,text,text,boolean),private.staff_auth_reserve(text,text,text,text,boolean,boolean),public.staff_auth_reserve(text,text,text,text,boolean,boolean) to service_role;

create or replace function private.staff_auth_finalize(p_reservation uuid,p_user_id uuid) returns void language plpgsql security definer set search_path='' as $$
declare reservation private.staff_auth_reservations; begin
 select * into reservation from private.staff_auth_reservations where id=p_reservation for update;
 if reservation.id is null or reservation.expires_at<clock_timestamp() then raise exception 'registration_unavailable'; end if;
 perform pg_advisory_xact_lock(hashtextextended('staff-username:'||reservation.username,7142303));
 -- 기존 이메일/UUID를 새 계정으로 재연결하지 않습니다. 수동 정책 예약은 네이티브 Auth에서
 -- 서버가 준비한 confirmed 계정만 받지만, 그것을 메일 소유가 확인된 것으로 표시하지 않습니다.
 if not exists(select 1 from auth.users where id=p_user_id and lower(email)=reservation.email_lower and created_at>=reservation.created_at
   and ((reservation.email_confirmation_required and email_confirmed_at is null and not private.is_manual_staff_signup(p_user_id)) or (not reservation.email_confirmation_required and email_confirmed_at is not null and private.is_manual_staff_signup(p_user_id))))
 or exists(select 1 from public.admin_roles where user_id=p_user_id) then raise exception 'registration_unavailable'; end if;
 insert into private.staff_accounts(user_id,username,real_name,department,notice_accepted_at,email_confirmation_required)
 values(p_user_id,reservation.username,reservation.real_name,reservation.department,clock_timestamp(),reservation.email_confirmation_required);
 delete from private.staff_auth_reservations where id=p_reservation;
end $$;


-- 기존 계정의 기본 true 정책과 legacy 접근은 그대로 두고, 새 수동 정책은 현재 승인/활성을 매 요청 확인합니다.
create or replace function private.staff_role_for(p_user_id uuid) returns text language sql stable security definer set search_path='' as $$
 select r.role from public.admin_roles r left join private.staff_accounts a on a.user_id=r.user_id
 where r.user_id=p_user_id and r.active and
 (a.user_id is null or (a.approval_status='approved' and (a.legacy_account or not a.email_confirmation_required or exists(select 1 from auth.users u where u.id=r.user_id and u.email_confirmed_at is not null))))
$$;

-- 정책은 가입 예약에서만 선택합니다. 자기 프로필 수정이나 기존 계정 전환으로 정책을 바꾸지 못합니다.
create or replace function private.guard_staff_account() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if tg_op='UPDATE' and (new.user_id<>old.user_id or new.username<>old.username or new.legacy_account<>old.legacy_account or new.email_confirmation_required<>old.email_confirmation_required) then raise exception 'account_identity_immutable'; end if;
 if tg_op='UPDATE' and not old.profile_enrollment_pending and new.profile_enrollment_pending then raise exception 'completed_identity_cannot_be_reset'; end if;
 if tg_op='DELETE' or (tg_op='UPDATE' and old.approval_status='approved' and new.approval_status<>'approved') then
   perform pg_advisory_xact_lock(7142301);
   if exists(select 1 from public.admin_roles where user_id=old.user_id and active and role='owner') and
     (select count(*) from public.admin_roles r where r.role='owner' and private.staff_role_for(r.user_id)='owner')<=1 then raise exception 'last_owner_cannot_be_removed'; end if;
 end if;
 if tg_op='DELETE' then return old; end if; new.updated_at:=now(); return new;
end $$;

-- 호환 email_confirmed도 수동 정책에서는 false입니다. 사용자에게 메일 소유 확인을 했다고 오인시키지 않습니다.
create or replace function private.office_account_state() returns jsonb language plpgsql stable security definer set search_path='' as $$
declare a private.staff_accounts; role_now text; begin
 if auth.uid() is null then raise exception 'authentication_required' using errcode='42501'; end if;
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

create or replace function private.office_staff_applications() returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if coalesce(private.current_role(),'') not in ('owner','administrator') then raise exception 'staff_management_required' using errcode='42501'; end if;
 return coalesce((select jsonb_agg(jsonb_build_object('user_id',a.user_id,'username',a.username,'real_name',a.real_name,'department',a.department,'approval_status',a.approval_status,'email_confirmation_required',a.email_confirmation_required,'email_verification_status',case when not a.email_confirmation_required then 'not_required' when u.email_confirmed_at is not null then 'verified' else 'pending' end,'email_confirmed',a.email_confirmation_required and u.email_confirmed_at is not null,'role',r.role,'active',r.active,'name_verified_at',a.name_verified_at,'name_verified_by',a.name_verified_by,'name_verified_by_name',(select v.real_name from private.staff_accounts v where v.user_id=a.name_verified_by and v.name_verified_at is not null),'created_at',a.created_at) order by a.created_at)
 from private.staff_accounts a join auth.users u on u.id=a.user_id left join public.admin_roles r on r.user_id=a.user_id),'[]');
end $$;

-- 메일 확인을 생략한 신규 포털 신청은 Owner가 실제 관계/실명을 확인하고 승인해야 합니다.
create or replace function private.office_review_staff(p_user_id uuid,p_decision text,p_role text,p_reason text) returns void language plpgsql security definer set search_path='' as $$
declare a private.staff_accounts; begin
 perform pg_advisory_xact_lock(7142301);
 perform private.assert_staff_reviewer(p_user_id,p_role);
 if p_decision is null or p_decision not in ('approved','rejected') or length(btrim(coalesce(p_reason,''))) not between 1 and 1000 then raise exception 'invalid_review' using errcode='22023'; end if;
 select * into a from private.staff_accounts where user_id=p_user_id for update;
 if a.user_id is null or a.approval_status<>'pending' then raise exception 'pending_application_required'; end if;
 if p_decision='approved' then
   if not a.email_confirmation_required and private.current_role() is distinct from 'owner' then raise exception 'owner_manual_approval_required' using errcode='42501'; end if;
   if p_role is null then raise exception 'role_required'; end if;
   if a.email_confirmation_required and not exists(select 1 from auth.users where id=p_user_id and email_confirmed_at is not null) then raise exception 'email_confirmation_and_role_required'; end if;
   update private.staff_accounts set approval_status='approved',name_verified_by=auth.uid(),name_verified_at=now(),approved_by=auth.uid(),approved_at=now(),review_reason=p_reason where user_id=p_user_id;
   insert into public.admin_roles(user_id,email,role,active) select id,email,p_role,true from auth.users where id=p_user_id
   on conflict(user_id) do update set role=excluded.role,active=true;
 else update private.staff_accounts set approval_status='rejected',approved_by=auth.uid(),approved_at=now(),review_reason=p_reason where user_id=p_user_id; end if;
 perform private.write_staff_audit('staff_accounts',p_user_id::text,'application_'||p_decision,array['approval_status','role','name_verified_at'],to_jsonb(a),jsonb_build_object('approval_status',p_decision,'role',p_role,'name_verified_at',case when p_decision='approved' then now() else null end),p_reason);
end $$;

create or replace function private.staff_auth_identity(p_username text) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('user_id',a.user_id,'email',u.email,'approval_status',a.approval_status,'email_confirmation_required',a.email_confirmation_required,'email_verification_status',case when not a.email_confirmation_required then 'not_required' when u.email_confirmed_at is not null then 'verified' else 'pending' end)
 from private.staff_accounts a join auth.users u on u.id=a.user_id where a.username=private.staff_username(p_username)
$$;

-- 새 신청은 서비스 예약/확정으로만 생성합니다. 자동 confirmed 계정의 확정 전/실패 후
-- 로그인으로 다른 아이디를 직접 enrollment하여 기존 메일 정책을 얻는 우회를 막습니다.
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
   if legacy.user_id is null then raise exception 'legacy_staff_enrollment_only' using errcode='42501'; end if;
   insert into private.staff_accounts(user_id,username,real_name,department,approval_status,legacy_account,notice_accepted_at)
   values(auth.uid(),uname,btrim(p_real_name),btrim(p_department),case when legacy.user_id is null then 'pending' when legacy.active then 'approved' else 'suspended' end,legacy.user_id is not null,now());
 end if;
 return private.office_account_state();
end $$;

-- 미확인 연락 주소를 공개 명부나 신청 목록에 섞지 않습니다. Owner가 특정 수동 승인 신청을
-- 실제 기존 구단 연락 수단과 대조할 때에만 주소를 별도 조회합니다. 승인 후 이 경로는 닫힙니다.
create function private.office_staff_application_contact(p_user_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare contact_email text; begin
 if auth.uid() is null or private.current_role() is distinct from 'owner' or p_user_id=auth.uid() then raise exception 'owner_contact_review_required' using errcode='42501'; end if;
 select u.email into contact_email from private.staff_accounts a join auth.users u on u.id=a.user_id
 where a.user_id=p_user_id and a.approval_status='pending' and not a.email_confirmation_required;
 if contact_email is null then raise exception 'pending_manual_application_required' using errcode='42501'; end if;
 return jsonb_build_object('user_id',p_user_id,'email',contact_email,'email_confirmation_required',false,'email_verification_status','not_required');
end $$;
create function public.office_staff_application_contact(p_user_id uuid) returns jsonb language sql stable security invoker set search_path='' as $$select private.office_staff_application_contact(p_user_id)$$;
revoke all on function private.office_staff_application_contact(uuid),public.office_staff_application_contact(uuid) from public,anon;
grant execute on function private.office_staff_application_contact(uuid),public.office_staff_application_contact(uuid) to authenticated;
