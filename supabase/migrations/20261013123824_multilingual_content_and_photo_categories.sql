-- [편집 안내] 기존 일본어 본문, ID, 공개 상태, 동의와 RLS를 유지하는 추가 변경입니다.
-- 번역은 게시글과 같은 행에 저장하여 승인/예약/복구 시 같은 버전으로 처리합니다.
alter table public.articles add column translations jsonb not null default '{}';
alter table public.site_pages add column translations jsonb not null default '{}';
alter table public.media_assets add column media_category text not null default 'general'
  check (media_category in ('general','player','match','training'));
alter table public.players add column photo_asset_id uuid references public.media_assets(id) on delete restrict;
create index players_photo_asset_idx on public.players(photo_asset_id) where photo_asset_id is not null;
grant select(translations) on public.articles to anon;
grant select(media_category) on public.media_assets to anon;

create function private.validate_content_translations() returns trigger
language plpgsql security invoker set search_path='' as $$
declare lang text; values jsonb; field text; value jsonb; required text[];
begin
  required:=case when tg_table_name='articles' then array['title','summary','body','cover_alt'] else array['title','introduction','body'] end;
  if jsonb_typeof(new.translations)<>'object' then raise exception 'invalid translation object'; end if;
  for lang,values in select * from jsonb_each(new.translations) loop
    if lang not in ('ko','en') or jsonb_typeof(values)<>'object' then raise exception 'invalid translation language'; end if;
    for field,value in select * from jsonb_each(values) loop
      if not(field=any(required)) or jsonb_typeof(value)<>'string' then raise exception 'invalid translation field'; end if;
      if length(value#>>'{}') > (case when field='title' then 200 when field='body' then 100000 else 10000 end)
        then raise exception 'invalid translation length'; end if;
    end loop;
    -- 빈 언어는 원문으로 표시합니다. 작성 중인 번역은 초안에서 허용하지만 공개하지 않습니다.
    if new.status='published' and values<>'{}'::jsonb then
      foreach field in array required loop
        if coalesce(length(trim(values->>field)),0)=0 then raise exception 'incomplete translation: %',lang; end if;
      end loop;
    end if;
  end loop;
  return new;
end $$;
revoke all on function private.validate_content_translations() from public,anon,authenticated;
create trigger validate_translations before insert or update on public.articles for each row execute function private.validate_content_translations();
create trigger validate_translations before insert or update on public.site_pages for each row execute function private.validate_content_translations();

-- 선수 등록은 내부 데이터입니다. 선택 후보만 검증하며 공개 프로필을 생성/승인하지 않습니다.
create function private.validate_player_photo() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  if new.photo_asset_id is not null and (tg_op='INSERT' or new.photo_asset_id is distinct from old.photo_asset_id) then
    if not exists(select 1 from public.media_assets m where m.id=new.photo_asset_id and m.kind='photo' and m.media_category='player'
      and m.status='published' and m.public_approved and m.published_at<=now()
      and (m.album_id is null or exists(select 1 from public.media_albums a where a.id=m.album_id and a.status='published')))
    then raise exception 'player photo must be an approved player category photo'; end if;
  end if;
  return new;
end $$;
revoke all on function private.validate_player_photo() from public,anon,authenticated;
create trigger validate_player_photo before insert or update on public.players for each row execute function private.validate_player_photo();

create or replace function private.content_fields(p_entity text) returns text[] language sql immutable security invoker set search_path='' as $$
select case p_entity
 when 'articles' then array['slug','title','summary','category','body','cover_path','cover_alt','gallery_paths','source_url','activity_date','featured','status','published_at','translations']
 when 'media_assets' then array['kind','title','storage_path','legacy_path','video_url','alt_text','description','source_url','captured_on','album_id','consent_confirmed','status','published_at','media_category']
 when 'media_albums' then array['title','description','captured_on','status','published_at']
 when 'site_pages' then array['title','introduction','body','status','published_at','translations']
 else '{}'::text[] end;
$$;

-- 새 열이 없던 과거 버전의 복구도 정확히 처리합니다. 동의 철회, URL 보존과 초안 복구 규칙은 유지합니다.
create or replace function private.restore_content_revision(p_revision uuid,p_expected timestamptz) returns jsonb language plpgsql security definer set search_path='' as $$
declare revision private.content_revisions; current_row jsonb; payload jsonb;
begin
  select * into revision from private.content_revisions where id=p_revision and captured_at>=now()-interval '90 days';
  perform private.assert_content_access(revision.entity);
  perform pg_advisory_xact_lock(7142302);
  execute format('select to_jsonb(t) from public.%I t where id::text=$1 for update',revision.entity) into current_row using revision.record_id;
  if current_row is null or (current_row->>'updated_at')::timestamptz is distinct from p_expected then raise exception 'content changed; reload before restoring'; end if;
  select jsonb_object_agg(key,value) into payload from jsonb_each(revision.snapshot) where key=any(private.content_fields(revision.entity));
  payload := payload || jsonb_build_object('status','draft','published_at',current_row->'published_at');
  if revision.entity in ('articles','site_pages') then payload:=payload || jsonb_build_object('translations',coalesce(payload->'translations','{}'::jsonb)); end if;
  if revision.entity='articles' then payload:=payload || jsonb_build_object('slug',current_row->'slug'); end if;
  if revision.entity='media_assets' then
    payload:=payload || jsonb_build_object('media_category',coalesce(payload->'media_category','"general"'::jsonb),
      'consent_confirmed',coalesce((current_row->>'consent_confirmed')::boolean,false) and coalesce((payload->>'consent_confirmed')::boolean,false));
  end if;
  return private.save_office_content(revision.entity,revision.record_id,p_expected,payload,null);
end $$;

-- 기존 공식 홈페이지의 네 훈련 사진만 이미 확인된 분류로 옮깁니다. 사진/동의/게시 상태는 변경하지 않습니다.
update public.media_assets set media_category='training' where media_category='general' and legacy_path in
 ('assets/training-october-01.jpg','assets/training-october-02.jpg','assets/training-september-01.jpg','assets/training-september-02.jpg');
