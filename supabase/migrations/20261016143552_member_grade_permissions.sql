-- [편집 안내] 기존 Auth UUID/원본 역할/감사 이력은 보존하고 실제 업무 권한만 세 등급으로 정규화합니다.
-- owner 값은 마지막 총괄 보호와 기존 복구 경로의 기준이므로 바꾸지 않습니다.
alter table public.admin_roles drop constraint admin_roles_role_check;
alter table public.admin_roles add constraint admin_roles_role_check
 check(role in ('owner','staff','player','administrator','editor','coach'));
create function private.member_grade(p_role text) returns text
language sql immutable security invoker set search_path='' as $$
 select case when p_role='owner' then 'owner' when p_role in ('staff','administrator','editor','coach') then 'staff' when p_role='player' then 'player' else null end
$$;
revoke all on function private.member_grade(text) from public,anon,service_role;
grant execute on function private.member_grade(text) to authenticated;
create or replace function private.staff_role_for(p_user_id uuid) returns text
language sql stable security definer set search_path='' as $$
 select private.member_grade(r.role) from public.admin_roles r left join private.staff_accounts a on a.user_id=r.user_id
 where r.user_id=p_user_id and r.active and
 (a.user_id is null or (a.approval_status='approved' and (a.legacy_account or not a.email_confirmation_required or exists(select 1 from auth.users u where u.id=r.user_id and u.email_confirmed_at is not null))))
$$;

-- 초안 편집 권한이 공개 수정/취소 권한으로 바뀌지 않도록 OLD와 NEW를 함께 검사합니다.
-- 원본을 자동 비공개로 바꾸지 않습니다. 공개 자료는 총괄이 먼저 공개 취소해야 스태프가 편집할 수 있습니다.
-- media_assets.public_approved는 동의/기존 사진 허용 목록에서 계산되는 값이며 공개 승인 권한이 아닙니다.
-- 이 값이 true인 초안도 status='published' 전환은 총괄만 수행하고 공개 RLS 역시 두 조건을 함께 확인합니다.
-- 실제 서버 자동 발행은 별도 발행기의 승인자 재검사를 통과하고 익명 DB 작업과 같은 허위 사람 이름을 만들지 않습니다.
create function private.guard_member_publication() returns trigger
language plpgsql security definer set search_path='' as $$
declare staff text:=private.current_role(); before_row jsonb:=coalesce(to_jsonb(old),'{}'); after_row jsonb:=coalesce(to_jsonb(new),'{}');
begin
 if auth.uid() is not null and staff is distinct from 'owner' then
  if staff is distinct from 'staff' then raise exception 'business_staff_required' using errcode='42501'; end if;
  if before_row->>'status'='published' or after_row->>'status'='published'
    or coalesce((before_row->>'is_public')::boolean,false) or coalesce((after_row->>'is_public')::boolean,false)
  then raise exception 'owner_publication_required' using errcode='42501'; end if;
  -- 공개 시각은 승인 기록입니다. 총괄이 비공개로 돌린 원본의 시각은 보존하되 스태프가 새로 만들거나 고치지 않습니다.
  if tg_op<>'DELETE' and nullif(after_row->>'published_at','') is not null
    and before_row->'published_at' is distinct from after_row->'published_at'
  then raise exception 'owner_publication_required' using errcode='42501'; end if;
  -- 동의/사진 연결의 변경은 공개 프로필을 철회할 수 있으므로 공개 선수의 의존 값도 보호합니다.
  if tg_table_name='players' and exists(select 1 from public.public_player_profiles p where p.player_id=(before_row->>'id')::uuid and p.status='published')
    and (tg_op='DELETE' or before_row->'profile_consent' is distinct from after_row->'profile_consent'
      or before_row->'photo_consent' is distinct from after_row->'photo_consent'
      or before_row->'photo_asset_id' is distinct from after_row->'photo_asset_id')
  then raise exception 'owner_publication_required' using errcode='42501'; end if;
 end if;
 if tg_op='DELETE' then return old; end if; return new;
