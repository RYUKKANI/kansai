-- [편집 안내] Auth가 생성을 확실히 거절한 경우에만 서버가 빈 가입 예약을 해제합니다.
-- Auth 저장 여부가 불명확하면 호출하지 않습니다. 계정·권한·콘텐츠를 삭제하지 않습니다.
create function private.staff_auth_release_reservation(p_reservation uuid) returns boolean
language plpgsql security definer set search_path='' as $$
declare reservation private.staff_auth_reservations;
begin
 select * into reservation from private.staff_auth_reservations where id=p_reservation;
 if reservation.id is null then return true; end if;
 -- reserve와 같은 이름 잠금을 먼저 얻고 행을 다시 확인하여 교정 후 재시도와 경합하지 않게 합니다.
 perform pg_advisory_xact_lock(hashtextextended('staff-username:'||reservation.username,7142303));
 select * into reservation from private.staff_auth_reservations where id=p_reservation for update;
 if reservation.id is null then return true; end if;
 -- 새 Auth 계정이 생겼다면 성공 응답을 잃은 요청일 수 있습니다. 자동 해제·재생성을 막습니다.
 if exists(select 1 from auth.users u where lower(u.email)=reservation.email_lower and u.created_at>=reservation.created_at) then return false; end if;
 delete from private.staff_auth_reservations where id=reservation.id;
 return true;
end $$;
create function public.staff_auth_release_reservation(p_reservation uuid) returns boolean
language sql security invoker set search_path='' as $$select private.staff_auth_release_reservation(p_reservation)$$;
revoke all on function private.staff_auth_release_reservation(uuid),public.staff_auth_release_reservation(uuid) from public,anon,authenticated;
grant execute on function private.staff_auth_release_reservation(uuid),public.staff_auth_release_reservation(uuid) to service_role;
