# 운영진 아이디·실명 전환 운영안

이 문서는 기존 Auth UUID와 콘텐츠를 유지하면서 이메일 중심 관리자를 아이디·비밀번호 로그인과 내부 실명 승인 방식으로 바꾸는 **검토용 전환 절차**입니다. 코드 작성이나 격리 테스트 통과는 운영 적용 완료를 뜻하지 않습니다. 운영 Auth 계정, 메일, DNS, 데이터에는 이 브랜치만으로 변경을 적용하지 않습니다.

`PUBLIC_STAFF_IDENTITY_ENABLED`의 기본값은 `false`입니다. 기존 Owner의 실제 새 로그인, 비밀번호 설정·복구, 두 번째 담당자를 통한 실명 확인과 기존 기능 회귀 검증이 끝나기 전에는 기존 Owner 로그인 경로와 역할을 유지합니다. 가입 접수, 이메일 확인, 내부 실명 확인, 운영진 승인, 실제 사용 권한은 각각 별도 상태입니다.

현재 DB는 기존 활성 `admin_roles` 행만 이전 승인으로 인정하는 호환 모드입니다. 매핑이 없는 일반 Auth 계정은 이전 운영진이 아니며, 새 신청은 `pending`으로 남습니다. 기존 운영진의 enrollment는 UUID·이전 역할을 보존하지만 실명을 자동 확인하지 않습니다. 기존 운영진은 전환 중 실명이 미확인이어도 기존 업무에 접근할 수 있으며, 그때 감사 이름은 `null`, 이름 상태는 `unverified`입니다. UI 플래그는 이 호환 예외를 제거하는 DB 강제 전환 스위치가 아닙니다. 이 예외가 남아 있는 동안 모든 작업이 확인된 실명으로 기록된다고 주장하지 않습니다.

## 지켜야 하는 데이터 경계

| 정보 | 기준과 보관 위치 | 공개 경계 |
| --- | --- | --- |
| 계정 식별 | 기존 Supabase Auth UUID | 아이디나 실명으로 UUID를 대체하지 않음 |
| 로그인 아이디 | 서버 정규화·고유 제약이 있는 비공개 매핑 | 익명 목록·중복 확인 API로 전체 매핑을 제공하지 않음 |
| 비밀번호 | Supabase Auth만 검사·저장 | 자체 테이블, 요청 로그, 감사 상세, 오류 원문에 남기지 않음 |
| 복구 이메일 | 실제 Auth 이메일과 계정 소유 확인 | 운영진 명부·일반 감사 화면의 기본 응답에서 제외 |
| 내부 실명·소속 | 신청 값과 확인된 값, 확인 담당자 UUID·시각 분리 | 승인된 운영진의 업무 명부에서 허용한 필드만 조회 |
| 활동 주체 | 서버가 확인한 Auth UUID와 당시 승인된 실명·역할 | 클라이언트가 actor/name/role을 지정하지 못함 |
| 선수·공개 프로필 | 별도 선수 UUID와 기존 공개 승인·사진 동의 | 운영진 가입으로 선수나 공개 프로필을 자동 생성하지 않음 |

실명은 Unicode 이름과 중복 이름을 허용합니다. 서로 다른 사람을 실명만으로 병합하지 않습니다. 이메일 앞부분에서 이름을 추측하거나 기존 이메일을 가짜 주소로 치환하지 않습니다. 내부 명부·감사 실명 이용 동의는 홈페이지 선수 이름·사진 공개 동의를 대신하지 않습니다.

## 위협 모델과 서버에서 확인할 조건

