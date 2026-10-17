-- [편집 안내] 채팅 원문은 private에만 보관합니다. 공개 Realtime 표에는 방/갱신 시각만
-- 보내며 수신자는 매번 현재 승인·역할·Auth 세션을 확인하는 RPC로 원문을 다시 읽습니다.
-- 선수 방: 선수와 총괄 / 운영 방: 스태프와 총괄. 기존 계정·선수·출석 행은 삭제하지 않습니다.
create table private.office_chat_messages (
  id bigint generated always as identity primary key,
  room text not null check (room in ('players','office')),
  sender_id uuid not null references auth.users(id) on delete restrict,
  sender_name text,
  sender_role text not null check (sender_role in ('owner','staff','player')),
  body text not null check (length(body)<=2000),
  nonce uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  removed_at timestamptz,
  removed_by uuid references auth.users(id) on delete restrict,
  unique(sender_id,nonce),
  check ((removed_at is null and removed_by is null and length(btrim(body))>0)
    or (removed_at is not null and removed_by is not null and body=''))
);
create index office_chat_room_page_idx on private.office_chat_messages(room,id desc);
create index office_chat_sender_rate_idx on private.office_chat_messages(sender_id,created_at desc);
create index office_chat_removed_by_idx on private.office_chat_messages(removed_by) where removed_by is not null;
alter table private.office_chat_messages enable row level security;
revoke all on private.office_chat_messages from public,anon,authenticated,service_role;
revoke all on sequence private.office_chat_messages_id_seq from public,anon,authenticated,service_role;
create policy office_chat_deny_clients on private.office_chat_messages
  for all to anon,authenticated using(false) with check(false);

create function private.can_use_club_chat_room(p_room text) returns boolean
language sql stable security definer set search_path='' as $$
  select coalesce(case p_room when 'players' then private.current_role() in ('owner','player')
    when 'office' then private.current_role() in ('owner','staff') else false end,false)
$$;
revoke all on function private.can_use_club_chat_room(text) from public,anon,service_role;
grant execute on function private.can_use_club_chat_room(text) to authenticated;

-- INSERT 알림만 발행합니다. DELETE 이벤트는 RLS 검사가 제한되므로 앱에서 발행하지 않습니다.
-- 이 표에는 메시지 ID/작성자/이름/본문/출석 등 개인정보를 절대 추가하지 않습니다.
create table public.office_chat_events (
  id bigint generated always as identity primary key,
  room text not null check (room in ('players','office')),
  created_at timestamptz not null default clock_timestamp()
);
create index office_chat_events_room_idx on public.office_chat_events(room,id desc);
alter table public.office_chat_events enable row level security;
revoke all on public.office_chat_events from public,anon,authenticated,service_role;
revoke all on sequence public.office_chat_events_id_seq from public,anon,authenticated,service_role;
grant select on public.office_chat_events to authenticated;
create policy office_chat_events_read on public.office_chat_events for select to authenticated
  using ((select private.can_use_club_chat_room(room)));
-- 실제 Supabase에서는 기존 publication에 추가합니다. PGlite와 같이 Realtime이 없는
-- 독립 검사 DB에는 publication을 가짜로 만들거나 기존 설정을 교체하지 않습니다.
do $$ begin
  if exists(select 1 from pg_publication where pubname='supabase_realtime')
    and not exists(select 1 from pg_publication_tables where pubname='supabase_realtime'
      and schemaname='public' and tablename='office_chat_events') then
    alter publication supabase_realtime add table public.office_chat_events;
  end if;
end $$;

create function private.club_chat_message_json(p_message private.office_chat_messages) returns jsonb
language sql immutable security invoker set search_path='' as $$
  select jsonb_build_object('id',p_message.id::text,'sender_id',p_message.sender_id,
    'sender_name',p_message.sender_name,'sender_role',p_message.sender_role,
    'body',case when p_message.removed_at is null then p_message.body else '' end,
    'is_removed',p_message.removed_at is not null,'created_at',p_message.created_at)
