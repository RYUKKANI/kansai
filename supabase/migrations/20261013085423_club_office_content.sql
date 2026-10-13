-- [편집 안내] 콘텐츠에만 이력/예약 기능을 추가합니다. 선수·연락처·평가 정보는 복제하지 않습니다.
create table private.content_revisions (
  id uuid primary key default gen_random_uuid(),
  sequence bigint generated always as identity unique,
  entity text not null check (entity in ('articles','media_assets','media_albums','site_pages')),
  record_id text not null,
  snapshot jsonb not null,
  reason text not null,
  actor_id uuid,
  actor_role text,
  captured_at timestamptz not null default now()
);
create index content_revision_record_idx on private.content_revisions(entity,record_id,sequence desc);
create table private.content_releases (
  entity text not null check (entity in ('articles','media_assets','media_albums','site_pages')),
  record_id text not null,
  scheduled_at timestamptz not null,
  expected_updated_at timestamptz not null,
  approved_by uuid references auth.users(id),
  approved_role text not null,
  approved_at timestamptz not null default now(),
  state text not null check (state in ('queued','published','cancelled','failed')),
  last_error text,
  completed_at timestamptz,
  primary key(entity,record_id)
);
create index content_release_due_idx on private.content_releases(scheduled_at) where state='queued';
create table private.office_automation_settings (id integer primary key check(id=1), publisher_enabled boolean not null default false);
insert into private.office_automation_settings(id) values(1);
alter table private.content_revisions enable row level security;
alter table private.content_releases enable row level security;
alter table private.office_automation_settings enable row level security;
revoke all on private.content_revisions,private.content_releases,private.office_automation_settings from public,anon,authenticated;
create policy revisions_deny_clients on private.content_revisions for all to anon,authenticated using(false) with check(false);
create policy releases_deny_clients on private.content_releases for all to anon,authenticated using(false) with check(false);
create policy automation_deny_clients on private.office_automation_settings for all to anon,authenticated using(false) with check(false);
-- private 스키마는 Data API에 추가하지 않습니다. 클라이언트는 역할을 검증하는 좁은 RPC만 사용합니다.
create function private.assert_content_access(p_entity text) returns void language plpgsql security invoker set search_path='' as $$
begin
  if auth.uid() is null or p_entity is null or p_entity not in ('articles','media_assets','media_albums','site_pages')
    or coalesce(private.current_role(),'') not in ('owner','administrator','editor')
    or (p_entity='site_pages' and private.current_role()='editor')
  then raise exception 'content permission denied'; end if;
end $$;
create function private.content_fields(p_entity text) returns text[] language sql immutable security invoker set search_path='' as $$
select case p_entity
 when 'articles' then array['slug','title','summary','category','body','cover_path','cover_alt','gallery_paths','source_url','activity_date','featured','status','published_at']
 when 'media_assets' then array['kind','title','storage_path','legacy_path','video_url','alt_text','description','source_url','captured_on','album_id','consent_confirmed','status','published_at']
 when 'media_albums' then array['title','description','captured_on','status','published_at']
 when 'site_pages' then array['title','introduction','body','status','published_at']
 else '{}'::text[] end;
$$;
revoke all on function private.assert_content_access(text),private.content_fields(text) from public,anon,authenticated;

create function private.capture_content_revision() returns trigger language plpgsql security definer set search_path='' as $$
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
  delete from private.content_revisions where id in (
    select id from private.content_revisions where entity=tg_table_name and record_id=record_key order by sequence desc offset 30
  );
  return new;
end $$;
revoke all on function private.capture_content_revision() from public,anon,authenticated;
do $$ declare tbl text; begin
 foreach tbl in array array['articles','media_assets','media_albums','site_pages'] loop
   execute format('create trigger content_revision after insert or update on public.%I for each row execute function private.capture_content_revision()',tbl);
 end loop;
end $$;