| 공격·실수 | 차단·관찰할 위치 | 확인해야 하는 한계 |
| --- | --- | --- |
| 미승인 계정이 관리자 UI를 건너뛰고 REST/RPC/Storage 호출 | DB의 현재 역할·승인·활성 상태와 RLS, 제한된 RPC | 화면 숨김이나 JWT의 오래된 역할만으로 차단했다고 판단하지 않음 |
| 이메일 확인을 운영진 승인으로 오인 | 계정 상태 조회와 승인 RPC | 이메일 확인만 끝난 계정은 본인 신청 상태만 조회 |
| `user_metadata`, 요청 body의 역할·actor 값 위조 | 서버 JWT 확인, DB 역할 조회, 입력 허용 목록 | 메타데이터는 권한 근거가 아님 |
| 기존 이메일로 새 가입을 시도해 계정 탈취·UUID 교체 | 예약·확정 RPC와 실제 Auth 사용자 이메일·생성 시각·UUID 확인 | Auth의 기존 사용자 은폐 응답을 신규 사용자 증거로 취급하지 않음 |
| 동일 아이디 동시 가입·대소문자 변형 | 서버 정규화와 DB 고유 제약·트랜잭션 | 브라우저 사전 중복 검사는 고유성 보장이 아님 |
| 본인 실명 확인·승인·권한 상승 | 승인·이름 확인·이름 변경·역할 RPC | Owner도 본인의 실명을 스스로 확인하지 않음 |
| 마지막 활성 Owner 정지·강등, 기존 세션 악용 | DB의 마지막 Owner 보호와 매 작업 권한 재조회 | 세션 해지 전이라도 다음 DB 요청을 제한해야 함 |
| 다른 사람의 활동으로 감사 기록 위조 | 실제 변경과 같은 DB 트랜잭션의 트리거·서버 RPC | 클라이언트 감사 INSERT/UPDATE/DELETE 금지 |
| 실패한 저장을 성공 이력으로 기록 | 업무 변경과 감사 기록의 원자성 | 거절·롤백은 성공 감사에 남기지 않음; 보안 오류 기록과 구분 |
| 감사 화면에서 연락처·본문·비공개 선수 정보 유출 | 엔터티·역할별 감사 읽기 필터와 허용한 변경 필드 | 비밀값을 먼저 저장한 뒤 UI에서 가리는 방식 금지 |
| 자동화 작업을 사람 작업으로 오인 | 서버가 확인할 수 있는 실행자와 요청자의 분리 | 확인할 수 없는 요청자를 추측하지 않음 |
| 로그인·가입·복구 남용과 IP 위조 | 중앙 원자적 전역·식별자 제한, 선택적 검증된 IP 제한 | 브라우저의 X-Forwarded-For는 신뢰하지 않음 |

전역·식별자 제한은 인스턴스 메모리 대신 DB의 원자적 제한을 사용합니다. 식별자는 서버 HMAC으로 해시하여 원문 아이디·이메일을 제한 테이블에 복제하지 않습니다. 검증된 프록시가 없으면 IP별 제한을 달성했다고 표시하지 않습니다. 선택적 IP 경로는 배포자가 헤더 덮어쓰기와 위조 거부를 실제 테스트한 경우에만 켭니다.

`staff-auth` 앞단의 제한만으로 Supabase Auth의 직접 비밀번호 로그인·가입·복구 엔드포인트까지 보호되는 것은 아닙니다. 공개 publishable key와 Auth URL을 아는 요청에 대해 Auth 자체의 비밀번호 정책·메일 확인·속도 제한을 별도로 확인해야 합니다. 현재 UI에는 CAPTCHA widget·token 전달이 없습니다. Auth CAPTCHA를 켠 프로젝트는 그 연동을 구현·검증하기 전 새 화면을 활성화하지 않습니다. 게이트웨이를 거치지 않고 생성된 Auth 계정에는 확인된 운영진 identity·활성 역할이 없으므로 내부 권한을 부여하지 않습니다. 프록시 뒤 Supabase Auth에서 여러 사용자가 하나의 서버 출구 IP로 계산될 수 있는 점도 실제 시험 대상입니다.

## 개발·검증 환경

이 변경은 별도 브랜치에서 준비합니다. 격리 PGlite는 SQL/RLS/트리거의 논리를, 가짜 SDK/HTTP 의존성은 UI와 Edge의 요청 처리를 검사합니다. 어느 쪽도 실제 Supabase Auth의 메일 전달·비밀번호 강도·복구 리다이렉트·세션 회수·프록시 경계를 입증하지 않습니다.

