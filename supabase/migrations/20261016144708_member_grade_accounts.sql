-- [편집 안내] 희망 소속과 실제 권한 등급을 분리합니다. 과거 신청의 희망은 추측하지 않고
-- NULL로 남기며, 이전 가입 서버의 새 신청만 최소 권한인 선수 희망으로 받습니다.
alter table private.staff_accounts add column requested_grade text check (requested_grade in ('owner','staff','player'));
alter table private.staff_auth_reservations add column requested_grade text not null default 'player' check (requested_grade in ('owner','staff','player'));
-- 담당 업무는 소속 등급과 별도인 선택 입력입니다. 기존 업무 문구는 수정하지 않습니다.
alter table private.staff_accounts drop constraint staff_accounts_department_check;
alter table private.staff_accounts add constraint staff_accounts_department_check check (length(btrim(department))<=200 and department !~ '[[:cntrl:]]');
create or replace function private.staff_validate_identity(p_real_name text,p_department text,p_notice boolean) returns void language plpgsql immutable security invoker set search_path='' as $$
begin
 if coalesce(p_notice,false)=false or p_real_name is null or length(btrim(p_real_name)) not between 1 and 150 or p_real_name ~ '[[:cntrl:]]'
 or length(btrim(coalesce(p_department,'')))>200 or coalesce(p_department,'') ~ '[[:cntrl:]]' then raise exception 'invalid_identity' using errcode='22023'; end if;
end $$;
-- 인자에 DEFAULT를 추가하지 않아 PostgREST의 기존 5/6인자 계약을 모호하게 하지 않습니다.
create function private.staff_auth_reserve(p_username text,p_email text,p_real_name text,p_department text,p_notice_accepted boolean,p_email_confirmation_required boolean,p_requested_grade text) returns uuid
language plpgsql security definer set search_path='' as $$
declare uname text:=private.staff_username(p_username); mail text:=lower(btrim(p_email)); reservation uuid; begin
 perform private.staff_validate_identity(p_real_name,p_department,p_notice_accepted);
 if p_requested_grade is null or p_requested_grade not in ('owner','staff','player') then raise exception 'invalid_requested_grade' using errcode='22023'; end if;
 if p_email_confirmation_required is null then raise exception 'email_policy_required' using errcode='22023'; end if;
 if mail is null or length(mail)>254 or mail !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' then raise exception 'invalid_email' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended('staff-username:'||uname,7142303));
 delete from private.staff_auth_reservations where expires_at<clock_timestamp();
 if exists(select 1 from private.staff_accounts where username=uname) or exists(select 1 from auth.users where lower(email)=mail) then raise exception 'registration_unavailable' using errcode='23505'; end if;
 insert into private.staff_auth_reservations(username,email_lower,real_name,department,email_confirmation_required,requested_grade)
 values(uname,mail,btrim(p_real_name),btrim(coalesce(p_department,'')),p_email_confirmation_required,p_requested_grade) returning id into reservation;
 return reservation;
end $$;
create or replace function private.staff_auth_reserve(p_username text,p_email text,p_real_name text,p_department text,p_notice_accepted boolean,p_email_confirmation_required boolean) returns uuid
language sql security invoker set search_path='' as $$select private.staff_auth_reserve(p_username,p_email,p_real_name,p_department,p_notice_accepted,p_email_confirmation_required,'player')$$;
create function public.staff_auth_reserve(p_username text,p_email text,p_real_name text,p_department text,p_notice_accepted boolean,p_email_confirmation_required boolean,p_requested_grade text) returns uuid
language sql security invoker set search_path='' as $$select private.staff_auth_reserve(p_username,p_email,p_real_name,p_department,p_notice_accepted,p_email_confirmation_required,p_requested_grade)$$;
revoke all on function private.staff_auth_reserve(text,text,text,text,boolean,boolean,text),public.staff_auth_reserve(text,text,text,text,boolean,boolean,text) from public,anon,authenticated;
grant execute on function private.staff_auth_reserve(text,text,text,text,boolean,boolean,text),public.staff_auth_reserve(text,text,text,text,boolean,boolean,text) to service_role;

