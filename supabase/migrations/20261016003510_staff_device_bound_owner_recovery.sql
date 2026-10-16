-- [편집 안내] 메일 없이 유일한 활성 Owner를 복구하는 영구 지원 경로입니다.
-- 공개 요청은 권한/세션을 만들지 않습니다. 승인만 postgres 제어면에서 수행하고,
-- 새 비밀번호는 이 DB에 전달하지 않고 공식 Auth 관리자 API에서만 처리합니다.
create table private.staff_support_recovery_requests (
 request_id uuid primary key,
 target_user_id uuid references private.staff_accounts(user_id) on delete restrict,
 proof_hash text not null check(proof_hash ~ '^[0-9a-f]{64}$'),
 device_fingerprint text not null check(device_fingerprint ~ '^[0-9a-f]{16}$'),
 state text not null default 'requested' check(state in ('requested','approved','executing','succeeded','failed','uncertain')),
 requested_at timestamptz not null default clock_timestamp(),
 expires_at timestamptz not null,
 approved_at timestamptz,
 approval_expires_at timestamptz,
 claimed_at timestamptz,
 completed_at timestamptz,
 check(expires_at > requested_at and expires_at <= requested_at + interval '10 minutes'),
 check((approved_at is null)=(approval_expires_at is null)),
 check(approval_expires_at is null or (approval_expires_at <= expires_at and approval_expires_at <= approved_at + interval '5 minutes')),
 check((state in ('executing','succeeded','failed','uncertain'))=(claimed_at is not null)),
 check((state in ('succeeded','failed','uncertain'))=(completed_at is not null)),
 check(state='requested' or (target_user_id is not null and approved_at is not null))
);
alter table private.staff_support_recovery_requests enable row level security;
revoke all on private.staff_support_recovery_requests from public,anon,authenticated,service_role;
create policy deny_client_access on private.staff_support_recovery_requests for all to anon,authenticated using(false) with check(false);
create index staff_support_recovery_expiry_idx on private.staff_support_recovery_requests(expires_at);
create unique index staff_support_recovery_executing_idx on private.staff_support_recovery_requests(target_user_id) where state='executing';

-- 길이가 고정된 HMAC 바이트 전체를 비교합니다. 비밀 값의 일치 위치에 따라 조기 반환하지 않습니다.
create function private.staff_support_recovery_proof_matches(p_left text,p_right text) returns boolean language plpgsql immutable security invoker set search_path='' as $$
declare left_bytes bytea; right_bytes bytea; difference integer:=0; i integer; begin
 if p_left is null or p_right is null or p_left !~ '^[0-9a-f]{64}$' or p_right !~ '^[0-9a-f]{64}$' then return false; end if;
 left_bytes:=decode(p_left,'hex'); right_bytes:=decode(p_right,'hex');
 for i in 0..31 loop difference:=difference | (get_byte(left_bytes,i) # get_byte(right_bytes,i)); end loop;
 return difference=0;
end $$;
create function private.staff_support_recovery_eligible(p_user_id uuid) returns boolean language sql stable security definer set search_path='' as $$
 select p_user_id is not null and exists(
   select 1 from private.staff_accounts a join public.admin_roles r on r.user_id=a.user_id join auth.users u on u.id=a.user_id
   where a.user_id=p_user_id and a.approval_status='approved' and r.active and r.role='owner'
     and private.staff_role_for(a.user_id)='owner' and (u.banned_until is null or u.banned_until<=clock_timestamp())
 ) and (select count(*) from public.admin_roles r join auth.users u on u.id=r.user_id
   where r.active and r.role='owner' and private.staff_role_for(r.user_id)='owner' and (u.banned_until is null or u.banned_until<=clock_timestamp()))=1
$$;
create function private.write_staff_support_recovery_audit(p_request private.staff_support_recovery_requests,p_state text) returns void language plpgsql security definer set search_path='' as $$
begin
 insert into public.audit_logs(actor_id,actor_role,actor_name,actor_name_status,requested_by,entity,record_id,operation,action,changed_fields,before_values,after_values,reason,source,executor)
 values(null,null,null,'unverified',null,'staff_accounts',coalesce(p_request.target_user_id,p_request.request_id)::text,'PROJECT_ADMIN_RECOVERY','project_admin_recovery_'||p_state,
 case when p_state='succeeded' then array['password'] else array['credential_recovery_'||p_state] end,
 '{}','{}','credential_recovery; request_id='||p_request.request_id::text,'project_admin_recovery',
 case when p_state='approved' then 'project_admin_control_plane' else 'staff_auth_edge_function' end);
end $$;

create function private.staff_auth_support_recovery_request(p_request_id uuid,p_username text,p_proof_hash text,p_fingerprint text) returns jsonb language plpgsql security definer set search_path='' as $$
declare target uuid; request private.staff_support_recovery_requests; now_at timestamptz:=clock_timestamp(); begin
 if p_request_id is null or p_proof_hash is null or p_proof_hash !~ '^[0-9a-f]{64}$' or p_fingerprint is null or p_fingerprint !~ '^[0-9a-f]{16}$' then raise exception 'invalid_support_request' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended('staff-support-recovery:'||p_request_id::text,7142307));
 select * into request from private.staff_support_recovery_requests where request_id=p_request_id for update;
 if request.request_id is null then
   select user_id into target from private.staff_accounts where username=private.staff_username(p_username);
   insert into private.staff_support_recovery_requests(request_id,target_user_id,proof_hash,device_fingerprint,requested_at,expires_at)
   values(p_request_id,target,p_proof_hash,p_fingerprint,now_at,now_at+interval '10 minutes') returning * into request;
   perform private.write_staff_support_recovery_audit(request,'requested');
 elsif not private.staff_support_recovery_proof_matches(request.proof_hash,p_proof_hash) or request.device_fingerprint<>p_fingerprint then
   -- 요청 UUID 충돌도 기존 매핑/지문/시간을 노출하지 않습니다. 이 응답으로 승인이 생기지 않습니다.
   return jsonb_build_object('request_id',p_request_id,'device_fingerprint',p_fingerprint,'expires_at',now_at+interval '10 minutes');
 end if;
 return jsonb_build_object('request_id',request.request_id,'device_fingerprint',request.device_fingerprint,'expires_at',request.expires_at);
