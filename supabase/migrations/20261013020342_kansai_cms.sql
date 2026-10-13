-- [편집 안내] 간사이 전용 새 프로젝트의 CMS 마이그레이션입니다.
-- 파일 버전은 실제 원격 마이그레이션 기록과 맞춥니다. 실행된 내용은 다시 수정하지 않습니다.
-- 공개 승인 데이터 / 운영 데이터 / 향후 내부 기록을 분리하며 다른 구단 DB에는 적용하지 않습니다.
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;
alter default privileges in schema private revoke execute on functions from public;

create table public.admin_roles (
  user_id uuid primary key references auth.users(id) on delete restrict,
  email text not null,
  role text not null check (role in ('owner','administrator','editor','coach')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.admin_roles enable row level security;

-- 역할 테이블의 재귀 RLS를 피하는 내부 조회 함수. 호출자의 실제 UUID만 조회합니다.
create function private.current_role() returns text
language sql stable security definer set search_path = ''
as $$ select role from public.admin_roles
      where auth.uid() is not null and user_id = (select auth.uid()) and active; $$;
revoke all on function private.current_role() from public, anon;
grant execute on function private.current_role() to authenticated;

create table public.players (
  id uuid primary key default gen_random_uuid(),
  internal_name text not null check (length(trim(internal_name)) between 1 and 150),
  activity_status text not null default 'active' check (activity_status in ('active','inactive','former')),
  profile_consent boolean not null default false,
  photo_consent boolean not null default false,
  consent_note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.public_player_profiles (
  player_id uuid primary key references public.players(id) on delete restrict,
  slug text unique not null check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) <= 120),
  display_name text not null check (length(trim(display_name)) between 1 and 150),
  romanized_name text not null default '',
  jersey_number integer check (jersey_number between 0 and 99),
  position text not null check (position in ('GK','DF','MF','FW')),
  photo_path text,
  bio text not null default '',
  activity_status text not null default 'active' check (activity_status in ('active','inactive','former')),
  display_order integer not null default 0 check (display_order >= 0),
  status text not null default 'draft' check (status in ('draft','pending','published')),
  approved_by uuid references auth.users(id),
  published_at timestamptz,
  updated_at timestamptz not null default now()
);
create table public.media_albums (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(trim(title)) between 1 and 200),
  description text not null default '',
  captured_on date,
  status text not null default 'draft' check (status in ('draft','pending','published')),
  published_at timestamptz,
  updated_at timestamptz not null default now()
);
create table public.media_assets (
  id uuid primary key default gen_random_uuid(),
  kind text not null default 'photo' check (kind in ('photo','video')),
  title text not null check (length(trim(title)) between 1 and 200),
  storage_path text unique check (storage_path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|jpeg|png|webp)$'),
  legacy_path text check (legacy_path ~ '^assets/[a-z0-9-]+\.(jpg|png|webp)$'),
  video_url text check (video_url is null or video_url ~ '^https://'),
  alt_text text not null default '',
  description text not null default '',
  source_url text check (source_url is null or source_url ~ '^https://'),
  captured_on date,
  album_id uuid references public.media_albums(id) on delete restrict,
  consent_confirmed boolean not null default false,
  status text not null default 'draft' check (status in ('draft','pending','published')),
  published_at timestamptz,
  updated_at timestamptz not null default now(),
  check ((kind = 'photo' and num_nonnulls(storage_path,legacy_path) = 1 and video_url is null)
      or (kind = 'video' and video_url is not null and storage_path is null and legacy_path is null)),
  check (status <> 'published' or (consent_confirmed and length(trim(alt_text)) > 0))
);
create table public.articles (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) <= 120),
  title text not null check (length(trim(title)) between 1 and 250),
  summary text not null default '',
  category text not null default 'club' check (category in ('training','club','match','announcement')),
  body text not null default '',
  cover_path text,
  cover_alt text not null default '',
  gallery_paths text[] not null default '{}',
  source_url text check (source_url is null or source_url ~ '^https://'),
  activity_date date,
  featured boolean not null default false,
  status text not null default 'draft' check (status in ('draft','pending','published')),
  published_at timestamptz,
  updated_at timestamptz not null default now(),
  check (status <> 'published' or (length(trim(body)) > 0 and length(trim(summary)) > 0 and length(trim(cover_alt)) > 0))
);
create table public.fixtures (
  id uuid primary key default gen_random_uuid(),
  opponent text not null check (length(trim(opponent)) between 1 and 200),
  competition text not null default '',
  kickoff_at timestamptz,
  venue text not null default '',
  home_away text not null default 'neutral' check (home_away in ('home','away','neutral')),
  match_status text not null default 'scheduled' check (match_status in ('scheduled','completed','postponed','cancelled')),
  own_score integer check (own_score between 0 and 99),
  opponent_score integer check (opponent_score between 0 and 99),
  opponent_logo_path text,
  report text not null default '',
  status text not null default 'draft' check (status in ('draft','pending','published')),
  published_at timestamptz,
  updated_at timestamptz not null default now(),
  check (match_status <> 'completed' or (own_score is not null and opponent_score is not null))
);
create table public.training_sessions (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(trim(title)) between 1 and 200),
  starts_at timestamptz not null,
  ends_at timestamptz,
  venue text not null default '',
  session_status text not null default 'scheduled' check (session_status in ('scheduled','completed','cancelled')),
  notes text not null default '',
  updated_at timestamptz not null default now(),
  check (ends_at is null or ends_at >= starts_at)
);
-- 출전 기록과 연결할 자리입니다. 선수 UUID와 경기 UUID를 쓰며 익명 API에 노출하지 않습니다.
create table public.match_events (
  id uuid primary key default gen_random_uuid(),
  fixture_id uuid not null references public.fixtures(id) on delete restrict,
  player_id uuid references public.players(id) on delete restrict,
  event_type text not null check (event_type in ('appearance','goal','assist','yellow_card','red_card','substitution')),
  minute integer check (minute between 0 and 150),
  details jsonb not null default '{}',
  updated_at timestamptz not null default now()
);
create table public.site_pages (
  id text primary key check (id in ('club','join')),
  title text not null check (length(trim(title)) between 1 and 200),
  introduction text not null default '',
  body text not null default '',
  status text not null default 'draft' check (status in ('draft','pending','published')),
  published_at timestamptz,
  updated_at timestamptz not null default now()
);
create table public.audit_logs (
  id bigint generated always as identity primary key,
  actor_id uuid,
  actor_role text,
  entity text not null,
  record_id text,
  operation text not null,
  changed_fields text[] not null default '{}',
  occurred_at timestamptz not null default now()
);
-- 값 자체를 이력에 복제하지 않습니다. 민감한 본문·개인정보는 감사 로그로도 누출시키지 않습니다.
create table public.publication_state (
  id integer primary key check (id = 1),
  version bigint not null default 0,
  changed_at timestamptz not null default now()
);
insert into public.publication_state(id) values(1);

