# 공개 사이트와 관리자 구조

공개 사이트는 GitHub Pages의 정적 HTML, 관리자는 별도 /admin/ 인증 클라이언트,
데이터와 역할은 간사이 전용 Supabase 프로젝트에 둡니다.

## 정적 페이지 반영

클라이언트 조회는 저장 직후 화면을 바꿀 수 있지만 새 기사 주소를 정적으로 만들기 어렵고
방문자의 JavaScript 실행과 네트워크에 본문이 의존합니다.
이번 구조는 승인된 데이터로 정적 HTML을 재구축합니다.
기존 기사 주소를 유지하고 새 기사·선수 프로필 주소, 본문·메타 정보·검색 결과를 빌드에 포함합니다.

1. 운영진은 Auth 세션으로 관리자에 로그인합니다.
2. 저장은 사용자 JWT와 데이터베이스 RLS를 거칩니다.
3. 발행된 콘텐츠가 바뀌면 publication_state.version을 갱신합니다.
4. GitHub Actions가 보통 15분 간격으로 공개 버전을 확인합니다.
5. 변경 시 익명 공개 키로 승인된 필드만 읽어 정적 사이트를 만듭니다.
6. main에서 성공한 빌드만 Pages에 배포합니다. build.json으로 반영 버전을 확인합니다.

GitHub 작업 지연으로 반영이 늦을 수 있습니다. 저장 성공을 배포 완료로 표시하지 않습니다.
조회 실패·허용되지 않은 이미지·500개 목록 제한 도달 시 빌드를 중단합니다.
500개를 넘으면 공개 조회 페이지네이션을 먼저 확장합니다.

## 역할과 데이터 경계

| 역할 | 관리 범위 |
| --- | --- |
| Owner | 전체 콘텐츠·운영진 초대·역할 변경 |
| Administrator | 전체 콘텐츠·공개 프로필 승인 |
| Editor | 기사·앨범·미디어 편집과 발행 |
| Coach | 선수 등록·프로필 초안, 경기·훈련·기록 |
| 방문자·일반 로그인 | 발행된 공개 콘텐츠 읽기 |

역할은 admin_roles의 활성 행에서 조회합니다. 사용자가 바꿀 수 있는 Auth 메타데이터를 신뢰하지 않습니다.
마지막 활성 Owner는 제거할 수 없습니다. 권한 변경은 다음 DB 작업에 적용됩니다.
players, training_sessions, match_events, admin_roles, audit_logs에는 익명 조회 권한이 없습니다.
공개 프로필의 승인 담당자 UUID도 익명 컬럼 권한에서 제외합니다.
모든 노출 테이블은 명시적 GRANT와 RLS를 함께 적용합니다.
[Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security)

## 사진과 서버 함수

새 사진은 비공개 버킷 kansai-media에 고유 파일명으로 올립니다.
발행된 미디어에 연결된 파일만 익명 RLS로 읽으며 승인 전 파일은 URL을 알아도 조회할 수 없습니다.
기존 파일은 덮어쓰지 않습니다. 빌드는 공개 사진만 복사하고 이전 생성 폴더를 비웁니다.
[Supabase Storage 접근 제어](https://supabase.com/docs/guides/storage/security/access-control)

기존 공개 사진 네 장은 같은 원본과 주소를 유지하며 새로운 동의 확인 값으로 자동 기록하지 않습니다.
새 업로드에는 공개 확인이 필요합니다.
운영진 초대는 invite-staff Edge Function이 처리합니다. JWT를 Auth 서버에서 확인하고 현재 Owner를 조회합니다.
Auth 관리용 비밀키는 함수 환경에만 둡니다. 역할 등록은 호출자의 RLS를 다시 거칩니다.
