# Owner 전용 운영진 계정 관리

관계자 관리 화면에서 Owner가 한 계정의 **로그인 아이디·실명·비밀번호 설정 여부**를 확인하고 아이디·실명 수정 또는 새 비밀번호 설정을 요청하는 기능입니다. 현재 비밀번호를 조회·복원하는 기능은 없습니다. 이 문서는 구현·검증 계약이며 실제 운영 계정 변경의 완료 증거가 아닙니다.

## 권한과 조회 범위

관계자 관리 메뉴와 관리 RPC는 Owner만 사용합니다. Administrator·Editor·Coach·미승인·정지 계정은 직접 RPC나 Edge 요청으로 우회할 수 없습니다. 본인 상태·본인 이름 정정 신청·승인된 운영진 명부와 업무별 감사 읽기의 기존 범위는 별도입니다.

서버는 JWT의 서명·현재 Auth 사용자, DB의 현재 활성 Owner 역할과 승인 상태, 같은 사용자의 `session_id`가 실제 `auth.sessions`에 남아 있고 만료되지 않았는지를 확인합니다. Owner에게 확인된 MFA factor가 있으면 `aal2`도 필요합니다. **비밀번호 초기화에는 추가로** 최근 15분 이내의 서명된 AMR을 요구합니다. 허용 방법은 `password`, `otp`, `magiclink`, `totp`, `webauthn`이며 복구·초대·가입 AMR은 이 경로의 근거가 아닙니다. 서버 시각보다 60초를 넘게 앞선 값도 거절합니다. JWT 갱신 시각이나 브라우저 시각·메타데이터를 최근 로그인 증거로 취급하지 않습니다. 조건이 부족하면 다시 인증하며, 클라이언트에서 역할이나 인증 시각을 바꿔 해결하지 않습니다.

대화창을 열 때만 선택한 UUID를 조회합니다. 일반 목록에 모든 계정의 연락 이메일·비밀번호 상태를 추가하지 않습니다. 계정 연결의 기준은 변하지 않는 Auth UUID이며 아이디·실명·이메일을 식별자로 바꾸지 않습니다.

### 비밀번호 설정 여부

비밀번호는 Supabase Auth가 저장·검사합니다. 서버 SQL은 `coalesce(encrypted_password, '') <> ''`의 **불리언 결과만** 반환합니다. 기존 비밀번호나 해시 값을 읽어 클라이언트·Edge·로그·감사에 전달하지 않으며 자체 비밀번호 테이블을 만들지 않습니다. 공식 User API의 이메일 provider만 보고 비밀번호가 있다고 추정하지 않습니다. 이메일 passwordless 계정도 같은 provider를 가질 수 있습니다.

`password_is_set=true`는 Auth에 비밀번호 값이 있다는 뜻입니다. 그 값을 알고 있다는 뜻, 사용자가 새 비밀번호로 로그인했다는 뜻, MFA나 이메일 소유 확인·구단 승인이 완료됐다는 뜻은 아닙니다.

## 아이디·실명 수정

- 아이디는 기존 규칙대로 소문자·앞뒤 공백 제거 후 3~32자의 `[a-z0-9._-]` 형식이며 첫 문자는 영문 소문자 또는 숫자입니다. 사용 중인 아이디와 유효한 가입 예약을 덮어쓰지 않습니다. 예약·enrollment·변경 경로의 공통 잠금과 고유 제약으로 경합을 막습니다.
- 사유를 입력하고 같은 UUID의 아이디·실명만 수정합니다. Auth 이메일·UUID·권한·승인·활동 상태·선수 연결·공개 동의는 이 작업으로 바뀌지 않습니다. 기존 비밀번호를 바꾸거나 세션을 자동 회수하는 작업도 아닙니다.
- 다른 사람의 완성된 프로필 실명을 수정할 때 Owner는 실제 본인과 이름을 확인하고 별도 확인란을 체크해야 합니다. 변경한 이름에는 해당 Owner가 확인자로 기록됩니다. 본인의 이미 확인된 실명은 직접 바꿀 수 없으며 다른 Owner에게 정정을 요청합니다. 본인의 미확인 이름을 입력해도 본인 확인이 되지는 않습니다.
- 이전 Owner의 빈 프로필에 이름을 입력해도 소속·안내 동의·확인 담당자를 대신 채우지 않습니다. 실제 본인이 기존 enrollment 절차로 남은 항목을 완성합니다.
- 직접 변경으로 대기 중 이름 정정이 무효화되면 같은 트랜잭션에서 정리합니다. 과거 감사의 UUID와 당시 이름 snapshot은 다시 쓰지 않습니다.