-- 내부 관리 프로그램의 확장 영역. private 스키마는 Data API 설정에 추가하지 않습니다.
create table private.player_contacts (
  player_id uuid primary key references public.players(id) on delete restrict,
  contact_data jsonb not null default '{}'
);
create table private.attendance (
  training_id uuid not null references public.training_sessions(id) on delete restrict,
  player_id uuid not null references public.players(id) on delete restrict,
  attendance_status text not null check (attendance_status in ('present','absent','late','excused')),
  primary key(training_id,player_id)
);
create table private.player_evaluations (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references public.players(id) on delete restrict,
  assessor_id uuid references auth.users(id),
  evaluated_on date not null,
  evaluation jsonb not null default '{}'
);
alter table private.player_contacts enable row level security;
alter table private.attendance enable row level security;
alter table private.player_evaluations enable row level security;
revoke all on all tables in schema private from public, anon, authenticated;

-- 발행, 선수 동의, 영구 URL을 데이터베이스에서도 확인합니다.
create function private.prepare_content() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare staff text := private.current_role(); item record; photo text;
begin
  new.updated_at := now();
  if tg_op = 'UPDATE' then
    if tg_table_name = 'public_player_profiles' then
      if new.player_id <> old.player_id then raise exception 'player UUID is immutable'; end if;
    elsif tg_table_name = 'admin_roles' then
      if new.user_id <> old.user_id then raise exception 'user UUID is immutable'; end if;
    else
      if new.id <> old.id then raise exception 'record ID is immutable'; end if;
    end if;
  end if;
  if tg_table_name in ('articles','public_player_profiles') and tg_op = 'UPDATE' then
    if old.published_at is not null and new.slug <> old.slug then raise exception 'published URL is immutable'; end if;
  end if;
  if tg_table_name in ('articles','public_player_profiles','fixtures','media_assets','media_albums','site_pages') then
    if new.status = 'published' then
      new.published_at := coalesce(new.published_at,now());
      if new.published_at > now() then raise exception 'future publication is not supported; save a draft'; end if;
      if tg_table_name = 'public_player_profiles' then
        if auth.uid() is not null and staff not in ('owner','administrator') then raise exception 'profile approval requires owner or administrator'; end if;
        select * into item from public.players where id = new.player_id;
        if item is null or not item.profile_consent then raise exception 'profile consent is required'; end if;
        if new.photo_path is not null and not item.photo_consent then raise exception 'photo consent is required'; end if;
        new.approved_by := auth.uid();
      end if;
      if tg_table_name = 'articles' then
        for photo in select unnest(array_append(new.gallery_paths,new.cover_path)) loop
          if photo is not null and not exists(select 1 from public.media_assets where kind = 'photo' and coalesce(storage_path,legacy_path) = photo and status = 'published' and consent_confirmed) then raise exception 'article image must be approved'; end if;
        end loop;
      elsif tg_table_name = 'public_player_profiles' then
        if new.photo_path is not null and not exists(select 1 from public.media_assets where kind = 'photo' and coalesce(storage_path,legacy_path) = new.photo_path and status = 'published' and consent_confirmed) then raise exception 'profile image must be approved'; end if;
      elsif tg_table_name = 'fixtures' then
        if new.opponent_logo_path is not null and not exists(select 1 from public.media_assets where kind = 'photo' and coalesce(storage_path,legacy_path) = new.opponent_logo_path and status = 'published' and consent_confirmed) then raise exception 'opponent logo must be approved'; end if;
      elsif tg_table_name = 'media_assets' then
        if new.album_id is not null and not exists(select 1 from public.media_albums where id = new.album_id and status = 'published') then raise exception 'album must be approved'; end if;
        if new.storage_path is not null and not exists(select 1 from storage.objects where bucket_id = 'kansai-media' and name = new.storage_path) then raise exception 'photo upload is required'; end if;
      end if;
    elsif tg_table_name = 'public_player_profiles' then new.approved_by := null;
    end if;
    if tg_op = 'UPDATE' and old.published_at is not null then
      -- 처음 발행했던 URL의 이력은 비공개로 돌려도 지우지 않습니다.
      new.published_at := coalesce(new.published_at,old.published_at);
    end if;
  end if;
  return new;