$$;
revoke all on function private.club_chat_message_json(private.office_chat_messages) from public,anon,authenticated,service_role;

create function private.require_club_member() returns text
language plpgsql stable security definer set search_path='' as $$
declare grade text:=private.current_role(); begin
  if auth.uid() is null or grade is null or grade not in ('owner','staff','player') then
    raise exception 'approved_club_member_required' using errcode='42501';
  end if;
  return grade;
end $$;
revoke all on function private.require_club_member() from public,anon,authenticated,service_role;

create function private.office_chat_rooms() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare grade text:=private.require_club_member(); begin
  return jsonb_build_object('user_id',auth.uid(),'role',grade,'server_time',statement_timestamp(),
    'rooms',case grade when 'owner' then '[{"id":"players"},{"id":"office"}]'::jsonb
      when 'staff' then '[{"id":"office"}]'::jsonb else '[{"id":"players"}]'::jsonb end);
end $$;
create function private.office_chat_messages(p_room text,p_before bigint default null) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare messages jsonb; more boolean; oldest bigint; begin
  perform private.require_club_member();
  if not private.can_use_club_chat_room(p_room) then raise exception 'chat_room_forbidden' using errcode='42501'; end if;
  if p_before is not null and p_before<=0 then raise exception 'invalid_chat_cursor' using errcode='22023'; end if;
  select coalesce(jsonb_agg(private.club_chat_message_json(q::private.office_chat_messages) order by q.id),'[]'),min(q.id)
    into messages,oldest from (select m.* from private.office_chat_messages m
      where m.room=p_room and (p_before is null or m.id<p_before) order by m.id desc limit 50) q;
  select exists(select 1 from private.office_chat_messages where room=p_room and id<oldest) into more;
  return jsonb_build_object('user_id',auth.uid(),'room',p_room,'messages',messages,'has_more',more);