end $$;
create function private.staff_auth_support_recovery_status(p_request_id uuid,p_proof_hash text) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare request private.staff_support_recovery_requests; state text; begin
 select * into request from private.staff_support_recovery_requests where request_id=p_request_id;
 if request.request_id is null or not private.staff_support_recovery_proof_matches(request.proof_hash,p_proof_hash) then return jsonb_build_object('state','unavailable'); end if;
 state:=request.state;
 if state in ('requested','approved') and (request.expires_at<=clock_timestamp() or (state='approved' and request.approval_expires_at<=clock_timestamp())) then state:='expired'; end if;
 return jsonb_build_object('request_id',request.request_id,'state',state,'device_fingerprint',request.device_fingerprint,'expires_at',case when request.state='approved' then request.approval_expires_at else request.expires_at end);
end $$;

-- postgres의 제어면만 승인할 수 있습니다. 서비스 키·로그인 세션·아이디 자체는 승인 권한이 아닙니다.
-- 프로젝트 관리자는 별도 본인 확인 후 요청 UUID, 정확한 기존 Owner UUID, 화면 지문을 함께 대조합니다.
create function private.approve_staff_support_recovery(p_request_id uuid,p_expected_owner_id uuid,p_fingerprint text,p_reason text default 'credential_recovery') returns jsonb language plpgsql security invoker set search_path='' as $$
declare request private.staff_support_recovery_requests; now_at timestamptz:=clock_timestamp(); begin
 if current_user<>'postgres' then raise exception 'project_control_plane_required' using errcode='42501'; end if;
 if p_reason is distinct from 'credential_recovery' then raise exception 'fixed_recovery_reason_required' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(7142301);
 perform pg_advisory_xact_lock(hashtextextended('staff-support-recovery:'||p_request_id::text,7142307));
 select * into request from private.staff_support_recovery_requests where request_id=p_request_id for update;
 now_at:=clock_timestamp();
 if request.request_id is null or request.state<>'requested' or request.expires_at<=now_at or p_expected_owner_id is null
   or request.target_user_id is distinct from p_expected_owner_id or request.device_fingerprint is distinct from p_fingerprint
   or not private.staff_support_recovery_eligible(p_expected_owner_id) then raise exception 'support_request_not_approvable' using errcode='42501'; end if;
 update private.staff_support_recovery_requests set state='approved',approved_at=now_at,approval_expires_at=least(expires_at,now_at+interval '5 minutes') where request_id=p_request_id returning * into request;
 perform private.write_staff_support_recovery_audit(request,'approved');
 return jsonb_build_object('request_id',request.request_id,'state',request.state,'approval_expires_at',request.approval_expires_at);