현재 별도 클라우드 테스트 프로젝트와 로컬 Auth 서버가 확보되지 않았다면, 실제 메일 발송·실계정 생성·운영 마이그레이션을 대신 수행하지 않습니다. 이 문서와 [검증표](STAFF_IDENTITY_TEST_MATRIX.md)의 실제 배포 항목은 미확인으로 남깁니다. 테스트 주소와 계정은 담당자가 지정한 수신자와 격리 환경에서만 사용합니다. `.invalid` 테스트 주소로 메일 성공을 주장하지 않습니다.

로컬 정적 사이트 회귀 검사는 실제 서비스와 통신하지 않는 다음 설정으로 빌드할 수 있습니다.

```bash
PUBLIC_CMS_ENABLED=false \
PUBLIC_SCHEDULE_ENABLED=false \
PUBLIC_STAFF_IDENTITY_ENABLED=false \
PUBLIC_SUPABASE_URL=https://kansai-tests.supabase.co \
PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_offline_test \
npm run build
npm run check
npm run export:preview
npm test
```

위 URL과 키는 격리 테스트용 가짜 값이며 실제 로그인 시험에 사용하지 않습니다. 실제 시험 배포에서는 테스트 프로젝트의 publishable key만 공개 빌드에 넣습니다. 서비스·secret key, HMAC 비밀, 프록시 서명 키는 공개 빌드·Git·Actions artifact에 넣지 않습니다.

## 테스트 배포와 기존 계정 전환

운영 적용 전에는 배포 대상 프로젝트 ID, 별도 테스트 URL, 허용 Origin, 이메일 확인·복구 redirect 주소를 담당자가 대조해야 합니다. 운영 프로젝트에 `supabase db reset`을 실행하지 않습니다. 아래의 `TEST_HOST`와 테스트 프로젝트는 실제 확보·승인한 값으로 바꿉니다. 이 작업 환경에는 Supabase CLI와 로컬 Auth 서버가 없어 실제 함수 배포를 실행·검증하지 않았습니다. 설치한 CLI의 `supabase --help`, `supabase db push --help`, `supabase functions deploy --help`, `supabase secrets set --help`로 지원 명령·대상 지정 방식을 먼저 확인합니다.

### 공개 빌드와 함수 환경

| 설정 | 테스트 환경 값·의미 |
| --- | --- |
| `PUBLIC_STAFF_IDENTITY_ENABLED` | 기본 `false`; 테스트용 새 화면 빌드만 `true` |
| `PUBLIC_STAFF_LEGACY_LOGIN_ENABLED` | 기본 `false`; 전환 확인용 기존 이메일 링크를 도움말에 보여줄 때만 `true` |
| `PUBLIC_SUPABASE_URL` | 격리 테스트 프로젝트 URL |
| `PUBLIC_SUPABASE_PUBLISHABLE_KEY` | 같은 테스트 프로젝트의 publishable key |
| `STAFF_AUTH_ENABLED` | 기본 비활성; 테스트 함수만 `true` |
| `STAFF_AUTH_REGISTRATION_ENABLED` | 테스트 가입을 허용할 때만 `true` |
| `STAFF_AUTH_LEGACY_EMAIL_ENABLED` | 도움말의 기존 이메일 링크 발송을 서버에서 허용할 때만 `true`; 공개 플래그와 독립 |
| `STAFF_AUTH_ALLOWED_ORIGINS` | `["https://TEST_HOST"]` 형태의 JSON 배열; 경로·와일드카드 없이 정확한 Origin |
| `STAFF_AUTH_LOGIN_REDIRECT_URL` | `https://TEST_HOST/admin/`; Auth 허용 redirect와 일치 |
| `STAFF_AUTH_RECOVERY_REDIRECT_URL` | `https://TEST_HOST/admin/help/`; Auth 허용 redirect와 일치 |
| `STAFF_AUTH_RATE_HMAC_SECRET` | 서버에서 생성한 32자 이상의 무작위 비밀; 공개 변수로 만들지 않음 |
| `SUPABASE_URL` | 함수 런타임의 같은 테스트 프로젝트 URL |
| `SUPABASE_SECRET_KEYS` | 함수 런타임의 secret key JSON (`default` 또는 유일한 키); 레거시 환경은 `SUPABASE_SERVICE_ROLE_KEY` |
| `SUPABASE_PUBLISHABLE_KEYS` | 함수 런타임의 publishable key JSON (`default` 또는 유일한 키); 레거시 환경은 `SUPABASE_ANON_KEY` |

