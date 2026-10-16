-- [편집 안내] 미확인 실명 입력과 다른 운영진의 실명 확인은 별개입니다.
-- 본인에게 승인/확인 권한을 주지 않고, 승인된 계정의 미확인 이름만 본인이 정정합니다.
-- 기존 UUID, 권한, 선수 연결, 완료되지 않은 소속/안내 확인 상태는 바꾸지 않습니다.
alter table private.staff_name_requests drop constraint staff_name_requests_status_check;
alter table private.staff_name_requests add constraint staff_name_requests_status_check
  check (status in ('pending','approved','rejected','withdrawn'));

create or replace function private.office_account_state() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare a private.staff_accounts; role_now text; edit_mode text; begin
 if private.live_staff_session() is null then raise exception 'authentication_required' using errcode='42501'; end if;
 select * into a from private.staff_accounts where user_id=auth.uid();
 role_now:=private.current_role();
 edit_mode:=case
   when a.user_id is null or role_now is null then 'unavailable'
   when a.name_verified_at is not null then 'review_required'
   else 'unverified_edit' end;
 return jsonb_build_object('user_id',auth.uid(),'username',a.username,'real_name',a.real_name,'department',a.department,
 'approval_status',case when a.user_id is null and role_now is null then 'pending' when a.user_id is null then 'legacy' else a.approval_status end,'role',role_now,'active',role_now is not null,
 'identity_enrolled',a.user_id is not null and not a.profile_enrollment_pending,
 'profile_enrollment_pending',coalesce(a.profile_enrollment_pending,role_now is not null),
 'name_edit_mode',edit_mode,'can_edit_real_name',edit_mode='unverified_edit',
 'approved_real_name',case when a.name_verified_at is not null then a.real_name else null end,
 'legacy',role_now is not null and (a.user_id is null or (a.legacy_account and a.profile_enrollment_pending)),
 'legacy_account',coalesce(a.legacy_account,a.user_id is null and role_now is not null),
 'email_confirmation_required',coalesce(a.email_confirmation_required,not private.is_manual_staff_signup(auth.uid())),
 'email_verification_status',case when coalesce(a.email_confirmation_required,not private.is_manual_staff_signup(auth.uid()))=false then 'not_required' when exists(select 1 from auth.users where id=auth.uid() and email_confirmed_at is not null) then 'verified' else 'pending' end,
 'email_confirmed',coalesce(a.email_confirmation_required,not private.is_manual_staff_signup(auth.uid())) and exists(select 1 from auth.users where id=auth.uid() and email_confirmed_at is not null),
 'name_verified_at',a.name_verified_at,'name_verified_by',a.name_verified_by,'name_verified_by_name',(select v.real_name from private.staff_accounts v where v.user_id=a.name_verified_by and v.name_verified_at is not null),'review_reason',a.review_reason,
 'name_request',(select to_jsonb(q) from (select id,real_name,status,reason,created_at,review_reason from private.staff_name_requests where user_id=auth.uid() order by created_at desc,id desc limit 1) q));
end $$;

create function private.office_update_unverified_name(p_real_name text,p_reason text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); role_now text; account private.staff_accounts; request private.staff_name_requests;
 new_name text:=nullif(btrim(p_real_name),''); begin
 -- 승인/정지 변경, 다른 Owner의 확인/정정과 같은 잠금을 사용해 확인 이후의 덮어쓰기를 막습니다.
 perform pg_advisory_xact_lock(7142301);
 role_now:=private.current_role();
 if actor is null or private.live_staff_session() is null or role_now is null then
   raise exception 'approved_staff_required' using errcode='42501';
 end if;
 if role_now='owner' then perform private.require_live_owner(); end if;
 if new_name is null or length(new_name)>150 or p_real_name ~ '[[:cntrl:]]' then
   raise exception 'invalid_real_name' using errcode='22023';
 end if;
 if length(btrim(coalesce(p_reason,''))) not between 1 and 1000 then
   raise exception 'identity_change_reason_required' using errcode='22023';
 end if;
 select * into account from private.staff_accounts where user_id=actor for update;
 if account.user_id is null or account.approval_status<>'approved' then
   raise exception 'approved_staff_required' using errcode='42501';
 end if;
 if account.name_verified_at is not null then
   raise exception 'self_verified_name_requires_review' using errcode='42501';
 end if;
 if new_name is not distinct from account.real_name then return private.office_account_state(); end if;
 -- 이전 정정 신청은 승인/반려로 오인하지 않도록 본인 취하 상태로 닫습니다.
 -- 확인자/확인시각은 만들지 않고 실제 요청자는 서버가 확인한 감사 actor UUID로 남깁니다.
 for request in select * from private.staff_name_requests where user_id=actor and status='pending' for update loop
   update private.staff_name_requests set status='withdrawn',reviewed_by=null,reviewed_at=null,review_reason=null where id=request.id;
   perform private.write_staff_audit('staff_name_requests',request.id::text,'name_request_withdrawn',array['status'],
     jsonb_build_object('status','pending'),jsonb_build_object('status','withdrawn'),p_reason);
 end loop;
 update private.staff_accounts set real_name=new_name where user_id=actor;
 perform private.write_staff_audit('staff_accounts',actor::text,'unverified_name_updated',array['real_name'],
   to_jsonb(account),jsonb_build_object('real_name',new_name),p_reason);
 return private.office_account_state();
end $$;
create function public.office_update_unverified_name(p_real_name text,p_reason text) returns jsonb
language sql security invoker set search_path='' as $$select private.office_update_unverified_name(p_real_name,p_reason)$$;
revoke all on function private.office_update_unverified_name(text,text),public.office_update_unverified_name(text,text) from public,anon,service_role;
grant execute on function private.office_update_unverified_name(text,text),public.office_update_unverified_name(text,text) to authenticated;

-- 이름 정정 신청도 같은 계정 잠금 순서를 따릅니다. 미확인 이름 저장 직후에 옛 신청이
-- 끼어들거나, 실명 확인/계정 정지와 경합해 승인된 이름을 덮어쓰지 않게 합니다.
create or replace function private.office_request_name_change(p_real_name text,p_reason text) returns void
language plpgsql security definer set search_path='' as $$
declare request_id uuid; account private.staff_accounts; begin
 perform pg_advisory_xact_lock(7142301);
 if auth.uid() is null or private.current_role() is null then raise exception 'approved_staff_required' using errcode='42501'; end if;
 select * into account from private.staff_accounts where user_id=auth.uid() for update;
 if account.user_id is null or account.profile_enrollment_pending then raise exception 'identity_enrollment_required'; end if;
 if p_real_name is null or length(btrim(p_real_name)) not between 1 and 150 or p_real_name ~ '[[:cntrl:]]' or length(btrim(coalesce(p_reason,''))) not between 1 and 1000 then raise exception 'invalid_name_request' using errcode='22023'; end if;
 insert into private.staff_name_requests(user_id,real_name,reason) values(auth.uid(),btrim(p_real_name),p_reason) returning id into request_id;
 perform private.write_staff_audit('staff_name_requests',request_id::text,'name_change_requested',array['real_name'],'{}','{}',null);
end $$;