end $$;

create function private.withdraw_profile() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if (old.profile_consent and not new.profile_consent) or (old.photo_consent and not new.photo_consent) then
    update public.public_player_profiles set status = 'draft', approved_by = null where player_id = new.id;
  end if;
  return new;
end $$;
create trigger player_consent_withdrawal after update on public.players for each row execute function private.withdraw_profile();

-- 사진의 동의 철회·비공개 전환 시 그 사진을 사용하는 공개 콘텐츠도 비공개로 돌립니다.
-- 권한 있는 편집자의 철회 요청만 처리하는 내부 트리거이며 일반 API로 실행할 수 없습니다.
create function private.withdraw_media() returns trigger
language plpgsql security definer set search_path = '' as $$
declare path text := coalesce(old.storage_path,old.legacy_path);
begin
  if auth.uid() is not null and private.current_role() not in ('owner','administrator','editor') then raise exception 'media editor required'; end if;
  if tg_op = 'DELETE' or (old.status = 'published' and (new.status <> 'published' or not new.consent_confirmed
    or coalesce(new.storage_path,new.legacy_path) is distinct from path)) then
    if path is not null then
      update public.articles set status = 'draft' where status = 'published' and (cover_path = path or path = any(gallery_paths));
      update public.public_player_profiles set status = 'draft', approved_by = null where status = 'published' and photo_path = path;
      update public.fixtures set status = 'draft' where status = 'published' and opponent_logo_path = path;
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
create trigger withdraw_media before update or delete on public.media_assets for each row execute function private.withdraw_media();
create function private.withdraw_album() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is not null and private.current_role() not in ('owner','administrator','editor') then raise exception 'album editor required'; end if;
  if old.status = 'published' and new.status <> 'published' then
    update public.media_assets set status = 'draft' where album_id = new.id and status = 'published';
  end if;
  return new;
end $$;
create trigger withdraw_album before update on public.media_albums for each row execute function private.withdraw_album();