Origin은 최대 10개이며 공개 HTTP는 허용하지 않습니다. 로컬 시험에만 `http://localhost:포트`, `http://127.0.0.1:포트` 같은 정확한 Origin을 허용합니다. 키 JSON에 여러 키가 있는데 `default`가 없으면 임의 선택하지 않고 실패합니다.

기본 IP 설정은 `STAFF_AUTH_IP_MODE=disabled`, `STAFF_AUTH_FORWARD_AUTH_IP=false`입니다. 이 경우에도 전역 200회/분과 정규화 식별자별 제한은 항상 DB에서 검사합니다. 아이디 로그인은 8회/15분, 가입의 아이디·이메일은 각각 3회/시간, 복구·기존 이메일 링크는 3회/시간, enrollment·비밀번호 변경은 인증 UUID당 6회/시간입니다. 고정 구간 방식이며 구간 경계에서 연속된 요청을 별도로 시험합니다.

추가 IP 제한을 쓰려면 실제 인입 경계가 덮어쓰는 단일 헤더만 선택합니다. `STAFF_AUTH_IP_MODE=attested-header`, `STAFF_AUTH_TRUSTED_IP_HEADER=cf-connecting-ip` 또는 `x-real-ip`, `STAFF_AUTH_IP_SOURCE_ATTESTED=overwrites-client-input`을 **위조 헤더·직접 접근 테스트 이후에만** 설정합니다. `X-Forwarded-For` 체인은 허용하지 않습니다. Supabase Auth로 IP를 전달하려면 여기에 새 `sb_secret_` 키, `STAFF_AUTH_FORWARD_AUTH_IP=true`, Auth의 실제 Management API opt-in을 확인한 `STAFF_AUTH_SB_FORWARDED_FOR_ENABLED=true`가 모두 필요합니다. 확인 문자열만 설정하는 것으로 네트워크 경계가 안전해지지 않습니다.

`supabase/config.toml`의 저장된 기본값은 가입을 계속 끕니다. 테스트 프로젝트에서 가입을 시험할 때만 Auth의 일반 가입과 이메일 가입을 허용하고 이메일 확인은 유지합니다. Site URL은 테스트 홈페이지, 허용 redirect는 정확한 테스트 `/admin/`와 `/admin/help/` 두 경로로 설정합니다. 신규 비밀번호 최소 12자 정책, 실제 Auth 속도 제한, 보안 이메일 변경, 복구 링크·만료, 실제 메일 수신을 확인합니다. `STAFF_AUTH_REGISTRATION_ENABLED=true`만으로 Auth의 가입 금지가 해제되지는 않습니다.

`staff-auth`는 공개 로그인·가입 진입을 위해 `verify_jwt=false`이고, enrollment·비밀번호 변경은 내부에서 Bearer를 Auth 서버로 확인합니다. 요청자가 redirect·역할·actor를 보낼 수 없습니다. 공개 로그인 응답은 세션 토큰만 반환하고, 가입·복구는 이메일 존재 여부나 승인 여부를 알려주지 않는 일반 응답입니다. 비밀번호 변경은 확인된 Bearer와 같은 UUID의 최근 15분 이내 서명된 복구·초대 AMR, 또는 실제 현재 비밀번호 재인증을 요구합니다. 비밀번호 저장은 Supabase Auth의 `/auth/v1/user`로 전달하며 브라우저 refresh token을 서버에 수집하지 않습니다.

