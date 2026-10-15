-- [편집 안내] 선택적 운영자 TTY 지원 도구의 시도/결과만 기록합니다. 비밀번호·키·토큰은
-- 인자로도 받지 않습니다. 실제 비밀번호 변경은 별도 네이티브 Auth Admin API가 수행합니다.
-- 외부 Auth 변경과 이 DB 기록은 원자적이지 않으며 'succeeded'는 신뢰한 서버 도구의 결과 보고입니다.
create table private.staff_password_support_operations (
 operation_id uuid primary key,
 user_id uuid not null references auth.users(id) on delete restrict,
 reason_code text not null check (reason_code in ('operator_requested_password_reset','credential_recovery')),
 state text not null check (state in ('requested','succeeded','failed','indeterminate')),
 requested_at timestamptz not null default clock_timestamp(),
 completed_at timestamptz,
 check ((state='requested')=(completed_at is null))
);
alter table private.staff_password_support_operations enable row level security;
revoke all on private.staff_password_support_operations from public,anon,authenticated,service_role;
create policy deny_client_access on private.staff_password_support_operations for all to anon,authenticated using(false) with check(false);
create index staff_password_support_user_idx on private.staff_password_support_operations(user_id,requested_at desc);

create function private.staff_auth_support_password_target(p_user_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare staff text:=private.staff_role_for(p_user_id); approval text; begin
 if p_user_id is null or staff is null then raise exception 'active_approved_account_required' using errcode='42501'; end if;
 select approval_status into approval from private.staff_accounts where user_id=p_user_id;
 return jsonb_build_object('user_id',p_user_id,'role',staff,'active',true,'approval_status',coalesce(approval,'approved'));
end $$;

create function private.staff_auth_support_password_audit(p_user_id uuid,p_operation_id uuid,p_state text,p_reason text) returns void language plpgsql security definer set search_path='' as $$
declare operation private.staff_password_support_operations; begin
 if p_user_id is null or p_operation_id is null or p_state is null or p_state not in ('requested','succeeded','failed','indeterminate')
 or p_reason is null or p_reason not in ('operator_requested_password_reset','credential_recovery') then raise exception 'invalid_support_audit_request' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended('staff-password-support:'||p_operation_id::text,7142304));
 select * into operation from private.staff_password_support_operations where operation_id=p_operation_id for update;
 if operation.operation_id is null then
   if p_state<>'requested' then raise exception 'support_request_record_required'; end if;
   perform private.staff_auth_support_password_target(p_user_id);
   insert into private.staff_password_support_operations(operation_id,user_id,reason_code,state) values(p_operation_id,p_user_id,p_reason,'requested');
 else
   if operation.user_id<>p_user_id or operation.reason_code<>p_reason then raise exception 'support_operation_identity_mismatch'; end if;
   if operation.state=p_state then return; end if;
   if operation.state<>'requested' or p_state='requested' then raise exception 'support_operation_already_finished'; end if;
   -- 진행 중에 계정이 정지되어도 이미 실행한 외부 요청의 결과를 기록할 수 있어야 합니다.
   -- 다음 지원 요청은 target 검사를 다시 통과해야 하며, 이 경로는 역할/정지 상태를 바꾸지 않습니다.
   update private.staff_password_support_operations set state=p_state,completed_at=clock_timestamp() where operation_id=p_operation_id;
 end if;
 insert into public.audit_logs(actor_id,actor_role,actor_name,actor_name_status,requested_by,entity,record_id,operation,action,changed_fields,before_values,after_values,reason,source,executor)
 values(null,null,null,'unknown',null,'staff_accounts',p_user_id::text,'SUPPORT_PASSWORD_RESET','support_password_reset_'||p_state,
 case when p_state='succeeded' then array['password'] when p_state='requested' then array['password_reset_requested'] else array['password_reset_attempt'] end,
 '{}','{}',p_reason||'; support_operation_id='||p_operation_id::text,'system_support','project_admin_password_support_cli');
end $$;
create function public.staff_auth_support_password_target(p_user_id uuid) returns jsonb language sql stable security invoker set search_path='' as $$select private.staff_auth_support_password_target(p_user_id)$$;
create function public.staff_auth_support_password_audit(p_user_id uuid,p_operation_id uuid,p_state text,p_reason text) returns void language sql security invoker set search_path='' as $$select private.staff_auth_support_password_audit(p_user_id,p_operation_id,p_state,p_reason)$$;
revoke all on function private.staff_auth_support_password_target(uuid),private.staff_auth_support_password_audit(uuid,uuid,text,text),public.staff_auth_support_password_target(uuid),public.staff_auth_support_password_audit(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function private.staff_auth_support_password_target(uuid),private.staff_auth_support_password_audit(uuid,uuid,text,text),public.staff_auth_support_password_target(uuid),public.staff_auth_support_password_audit(uuid,uuid,text,text) to service_role;