end $$;
revoke all on function private.guard_member_publication() from public,anon,authenticated,service_role;
do $$ declare tbl text; begin
 foreach tbl in array array['articles','public_player_profiles','fixtures','media_assets','media_albums','site_pages','training_sessions','club_events','players'] loop
  execute format('create trigger member_publication_guard before insert or update or delete on public.%I for each row execute function private.guard_member_publication()',tbl);
 end loop;
end $$;

-- 원본 관리 자료는 총괄/스태프만 읽습니다. 공개 홈페이지의 anon 열 허용 목록은 변경하지 않습니다.
do $$ declare tbl text; begin
 foreach tbl in array array['players','match_events','training_sessions','training_series','club_events'] loop
  execute format('alter policy football_manage on public.%I using ((select private.current_role()) in (''owner'',''staff'')) with check ((select private.current_role()) in (''owner'',''staff''))',tbl);
 end loop;
 foreach tbl in array array['articles','fixtures','media_assets','media_albums','site_pages'] loop
  execute format('alter policy staff_insert on public.%I with check ((select private.current_role()) in (''owner'',''staff''))',tbl);
  execute format('alter policy staff_update on public.%I using ((select private.current_role()) in (''owner'',''staff'')) with check ((select private.current_role()) in (''owner'',''staff''))',tbl);
  execute format('alter policy staff_delete on public.%I using ((select private.current_role()) in (''owner'',''staff''))',tbl);
 end loop;
end $$;
alter policy articles_read_authenticated on public.articles using ((select private.current_role()) in ('owner','staff'));
alter policy fixtures_read_authenticated on public.fixtures using ((select private.current_role()) in ('owner','staff'));
alter policy albums_read_authenticated on public.media_albums using ((select private.current_role()) in ('owner','staff'));
alter policy pages_read_authenticated on public.site_pages using ((select private.current_role()) in ('owner','staff'));
alter policy media_read_authenticated on public.media_assets using ((select private.current_role()) in ('owner','staff'));
alter policy profile_read_staff on public.public_player_profiles using ((select private.current_role()) in ('owner','staff'));
alter policy profile_insert_staff on public.public_player_profiles with check ((select private.current_role()) in ('owner','staff'));
alter policy profile_update_staff on public.public_player_profiles using ((select private.current_role()) in ('owner','staff')) with check ((select private.current_role()) in ('owner','staff'));
alter policy profile_delete_staff on public.public_player_profiles using ((select private.current_role()) in ('owner','staff'));
alter policy kansai_storage_staff_read on storage.objects using (bucket_id='kansai-media' and (select private.current_role()) in ('owner','staff'));
alter policy kansai_storage_upload on storage.objects with check (bucket_id='kansai-media' and (select private.current_role()) in ('owner','staff')
 and (storage.foldername(name))[1]=(select auth.uid())::text and name ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|jpeg|png|webp)$');
alter policy kansai_storage_delete_unused on storage.objects using (bucket_id='kansai-media' and (select private.current_role())='owner'
 and not exists(select 1 from public.media_assets where storage_path=name));

create or replace function private.assert_content_access(p_entity text) returns void
language plpgsql security invoker set search_path='' as $$
begin
 if auth.uid() is null or p_entity is null or p_entity not in ('articles','media_assets','media_albums','site_pages')
   or coalesce(private.current_role(),'') not in ('owner','staff')
 then raise exception 'content permission denied' using errcode='42501'; end if;
end $$;

-- 기존 업무의 동의·경합·트랜잭션 검사는 유지하고 세 등급의 권한 경계만 적용합니다.
CREATE OR REPLACE FUNCTION private.prepare_content()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
        if auth.uid() is not null and staff is distinct from 'owner' then raise exception 'profile approval requires owner'; end if;
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
end $function$
;

-- 기존 업무의 동의·경합·트랜잭션 검사는 유지하고 세 등급의 권한 경계만 적용합니다.
CREATE OR REPLACE FUNCTION private.withdraw_media()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare path text := coalesce(old.storage_path,old.legacy_path);
begin
  if auth.uid() is not null and coalesce(private.current_role(),'') not in ('owner','staff') then raise exception 'media editor required'; end if;
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
end $function$
;

