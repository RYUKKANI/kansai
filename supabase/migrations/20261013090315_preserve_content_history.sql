-- [운영 적용] 복구 이력의 영구 정리는 별도 승인을 받을 때까지 실행하지 않습니다.
create or replace function private.capture_content_revision() returns trigger language plpgsql security definer set search_path='' as $$
declare record_key text := new.id::text;
begin
  -- 이전 시스템에서 작성한 내용의 첫 수정 때에도 수정 직전 값 하나를 남깁니다.
  -- 'baseline'은 과거 작업을 만든 것이 아니라 지금 확인한 수정 전 상태입니다.
  if tg_op='UPDATE' and not exists(select 1 from private.content_revisions where entity=tg_table_name and record_id=record_key) then
    insert into private.content_revisions(entity,record_id,snapshot,reason) values(tg_table_name,record_key,to_jsonb(old)-'public_approved','baseline');
  end if;
  insert into private.content_revisions(entity,record_id,snapshot,reason,actor_id,actor_role)
    values(tg_table_name,record_key,to_jsonb(new)-'public_approved',lower(tg_op),auth.uid(),private.current_role());
  -- 편집을 계속한 내용은 이전 예약 승인과 다른 버전이므로 자동 공개하지 않습니다.
  update private.content_releases set state='cancelled',last_error='content_changed' where entity=tg_table_name and record_id=record_key and state='queued';
  return new;
end $$;
create or replace function private.publish_due_content() returns integer language plpgsql security definer set search_path='' as $$
declare job private.content_releases; content jsonb; staff text; affected integer:=0;
begin
  if not (select publisher_enabled from private.office_automation_settings where id=1) then return 0; end if;
  perform pg_advisory_xact_lock(7142302);
  for job in select * from private.content_releases where state='queued' and scheduled_at<=now() order by scheduled_at limit 100 for update skip locked loop
    begin
      select role into staff from public.admin_roles where user_id=job.approved_by and active;
      if coalesce(staff,'') not in ('owner','administrator','editor') or (job.entity='site_pages' and staff='editor') then raise exception 'approval_no_longer_valid'; end if;
      execute format('select to_jsonb(t) from public.%I t where id::text=$1 for update',job.entity) into content using job.record_id;
      if content is null or (content->>'updated_at')::timestamptz is distinct from job.expected_updated_at then raise exception 'content_changed'; end if;
      execute format('update public.%I set status=''published'',published_at=$1 where id::text=$2',job.entity) using job.scheduled_at,job.record_id;
      update private.content_releases set state='published',last_error=null,completed_at=now() where entity=job.entity and record_id=job.record_id;
      affected:=affected+1;
    exception when others then
      update private.content_releases set state='failed',last_error='validation_or_approval_failed',completed_at=now() where entity=job.entity and record_id=job.record_id;
    end;
  end loop;
  return affected;
end $$;
revoke execute on function private.prune_content_history() from service_role;