## 비밀번호 초기화

대상과 이유를 확인한 Owner가 새 비밀번호와 확인 값을 입력합니다. 최소 12자, 최대 72 UTF-8 바이트이며 실제 Auth 비밀번호 정책도 적용합니다. 원래 비밀번호를 요청하지 않습니다. 새 값을 채팅·이메일·PR·스크린샷으로 전달하지 않습니다. 에이전트가 실제 새 자격 증명을 입력하거나 수집하는 절차를 이 문서로 허가하지 않습니다.

`staff-auth`의 `owner_reset_password` 요청에는 `user_id`, `operation_id`, `password`, `password_confirmation`, `reason`만 받습니다. actor·역할·이메일·확인 상태·redirect를 받지 않습니다. 기존 공통 제한과 인증 UUID당 6회/시간 제한이 적용됩니다.

| 단계 | 서버 처리 |
| --- | --- |
| 요청 기록 | 인증 사용자 RPC가 Owner·최근 인증·세션·대상을 확인하고 operation UUID에 당시 작업자·역할·확인 이름·세션·사유를 결합 |
| 일회 실행 권한 | service-only claim이 현재 Owner·세션·대상을 다시 검사하고 유효한 `requested`를 `executing`으로 한 번만 전환; 같은 대상에 이미 실행 중인 작업이 있으면 다른 operation도 동시에 Auth를 변경하지 못함 |
| Auth 변경 | 공식 `auth.admin.updateUserById(대상 UUID, {password})` 한 번 호출; 원본 Auth 응답을 클라이언트에 반환하지 않음 |
| 결과 기록 | 같은 operation·작업자에 대해 `succeeded`, `failed`, `uncertain` 중 하나 기록; 자신의 초기화로 세션이 삭제되어도 이미 시작한 결과는 service 경로로 기록 |

DB 감사와 Auth 변경은 서로 다른 트랜잭션입니다. 성공 응답만으로 전체 완료를 표시하지 않고 최종 감사 응답까지 확인합니다. 이미 성공한 operation을 다시 보낸 경우는 별도 코드로 표시하며, 이번에 입력한 다른 비밀번호가 적용됐다고 안내하지 않습니다.

| 결과 | 처리 |
| --- | --- |
| 권한·최근 인증·대상·요청 기록 거절 | Auth 변경 전 중단 |
| Auth의 명확한 정책 거절 | 실패로 기록하고 성공으로 표시하지 않음 |
| 네트워크·서버 오류, 반환 UUID 불일치, 최종 감사 불명 | `uncertain`; 자동 재시도나 새 operation으로 반복하지 않고 프로젝트 관리자가 Auth 로그와 operation 상태를 대조 |
| 성공 및 감사 확인 | 완료 표시; 대상 본인이 실제 배포 주소에서 새 비밀번호 로그인 확인 |

대화창을 닫거나 로그아웃·화면 이동 시 새 비밀번호 입력을 비우고 늦게 도착한 응답을 무시합니다. 불확실 결과는 현재 관리 창에서 추가 재설정을 차단합니다. 이것이 영구적인 계정 잠금은 아니며, 새 operation은 이전 결과를 조사한 뒤 별도 판단합니다. 자신의 비밀번호를 초기화했다면 로컬 로그인 상태도 정리하고 다시 로그인합니다. 브라우저 문자열을 메모리에서 즉시 완전 삭제한다는 보장은 하지 않습니다.