-- 기존 업무의 동의·경합·트랜잭션 검사는 유지하고 세 등급의 권한 경계만 적용합니다.
CREATE OR REPLACE FUNCTION private.withdraw_album()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if auth.uid() is not null and coalesce(private.current_role(),'') not in ('owner','staff') then raise exception 'album editor required'; end if;
  if old.status = 'published' and new.status <> 'published' then
    update public.media_assets set status = 'draft' where album_id = new.id and status = 'published';
  end if;
  return new;
end $function$
;

-- 기존 업무의 동의·경합·트랜잭션 검사는 유지하고 세 등급의 권한 경계만 적용합니다.
CREATE OR REPLACE FUNCTION private.validate_player_photo()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
 if new.photo_asset_id is not null and (tg_op='INSERT' or new.photo_asset_id is distinct from old.photo_asset_id) then
  if not exists(select 1 from public.media_assets m where m.id=new.photo_asset_id and m.kind='photo' and m.media_category='player'
   and ((select private.current_role()) in ('owner','staff')
    or (m.status='published' and m.public_approved and m.published_at<=now()
      and (m.album_id is null or exists(select 1 from public.media_albums a where a.id=m.album_id and a.status='published')))))
  then raise exception 'player photo must be an approved player category photo'; end if;
 end if;
 return new;
end $function$
;

