-- [편집 안내] 실제 프로젝트의 보안 검사 결과를 반영한 후속 마이그레이션입니다.
-- 실제 원격 실행 버전에 맞춰 파일명을 관리합니다.
-- 기존 사이트에서 이미 공개된 네 사진은 유지합니다. 새로운 사진과 선수 프로필의 동의 상태는 별도로 확인합니다.
-- 이미 공개된 자료라는 사실과 새로운 동의 확인을 같은 값으로 기록하지 않습니다.
alter table public.media_assets add column public_approved boolean generated always as
  (consent_confirmed or coalesce(legacy_path in ('assets/training-october-01.jpg','assets/training-october-02.jpg','assets/training-september-01.jpg','assets/training-september-02.jpg'),false)) stored;
alter table public.media_assets drop constraint media_assets_check1;
alter table public.media_assets add constraint media_publication_check check
  (status <> 'published' or (public_approved and length(trim(alt_text)) > 0));
grant select(public_approved) on public.media_assets to anon;
create or replace function private.prepare_content() returns trigger
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
          if photo is not null and not exists(select 1 from public.media_assets where kind = 'photo' and coalesce(storage_path,legacy_path) = photo and status = 'published' and public_approved) then raise exception 'article image must be approved'; end if;
        end loop;
      elsif tg_table_name = 'public_player_profiles' then
        if new.photo_path is not null and not exists(select 1 from public.media_assets where kind = 'photo' and coalesce(storage_path,legacy_path) = new.photo_path and status = 'published' and public_approved) then raise exception 'profile image must be approved'; end if;
      elsif tg_table_name = 'fixtures' then
        if new.opponent_logo_path is not null and not exists(select 1 from public.media_assets where kind = 'photo' and coalesce(storage_path,legacy_path) = new.opponent_logo_path and status = 'published' and public_approved) then raise exception 'opponent logo must be approved'; end if;
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
create or replace function private.withdraw_media() returns trigger
language plpgsql security definer set search_path = '' as $$
declare path text := coalesce(old.storage_path,old.legacy_path);
begin
  if auth.uid() is not null and private.current_role() not in ('owner','administrator','editor') then raise exception 'media editor required'; end if;
  if tg_op = 'DELETE' or (old.status = 'published' and (new.status <> 'published' or (not new.consent_confirmed and not coalesce(new.legacy_path in ('assets/training-october-01.jpg','assets/training-october-02.jpg','assets/training-september-01.jpg','assets/training-september-02.jpg'),false))
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

-- 기본 자동 RLS 함수가 공개 RPC로 열려 있던 권한을 제거합니다. 이벤트 트리거 자체는 유지됩니다.
do $$ begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    revoke execute on function public.rls_auto_enable() from public,anon,authenticated;
  end if;
end $$;
-- 미구현 내부 API는 모든 클라이언트에 명시적으로 차단합니다.
create policy contacts_deny_clients on private.player_contacts for all to anon,authenticated using(false) with check(false);
create policy attendance_deny_clients on private.attendance for all to anon,authenticated using(false) with check(false);
create policy evaluations_deny_clients on private.player_evaluations for all to anon,authenticated using(false) with check(false);

-- 같은 역할의 SELECT 정책을 한 번만 평가하도록 공개 읽기와 직원 읽기를 합칩니다.
drop policy roles_manage on public.admin_roles;
create policy roles_insert on public.admin_roles for insert to authenticated with check ((select private.current_role()) = 'owner');
create policy roles_update on public.admin_roles for update to authenticated using ((select private.current_role()) = 'owner') with check ((select private.current_role()) = 'owner');
create policy roles_delete on public.admin_roles for delete to authenticated using ((select private.current_role()) = 'owner');

do $$
declare tbl text; rule text; staff text;
begin
  foreach tbl in array array['articles','fixtures','media_assets','media_albums','site_pages'] loop
    staff := case when tbl = 'fixtures' then '(''owner'',''administrator'',''coach'')'
      when tbl = 'site_pages' then '(''owner'',''administrator'')'
      else '(''owner'',''administrator'',''editor'')' end;
    rule := case when tbl = 'fixtures' then 'football_manage' when tbl = 'site_pages' then 'pages_manage' else 'editorial_manage' end;
    execute format('drop policy %I on public.%I',rule,tbl);
    execute format('create policy staff_insert on public.%I for insert to authenticated with check ((select private.current_role()) in %s)',tbl,staff);
    execute format('create policy staff_update on public.%I for update to authenticated using ((select private.current_role()) in %s) with check ((select private.current_role()) in %s)',tbl,staff,staff);
    execute format('create policy staff_delete on public.%I for delete to authenticated using ((select private.current_role()) in %s)',tbl,staff);
  end loop;
end $$;
alter policy articles_public on public.articles to anon;
alter policy fixtures_public on public.fixtures to anon;
alter policy albums_public on public.media_albums to anon;
alter policy pages_public on public.site_pages to anon;
alter policy profiles_public on public.public_player_profiles to anon;
drop policy media_public on public.media_assets;
create policy media_public on public.media_assets for select to anon using (status = 'published' and public_approved and published_at <= now() and (album_id is null or exists(select 1 from public.media_albums where id = album_id and status = 'published')));
create policy articles_read_authenticated on public.articles for select to authenticated using ((status = 'published' and published_at <= now()) or (select private.current_role()) in ('owner','administrator','editor'));
create policy fixtures_read_authenticated on public.fixtures for select to authenticated using ((status = 'published' and published_at <= now()) or (select private.current_role()) in ('owner','administrator','coach'));
create policy albums_read_authenticated on public.media_albums for select to authenticated using ((status = 'published' and published_at <= now()) or (select private.current_role()) in ('owner','administrator','editor'));
create policy pages_read_authenticated on public.site_pages for select to authenticated using ((status = 'published' and published_at <= now()) or (select private.current_role()) in ('owner','administrator'));
alter policy profile_read_staff on public.public_player_profiles using ((status = 'published' and published_at <= now()) or (select private.current_role()) in ('owner','administrator','coach'));
create policy media_read_authenticated on public.media_assets for select to authenticated using ((status = 'published' and public_approved and published_at <= now() and (album_id is null or exists(select 1 from public.media_albums where id = album_id and status = 'published'))) or (select private.current_role()) in ('owner','administrator','editor'));
drop policy kansai_storage_public_read on storage.objects;
drop policy kansai_storage_staff_read on storage.objects;
create policy kansai_storage_public_read on storage.objects for select to anon using (bucket_id = 'kansai-media' and exists(select 1 from public.media_assets where storage_path = name and status = 'published' and public_approved));
create policy kansai_storage_staff_read on storage.objects for select to authenticated using (bucket_id = 'kansai-media' and ((select private.current_role()) in ('owner','administrator','editor') or exists(select 1 from public.media_assets where storage_path = name and status = 'published' and public_approved)));