end $$;
create function private.office_chat_send(p_room text,p_body text,p_nonce uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare grade text:=private.require_club_member(); actor uuid:=auth.uid(); message private.office_chat_messages;
  clean_body text:=btrim(p_body); verified_name text; begin
  if not private.can_use_club_chat_room(p_room) then raise exception 'chat_room_forbidden' using errcode='42501'; end if;
  if p_nonce is null or clean_body is null or length(clean_body) not between 1 and 2000
    or regexp_replace(clean_body,E'[\n\r\t]','','g') ~ '[[:cntrl:]]' then
    raise exception 'invalid_chat_message' using errcode='22023';
  end if;
  -- 한 작성자의 동시 요청도 같은 잠금을 사용합니다. 재전송 nonce는 저장/알림을 중복 생성하지 않습니다.
  perform pg_advisory_xact_lock(hashtextextended('club-chat-send:'||actor::text,7142310));
  select * into message from private.office_chat_messages where sender_id=actor and nonce=p_nonce;
  if found then
    if message.room<>p_room or (message.removed_at is null and message.body<>clean_body) then
      raise exception 'chat_nonce_conflict' using errcode='22023';
    end if;
    return jsonb_build_object('user_id',actor,'room',p_room,'message',private.club_chat_message_json(message));
  end if;
  if (select count(*) from private.office_chat_messages where sender_id=actor
      and created_at>clock_timestamp()-interval '1 minute')>=20 then
    raise exception 'chat_rate_limited' using errcode='P0001';
  end if;
  select real_name into verified_name from private.staff_accounts
    where user_id=actor and name_verified_at is not null;
  insert into private.office_chat_messages(room,sender_id,sender_name,sender_role,body,nonce)
    values(p_room,actor,verified_name,grade,clean_body,p_nonce) returning * into message;
  insert into public.office_chat_events(room) values(p_room);
  return jsonb_build_object('user_id',actor,'room',p_room,'message',private.club_chat_message_json(message));
end $$;
create function private.office_chat_remove(p_message_id bigint,p_reason text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare message private.office_chat_messages; begin
  perform private.require_live_owner();
  if p_message_id is null or nullif(btrim(p_reason),'') is null or length(p_reason)>500 or p_reason ~ '[[:cntrl:]]' then
    raise exception 'chat_removal_reason_required' using errcode='22023';
  end if;
  select * into message from private.office_chat_messages where id=p_message_id for update;
  if not found then raise exception 'chat_message_unavailable' using errcode='22023'; end if;
  if message.removed_at is null then
    update private.office_chat_messages set body='',removed_at=clock_timestamp(),removed_by=auth.uid()
      where id=message.id returning * into message;
    -- 원문과 이름은 감사 값에 복제하지 않습니다. 실제 수정과 감사·알림은 한 트랜잭션입니다.
    perform private.write_staff_audit('office_chat_messages',message.id::text,'chat_message_removed',array['body'],
      '{}','{}',btrim(p_reason));
    insert into public.office_chat_events(room) values(message.room);
  end if;
  return jsonb_build_object('user_id',auth.uid(),'room',message.room,'message',private.club_chat_message_json(message));
end $$;

-- [편집 안내] 원래의 (training_id,player_id) 기본 키와 출석 상태를 그대로 보존합니다.
-- 이전 기록은 확인할 수 없는 작성자/시각을 새 사람 이름으로 소급 채우지 않고 NULL로 둡니다.
alter table private.attendance add column recorded_by uuid references auth.users(id) on delete restrict,
  add column recorded_at timestamptz,add column self_checked_at timestamptz;
create index attendance_recorded_by_idx on private.attendance(recorded_by) where recorded_by is not null;
revoke all on private.attendance from public,anon,authenticated,service_role;

create function private.club_today() returns date
language sql stable security invoker set search_path='' as $$
  select (statement_timestamp() at time zone 'Asia/Tokyo')::date
$$;
revoke all on function private.club_today() from public,anon,authenticated,service_role;
create function private.club_attendance_json(p_attendance private.attendance) returns jsonb
language sql stable security invoker set search_path='' as $$
  select jsonb_build_object('user_id',auth.uid(),'training_id',p_attendance.training_id,
    'player_id',p_attendance.player_id,'status',p_attendance.attendance_status,
    'recorded_at',p_attendance.recorded_at,'self_checked_at',p_attendance.self_checked_at)
$$;
revoke all on function private.club_attendance_json(private.attendance) from public,anon,authenticated,service_role;

create function private.office_training_attendance_today() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare grade text:=private.require_club_member(); day date:=private.club_today(); player uuid; active_link boolean; items jsonb; begin
  select a.player_id into player from private.staff_accounts a where a.user_id=auth.uid();
  active_link:=player is not null and exists(select 1 from public.players p where p.id=player and p.activity_status='active');
  select coalesce(jsonb_agg(jsonb_build_object('id',t.id,'title',t.title,'starts_at',t.starts_at,
    'ends_at',t.ends_at,'venue',t.venue,'session_status',t.session_status,
    'can_check_in',grade='player' and active_link and t.session_status='scheduled',
    'attendance',(select coalesce(jsonb_agg(jsonb_build_object('player_id',p.id,'player_name',p.internal_name,
      'status',a.attendance_status,'recorded_at',a.recorded_at,'self_checked_at',a.self_checked_at)
      order by p.internal_name,p.id),'[]') from public.players p left join private.attendance a on a.player_id=p.id and a.training_id=t.id
      where p.activity_status='active' and (grade in ('owner','staff') or p.id=player)))
    order by t.starts_at,t.id),'[]') into items from public.training_sessions t
    where t.starts_at >= (day::timestamp at time zone 'Asia/Tokyo')
      and t.starts_at < ((day+1)::timestamp at time zone 'Asia/Tokyo');
  return jsonb_build_object('user_id',auth.uid(),'role',grade,'today',day,'player_id',player,
    'linked',active_link,'trainings',items);
end $$;
create function private.office_training_check_in(p_training_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare grade text:=private.require_club_member(); player uuid; session public.training_sessions; attendance private.attendance;
begin
  if grade<>'player' then raise exception 'player_self_check_in_required' using errcode='42501'; end if;
  select a.player_id into player from private.staff_accounts a join public.players p on p.id=a.player_id
    where a.user_id=auth.uid() and p.activity_status='active' for share of a,p;
  if player is null then raise exception 'active_player_link_required' using errcode='42501'; end if;
  select * into session from public.training_sessions where id=p_training_id for share;
  if not found or (session.starts_at at time zone 'Asia/Tokyo')::date<>private.club_today()
    or session.session_status<>'scheduled' then raise exception 'today_training_unavailable' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('club-attendance:'||p_training_id::text||':'||player::text,7142311));
  select * into attendance from private.attendance where training_id=p_training_id and player_id=player for update;
  if found and attendance.attendance_status in ('absent','excused') then
    raise exception 'attendance_managed_by_staff' using errcode='42501';
  end if;
  if not found then
    insert into private.attendance(training_id,player_id,attendance_status,recorded_by,recorded_at,self_checked_at)
      values(p_training_id,player,'present',auth.uid(),clock_timestamp(),clock_timestamp()) returning * into attendance;
    perform private.write_staff_audit('attendance',p_training_id::text||':'||player::text,'training_self_checked_in',array['status'],
      '{}',jsonb_build_object('status',attendance.attendance_status));
  elsif attendance.self_checked_at is null then
    update private.attendance set self_checked_at=clock_timestamp() where training_id=p_training_id and player_id=player returning * into attendance;
    perform private.write_staff_audit('attendance',p_training_id::text||':'||player::text,'training_self_checked_in',array['self_checked_at'],
      '{}','{}');
  end if;
  return private.club_attendance_json(attendance);
end $$;
create function private.office_training_set_attendance(p_training_id uuid,p_player_id uuid,p_status text,p_reason text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare grade text:=private.require_club_member(); session public.training_sessions; before_row private.attendance; saved private.attendance;
begin
  if grade not in ('owner','staff') then raise exception 'training_staff_required' using errcode='42501'; end if;
  if p_status is null or p_status not in ('present','late','absent','excused')
    or nullif(btrim(p_reason),'') is null or length(p_reason)>500 or p_reason ~ '[[:cntrl:]]' then
    raise exception 'invalid_attendance_update' using errcode='22023';
  end if;
  perform 1 from public.players where id=p_player_id and activity_status='active' for share;
  if not found then raise exception 'active_player_required' using errcode='22023'; end if;
  select * into session from public.training_sessions where id=p_training_id for share;
  if not found or (session.starts_at at time zone 'Asia/Tokyo')::date<>private.club_today()
    or session.session_status='cancelled' then raise exception 'today_training_unavailable' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('club-attendance:'||p_training_id::text||':'||p_player_id::text,7142311));
  select * into before_row from private.attendance where training_id=p_training_id and player_id=p_player_id for update;
  if found and before_row.attendance_status=p_status then return private.club_attendance_json(before_row); end if;
  insert into private.attendance(training_id,player_id,attendance_status,recorded_by,recorded_at)
    values(p_training_id,p_player_id,p_status,auth.uid(),clock_timestamp())
    on conflict(training_id,player_id) do update set attendance_status=excluded.attendance_status,
      recorded_by=excluded.recorded_by,recorded_at=excluded.recorded_at returning * into saved;
  perform private.write_staff_audit('attendance',p_training_id::text||':'||p_player_id::text,'training_attendance_changed',array['status'],
    jsonb_build_object('status',before_row.attendance_status),jsonb_build_object('status',saved.attendance_status),btrim(p_reason));
  return private.club_attendance_json(saved);
end $$;

-- 새 이력도 원래 업무 범위를 따릅니다. 채팅 삭제 이력은 총괄만, 출석은 운영진만 읽습니다.
create or replace function private.can_read_audit(p_entity text) returns boolean
language plpgsql stable security definer set search_path='' as $$
declare staff text:=private.current_role(); begin
  if p_entity in ('admin_roles','staff_accounts','staff_name_requests','office_chat_messages') then
    if staff is distinct from 'owner' then return false; end if;
    begin perform private.require_live_owner(); return true; exception when insufficient_privilege then return false; end;
  end if;
  return coalesce(staff in ('owner','staff') and p_entity in ('attendance','players','public_player_profiles','articles','fixtures',
    'training_sessions','training_series','match_events','media_assets','media_albums','site_pages','club_events'),false);
end $$;

-- 탐색 메뉴는 실제 배포된 DB capability가 확인된 후에만 새 기능을 엽니다.
-- 이전 flag의 의미와 세 등급 권한은 바꾸지 않습니다.
create or replace function private.office_capabilities() returns jsonb
language sql stable security definer set search_path='' as $$
  select case when private.current_role() is not null then jsonb_build_object(
    'schedule',private.current_role() in ('owner','staff'),'content',private.current_role() in ('owner','staff'),
    'players',private.current_role() in ('owner','staff'),'media',private.current_role() in ('owner','staff'),
    'staff_identity',true,'directory',private.current_role() in ('owner','staff'),'audit',private.current_role() in ('owner','staff'),
    'publish',private.current_role()='owner','manage_members',private.current_role()='owner','player_portal',private.current_role()='player',
    'club_chat',true,'training_attendance',true,
    'publisher',private.current_role()='owner' and (select publisher_enabled from private.office_automation_settings where id=1)) else '{}'::jsonb end
$$;

-- 공개 RPC는 INVOKER이며 실제 private 조회가 필요한 내부 함수만 DEFINER입니다.
create function public.office_chat_rooms() returns jsonb language sql stable security invoker set search_path='' as $$select private.office_chat_rooms()$$;
create function public.office_chat_messages(p_room text,p_before bigint default null) returns jsonb language sql stable security invoker set search_path='' as $$select private.office_chat_messages(p_room,p_before)$$;
create function public.office_chat_send(p_room text,p_body text,p_nonce uuid) returns jsonb language sql security invoker set search_path='' as $$select private.office_chat_send(p_room,p_body,p_nonce)$$;
create function public.office_chat_remove(p_message_id bigint,p_reason text) returns jsonb language sql security invoker set search_path='' as $$select private.office_chat_remove(p_message_id,p_reason)$$;
create function public.office_training_attendance_today() returns jsonb language sql stable security invoker set search_path='' as $$select private.office_training_attendance_today()$$;
create function public.office_training_check_in(p_training_id uuid) returns jsonb language sql security invoker set search_path='' as $$select private.office_training_check_in(p_training_id)$$;
create function public.office_training_set_attendance(p_training_id uuid,p_player_id uuid,p_status text,p_reason text) returns jsonb language sql security invoker set search_path='' as $$select private.office_training_set_attendance(p_training_id,p_player_id,p_status,p_reason)$$;
revoke all on function private.office_chat_rooms(),private.office_chat_messages(text,bigint),private.office_chat_send(text,text,uuid),
  private.office_chat_remove(bigint,text),private.office_training_attendance_today(),private.office_training_check_in(uuid),
  private.office_training_set_attendance(uuid,uuid,text,text),public.office_chat_rooms(),public.office_chat_messages(text,bigint),
  public.office_chat_send(text,text,uuid),public.office_chat_remove(bigint,text),public.office_training_attendance_today(),
  public.office_training_check_in(uuid),public.office_training_set_attendance(uuid,uuid,text,text) from public,anon,service_role;
grant execute on function private.office_chat_rooms(),private.office_chat_messages(text,bigint),private.office_chat_send(text,text,uuid),
  private.office_chat_remove(bigint,text),private.office_training_attendance_today(),private.office_training_check_in(uuid),
  private.office_training_set_attendance(uuid,uuid,text,text),public.office_chat_rooms(),public.office_chat_messages(text,bigint),
  public.office_chat_send(text,text,uuid),public.office_chat_remove(bigint,text),public.office_training_attendance_today(),
  public.office_training_check_in(uuid),public.office_training_set_attendance(uuid,uuid,text,text) to authenticated;
notify pgrst,'reload schema';