-- 기존 업무의 동의·경합·트랜잭션 검사는 유지하고 세 등급의 권한 경계만 적용합니다.
CREATE OR REPLACE FUNCTION private.save_office_content(p_entity text, p_id text, p_expected timestamp with time zone, p_values jsonb, p_publish_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare allowed text[]; payload jsonb; old_row jsonb; saved jsonb; columns_sql text; values_sql text; changes_sql text; key text;
begin
  perform private.assert_content_access(p_entity);
  if p_publish_at is not null and private.current_role() is distinct from 'owner' then raise exception 'owner_publication_required' using errcode='42501'; end if;
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
end $function$
;

-- 기존 업무의 동의·경합·트랜잭션 검사는 유지하고 세 등급의 권한 경계만 적용합니다.
CREATE OR REPLACE FUNCTION private.cancel_content_release(p_entity text, p_id text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.assert_content_access(p_entity);
  perform private.require_live_owner();
  perform pg_advisory_xact_lock(7142302);
  update private.content_releases set state='cancelled',last_error=null where entity=p_entity and record_id=p_id and state='queued';
end $function$
;

-- 기존 업무의 동의·경합·트랜잭션 검사는 유지하고 세 등급의 권한 경계만 적용합니다.
CREATE OR REPLACE FUNCTION private.publish_due_content()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare job private.content_releases; content jsonb; staff text; affected integer:=0; begin
 if not (select publisher_enabled from private.office_automation_settings where id=1) then return 0; end if;
 perform pg_advisory_xact_lock(7142302);
 for job in select * from private.content_releases where state='queued' and scheduled_at<=now() order by scheduled_at limit 100 for update skip locked loop
  begin
   staff:=private.staff_role_for(job.approved_by);
   -- staff_role_for는 세션과 독립적입니다. 예약 승인자의 플랫폼 정지는 별도로 재검사합니다.
   if staff is distinct from 'owner'
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
end $function$
;

-- 기존 업무의 동의·경합·트랜잭션 검사는 유지하고 세 등급의 권한 경계만 적용합니다.
CREATE OR REPLACE FUNCTION public.save_player_office(p_player_id uuid, p_expected_player timestamp with time zone, p_expected_profile timestamp with time zone, p_player jsonb, p_profile jsonb DEFAULT NULL::jsonb, p_photo_id uuid DEFAULT NULL::uuid, p_photo_changed boolean DEFAULT false, p_upload jsonb DEFAULT NULL::jsonb, p_expected_photo timestamp with time zone DEFAULT NULL::timestamp with time zone, p_status text DEFAULT 'draft'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  staff text := private.current_role();
  person public.players%rowtype;
  profile public.public_player_profiles%rowtype;
  image public.media_assets%rowtype;
  had_player boolean;
  had_profile boolean;
  chosen_id uuid;
  v_photo_path text;
begin
  if auth.uid() is null or staff is null or staff not in ('owner','staff') then
    raise exception 'player office permission required' using errcode = '42501';
  end if;
  if p_player_id is null or jsonb_typeof(p_player) is distinct from 'object'
    or (p_profile is not null and jsonb_typeof(p_profile) is distinct from 'object')
    or (p_upload is not null and jsonb_typeof(p_upload) is distinct from 'object')
    or p_status is null or p_status not in ('draft','pending','published') or p_photo_changed is null then
    raise exception 'invalid player form';
  end if;
  -- 전달 가능한 필드를 제한합니다. 역할·승인자·연락처·동의 메모는 이 RPC로 바꿀 수 없습니다.
  if exists(select 1 from jsonb_object_keys(p_player) k where k not in
      ('internal_name','activity_status','profile_consent','photo_consent'))
    or exists(select 1 from jsonb_object_keys(coalesce(p_profile,'{}')) k where k not in
      ('slug','display_name','romanized_name','jersey_number','position','bio','activity_status','display_order'))
    or exists(select 1 from jsonb_object_keys(coalesce(p_upload,'{}')) k where k not in
      ('id','storage_path','title','alt_text','captured_on')) then
    raise exception 'unsupported player form field';
  end if;
  if p_profile is null and p_status <> 'draft' then raise exception 'profile details are required'; end if;
  if p_status = 'published' and staff is distinct from 'owner' then
    raise exception 'profile approval requires owner' using errcode = '42501';
  end if;
  if p_upload is not null and (staff not in ('owner','staff') or not p_photo_changed or p_photo_id is not null) then
    raise exception 'player photo upload permission required' using errcode = '42501';
  end if;

  -- 먼저 최신 행을 잠급니다. 다른 창에서 바뀐 동의·프로필·사진을 이전 값으로 덮어쓰지 않습니다.
  select * into person from public.players where id = p_player_id for update;
  had_player := found;
  if (had_player and (p_expected_player is null or person.updated_at is distinct from p_expected_player))
    or (not had_player and p_expected_player is not null) then
    raise exception 'player form has changed; reopen the latest version' using errcode = '40001';
  end if;
  select * into profile from public.public_player_profiles where player_id = p_player_id for update;
  had_profile := found;
  if (had_profile and (p_expected_profile is null or profile.updated_at is distinct from p_expected_profile))
    or (not had_profile and p_expected_profile is not null) then
    raise exception 'player profile has changed; reopen the latest version' using errcode = '40001';
  end if;
  chosen_id := case when p_photo_changed then p_photo_id else person.photo_asset_id end;
  v_photo_path := case when had_profile then profile.photo_path else null end;

  if p_upload is not null then
    -- Storage 업로드는 호출자 자신의 폴더에 있어야 합니다. 버킷을 공개로 변경하지 않습니다.
    if p_upload->>'storage_path' is null or split_part(p_upload->>'storage_path','/',1) <> auth.uid()::text
      or not exists(select 1 from storage.objects where bucket_id = 'kansai-media' and name = p_upload->>'storage_path') then
      raise exception 'photo upload is required';
    end if;
    insert into public.media_assets(id,kind,media_category,title,storage_path,alt_text,captured_on,consent_confirmed,status)
      values((p_upload->>'id')::uuid,'photo','player',p_upload->>'title',p_upload->>'storage_path',
        coalesce(p_upload->>'alt_text',''),nullif(p_upload->>'captured_on','')::date,
        coalesce((p_player->>'photo_consent')::boolean,false),'draft') returning * into image;
    chosen_id := image.id;
  elsif chosen_id is not null then
    -- 세 등급 전환 후 스태프도 초안 사진을 관리합니다. 사진 선택과 교체 사이의 경합은 같은 행 잠금으로 막습니다.
    select * into image from public.media_assets where id = chosen_id for update;
    if not found then
      -- 예전 자료에서 사진이 없어진 연결도 임의의 새 사진으로 바꾸지 않습니다.
      if p_photo_changed or p_status = 'published' then raise exception 'player photo is unavailable'; end if;
    elsif image.kind <> 'photo' or image.media_category <> 'player' then
      if p_photo_changed or not had_profile then raise exception 'player category photo required'; end if;
    end if;
  end if;
  if p_photo_changed and p_upload is null and image.id is not null and image.updated_at is distinct from p_expected_photo then
    raise exception 'player photo has changed; reopen the latest version' using errcode = '40001';
  end if;
  if p_photo_changed or not had_profile then v_photo_path := coalesce(image.storage_path,image.legacy_path); end if;
  if p_photo_changed and chosen_id is null then v_photo_path := null; end if;

  -- 공개 버튼을 누른 경우에만 새 사진 또는 선택한 초안 사진을 함께 승인합니다.
  if p_status = 'published' then
    if not coalesce((p_player->>'profile_consent')::boolean,false) then raise exception 'profile consent is required'; end if;
    if v_photo_path is not null and not coalesce((p_player->>'photo_consent')::boolean,false) then raise exception 'photo consent is required'; end if;
    if v_photo_path is not null then
      if image.id is null or coalesce(image.storage_path,image.legacy_path) is distinct from v_photo_path then
        select * into image from public.media_assets where kind = 'photo' and coalesce(storage_path,legacy_path) = v_photo_path for update;
      end if;
      if image.id is null then raise exception 'player photo is unavailable'; end if;
      if p_upload is null and image.updated_at is distinct from p_expected_photo then
        raise exception 'player photo has changed; reopen the latest version' using errcode = '40001';
      end if;
      if image.status <> 'published' or not image.public_approved then
        if image.media_category <> 'player' then raise exception 'player category photo required'; end if;
        if length(trim(image.alt_text)) = 0 then raise exception 'photo description is required'; end if;
        update public.media_assets set status = 'published',consent_confirmed = true where id = image.id returning * into image;
      end if;
      if image.published_at > now() or (image.album_id is not null and not exists(
        select 1 from public.media_albums where id = image.album_id and status = 'published')) then
        raise exception 'album must be approved';
      end if;
    end if;
  end if;

  if had_player then
    update public.players set internal_name = p_player->>'internal_name',
      activity_status = coalesce(p_player->>'activity_status','active'),
      profile_consent = coalesce((p_player->>'profile_consent')::boolean,false),
      photo_consent = coalesce((p_player->>'photo_consent')::boolean,false),
      photo_asset_id = chosen_id where id = p_player_id returning * into person;
  else
    insert into public.players(id,internal_name,activity_status,profile_consent,photo_consent,photo_asset_id)
      values(p_player_id,p_player->>'internal_name',coalesce(p_player->>'activity_status','active'),
        coalesce((p_player->>'profile_consent')::boolean,false),coalesce((p_player->>'photo_consent')::boolean,false),chosen_id)
      returning * into person;
  end if;
  if p_profile is not null then
    if had_profile then
      update public.public_player_profiles set slug = p_profile->>'slug',display_name = p_profile->>'display_name',
        romanized_name = coalesce(p_profile->>'romanized_name',''),jersey_number = (p_profile->>'jersey_number')::integer,
        position = p_profile->>'position',photo_path = v_photo_path,bio = coalesce(p_profile->>'bio',''),
        activity_status = coalesce(p_profile->>'activity_status','active'),display_order = coalesce((p_profile->>'display_order')::integer,0),
        status = p_status where player_id = p_player_id returning * into profile;
    else
      insert into public.public_player_profiles(player_id,slug,display_name,romanized_name,jersey_number,position,photo_path,bio,activity_status,display_order,status)
        values(p_player_id,p_profile->>'slug',p_profile->>'display_name',coalesce(p_profile->>'romanized_name',''),
          (p_profile->>'jersey_number')::integer,p_profile->>'position',v_photo_path,coalesce(p_profile->>'bio',''),
          coalesce(p_profile->>'activity_status','active'),coalesce((p_profile->>'display_order')::integer,0),p_status)
        returning * into profile;
    end if;
  end if;
  -- 동의 철회 트리거가 프로필 상태를 바꾼 경우도 실제 저장 결과를 반환합니다.
  select * into profile from public.public_player_profiles where player_id = p_player_id;
  -- 내부 메모 등은 반환하지 않고, 저장 확인과 동시 편집 검사에 필요한 식별자만 반환합니다.
  return jsonb_build_object('player_id',person.id,'player_updated_at',person.updated_at,
    'profile_status',profile.status,'profile_updated_at',profile.updated_at,'photo_asset_id',person.photo_asset_id);
end $function$
;

-- 기존 업무의 동의·경합·트랜잭션 검사는 유지하고 세 등급의 권한 경계만 적용합니다.
CREATE OR REPLACE FUNCTION public.create_training_series(p_template jsonb, p_interval_weeks integer, p_occurrences integer)
 RETURNS SETOF training_sessions
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare series uuid; n integer; first_start timestamptz; first_end timestamptz;
begin
  if auth.uid() is null or coalesce(private.current_role(),'') not in ('owner','staff') then raise exception 'football staff required'; end if;
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
end $function$
;

-- 기존 업무의 동의·경합·트랜잭션 검사는 유지하고 세 등급의 권한 경계만 적용합니다.
CREATE OR REPLACE FUNCTION public.update_training_occurrences(p_id uuid, p_expected timestamp with time zone, p_patch jsonb, p_scope text)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare anchor public.training_sessions; item public.training_sessions; delta interval; duration interval; affected integer:=0;
begin
  if auth.uid() is null or coalesce(private.current_role(),'') not in ('owner','staff') then raise exception 'football staff required'; end if;
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
end $function$
;

-- 모든 스태프가 같은 초안 업무를 맡으므로 공개 예약의 오류 건수도 같은 업무 범위를 따릅니다.
-- 조회는 승인 권한이 아닙니다. 예약 생성/취소와 실제 발행기는 위에서 총괄만 허용합니다.
create or replace function private.office_release_attention() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare items jsonb; begin
 perform private.assert_content_access('articles');
 select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) into items from (
  select entity,count(*)::int as total from private.content_releases
  where state='failed' or (state='queued' and scheduled_at<now()-interval '10 minutes') group by entity
 ) t;
 return items;
end $$;

-- 감사 원문도 업무 권한을 따릅니다. 선수는 운영/다른 사람의 변경 기록을 읽지 못합니다.
create or replace function private.can_read_audit(p_entity text) returns boolean
language plpgsql stable security definer set search_path='' as $$
declare staff text:=private.current_role(); begin
 if p_entity in ('admin_roles','staff_accounts','staff_name_requests') then
  if staff is distinct from 'owner' then return false; end if;
  begin perform private.require_live_owner(); return true; exception when insufficient_privilege then return false; end;
 end if;
 return coalesce(staff in ('owner','staff') and p_entity in ('players','public_player_profiles','articles','fixtures','training_sessions','training_series','match_events','media_assets','media_albums','site_pages','club_events'),false);
end $$;
create or replace function private.office_capabilities() returns jsonb
language sql stable security definer set search_path='' as $$
 select case when private.current_role() is not null then jsonb_build_object(
  'schedule',private.current_role() in ('owner','staff'),'content',private.current_role() in ('owner','staff'),
  'players',private.current_role() in ('owner','staff'),'media',private.current_role() in ('owner','staff'),
  'staff_identity',true,'directory',private.current_role() in ('owner','staff'),'audit',private.current_role() in ('owner','staff'),
  'publish',private.current_role()='owner','manage_members',private.current_role()='owner','player_portal',private.current_role()='player',
  'publisher',private.current_role()='owner' and (select publisher_enabled from private.office_automation_settings where id=1)) else '{}'::jsonb end
$$;
-- CREATE OR REPLACE는 기존 ACL을 보존합니다. 새 helper는 제한하고 새 공개 definer는 만들지 않습니다.
revoke all on function private.staff_role_for(uuid) from public,anon,authenticated;
revoke all on function private.assert_content_access(text) from public,anon,authenticated;
notify pgrst,'reload schema';