복구 메일은 도움말 페이지의 공식 SDK가 PKCE 검증기를 브라우저에 보관하고 S256 challenge만 만듭니다. `src/lib/staff-auth-recovery.ts`의 fetch 어댑터가 `/recover` 요청을 `staff-auth`로 보내며, 서버는 challenge와 고정된 도움말 redirect만 Auth에 전달합니다. 검증기(`code_verifier`)를 게이트웨이에 보내지 않습니다. 링크는 요청한 같은 브라우저에서 열어 공식 SDK가 코드를 교환해야 합니다. 다른 기기·브라우저, 검증기 삭제, 오래된 링크에서 실패할 때는 그 브라우저에서 복구를 새로 요청합니다. URL에 `type=recovery`를 붙이거나 일반 로그인 세션을 보유한 것만으로 비밀번호 양식을 열지 않습니다. 실제 Auth의 PKCE 코드 교환과 복구 AMR은 테스트 배포에서 확인해야 합니다.

### 마이그레이션과 RPC 계약

새 SQL 파일은 `supabase/migrations/20261015043050_staff_identity_accounts.sql`입니다. 기존 마이그레이션 뒤에 적용하며 과거 파일을 수정해 원격 이력을 덮어쓰지 않습니다. 새 테이블은 `private.staff_accounts`, `private.staff_name_requests`, `private.staff_auth_reservations`, `private.staff_auth_rate_buckets`이고 클라이언트 직접 접근을 금지합니다. `public.audit_logs`에는 기존 행을 보존하는 열만 추가합니다. 기존 행의 이름·출처를 새 인물로 소급해 채우지 않습니다.

배포 순서에도 주의합니다. 업데이트한 `invite-staff`는 `office_capabilities.staff_identity=true`를 확인하면 **메일을 보내기 전에** 기존 초대를 중지하며, 비어 있는 권한 응답도 거절합니다. 이 보호 버전을 DB migration보다 먼저 배포·검증해야 합니다. 예전 함수와 새 DB를 섞으면 초대 메일만 전송된 뒤 금지된 역할 INSERT가 실패할 수 있습니다. migration 이후 신규 운영진은 새 가입·실명 확인·승인 RPC를 사용하며, 이전 화면 플래그를 끄는 것만으로 기존 직접 역할 편집·초대를 재허용하지 않습니다.

| RPC | 호출 주체 | 인자·역할 |
| --- | --- | --- |
| `office_account_state()` | 인증된 본인 | 자기 신청·이메일 확인·역할·실명 확인 상태만 조회 |
| `office_enroll_identity(...)` | 인증된 본인 | `p_username`, `p_real_name`, `p_department`, `p_notice_accepted`; 기존 역할은 유지하고 없는 계정은 `pending` |
| `office_staff_directory()` | 현재 활성 운영진 | 확인된 실명·소속·활동 상태; 이메일·로그인 아이디 제외 |
| `office_staff_applications()` | Owner/Administrator | 승인 관리용 최소 신청 상태; 이메일 주소 제외 |
| `office_review_staff(...)` | 타인을 검토하는 Owner/Administrator | `p_user_id`, `p_decision` (`approved`/`rejected`), `p_role`, `p_reason`; 승인 시 이메일 확인과 담당자의 실명 확인을 함께 기록 |
| `office_verify_staff_identity(...)` | 권한 있는 다른 담당자 | `p_user_id`, `p_real_name`, `p_reason`; 승인된 기존 계정의 아직 확인하지 않은 정확한 신청 실명만 확인 |
| `office_set_staff_access(...)` | 타인을 관리하는 Owner/Administrator | `p_user_id`, `p_role`, `p_active`, `p_reason`; 자기 변경·과권한·마지막 Owner 제거 금지 |
| `office_request_name_change(...)` | 현재 활성 본인 | `p_real_name`, `p_reason`; 확인된 이름은 승인 전까지 유지 |
| `office_staff_name_requests()` | Owner/Administrator | 이름 정정 검토 목록 |
| `office_review_name_change(...)` | 권한 있는 다른 담당자 | `p_request_id`, `p_approve`, `p_reason`; 과거 감사 snapshot은 변경하지 않음 |
| `office_staff_audit(...)` | 현재 활성 운영진 | `p_limit` (1~100), `p_before_id`; 실제 RLS의 업무별 조회 범위 적용 |
| `staff_auth_identity`, `staff_auth_reserve`, `staff_auth_finalize`, `staff_auth_rate_limit` | 함수의 service role만 | 비공개 매핑·가입 예약/확정·중앙 제한; 익명/일반 인증 EXECUTE 금지 |

