-- [편집 안내] 기존 계정/자료를 바꾸지 않고, 세 경로의 권한 검사를 동일한 업무 경계에 맞춥니다.
-- 1) 레거시 Owner의 초기 프로필 등록도 이미 등록한 MFA를 우회하지 못합니다.
-- 2) 예약 실행기는 사람의 세션을 요구하지 않되 현재 Auth 정지를 다시 확인합니다.
-- 3) 최고 관리자 전용 업무의 상세 감사는 일반 관리자에게 별도 조회 통로가 되지 않습니다.
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

create or replace function private.publish_due_content() returns integer
language plpgsql security definer set search_path='' as $$
declare job private.content_releases; content jsonb; staff text; affected integer:=0; begin
 if not (select publisher_enabled from private.office_automation_settings where id=1) then return 0; end if;
 perform pg_advisory_xact_lock(7142302);
 for job in select * from private.content_releases where state='queued' and scheduled_at<=now() order by scheduled_at limit 100 for update skip locked loop
  begin
   staff:=private.staff_role_for(job.approved_by);
   -- staff_role_for는 세션과 독립적입니다. 예약 승인자의 플랫폼 정지는 별도로 재검사합니다.
   if coalesce(staff,'') not in ('owner','administrator','editor') or (job.entity='site_pages' and staff='editor')
     or not exists(select 1 from auth.users u where u.id=job.approved_by and (u.banned_until is null or u.banned_until<=clock_timestamp()))
   then raise exception 'approval_no_longer_valid'; end if;
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

create or replace function private.can_read_audit(p_entity text) returns boolean
language plpgsql stable security definer set search_path='' as $$
declare staff text:=private.current_role(); begin
 if p_entity in ('admin_roles','staff_accounts','staff_name_requests') then
   if staff is distinct from 'owner' then return false; end if;
   -- Owner의 MFA가 불충분하면 해당 행을 숨깁니다. 일반 업무 로그 조회까지 실패시키지 않습니다.
   begin
     perform private.require_live_owner();
     return true;
   exception when insufficient_privilege then return false;
   end;
 end if;
 if staff in ('owner','administrator') then
   return coalesce(p_entity in ('players','public_player_profiles','articles','fixtures','training_sessions','training_series','match_events','media_assets','media_albums','site_pages','club_events'),false);
 elsif staff='editor' then
   return coalesce(p_entity in ('articles','media_assets','media_albums'),false);
 elsif staff='coach' then
   return coalesce(p_entity in ('players','public_player_profiles','fixtures','training_sessions','training_series','match_events','club_events'),false);
 end if;
 return false;
end $$;
-- CREATE OR REPLACE는 기존 ACL을 유지하지만, 새 공개 진입점이 생기지 않도록 경계를 재명시합니다.
revoke all on function private.office_enroll_identity(text,text,text,boolean) from public,anon,service_role;
grant execute on function private.office_enroll_identity(text,text,text,boolean) to authenticated;
revoke all on function private.publish_due_content() from public,anon,authenticated;
grant execute on function private.publish_due_content() to service_role;
revoke all on function private.can_read_audit(text) from public,anon,service_role;
grant execute on function private.can_read_audit(text) to authenticated;