-- 허용된 테이블/필드만 수정합니다. 동시 수정 검사, 저장, 예약 승인을 같은 트랜잭션으로 묶습니다.
create function private.save_office_content(p_entity text,p_id text,p_expected timestamptz,p_values jsonb,p_publish_at timestamptz)
returns jsonb language plpgsql security definer set search_path='' as $$
declare allowed text[]; payload jsonb; old_row jsonb; saved jsonb; columns_sql text; values_sql text; changes_sql text; key text;
begin
  perform private.assert_content_access(p_entity);
  perform pg_advisory_xact_lock(7142302);
  allowed:=private.content_fields(p_entity);
  payload:=coalesce(p_values,'{}'::jsonb);
  if jsonb_typeof(payload)<>'object' then raise exception 'invalid content payload'; end if;
  if p_id is not null then
    execute format('select to_jsonb(t) from public.%I t where id::text=$1 for update',p_entity) into old_row using p_id;
    if old_row is null or (old_row->>'updated_at')::timestamptz is distinct from p_expected then raise exception 'content changed; reload before saving'; end if;
  elsif p_entity='site_pages' then allowed:=array_append(allowed,'id');
  end if;
  if exists(select 1 from jsonb_object_keys(payload) k where not (k=any(allowed))) then raise exception 'invalid content field'; end if;
  if p_publish_at is not null then
    if not (select publisher_enabled from private.office_automation_settings where id=1) then raise exception 'scheduled publisher is not enabled'; end if;
    if p_publish_at<=now() or p_publish_at>now()+interval '1 year' then raise exception 'schedule must be in the next year'; end if;
    payload:=payload || jsonb_build_object('status','draft');
  end if;
  select string_agg(format('%I',k),','),string_agg(format('v.%I',k),','),string_agg(format('%I=v.%I',k,k),',')
    into columns_sql,values_sql,changes_sql from jsonb_object_keys(payload) k;
  if columns_sql is null then raise exception 'empty content payload'; end if;
  if p_id is null then
    execute format('insert into public.%1$I(%2$s) select %3$s from jsonb_populate_record(null::public.%1$I,$1) v returning to_jsonb(%1$I)',p_entity,columns_sql,values_sql)
      into saved using payload;
  else
    execute format('update public.%1$I t set %2$s from jsonb_populate_record(null::public.%1$I,$1) v where t.id::text=$2 returning to_jsonb(t)',p_entity,changes_sql)
      into saved using payload,p_id;
  end if;
  if p_publish_at is not null then
    -- 즉시 공개하지 않습니다. 실제 발행 시 원본의 동의/이미지/필수값 제약을 다시 실행합니다.
    insert into private.content_releases(entity,record_id,scheduled_at,expected_updated_at,approved_by,approved_role,state)
    values(p_entity,saved->>'id',p_publish_at,(saved->>'updated_at')::timestamptz,auth.uid(),private.current_role(),'queued')
    on conflict(entity,record_id) do update set scheduled_at=excluded.scheduled_at,expected_updated_at=excluded.expected_updated_at,
      approved_by=excluded.approved_by,approved_role=excluded.approved_role,approved_at=now(),state='queued',last_error=null,completed_at=null;
  end if;
  return saved;
end $$;
revoke all on function private.save_office_content(text,text,timestamptz,jsonb,timestamptz) from public,anon;
grant execute on function private.save_office_content(text,text,timestamptz,jsonb,timestamptz) to authenticated;
create function public.save_office_content(p_entity text,p_id text,p_expected timestamptz,p_values jsonb,p_publish_at timestamptz default null)
returns jsonb language sql security invoker set search_path='' as $$select private.save_office_content(p_entity,p_id,p_expected,p_values,p_publish_at)$$;
revoke all on function public.save_office_content(text,text,timestamptz,jsonb,timestamptz) from public,anon;
grant execute on function public.save_office_content(text,text,timestamptz,jsonb,timestamptz) to authenticated;

create function private.office_content_state(p_entity text,p_id text) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare versions jsonb; release jsonb;
begin
  perform private.assert_content_access(p_entity);
  select coalesce(jsonb_agg(to_jsonb(v) order by v.sequence desc),'[]'::jsonb) into versions from (
    select id,sequence,captured_at,actor_id,actor_role,reason,snapshot->>'title' as title,snapshot->>'status' as status
    from private.content_revisions where entity=p_entity and record_id=p_id and captured_at>=now()-interval '90 days' order by sequence desc limit 30
  ) v;
  select to_jsonb(r) into release from private.content_releases r where entity=p_entity and record_id=p_id;
  return jsonb_build_object('revisions',versions,'release',release);
end $$;
revoke all on function private.office_content_state(text,text) from public,anon;
grant execute on function private.office_content_state(text,text) to authenticated;
create function public.office_content_state(p_entity text,p_id text) returns jsonb language sql stable security invoker set search_path='' as $$select private.office_content_state(p_entity,p_id)$$;
revoke all on function public.office_content_state(text,text) from public,anon;
grant execute on function public.office_content_state(text,text) to authenticated;

create function private.restore_content_revision(p_revision uuid,p_expected timestamptz) returns jsonb language plpgsql security definer set search_path='' as $$
declare revision private.content_revisions; current_row jsonb; payload jsonb;
begin
  select * into revision from private.content_revisions where id=p_revision and captured_at>=now()-interval '90 days';
  perform private.assert_content_access(revision.entity);
  perform pg_advisory_xact_lock(7142302);
  execute format('select to_jsonb(t) from public.%I t where id::text=$1 for update',revision.entity) into current_row using revision.record_id;
  if current_row is null or (current_row->>'updated_at')::timestamptz is distinct from p_expected then raise exception 'content changed; reload before restoring'; end if;
  select jsonb_object_agg(key,value) into payload from jsonb_each(revision.snapshot) where key=any(private.content_fields(revision.entity));
  payload := payload || jsonb_build_object('status','draft','published_at',current_row->'published_at');
  if revision.entity='articles' then payload:=payload || jsonb_build_object('slug',current_row->'slug'); end if;
  -- 사진 동의 철회를 이전 버전의 true로 되돌릴 수 없습니다.
  if revision.entity='media_assets' then
    payload:=payload || jsonb_build_object('consent_confirmed',coalesce((current_row->>'consent_confirmed')::boolean,false) and coalesce((payload->>'consent_confirmed')::boolean,false));
  end if;
  return private.save_office_content(revision.entity,revision.record_id,p_expected,payload,null);