end $$;

create function private.staff_auth_support_recovery_claim(p_request_id uuid,p_proof_hash text) returns jsonb language plpgsql security definer set search_path='' as $$
declare request private.staff_support_recovery_requests; now_at timestamptz:=clock_timestamp(); begin
 perform pg_advisory_xact_lock(7142301);
 perform pg_advisory_xact_lock(hashtextextended('staff-support-recovery:'||p_request_id::text,7142307));
 select * into request from private.staff_support_recovery_requests where request_id=p_request_id for update;
 now_at:=clock_timestamp();
 if request.request_id is null or not private.staff_support_recovery_proof_matches(request.proof_hash,p_proof_hash) then raise exception 'support_recovery_unavailable' using errcode='42501'; end if;
 if not private.staff_support_recovery_eligible(request.target_user_id) then raise exception 'support_recovery_unavailable' using errcode='42501'; end if;
 if request.state='succeeded' then return jsonb_build_object('request_id',request.request_id,'state','succeeded'); end if;
 if request.state in ('failed','uncertain','executing') then return jsonb_build_object('request_id',request.request_id,'state',case when request.state='executing' then 'uncertain' else request.state end); end if;
 if request.state<>'approved' or request.expires_at<=now_at or request.approval_expires_at<=now_at then raise exception 'support_recovery_unavailable' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(hashtextextended('staff-owner-password-target:'||request.target_user_id::text,7142306));
 if exists(select 1 from private.staff_owner_password_operations where target_user_id=request.target_user_id and state='executing')
   or exists(select 1 from private.staff_support_recovery_requests where target_user_id=request.target_user_id and state='executing') then raise exception 'support_recovery_unavailable' using errcode='42501'; end if;
 update private.staff_support_recovery_requests set state='executing',claimed_at=clock_timestamp() where request_id=p_request_id returning * into request;
 perform private.write_staff_support_recovery_audit(request,'executing');
 return jsonb_build_object('request_id',request.request_id,'state','executing','target_user_id',request.target_user_id);
end $$;
create function private.staff_auth_support_recovery_finish(p_request_id uuid,p_proof_hash text,p_state text) returns void language plpgsql security definer set search_path='' as $$
declare request private.staff_support_recovery_requests; begin
 if p_state is null or p_state not in ('succeeded','failed','uncertain') then raise exception 'invalid_support_recovery_outcome' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended('staff-support-recovery:'||p_request_id::text,7142307));
 select * into request from private.staff_support_recovery_requests where request_id=p_request_id for update;
 if request.request_id is null or not private.staff_support_recovery_proof_matches(request.proof_hash,p_proof_hash) then raise exception 'support_recovery_unavailable' using errcode='42501'; end if;
 if request.state=p_state then return; end if;
 if request.state<>'executing' then raise exception 'support_recovery_unavailable' using errcode='42501'; end if;
 -- Auth가 모든 세션을 회수한 뒤에도 이미 실행한 결과는 기록할 수 있어야 합니다.
 update private.staff_support_recovery_requests set state=p_state,completed_at=clock_timestamp() where request_id=p_request_id returning * into request;
 perform private.write_staff_support_recovery_audit(request,p_state);
end $$;