create or replace function private.staff_auth_finalize(p_reservation uuid,p_user_id uuid) returns void language plpgsql security definer set search_path='' as $$
declare reservation private.staff_auth_reservations; begin
 select * into reservation from private.staff_auth_reservations where id=p_reservation for update;
 if reservation.id is null or reservation.expires_at<clock_timestamp() then raise exception 'registration_unavailable'; end if;
 perform pg_advisory_xact_lock(hashtextextended('staff-username:'||reservation.username,7142303));
 if not exists(select 1 from auth.users where id=p_user_id and lower(email)=reservation.email_lower and created_at>=reservation.created_at
   and ((reservation.email_confirmation_required and email_confirmed_at is null and not private.is_manual_staff_signup(p_user_id)) or (not reservation.email_confirmation_required and email_confirmed_at is not null and private.is_manual_staff_signup(p_user_id))))
 or exists(select 1 from public.admin_roles where user_id=p_user_id) then raise exception 'registration_unavailable'; end if;
 insert into private.staff_accounts(user_id,username,real_name,department,notice_accepted_at,email_confirmation_required,requested_grade)
 values(p_user_id,reservation.username,reservation.real_name,reservation.department,clock_timestamp(),reservation.email_confirmation_required,reservation.requested_grade);
 delete from private.staff_auth_reservations where id=p_reservation;
end $$;

-- 기존 계정 전환에서도 선택 담당 업무를 빈 문자열로 보관하고 기존 Owner 세션 보호를 유지합니다.
create or replace function private.office_enroll_identity(p_username text,p_real_name text,p_department text,p_notice_accepted boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare uname text:=private.staff_username(p_username); legacy public.admin_roles; account private.staff_accounts; begin
 if private.live_staff_session() is null then raise exception 'authentication_required' using errcode='42501'; end if;
 -- 미확인 이름 직접 수정과 같은 Owner 보호를 초기 등록/소속·안내 보충에도 적용합니다.
 if private.current_role()='owner' then perform private.require_live_owner(); end if;
 perform private.staff_validate_identity(p_real_name,p_department,p_notice_accepted);
 perform pg_advisory_xact_lock(hashtextextended('staff-username:'||uname,7142303));
 select * into account from private.staff_accounts where user_id=auth.uid() for update;
 if account.user_id is not null then
   if not account.legacy_account or not account.profile_enrollment_pending then raise exception 'identity_already_enrolled' using errcode='23505'; end if;
   if account.username<>uname then raise exception 'account_identity_immutable' using errcode='23505'; end if;
   update private.staff_accounts set real_name=btrim(p_real_name),department=btrim(coalesce(p_department,'')),notice_accepted_at=now(),profile_enrollment_pending=false where user_id=auth.uid();
 else
   if exists(select 1 from private.staff_auth_reservations where username=uname and expires_at>=clock_timestamp()) then raise exception 'username_unavailable' using errcode='23505'; end if;
   select * into legacy from public.admin_roles where user_id=auth.uid();
   if legacy.user_id is null then raise exception 'legacy_staff_enrollment_only' using errcode='42501'; end if;
   insert into private.staff_accounts(user_id,username,real_name,department,approval_status,legacy_account,notice_accepted_at)
   values(auth.uid(),uname,btrim(p_real_name),btrim(coalesce(p_department,'')),case when legacy.user_id is null then 'pending' when legacy.active then 'approved' else 'suspended' end,legacy.user_id is not null,now());
 end if;
 return private.office_account_state();
end $$;

-- 실제 권한은 현재 DB의 승인 상태와 역할로 결정합니다. 자기 신청/권한 변경은 계속 금지합니다.
create or replace function private.assert_staff_reviewer(p_user_id uuid,p_role text) returns void language plpgsql stable security definer set search_path='' as $$
begin
 perform private.require_live_owner();
 if p_user_id is null then raise exception 'target_account_required' using errcode='22023'; end if;
 if p_user_id=auth.uid() then raise exception 'self_review_forbidden' using errcode='42501'; end if;
 if p_role is not null and p_role not in ('owner','staff','player') then raise exception 'invalid_role' using errcode='22023'; end if;
end $$;

-- 과거 원본 역할은 보존하지만 인증된 관리 경로가 새로운 네 번째 역할을 지정하지 못하게 합니다.
-- 기존 레거시 역할을 그대로 둔 정지/해제는 허용하고, 역할을 바꾸는 순간 세 등급만 받습니다.
create or replace function private.guard_roles() returns trigger language plpgsql security definer set search_path='' as $$
declare target uuid:=case when tg_op='DELETE' then old.user_id else new.user_id end; begin
 perform pg_advisory_xact_lock(7142301);
 if auth.uid() is not null then
   perform private.require_live_owner();
   if target=auth.uid() then raise exception 'self_access_change_forbidden' using errcode='42501'; end if;
   if tg_op<>'DELETE' and new.role not in ('owner','staff','player') and (tg_op='INSERT' or new.role is distinct from old.role) then
     raise exception 'invalid_role' using errcode='22023';
   end if;
 end if;
 if tg_op in ('UPDATE','DELETE') and old.role='owner' and old.active and (tg_op='DELETE' or not new.active or new.role<>'owner') then
   if not exists(select 1 from public.admin_roles r join auth.users u on u.id=r.user_id
     where r.user_id<>old.user_id and r.role='owner' and private.staff_role_for(r.user_id)='owner'
       and (u.banned_until is null or u.banned_until<=clock_timestamp()))
   then raise exception 'last_owner_cannot_be_removed'; end if;
 end if;
 if tg_op='DELETE' then return old; end if; return new;
end $$;

-- 역할 변경과 계정 정지는 같은 잠금/대체 총괄 기준을 사용합니다. 플랫폼에서 차단된
-- 다른 총괄을 접근 가능한 대체 담당자로 세지 않으며 세션/MFA 검사는 기존 경로를 유지합니다.
create or replace function private.guard_staff_account() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if tg_op='UPDATE' and (new.user_id<>old.user_id or new.legacy_account<>old.legacy_account or new.email_confirmation_required<>old.email_confirmation_required) then raise exception 'account_identity_immutable'; end if;
 if tg_op='UPDATE' and new.username<>old.username then perform private.require_live_owner(); end if;
 if tg_op='UPDATE' and not old.profile_enrollment_pending and new.profile_enrollment_pending then raise exception 'completed_identity_cannot_be_reset'; end if;
 if tg_op='DELETE' or (tg_op='UPDATE' and old.approval_status='approved' and new.approval_status<>'approved') then
   perform pg_advisory_xact_lock(7142301);
   if exists(select 1 from public.admin_roles where user_id=old.user_id and active and role='owner')
     and not exists(select 1 from public.admin_roles r join auth.users u on u.id=r.user_id
       where r.user_id<>old.user_id and r.role='owner' and private.staff_role_for(r.user_id)='owner'
         and (u.banned_until is null or u.banned_until<=clock_timestamp()))
   then raise exception 'last_owner_cannot_be_removed'; end if;
 end if;
 if tg_op='DELETE' then return old; end if; new.updated_at:=now(); return new;
end $$;

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
 'name_verified_at',a.name_verified_at,'name_verified_by',a.name_verified_by,'name_verified_by_name',(select v.real_name from private.staff_accounts v where v.user_id=a.name_verified_by and v.name_verified_at is not null),'review_reason',a.review_reason,
 'name_request',(select to_jsonb(q) from (select id,real_name,status,reason,created_at,review_reason from private.staff_name_requests where user_id=auth.uid() order by created_at desc,id desc limit 1) q));