함수 중단으로 `executing`이 남으면 같은 대상의 다른 초기화가 차단됩니다. 신뢰한 프로젝트 관리자가 Auth 요청·로그·저장된 operation과 실제 대상 UUID를 조사한 뒤에만 service-only `staff_auth_owner_password_finish(작업 UUID, 저장된 작업자 UUID, 'uncertain')`로 불확실 상태를 기록할 수 있습니다. 확인되지 않은 성공·실패를 만들어 채우지 않습니다. 실제 진행 중인 Auth 호출이 종료됐는지 확인하기 전에는 새 초기화를 시작하지 않습니다. 브라우저에서 임의로 operation을 정리하는 기능은 없습니다.

## 세션·MFA와 감사의 한계

공식 Auth v2.197.0의 관리자 비밀번호 변경은 대상의 전체 native 세션과 대기 중 복구·재인증·주소 변경 토큰을 정리합니다. MFA factor를 제거하지는 않습니다. 관리자 API 자체는 일반 사용자 변경의 현재 비밀번호·nonce·MFA 재인증 검사를 대신 실행하지 않으므로, 위의 Owner·최근 인증·MFA 검사가 앱의 필수 경계입니다.

이미 발급된 access JWT는 만료까지 서명 검증을 통과할 수 있습니다. 새 Owner 관리 RPC는 세션 존재를 추가 확인하지만 기존 콘텐츠 전체에 그 검사를 새로 적용한 것은 아닙니다. 기존 콘텐츠는 현재 역할·정지 상태를 매 요청 검사하며, 비밀번호 초기화만으로 모든 업무의 JWT가 즉시 무효화됐다고 주장하지 않습니다. 실제 배포 Auth 버전과 refresh/access token 동작을 별도 확인합니다.

이력에는 operation UUID·대상 UUID·서버가 확인한 당시 Owner UUID/역할/확인 이름·변경 필드·사유만 남깁니다. 비밀번호·해시·토큰·이메일과 아이디·실명의 변경 전후 민감 값은 저장하지 않습니다. `source=owner_password_reset`이며 요청 감사의 실행자는 `authenticated_user`, 결과 감사의 실행자는 `staff_auth_edge_function`으로 요청자와 서버 실행을 구분합니다. 해당 Owner 자격을 사용한 실제 사람이 누구인지 DB만으로 증명하지 않습니다. 서비스 키·DB 소유자는 이 경계를 우회할 수 있어 별도 플랫폼 감사가 필요합니다.

이 경로는 복구 메일을 요청하지 않지만 프로젝트에서 비밀번호 변경 알림을 켰다면 Auth가 별도 알림을 보낼 수 있습니다.

새 operation과 감사에도 기존의 목적·접근·보관 기간·백업·삭제 검토를 적용합니다. 이 migration은 자동 정리 작업이나 임의의 무기한 보관 승인을 추가하지 않으며 기존 감사 행을 삭제하지 않습니다.

## 구현과 배포

| RPC | 호출 주체·계약 |
| --- | --- |
| `office_owner_account(p_user_id)` | 현재 세션·MFA를 확인한 Owner; 매핑된 한 대상의 UUID·아이디·실명·비밀번호 설정 불리언과 편집 상태만 조회 |
| `office_owner_update_identity(p_user_id, p_username, p_real_name, p_reason)` | 같은 Owner 경계; 동일 UUID의 아이디·실명과 필요한 정정 상태·감사를 같은 DB 트랜잭션에서 변경 |
| `office_owner_begin_password_reset(p_user_id, p_operation_id, p_reason)` | 실제 사용자 JWT; 추가 최근 AMR 확인 후 최대 5분 유효한 요청에 대상·작업자·세션을 결합. AMR의 15분 기한이 먼저 오면 더 일찍 만료 |
| `staff_auth_owner_password_claim(p_operation_id, p_actor_id)` | service role만; 저장된 실제 작업자와 현재 Owner·세션을 재확인하고 한 번 실행 권한 부여 |
| `staff_auth_owner_password_finish(p_operation_id, p_actor_id, p_state)` | service role만; 결합된 실행 작업의 결과 기록, 같은 최종 상태 재시도만 멱등 허용 |

