-- [편집 안내] 한 선수 양식의 등록 정보·공개 프로필·사진 기록을 한 트랜잭션으로 저장합니다.
-- 기존 테이블, UUID, 동의 트리거, RLS는 그대로 사용합니다. 실패하면 모든 행 변경이 취소됩니다.
-- invoker 함수이므로 호출자에게 없는 사진 등록·프로필 발행 권한을 얻을 수 없습니다.
create function public.save_player_office(
  p_player_id uuid,
  p_expected_player timestamptz,
  p_expected_profile timestamptz,
  p_player jsonb,
  p_profile jsonb default null,
  p_photo_id uuid default null,
  p_photo_changed boolean default false,
  p_upload jsonb default null,
  p_expected_photo timestamptz default null,
  p_status text default 'draft'
) returns jsonb language plpgsql security invoker set search_path = '' as $$
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
  if auth.uid() is null or staff is null or staff not in ('owner','administrator','coach') then
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
  if p_status = 'published' and staff not in ('owner','administrator') then
    raise exception 'profile approval requires owner or administrator' using errcode = '42501';
  end if;
  if p_upload is not null and (staff not in ('owner','administrator') or not p_photo_changed or p_photo_id is not null) then
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
    if staff = 'coach' then
      -- 코치는 공개 사진을 선택할 수 있지만 미디어를 수정하거나 잠글 권한은 없습니다.
      select * into image from public.media_assets where id = chosen_id;
    else
      select * into image from public.media_assets where id = chosen_id for update;
    end if;
    if not found then
      -- 코치는 관리자가 연결한 비공개 사진을 읽을 수 없습니다. 사진을 변경하지 않으면 연결을 보존합니다.
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
end $$;
revoke all on function public.save_player_office(uuid,timestamptz,timestamptz,jsonb,jsonb,uuid,boolean,jsonb,timestamptz,text) from public,anon;
grant execute on function public.save_player_office(uuid,timestamptz,timestamptz,jsonb,jsonb,uuid,boolean,jsonb,timestamptz,text) to authenticated;
notify pgrst, 'reload schema';