end $$;

create or replace function private.office_staff_applications() returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 perform private.require_live_owner();
 return coalesce((select jsonb_agg(jsonb_build_object('user_id',a.user_id,'username',a.username,'real_name',a.real_name,'department',a.department,'requested_grade',a.requested_grade,'player_id',a.player_id,
 'approval_status',a.approval_status,'email_confirmation_required',a.email_confirmation_required,'email_verification_status',case when not a.email_confirmation_required then 'not_required' when u.email_confirmed_at is not null then 'verified' else 'pending' end,'email_confirmed',a.email_confirmation_required and u.email_confirmed_at is not null,
 'role',private.member_grade(r.role),'active',coalesce(r.active,false),'name_verified_at',a.name_verified_at,'name_verified_by',a.name_verified_by,'name_verified_by_name',(select v.real_name from private.staff_accounts v where v.user_id=a.name_verified_by and v.name_verified_at is not null),'created_at',a.created_at) order by a.created_at)
 from private.staff_accounts a join auth.users u on u.id=a.user_id left join public.admin_roles r on r.user_id=a.user_id),'[]');
end $$;
create or replace function private.office_owner_account(p_user_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb; begin
 perform private.require_live_owner();
 select jsonb_build_object('user_id',a.user_id,'username',a.username,'real_name',a.real_name,'department',a.department,'requested_grade',a.requested_grade,'player_id',a.player_id,'password_is_set',coalesce(u.encrypted_password,'')<>'',
 'approval_status',a.approval_status,'role',private.member_grade(r.role),'member_grade',private.member_grade(r.role),'active',coalesce(r.active,false),'name_verified_at',a.name_verified_at,'name_verified_by',a.name_verified_by,
 'profile_enrollment_pending',a.profile_enrollment_pending,'can_edit_real_name',a.user_id<>auth.uid() or a.name_verified_at is null)
 into result from private.staff_accounts a join auth.users u on u.id=a.user_id left join public.admin_roles r on r.user_id=a.user_id where a.user_id=p_user_id;
 if result is null then raise exception 'mapped_account_required' using errcode='42501'; end if;
 return result;
end $$;
create or replace function private.office_staff_directory() returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if coalesce(private.current_role(),'') not in ('owner','staff') then raise exception 'staff_directory_required' using errcode='42501'; end if;
 return coalesce((select jsonb_agg(jsonb_build_object('user_id',a.user_id,'real_name',a.real_name,'department',a.department,'role',private.member_grade(r.role),'activity_status',case when a.approval_status='approved' and r.active then 'active' else 'inactive' end) order by a.real_name,a.user_id)
 from private.staff_accounts a join public.admin_roles r on r.user_id=a.user_id where a.name_verified_at is not null and a.approval_status in ('approved','suspended')),'[]');
end $$;

-- 대상 UUID 인자를 받지 않는 선수 전용 창입니다. raw 선수/프로필 테이블 접근 권한을 열지 않고
-- 로그인한 본인에게만 동의·활동 상태와 공개용 프로필 필드를 명시적으로 돌려줍니다.
create function private.office_player_portal() returns jsonb language plpgsql stable security definer set search_path='' as $$
declare a private.staff_accounts; player jsonb; begin
 if private.current_role() is distinct from 'player' then raise exception 'player_access_required' using errcode='42501'; end if;
 select * into a from private.staff_accounts where user_id=auth.uid();
 select jsonb_build_object('player_id',p.id,'activity_status',p.activity_status,'profile_consent',p.profile_consent,'photo_consent',p.photo_consent,
 'public_profile',(select jsonb_build_object('slug',q.slug,'display_name',q.display_name,'romanized_name',q.romanized_name,'jersey_number',q.jersey_number,'position',q.position,'photo_path',q.photo_path,'bio',q.bio,'activity_status',q.activity_status,'status',q.status,'published_at',q.published_at) from public.public_player_profiles q where q.player_id=p.id))
 into player from public.players p where p.id=a.player_id;
 return jsonb_build_object('user_id',auth.uid(),'real_name',a.real_name,'approved_real_name',case when a.name_verified_at is not null then a.real_name else null end,'player_id',a.player_id,'linked',player is not null,'player',player);
end $$;
create function public.office_player_portal() returns jsonb language sql stable security invoker set search_path='' as $$select private.office_player_portal()$$;

-- 계정 UUID와 선수 UUID의 연결은 총괄이 명시적으로 수행합니다. 역할 변경 시 기존 연결을
-- 자동 삭제하지 않고, 선수를 새로 만들지도 않습니다. UNIQUE 제약과 공통 잠금으로 중복 연결을 막습니다.
create function private.office_owner_set_player_link(p_user_id uuid,p_player_id uuid,p_reason text) returns jsonb language plpgsql security definer set search_path='' as $$
declare a private.staff_accounts; target_grade text; begin
 perform pg_advisory_xact_lock(7142301);
 perform private.require_live_owner();
 if p_user_id is null or length(btrim(coalesce(p_reason,''))) not between 1 and 1000 then raise exception 'invalid_player_link' using errcode='22023'; end if;
 select * into a from private.staff_accounts where user_id=p_user_id for update;
 if a.user_id is null then raise exception 'mapped_account_required' using errcode='42501'; end if;
 select private.member_grade(role) into target_grade from public.admin_roles where user_id=p_user_id;
 if p_player_id is not null then
   if target_grade is distinct from 'player' then raise exception 'player_grade_required' using errcode='42501'; end if;
   if not exists(select 1 from public.players where id=p_player_id) then raise exception 'existing_player_required' using errcode='22023'; end if;
 end if;
 if a.player_id is not distinct from p_player_id then return private.office_owner_account(p_user_id); end if;
 update private.staff_accounts set player_id=p_player_id where user_id=p_user_id;
 perform private.write_staff_audit('staff_accounts',p_user_id::text,'player_link_changed',array['player_id'],jsonb_build_object('player_id',a.player_id),jsonb_build_object('player_id',p_player_id),p_reason);
 return private.office_owner_account(p_user_id);
end $$;
create function public.office_owner_set_player_link(p_user_id uuid,p_player_id uuid,p_reason text) returns jsonb language sql security invoker set search_path='' as $$select private.office_owner_set_player_link(p_user_id,p_player_id,p_reason)$$;
revoke all on function private.office_player_portal(),public.office_player_portal(),private.office_owner_set_player_link(uuid,uuid,text),public.office_owner_set_player_link(uuid,uuid,text) from public,anon,service_role;
grant execute on function private.office_player_portal(),public.office_player_portal(),private.office_owner_set_player_link(uuid,uuid,text),public.office_owner_set_player_link(uuid,uuid,text) to authenticated;

-- 새 RPC/7인자 가입 계약을 PostgREST 캐시에 반영합니다.
notify pgrst,'reload schema';
