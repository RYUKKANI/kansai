-- [편집 안내] 통합 선수 화면에서 등록한 초안 사진을 내부 선수와 연결할 수 있게 합니다.
-- 공개 프로필의 사진 동의/공개 승인, 공개 미디어 RLS와 Storage 규칙은 바꾸지 않습니다.
create or replace function private.validate_player_photo() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 if new.photo_asset_id is not null and (tg_op='INSERT' or new.photo_asset_id is distinct from old.photo_asset_id) then
  if not exists(select 1 from public.media_assets m where m.id=new.photo_asset_id and m.kind='photo' and m.media_category='player'
   and ((select private.current_role()) in ('owner','administrator')
    or (m.status='published' and m.public_approved and m.published_at<=now()
      and (m.album_id is null or exists(select 1 from public.media_albums a where a.id=m.album_id and a.status='published')))))
  then raise exception 'player photo must be an approved player category photo'; end if;
 end if;
 return new;
end $$;
