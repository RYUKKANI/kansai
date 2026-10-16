-- [편집 안내] 이메일을 받지 않는 신규 가입의 Auth 전용 주소는 연락처가 아닙니다.
-- 기존 계정/주소/정책은 변경하지 않고, Owner의 예전 연락처 조회 RPC에서만 해당
-- 예약 네임스페이스를 감춥니다. 로그인 서버의 서비스 전용 UUID→Auth 주소 조회는 유지합니다.
create or replace function private.office_staff_application_contact(p_user_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare contact_email text; contact_available boolean; begin
 perform private.require_live_owner();
 if p_user_id=auth.uid() then raise exception 'owner_contact_review_required' using errcode='42501'; end if;
 select u.email into contact_email from private.staff_accounts a join auth.users u on u.id=a.user_id
 where a.user_id=p_user_id and a.approval_status='pending' and not a.email_confirmation_required;
 if contact_email is null then raise exception 'pending_manual_application_required' using errcode='42501'; end if;
 -- 사용자 수정 가능한 metadata가 아닌 서버가 사용하는 주소 영역으로 분류합니다.
 -- 이 영역은 .invalid 예약 도메인이므로 실제 수신 가능한 연락처로 취급하지 않습니다.
 contact_available:=split_part(lower(btrim(contact_email)),'@',2)<>'accounts.kansai.invalid';
 return jsonb_build_object('user_id',p_user_id,'email',case when contact_available then contact_email else null end,
   'contact_available',contact_available,'email_confirmation_required',false,'email_verification_status','not_required');
end $$;
