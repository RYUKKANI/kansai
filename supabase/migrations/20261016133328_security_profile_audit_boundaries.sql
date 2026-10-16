-- [편집 안내] 공개 선수 정보의 열 제한은 anon 전용 정책/GRANT에 그대로 둡니다.
-- authenticated는 열 전체 SELECT 권한이 있으므로 공개 상태만으로 내부 승인 UUID를
-- 읽게 하지 않고 현재 승인·역할·실제 세션을 확인하는 기존 helper를 사용합니다.
alter policy profile_read_staff on public.public_player_profiles
  using ((select private.current_role()) in ('owner','administrator','coach'));

-- 반복 일정 본체도 개별 일정과 같은 서버 감사 경로를 사용합니다.
-- 업무 행과 AFTER 트리거가 같은 트랜잭션에서 확정되며 기존 이력을 소급 생성하지 않습니다.
-- training_series에는 updated_at이 없으므로 prepare_content 트리거는 추가하지 않습니다.
create trigger audit_content
  after insert or update or delete on public.training_series
  for each row execute function private.capture_audit();
