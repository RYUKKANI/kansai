# 실제 Auth 격리 검증

`node scripts/test-native-auth.mjs`는 가짜 Auth 응답 대신 Docker의 실제 Supabase Auth·PostgreSQL·PostgREST·Edge Runtime·Mailpit으로 인증 경계를 확인합니다. 운영 프로젝트, 기존 사용자, 실제 수신자, 저장소 secrets에는 연결하지 않습니다. Node 24와 실행 중인 Docker가 필요합니다.

Supabase CLI는 npm `supabase@2.121.0`에 고정합니다. 구현 시 npm 메타데이터와 실제 `--version`, `init` 생성 설정, `start`, `status`, `functions serve`, `stop` 도움말을 대조했습니다. 이 버전의 로컬 메일 설정은 `[local_smtp]`이고 Mailpit의 Docker 내부 별칭은 `inbucket`입니다. 고정 CLI가 선택한 실제 Auth 버전은 실행 로그에 비밀값 없이 기록합니다.

검사마다 임시 디렉터리와 무작위 `kansai-auth-ci-…` 프로젝트를 만들고 저장소 마이그레이션 전체와 Edge 소스를 복사합니다. 키는 로컬 `status -o json` 응답에서 메모리로만 읽습니다. 비밀번호와 기기 증명은 무작위 생성하며 명령 인자·소스·로그·결과물로 내보내지 않습니다. 임시 Edge 환경 파일은 접근 권한 `0600`으로 만들고 종료 시 제거합니다. HTTP 요청은 loopback만 허용하고 리디렉션을 자동으로 따라가지 않습니다.

실행하는 검사는 다음과 같습니다.

- 공식 Auth Admin API로 격리용 Owner를 만든 뒤 같은 UUID와 역할로 아이디 로그인합니다.
- 실제 복구 메일을 Mailpit에서 받고, SDK가 보관한 같은 PKCE verifier로 코드 교환과 게이트웨이 비밀번호 저장을 완료합니다. 기존 비밀번호·복구 링크 재사용은 거절되고 새 비밀번호 로그인의 UUID는 유지돼야 합니다.
- 실제 가입자는 Auth 세션을 얻어도 승인 대기 상태이며 명부와 내부 선수 행에 접근하지 못해야 합니다. 먼저 Owner에게 보이는 내부 시험 행을 넣어 빈 테이블로 인한 거짓 통과를 피합니다.
- 메일 없는 기기 복구는 승인 전 실행과 위조 증명을 거절해야 합니다. 격리 PostgreSQL의 관리자 승인 후 한 번만 비밀번호를 변경하고, 같은 Owner UUID·역할을 유지하며 기존 access/refresh 세션을 제한해야 합니다. 완료 요청에 다른 비밀번호를 다시 제출해도 그 값은 적용되면 안 됩니다.
- CLI 기본 로컬 Mailpit을 사용하며 커스텀 SMTP나 발송용 인증 정보를 만들지 않습니다. 아직 복구를 요청하지 않은 시험 주소로 두 번 연속 요청해 실제 Auth의 60초 재발송 제한을 확인합니다. 게이트웨이도 429 오류를 돌려줘야 하며 메일 전송 성공 안내를 반환하면 실패합니다.

`.github/workflows/auth-integration.yml`은 PR, `main`과 복구 수정 브랜치 push, 수동 실행에서 이 명령을 실행합니다. 의존 서비스나 Docker가 없으면 건너뛰지 않고 실패합니다. 로컬 컨테이너 출력, 키, 메일 원문, 복구 링크는 CI 로그나 artifact로 업로드하지 않습니다. 정상 종료와 검사 실패 시에는 이번 명령이 만든 프로젝트 ID의 컨테이너와 데이터 볼륨만 정리합니다. 작업이 강제 취소되면 일회용 CI runner 자체가 제거됩니다.

이 검사는 실제 운영 Owner의 복구 완료, Gmail 도착, 운영 배포 URL의 모바일 화면, 운영 프록시 설정을 입증하지 않습니다. 개발 호스트에는 Docker가 없어 구문 검사와 CLI 설정 대조만 수행했으며 실제 통합 성공 여부는 해당 CI 실행 결과로 기록해야 합니다.