| 위치 | 역할 |
| --- | --- |
| `supabase/migrations/20261015093911_owner_account_management.sql` | Owner 한정 관리·조회·수정·비밀번호 operation 및 감사 계약 |
| `src/scripts/owner-account-management.ts` | 계정별 대화창·입력·중복 제출·세션 변경 처리 |
| `src/scripts/admin-staff.ts`, `src/scripts/admin.ts` | 관계자 관리의 Owner 전용 진입과 대화창 수명 관리 |
| `supabase/functions/staff-auth/owner-password-reset.ts` | 일회 실행·공식 Auth Admin 변경·불확실 결과 처리 |

기존 identity migration을 다시 적용하지 않습니다. 신규 migration → 이를 이해하는 `staff-auth` → 새 UI 순서로 같은 검증 버전을 배포합니다. 새 공개/서버 비밀 설정은 추가하지 않으며 기존 `PUBLIC_STAFF_IDENTITY_ENABLED`, `STAFF_AUTH_ENABLED`, 서버 secret key·HMAC·Origin 설정을 사용합니다. service key를 공개 빌드에 넣지 않습니다.

문제가 생기면 새 관리 UI를 제거한 검증 버전으로 되돌리고 Owner 기능을 거절하는 안전한 gateway 버전을 사용합니다. 필요한 경우 기존 Owner fallback을 보존하며 전체 identity UI/gateway 플래그를 중지합니다. 새로운 service-only operation·감사와 UUID·콘텐츠는 유지하고 역할 직접 DML을 복구하거나 DB를 DROP하지 않습니다. 이미 실행 중이거나 불확실한 Auth 변경은 UI 롤백으로 취소되지 않으므로 operation을 먼저 대조합니다.

## 검증 결과

- `npm run check`: 72개 파일, 오류·경고·힌트 각각 0개.
- 새 화면 플래그 on의 가짜 공개 설정으로 `npm run build` 32페이지, `npm run export:preview` 32개 HTML. 별도 기존 화면 fixture 빌드도 통과했습니다.
- `ADMIN_TEST_DIST=dist-legacy npm test`: SQL 409개(기존 153 + identity 155 + Owner 101), Node 171개 통과·6개 건너뜀·실패 0개(총 177개).
- `STAFF_IDENTITY_TEST_DIST=dist node --test tests/staff-identity-app.test.mjs`: 위에서 건너뛴 새 화면 통합 6개 모두 통과했습니다.

자동 검사는 격리 DB·가짜 Auth/HTTP·메모리 DOM을 사용합니다. 단일 PGlite 연결 검사는 실제 여러 DB 연결의 잠금 경합을 입증하지 않습니다. 실제 운영 초기화·Owner 새 비밀번호 로그인·실기기 다국어 대화창·MFA step-up·세션 회수 검사는 아직 이 기능의 완료로 기록하지 않았습니다. 남은 실제 검사는 [검증표](STAFF_IDENTITY_TEST_MATRIX.md)에 구분합니다.

## 공식 근거

- [Admin updateUserById](https://supabase.com/docs/reference/javascript/auth-admin-updateuserbyid), [고정 버전 Admin 구현](https://github.com/supabase/auth/blob/v2.197.0/internal/api/admin.go): 서버 자격의 같은 UUID 비밀번호 변경.
- [UpdatePassword와 세션 정리](https://github.com/supabase/auth/blob/v2.197.0/internal/models/user.go#L434-L463), [세션과 JWT 만료](https://supabase.com/docs/guides/auth/sessions#how-to-ensure-an-access-token-jwt-cannot-be-used-after-a-user-signs-out): 세션 삭제와 stateless JWT의 차이.
- [getUser의 현재 세션 검사](https://github.com/supabase/auth/blob/v2.197.0/internal/api/auth.go#L118-L163), [MFA 규칙 강제](https://supabase.com/docs/guides/auth/auth-mfa#enforce-rules-for-mfa-logins): 서명 확인에 더해 앱이 강제할 민감 작업 경계.