Administrator는 Owner/Administrator를 승인·확인·변경하거나 그 역할을 부여하지 못합니다. Owner 검증에는 다른 Owner가 필요합니다. 계정 사유에는 비밀번호·이메일·전화·민감한 개인 정보를 쓰지 않습니다.

RPC는 실제 인증된 사용자 JWT로 호출해야 합니다. SQL Editor에서 다른 사람 UUID를 `request.jwt.claim.sub`로 설정하는 방식은 운영 사용자 인증이 아니며 사람 귀속 증거가 되지 않습니다. 아래는 시험 도구에서 **각 인자를 별도로 바인딩**하는 SQL 형태입니다. `$1` 등에 실제 비밀값을 문자열로 이어 붙이거나 예시 이름으로 실행하지 않습니다.

```sql
select public.office_account_state();
select public.office_enroll_identity($1, $2, $3, $4);
select public.office_review_staff($1, $2, $3, $4);
select public.office_verify_staff_identity($1, $2, $3);
select public.office_set_staff_access($1, $2, $3, $4);
```

승인 시험은 새 계정의 이메일 확인 → 다른 담당자의 실제 관계·실명 확인 → `office_review_staff(..., 'approved', 적절한 역할, 사유)` 순서입니다. 서비스 키로 본인 대신 승인하거나 사용자 UUID를 새로 만들지 않습니다. 가입 예약 뒤 Auth 생성·확정은 서로 다른 서비스의 작업이어서 단일 DB 트랜잭션이 아닙니다. 중간 실패 계정은 역할 없는 상태로 격리하고, 운영자가 Auth UUID·예약·이메일 소유를 대조한 뒤 재시도를 검토합니다. 기존 사용자 삭제·재생성으로 해결하지 않습니다.

1. 기존 역할·계정 UUID·콘텐츠·감사 행 수와 스키마 버전을 읽기 전용으로 기록합니다. 비공개 데이터 백업 위치·접근자·보관 기간을 정합니다.
2. 격리 프로젝트에 기존 마이그레이션과 새 identity 마이그레이션을 순서대로 적용합니다. 공개 API에 `private` 스키마를 노출하지 않습니다. 역할별 직접 REST/RPC/Storage 부정 시험을 먼저 통과시킵니다.
3. 테스트 전용 Auth URL/redirect·메일 확인·비밀번호 정책과 실제 프록시·속도 제한 설정을 준비합니다. 등록 허용은 테스트 범위에서만 켜고 외부 수신자를 임의로 초대하지 않습니다.
4. Edge를 테스트 프로젝트에 배포하고 새 화면 플래그를 테스트 빌드에서만 켭니다. 잘못된 Origin·위조 헤더·다중 인스턴스·중복 아이디 경합·직접 Auth 우회 요청을 시험합니다.
5. 기존 비밀번호가 없는 초대 계정은 확인된 기존 이메일로 실제 비밀번호 설정·복구를 검증합니다. 기존 UUID와 역할이 유지되는지 전후 비교합니다. 계정을 지우고 다시 만드는 방식은 사용하지 않습니다.
6. 승인·이름 확인·비활성화·이름 변경·역할 변경과 감사 기록을 각 역할로 점검합니다. 기존 기사·선수·일정·미디어 작업과 일본어·한국어·영어 및 모바일 화면을 검증표에 기록합니다.
7. Owner와 담당자가 실제 시험 증거·보관 정책·복구 수단을 검토한 뒤 운영 전환 시점을 정합니다. 그 전에는 운영 플래그·계정·메일 설정을 바꾸지 않습니다.

### 현재 유일한 Owner의 실명 확인

기존 Owner가 한 명인 경우에도 본인 이름을 자동 확정하거나 `verified_by = 본인 UUID`로 채우지 않습니다. 기존 이름을 이메일에서 유추하지 않습니다.