end $$;
revoke all on function private.restore_content_revision(uuid,timestamptz) from public,anon;
grant execute on function private.restore_content_revision(uuid,timestamptz) to authenticated;
create function public.restore_content_revision(p_revision uuid,p_expected timestamptz) returns jsonb language sql security invoker set search_path='' as $$select private.restore_content_revision(p_revision,p_expected)$$;
revoke all on function public.restore_content_revision(uuid,timestamptz) from public,anon;
grant execute on function public.restore_content_revision(uuid,timestamptz) to authenticated;

create function private.cancel_content_release(p_entity text,p_id text) returns void language plpgsql security definer set search_path='' as $$
begin
  perform private.assert_content_access(p_entity);
  perform pg_advisory_xact_lock(7142302);
  update private.content_releases set state='cancelled',last_error=null where entity=p_entity and record_id=p_id and state='queued';
end $$;
revoke all on function private.cancel_content_release(text,text) from public,anon;
grant execute on function private.cancel_content_release(text,text) to authenticated;
create function public.cancel_content_release(p_entity text,p_id text) returns void language sql security invoker set search_path='' as $$select private.cancel_content_release(p_entity,p_id)$$;
revoke all on function public.cancel_content_release(text,text) from public,anon;
grant execute on function public.cancel_content_release(text,text) to authenticated;

-- 서버에서만 실행하는 예약 발행기입니다. 브라우저·익명·운영진 JWT에는 실행 권한을 부여하지 않습니다.
create function private.publish_due_content() returns integer language plpgsql security definer set search_path='' as $$
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
  -- 콘텐츠 본문 이력은 최근 90일/항목별 30개까지만 보관합니다. 내부 선수 자료는 대상이 아닙니다.
  delete from private.content_revisions where captured_at < now()-interval '90 days';
  return affected;
end $$;
revoke all on function private.publish_due_content() from public,anon,authenticated;
grant usage on schema private to service_role;
grant execute on function private.publish_due_content() to service_role;

create function private.office_capabilities() returns jsonb language sql stable security definer set search_path='' as $$
 select case when auth.uid() is not null and private.current_role() is not null then
 jsonb_build_object('schedule',true,'content',true,'publisher',(select publisher_enabled from private.office_automation_settings where id=1)) else '{}'::jsonb end;
$$;
revoke all on function private.office_capabilities() from public,anon;
grant execute on function private.office_capabilities() to authenticated;
create or replace function public.office_capabilities() returns jsonb language sql stable security invoker set search_path='' as $$select private.office_capabilities()$$;
-- 목록은 현재 페이지의 ID만 전달합니다. 본문/과거 버전을 일괄 추출하지 않습니다.
create function private.office_release_states(p_entity text,p_ids text[]) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare items jsonb;
begin
 perform private.assert_content_access(p_entity);
 if p_ids is null or cardinality(p_ids)>50 then raise exception 'at most 50 content IDs required'; end if;
 select coalesce(jsonb_agg(jsonb_build_object('record_id',record_id,'state',state,'scheduled_at',scheduled_at)),'[]'::jsonb) into items
 from private.content_releases where entity=p_entity and record_id=any(p_ids);
 return items;
end $$;
revoke all on function private.office_release_states(text,text[]) from public,anon;
grant execute on function private.office_release_states(text,text[]) to authenticated;
create function public.office_release_states(p_entity text,p_ids text[]) returns jsonb language sql stable security invoker set search_path='' as $$select private.office_release_states(p_entity,p_ids)$$;
revoke all on function public.office_release_states(text,text[]) from public,anon;
grant execute on function public.office_release_states(text,text[]) to authenticated;
create function private.office_release_attention() returns jsonb language plpgsql stable security definer set search_path='' as $$
declare items jsonb;
begin
 perform private.assert_content_access('articles');
 select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) into items from (
   select entity,count(*)::int as total from private.content_releases
   where (state='failed' or (state='queued' and scheduled_at<now()-interval '10 minutes'))
     and (entity<>'site_pages' or private.current_role() in ('owner','administrator'))
   group by entity
 ) t;
 return items;
end $$;
revoke all on function private.office_release_attention() from public,anon;
grant execute on function private.office_release_attention() to authenticated;
create function public.office_release_attention() returns jsonb language sql stable security invoker set search_path='' as $$select private.office_release_attention()$$;
revoke all on function public.office_release_attention() from public,anon;
grant execute on function public.office_release_attention() to authenticated;
-- 발행기 중지 여부와 별개로 운영자가 실행할 수 있는 콘텐츠 이력 정리 작업입니다.
create function private.prune_content_history() returns void language sql security definer set search_path='' as $$
 delete from private.content_revisions where captured_at<now()-interval '90 days';
$$;
revoke all on function private.prune_content_history() from public,anon,authenticated;
grant execute on function private.prune_content_history() to service_role;