create function private.guard_roles() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is not null and private.current_role() is distinct from 'owner' then raise exception 'owner role required'; end if;
  -- 동시에 두 Owner가 마지막 권한을 제거하지 못하도록 트랜잭션 잠금을 사용합니다.
  perform pg_advisory_xact_lock(7142301);
  if tg_op in ('UPDATE','DELETE') and old.role = 'owner' and old.active then
    if tg_op = 'DELETE' or not new.active or new.role <> 'owner' then
      if (select count(*) from public.admin_roles where role = 'owner' and active) <= 1 then raise exception 'last owner cannot be removed'; end if;
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
create trigger protect_owner before insert or update or delete on public.admin_roles for each row execute function private.guard_roles();

create function private.capture_audit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare before_row jsonb := coalesce(to_jsonb(old),'{}'); after_row jsonb := coalesce(to_jsonb(new),'{}'); fields text[];
begin
  if auth.uid() is not null and private.current_role() is null then raise exception 'active staff required'; end if;
  select array_agg(k) into fields from (select jsonb_object_keys(before_row || after_row) as k) keys
    where before_row->k is distinct from after_row->k and k <> 'updated_at';
  insert into public.audit_logs(actor_id,actor_role,entity,record_id,operation,changed_fields)
    values(auth.uid(),private.current_role(),tg_table_name,coalesce(after_row->>'id',after_row->>'player_id',after_row->>'user_id',before_row->>'id',before_row->>'player_id',before_row->>'user_id'),tg_op,coalesce(fields,'{}'));
  if tg_table_name in ('articles','public_player_profiles','fixtures','media_assets','media_albums','site_pages')
    and (before_row->>'status' = 'published' or after_row->>'status' = 'published') then
    update public.publication_state set version = version + 1, changed_at = now() where id = 1;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
revoke all on function private.prepare_content(), private.withdraw_profile(), private.withdraw_media(), private.withdraw_album(), private.guard_roles(), private.capture_audit() from public, anon, authenticated;

-- 모든 노출 테이블에 명시적 GRANT + RLS를 적용합니다. 기본 권한 설정에 의존하지 않습니다.
do $$
declare tbl text;
begin
  foreach tbl in array array['admin_roles','players','public_player_profiles','articles','fixtures','training_sessions','match_events','media_assets','media_albums','site_pages','audit_logs','publication_state'] loop
    execute format('alter table public.%I enable row level security',tbl);
    execute format('revoke all on public.%I from public, anon, authenticated',tbl);
  end loop;
  foreach tbl in array array['admin_roles','players','public_player_profiles','articles','fixtures','training_sessions','match_events','media_assets','media_albums','site_pages'] loop
    execute format('grant select, insert, update, delete on public.%I to authenticated',tbl);
    execute format('create trigger prepare_content before insert or update on public.%I for each row execute function private.prepare_content()',tbl);
    execute format('create trigger audit_content after insert or update or delete on public.%I for each row execute function private.capture_audit()',tbl);
  end loop;
end $$;

create policy roles_read on public.admin_roles for select to authenticated
  using (user_id = (select auth.uid()) or (select private.current_role()) = 'owner');
create policy roles_manage on public.admin_roles for all to authenticated
  using ((select private.current_role()) = 'owner') with check ((select private.current_role()) = 'owner');

-- 축구 운영 데이터는 Owner/Administrator/Coach만 접근합니다.
do $$
declare tbl text;
begin
  foreach tbl in array array['players','fixtures','training_sessions','match_events'] loop
    execute format('create policy football_manage on public.%I for all to authenticated using ((select private.current_role()) in (''owner'',''administrator'',''coach'')) with check ((select private.current_role()) in (''owner'',''administrator'',''coach''))',tbl);
  end loop;
  foreach tbl in array array['articles','media_assets','media_albums'] loop
    execute format('create policy editorial_manage on public.%I for all to authenticated using ((select private.current_role()) in (''owner'',''administrator'',''editor'')) with check ((select private.current_role()) in (''owner'',''administrator'',''editor''))',tbl);
  end loop;
end $$;
create policy profile_read_staff on public.public_player_profiles for select to authenticated
  using ((select private.current_role()) in ('owner','administrator','coach'));
create policy profile_insert_staff on public.public_player_profiles for insert to authenticated
  with check ((select private.current_role()) in ('owner','administrator') or ((select private.current_role()) = 'coach' and status in ('draft','pending')));
create policy profile_update_staff on public.public_player_profiles for update to authenticated
  using ((select private.current_role()) in ('owner','administrator','coach'))
  with check ((select private.current_role()) in ('owner','administrator') or ((select private.current_role()) = 'coach' and status in ('draft','pending')));