1. 기존 Owner는 기존의 확인된 로그인 경로로 접근하고 본인의 실제 아이디·실명·소속을 직접 신청합니다. 이 단계는 새 실명의 검증 완료가 아닙니다.
2. Owner가 실제 확인 가능한 다른 담당자 한 명의 가입·이메일·실명·소속을 확인하고 적절한 권한으로 승인합니다. 확인 방식과 이유는 운영자가 정하며 문서·신분증 번호를 앱에 업로드하도록 요구하지 않습니다.
3. 승인된 담당자에게 Owner 실명을 확인할 수 있는 권한을 부여하고, 그 담당자가 기존 Owner의 실명을 별도로 확인합니다. 현재 권한 계약에서는 다른 Owner가 필요하므로, 기존 Owner가 실제 책임을 맡을 두 번째 Owner를 지정해야 합니다. Administrator를 임시로 Owner인 것처럼 간주하지 않습니다. 자기 확인 금지와 마지막 Owner 보호는 유지합니다.
4. 두 담당자가 각각 새 아이디 로그인과 복구를 실제 배포 URL에서 확인합니다. 기존 Owner UUID·역할·콘텐츠 이력의 연결을 검증합니다.
5. 이후에만 운영 새 화면 전환을 검토합니다. 현재 migration에는 기존 운영진 전체의 실명 확인을 일괄 강제하는 별도 전환 스위치가 없습니다. 그 강제가 필요하면 기존 운영진 전원의 검증·복구 시험을 마친 후 별도 migration으로 검토합니다. 다른 검증 담당자를 확보하지 못하면 기존 Owner 접근을 유지하고 전환을 보류합니다.

## 감사 기록과 귀속의 한계

서버는 실제 변경 시점의 UUID, 확인된 내부 실명, 당시 역할, 시각, 작업, 엔터티·항목 ID, 변경 필드와 허용한 마스킹 값·사유를 기록합니다. 새 이름이 승인되어도 과거 행을 새 이름으로 덮어쓰지 않습니다. 기존의 이름을 알 수 없는 행은 알 수 없는 상태를 유지합니다. 요청 본문·토큰·비밀번호·복구 링크·전체 이메일·선수 연락처나 본문 전체를 감사 상세에 복제하지 않습니다.

직접 SQL, DB 소유자, `service_role`, 자동 발행 작업은 일반 브라우저 사용자 JWT와 동일한 인간 귀속을 제공하지 않습니다. 이 권한은 RLS를 우회하거나 요청 claim을 설정할 수 있으므로, DB만으로 실제 사람이 누구인지 증명할 수 없습니다. 신뢰한 서버가 확인한 실행자와 알려진 요청자를 별도 기록할 때만 그 관계를 표시합니다. 예약 발행은 `source=scheduled`, `executor=content_publisher`, 검증된 예약 승인자의 `requested_by`를 구분합니다. 직접 DB 작업은 `database_unattributed`이고 임의 이름을 채우지 않습니다. `source=human`은 현재 구현에서 인증된 사용자 자격으로 한 요청이라는 기술 분류입니다. 동일 JWT를 사용하는 사람·AI를 탐지한다는 뜻이 아니며, 별도의 AI 실행자 위임 연동은 구현하지 않았습니다. AI·자동화가 수행했다고 해서 Owner가 직접 실행한 것으로 추측하지 않습니다. 관리 콘솔·직접 SQL의 별도 감사와 변경 승인 절차가 필요합니다.

### 보관 정책 결정 전제

새 감사·identity 행에 임의의 보관 기간이나 자동 삭제 job을 추가하지 않습니다. 기존 감사·콘텐츠 행을 이 변경으로 정리하거나 삭제하지 않습니다. **자동 삭제가 없다는 사실은 무기한 보관이 승인되었다는 뜻이 아닙니다.** 운영 활성화 전 담당자가 목적, 대상 필드, 접근자, 기간, 백업 만료, 삭제·가명화 검토 절차를 정하고 검토 결과를 남겨야 합니다.

감사 보존 필요와 내부 실명 개인정보의 최소화를 함께 검토해야 합니다. 임시 가입 예약은 15분 뒤 만료되고 후속 예약 요청에서 만료 행을 정리합니다. HMAC 제한 버킷은 후속 제한 요청에서 48시간이 지난 구간을 정리합니다. 별도 cleanup job은 없으므로 요청이 없으면 이 시점에 실제 삭제된다고 보장하지 않습니다. 이 임시 남용 방지 데이터의 유지 관리와 감사·실명 보관 정책은 같은 것이 아닙니다. 보관 기간을 정하지 못한 상태를 기능 활성화 승인으로 취급하지 않습니다.