create function public.staff_auth_support_recovery_request(p_request_id uuid,p_username text,p_proof_hash text,p_fingerprint text) returns jsonb language sql security invoker set search_path='' as $$select private.staff_auth_support_recovery_request(p_request_id,p_username,p_proof_hash,p_fingerprint)$$;
create function public.staff_auth_support_recovery_status(p_request_id uuid,p_proof_hash text) returns jsonb language sql stable security invoker set search_path='' as $$select private.staff_auth_support_recovery_status(p_request_id,p_proof_hash)$$;
create function public.staff_auth_support_recovery_claim(p_request_id uuid,p_proof_hash text) returns jsonb language sql security invoker set search_path='' as $$select private.staff_auth_support_recovery_claim(p_request_id,p_proof_hash)$$;
create function public.staff_auth_support_recovery_finish(p_request_id uuid,p_proof_hash text,p_state text) returns void language sql security invoker set search_path='' as $$select private.staff_auth_support_recovery_finish(p_request_id,p_proof_hash,p_state)$$;
revoke all on function private.staff_support_recovery_proof_matches(text,text),private.staff_support_recovery_eligible(uuid),private.write_staff_support_recovery_audit(private.staff_support_recovery_requests,text),private.approve_staff_support_recovery(uuid,uuid,text,text) from public,anon,authenticated,service_role;
revoke all on function private.staff_auth_support_recovery_request(uuid,text,text,text),public.staff_auth_support_recovery_request(uuid,text,text,text),private.staff_auth_support_recovery_status(uuid,text),public.staff_auth_support_recovery_status(uuid,text),private.staff_auth_support_recovery_claim(uuid,text),public.staff_auth_support_recovery_claim(uuid,text),private.staff_auth_support_recovery_finish(uuid,text,text),public.staff_auth_support_recovery_finish(uuid,text,text) from public,anon,authenticated;
grant execute on function private.staff_auth_support_recovery_request(uuid,text,text,text),public.staff_auth_support_recovery_request(uuid,text,text,text),private.staff_auth_support_recovery_status(uuid,text),public.staff_auth_support_recovery_status(uuid,text),private.staff_auth_support_recovery_claim(uuid,text),public.staff_auth_support_recovery_claim(uuid,text),private.staff_auth_support_recovery_finish(uuid,text,text),public.staff_auth_support_recovery_finish(uuid,text,text) to service_role;

-- 기존 Owner 웹 경로도 같은 대상 잠금 아래 지원 작업의 실행 상태를 검사합니다.
create or replace function private.staff_auth_owner_password_claim(p_operation_id uuid,p_actor_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare operation private.staff_owner_password_operations; session_aal text; begin
 perform pg_advisory_xact_lock(7142301);
 perform pg_advisory_xact_lock(hashtextextended('staff-owner-password:'||p_operation_id::text,7142305));
 select * into operation from private.staff_owner_password_operations where operation_id=p_operation_id for update;
 if operation.operation_id is null or p_actor_id is null or operation.actor_id<>p_actor_id or operation.state<>'requested' or operation.expires_at<clock_timestamp() then raise exception 'owner_password_operation_unavailable' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(hashtextextended('staff-owner-password-target:'||operation.target_user_id::text,7142306));
 if exists(select 1 from private.staff_owner_password_operations where target_user_id=operation.target_user_id and state='executing' and operation_id<>p_operation_id) then raise exception 'target_password_operation_in_progress' using errcode='42501'; end if;
 if exists(select 1 from private.staff_support_recovery_requests where target_user_id=operation.target_user_id and state='executing') then raise exception 'target_password_operation_in_progress' using errcode='42501'; end if;
 if private.staff_role_for(operation.actor_id) is distinct from 'owner' or not exists(select 1 from auth.users u where u.id=operation.actor_id and (u.banned_until is null or u.banned_until<=clock_timestamp())) then raise exception 'live_owner_required' using errcode='42501'; end if;
 select s.aal::text into session_aal from auth.sessions s where s.id=operation.session_id and s.user_id=operation.actor_id and (s.not_after is null or s.not_after>clock_timestamp());
 if not found then raise exception 'live_owner_session_required' using errcode='42501'; end if;
 if exists(select 1 from auth.mfa_factors f where f.user_id=operation.actor_id and f.status::text='verified')
 and (operation.actor_aal<>'aal2' or session_aal is distinct from 'aal2') then raise exception 'owner_mfa_required' using errcode='42501'; end if;
 if not exists(select 1 from private.staff_accounts where user_id=operation.target_user_id) then raise exception 'mapped_account_required' using errcode='42501'; end if;
 update private.staff_owner_password_operations set state='executing',claimed_at=clock_timestamp() where operation_id=p_operation_id returning * into operation;
 return private.owner_password_operation_result(operation);
end $$;