create policy profile_delete_staff on public.public_player_profiles for delete to authenticated
  using ((select private.current_role()) in ('owner','administrator'));
create policy pages_manage on public.site_pages for all to authenticated
  using ((select private.current_role()) in ('owner','administrator'))
  with check ((select private.current_role()) in ('owner','administrator'));

-- 승인된 공개 내용만 익명에게 허용합니다. 승인 담당자 UUID·동의 기록은 컬럼 GRANT에서도 제외합니다.
grant select(id,slug,title,summary,category,body,cover_path,cover_alt,gallery_paths,source_url,activity_date,featured,status,published_at,updated_at) on public.articles to anon;
grant select(player_id,slug,display_name,romanized_name,jersey_number,position,photo_path,bio,activity_status,display_order,status,published_at,updated_at) on public.public_player_profiles to anon;
grant select(id,opponent,competition,kickoff_at,venue,home_away,match_status,own_score,opponent_score,opponent_logo_path,report,status,published_at,updated_at) on public.fixtures to anon;
grant select(id,kind,title,storage_path,legacy_path,video_url,alt_text,description,source_url,captured_on,album_id,consent_confirmed,status,published_at,updated_at) on public.media_assets to anon;
grant select on public.media_albums, public.site_pages, public.publication_state to anon;
grant select on public.audit_logs, public.publication_state to authenticated;
create policy articles_public on public.articles for select to anon, authenticated using (status = 'published' and published_at <= now());
create policy profiles_public on public.public_player_profiles for select to anon, authenticated using (status = 'published' and published_at <= now());
create policy fixtures_public on public.fixtures for select to anon, authenticated using (status = 'published' and published_at <= now());
create policy albums_public on public.media_albums for select to anon, authenticated using (status = 'published' and published_at <= now());
create policy pages_public on public.site_pages for select to anon, authenticated using (status = 'published' and published_at <= now());
create policy media_public on public.media_assets for select to anon, authenticated
  using (status = 'published' and consent_confirmed and published_at <= now()
    and (album_id is null or exists(select 1 from public.media_albums where id = album_id and status = 'published')));
create policy publication_read on public.publication_state for select to anon, authenticated using (true);
create policy audit_read on public.audit_logs for select to authenticated
  using ((select private.current_role()) in ('owner','administrator') or (actor_id = (select auth.uid()) and (select private.current_role()) in ('editor','coach')));

create index articles_publication_idx on public.articles(published_at desc) where status = 'published';
create index profiles_order_idx on public.public_player_profiles(display_order) where status = 'published';
create index profiles_approver_idx on public.public_player_profiles(approved_by);
create index fixtures_kickoff_idx on public.fixtures(kickoff_at);
create index training_starts_idx on public.training_sessions(starts_at);
create index events_fixture_idx on public.match_events(fixture_id);
create index events_player_idx on public.match_events(player_id);
create index media_album_idx on public.media_assets(album_id);
create index audit_actor_idx on public.audit_logs(actor_id,occurred_at desc);
create index evaluation_player_idx on private.player_evaluations(player_id);
create index evaluation_assessor_idx on private.player_evaluations(assessor_id);
create index attendance_player_idx on private.attendance(player_id);

-- 비공개 버킷: URL을 알아도 미승인 사진은 읽을 수 없습니다. 공개 API도 SELECT RLS를 거칩니다.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('kansai-media','kansai-media',false,10485760,array['image/jpeg','image/png','image/webp']);
create policy kansai_storage_public_read on storage.objects for select to anon, authenticated
using (bucket_id = 'kansai-media' and exists(select 1 from public.media_assets
  where storage_path = name and status = 'published' and consent_confirmed));
create policy kansai_storage_staff_read on storage.objects for select to authenticated
using (bucket_id = 'kansai-media' and (select private.current_role()) in ('owner','administrator','editor'));
create policy kansai_storage_upload on storage.objects for insert to authenticated
with check (bucket_id = 'kansai-media' and (select private.current_role()) in ('owner','administrator','editor')
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and name ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|jpeg|png|webp)$');
-- 새 파일명으로 업로드하고 기존 파일을 덮어쓰지 않습니다. 버전 간 충돌과 캐시 오염을 피합니다.
create policy kansai_storage_delete_unused on storage.objects for delete to authenticated
using (bucket_id = 'kansai-media' and (select private.current_role()) in ('owner','administrator')
  and not exists(select 1 from public.media_assets where storage_path = name));