## 중단·복구와 롤백

문제 발생 시 `PUBLIC_STAFF_IDENTITY_ENABLED=false`로 다시 빌드하고 `STAFF_AUTH_REGISTRATION_ENABLED=false`로 새 등록을 중지합니다. 필요하면 `STAFF_AUTH_ENABLED=false`로 게이트웨이를 중지하되, 기존 Owner의 확인된 로그인 경로와 역할을 유지합니다. 전환 시각·대상 버전·복구 담당자를 기록합니다. 기존 Auth 사용자와 `admin_roles`를 삭제하거나 UUID를 재발급하지 않습니다. 이미 저장된 콘텐츠·선수 연결·원본 감사 행을 되돌리기 위해 데이터베이스를 초기화하지 않습니다.

DB는 기존 역할 호환 경로를 유지하지만 역할 직접 CRUD는 회피 경로를 닫기 위해 제한합니다. UI만 과거 버전으로 돌린다고 이전 역할 편집·초대가 자동 복구되는 것은 아닙니다. 승인·권한 변경은 새 검증 RPC 경로를 유지해야 합니다. 미승인 계정에 `admin_roles`를 직접 넣거나 원래의 넓은 DML GRANT를 되살리는 SQL은 롤백 절차가 아닙니다. 새 migration을 역으로 DROP하거나 감사 실명 열을 제거하지 않습니다. 다시 켜기 전 Owner 로그인·복구와 직접 API 부정 시험을 반복합니다.

실제 Auth·메일·모바일 브라우저 검증이 없는 상태에서는 완료로 표시하지 않고 [검증표](STAFF_IDENTITY_TEST_MATRIX.md)에 미확인 사유와 다음 시험 환경을 기록합니다.

## 구현 위치와 검증 근거

| 영역 | 파일 |
| --- | --- |
| 개인 계정·승인·안전한 명부·감사·역할 경계 | `supabase/migrations/20261015043050_staff_identity_accounts.sql` |
| 공개 인증 gateway·환경·Auth REST 어댑터 | `supabase/functions/staff-auth/` |
| 기존 초대 중단 보호 | `supabase/functions/invite-staff/handler.ts` |
| 로그인·가입·기존 계정 전환 | `src/components/admin/StaffAuthPortal.astro`, `src/scripts/staff-auth.ts` |
| 도움말·브라우저 PKCE 복구 | `src/pages/admin/help.astro`, `src/scripts/staff-auth-help.ts`, `src/lib/staff-auth-recovery.ts` |
| 운영진 명부·승인·자기 계정·이력 | `src/scripts/admin-staff.ts`, `src/styles/admin-staff.css` |
| 기존 관리자 통합·역할별 업무 화면 | `src/scripts/admin.ts`, `src/lib/admin-ui.ts` |
| 격리 회귀·남용 입력 | `supabase/tests/staff-identity.test.mjs`, `tests/auth-gateway.test.mjs`, `tests/staff-auth-ui.test.mjs`, `tests/staff-management-ui.test.mjs` |
| 공식 SDK PKCE·새 화면 전체 통합 | `tests/staff-auth-recovery.test.mjs`, `tests/staff-identity-app.test.mjs` |

현재 SDK 계약 검토에는 저장소에 고정된 `@supabase/supabase-js`와 `@supabase/auth-js` 소스를 사용합니다. 외부 검토 기준은 [Auth JWT claims](https://supabase.com/docs/guides/auth/jwt-fields), [비밀번호 보안](https://supabase.com/docs/guides/auth/password-security), [PKCE](https://supabase.com/docs/guides/auth/sessions/pkce-flow), [Auth 속도 제한](https://supabase.com/docs/guides/auth/rate-limits)입니다. 문서의 기능 지원만으로 현재 프로젝트의 실제 설정·메일 흐름이 확인된 것은 아닙니다.
