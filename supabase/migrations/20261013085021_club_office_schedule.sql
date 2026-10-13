-- [편집 안내] 기존 경기/훈련 UUID와 내부 메모를 보존하는 일정 확장입니다.
-- 운영 적용 전 로컬 권한/반복 일정 검사를 통과시키고 PR 순서대로 적용합니다.
create table public.training_series (
  id uuid primary key default gen_random_uuid(),
  interval_weeks integer not null check (interval_weeks between 1 and 12),
  occurrences integer not null check (occurrences between 2 and 52),
  created_at timestamptz not null default now(),
  check (interval_weeks * (occurrences - 1) <= 52)
);
alter table public.training_sessions
  add column series_id uuid references public.training_series(id) on delete restrict,
  add column is_public boolean not null default false,
  add column public_description text not null default '';
create index training_series_occurrence_idx on public.training_sessions(series_id,starts_at) where series_id is not null;
create table public.club_events (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(trim(title)) between 1 and 200),
  starts_at timestamptz not null,
  ends_at timestamptz,
  venue text not null default '',
  session_status text not null default 'scheduled' check (session_status in ('scheduled','completed','cancelled')),
  is_public boolean not null default false,
  public_description text not null default '',
  notes text not null default '',
  updated_at timestamptz not null default now(),
  check (ends_at is null or ends_at >= starts_at)
);
create index club_events_starts_idx on public.club_events(starts_at,id);
do $$ declare tbl text; begin
  foreach tbl in array array['training_series','club_events'] loop
    execute format('alter table public.%I enable row level security',tbl);
    execute format('revoke all on public.%I from public,anon,authenticated',tbl);
    execute format('grant select,insert,update,delete on public.%I to authenticated',tbl);
    execute format('create policy football_manage on public.%I for all to authenticated using ((select private.current_role()) in (''owner'',''administrator'',''coach'')) with check ((select private.current_role()) in (''owner'',''administrator'',''coach''))',tbl);
  end loop;
end $$;
create trigger prepare_content before insert or update on public.club_events for each row execute function private.prepare_content();
create trigger audit_content after insert or update or delete on public.club_events for each row execute function private.capture_audit();

-- 공개 일정은 원본을 직접 노출하지 않고 트리거가 허용된 필드만 복사합니다.
-- 사람이 이 테이블에 중복 입력하지 않으며 notes/series_id/작업자 정보는 포함하지 않습니다.
create table public.published_schedule (
  resource text not null check (resource in ('fixtures','training_sessions','club_events')),
  id uuid not null,
  title text not null,
  starts_at timestamptz,
  ends_at timestamptz,
  venue text not null,
  schedule_status text not null,
  description text not null,
  primary key(resource,id)
);
create index published_schedule_starts_idx on public.published_schedule(starts_at,id);
alter table public.published_schedule enable row level security;
revoke all on public.published_schedule from public,anon,authenticated;
grant select on public.published_schedule to anon,authenticated;
create policy published_schedule_read on public.published_schedule for select to anon,authenticated using(true);
create function private.sync_public_schedule() returns trigger
language plpgsql security definer set search_path = '' as $$
declare item jsonb := case when tg_op='DELETE' then to_jsonb(old) else to_jsonb(new) end;
  exposed boolean; changed integer;
begin
  if auth.uid() is not null and private.current_role() is null then raise exception 'active staff required'; end if;
  delete from public.published_schedule where resource=tg_table_name and id=(item->>'id')::uuid;
  get diagnostics changed = row_count;
  exposed := tg_op <> 'DELETE' and case when tg_table_name='fixtures' then item->>'status'='published' else (item->>'is_public')::boolean end;
  if exposed then
    insert into public.published_schedule(resource,id,title,starts_at,ends_at,venue,schedule_status,description)
    values(tg_table_name,(item->>'id')::uuid,
      case when tg_table_name='fixtures' then 'vs ' || (item->>'opponent') else item->>'title' end,
      (case when tg_table_name='fixtures' then item->>'kickoff_at' else item->>'starts_at' end)::timestamptz,
      (item->>'ends_at')::timestamptz,item->>'venue',
      case when tg_table_name='fixtures' then item->>'match_status' else item->>'session_status' end,
      coalesce(item->>'public_description',item->>'competition',''));
  end if;
  if changed > 0 or exposed then
    update public.publication_state set version=version+1,changed_at=now() where id=1;
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;
revoke all on function private.sync_public_schedule() from public,anon,authenticated;
create trigger sync_public_schedule after insert or update or delete on public.fixtures for each row execute function private.sync_public_schedule();
create trigger sync_public_schedule after insert or update or delete on public.training_sessions for each row execute function private.sync_public_schedule();
create trigger sync_public_schedule after insert or update or delete on public.club_events for each row execute function private.sync_public_schedule();
insert into public.published_schedule(resource,id,title,starts_at,venue,schedule_status,description)
select 'fixtures',id,'vs ' || opponent,kickoff_at,venue,match_status,competition from public.fixtures where status='published' and published_at<=now();

create function public.office_capabilities() returns jsonb language sql stable security invoker set search_path = '' as $$
 select case when private.current_role() is not null then '{"schedule":true,"content":false}'::jsonb else '{}'::jsonb end;
$$;
revoke all on function public.office_capabilities() from public,anon;
grant execute on function public.office_capabilities() to authenticated;

-- 반복 생성은 하나의 트랜잭션입니다. 하나라도 유효하지 않으면 전체를 취소합니다.
create function public.create_training_series(p_template jsonb,p_interval_weeks integer,p_occurrences integer)
returns setof public.training_sessions language plpgsql security invoker set search_path = '' as $$
declare series uuid; n integer; first_start timestamptz; first_end timestamptz;
begin
  if auth.uid() is null or coalesce(private.current_role(),'') not in ('owner','administrator','coach') then raise exception 'football staff required'; end if;
  if p_occurrences is null or p_interval_weeks is null then raise exception 'recurrence limits required'; end if;
  insert into public.training_series(interval_weeks,occurrences) values(p_interval_weeks,p_occurrences) returning id into series;
  first_start := (p_template->>'starts_at')::timestamptz;
  first_end := (p_template->>'ends_at')::timestamptz;
  for n in 0..p_occurrences-1 loop
    return query insert into public.training_sessions(title,starts_at,ends_at,venue,session_status,notes,is_public,public_description,series_id)
    values(p_template->>'title',
      ((first_start at time zone 'Asia/Tokyo') + make_interval(days=>n*7*p_interval_weeks)) at time zone 'Asia/Tokyo',
      ((first_end at time zone 'Asia/Tokyo') + make_interval(days=>n*7*p_interval_weeks)) at time zone 'Asia/Tokyo',
      coalesce(p_template->>'venue',''),'scheduled',coalesce(p_template->>'notes',''),
      coalesce((p_template->>'is_public')::boolean,false),coalesce(p_template->>'public_description',''),series)
    returning *;
  end loop;
end $$;
revoke all on function public.create_training_series(jsonb,integer,integer) from public,anon;
grant execute on function public.create_training_series(jsonb,integer,integer) to authenticated;

-- 단일 회차는 ID를 유지합니다. 전체 수정은 이미 끝난 회차를 제외하고 날짜 차이만큼 함께 이동합니다.
create function public.update_training_occurrences(p_id uuid,p_expected timestamptz,p_patch jsonb,p_scope text)
returns integer language plpgsql security invoker set search_path = '' as $$
declare anchor public.training_sessions; item public.training_sessions; delta interval; duration interval; affected integer:=0;
begin
  if auth.uid() is null or coalesce(private.current_role(),'') not in ('owner','administrator','coach') then raise exception 'football staff required'; end if;
  if p_scope is null or p_scope not in ('single','series') then raise exception 'invalid recurrence scope'; end if;
  -- 같은 반복 묶음의 수정 순서를 고정해 동시 저장 충돌과 교착 상태를 줄입니다.
  perform pg_advisory_xact_lock(hashtextextended(coalesce((select series_id::text from public.training_sessions where id=p_id),p_id::text),0));
  select * into anchor from public.training_sessions where id=p_id for update;
  if anchor.id is null or anchor.updated_at is distinct from p_expected then raise exception 'schedule changed; reload before saving'; end if;
  if p_scope='series' and (anchor.series_id is null or anchor.starts_at<now() or anchor.session_status='completed') then raise exception 'select a future series occurrence'; end if;
  delta := (p_patch->>'starts_at')::timestamptz-anchor.starts_at;
  if delta is null then raise exception 'start time required'; end if;
  duration := (p_patch->>'ends_at')::timestamptz-(p_patch->>'starts_at')::timestamptz;
  for item in select * from public.training_sessions where id=p_id or
    (p_scope='series' and series_id=anchor.series_id and starts_at>=now() and session_status<>'completed') order by id for update loop
    update public.training_sessions set title=p_patch->>'title',starts_at=item.starts_at+delta,
      ends_at=case when duration is null then null else item.starts_at+delta+duration end,
      venue=coalesce(p_patch->>'venue',''),session_status=coalesce(p_patch->>'session_status','scheduled'),
      notes=coalesce(p_patch->>'notes',''),is_public=coalesce((p_patch->>'is_public')::boolean,false),
      public_description=coalesce(p_patch->>'public_description','') where id=item.id;
    affected := affected+1;
  end loop;
  return affected;
end $$;
revoke all on function public.update_training_occurrences(uuid,timestamptz,jsonb,text) from public,anon;
grant execute on function public.update_training_occurrences(uuid,timestamptz,jsonb,text) to authenticated;
