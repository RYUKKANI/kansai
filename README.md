# 간사이 유나이티드 FC 공식 홈페이지

Astro 7·TypeScript·Tailwind CSS로 만드는 일본어 공식 홈페이지입니다.
GitHub Pages에서 <https://kansaiunited.com/>으로 제공하고 운영진은 Supabase 관리자에서 콘텐츠를 편집합니다.
사람이 읽고 편집하기 쉬운 코드와 한국어 주석을 기본 원칙으로 합니다.

## 콘텐츠 편집

공식 관리자 주소는 <https://kansaiunited.com/admin/>입니다. 로그인 아이디와 비밀번호로 로그인하며, 회원가입에 이메일은 필요하지 않습니다. 가입 승인과 계정 복구는 총괄(Owner)가 본인 확인 후 처리합니다. [이메일 없는 계정 운영 안내](docs/STAFF_NO_EMAIL_20261016.md)를 참고하세요.
공개 메뉴에는 관리자 링크를 넣지 않습니다. 실제 접근 권한은 데이터베이스 RLS로 제한합니다.

| 작업 | 관리자 메뉴 |
| --- | --- |
| 기사 작성·수정·삭제, 초안·발행·발행 취소, 추천 기사 | 뉴스 |
| 영구 선수 UUID, 활동 상태, 공개 동의 여부 | 선수 등록·동의 |
| 이름·등번호·포지션·사진·소개·표시 순서, 공개 승인 | 공개 프로필 |
| 경기 일정·결과·변경·취소·리포트 | 경기 |
| 훈련 시간·장소·운영 메모 | 훈련 예정 |
| 사진 업로드·영상 URL·앨범·공개 상태 | 사진·영상, 앨범 |
| 구단 소개·참가 안내 문구 | 구단·참가 안내 |
| 가입 승인·계정 복구·역할 변경·접근 비활성화 | 운영 멤버 (총괄) |

기사와 선수 프로필의 URL은 첫 발행 후 변경할 수 없습니다. 이름과 제목을 바꿔도 기존 링크를 유지합니다.
URL은 영문 소문자·숫자·하이픈으로 지정합니다. 본문은 빈 줄로 문단을 나누며 HTML은 텍스트로 처리합니다.
선수의 내부 정보와 공개 프로필은 분리합니다. 스태프는 초안을 작성하고 총괄이 공개합니다. 선수는 본인 정보와 공개 일정을 조회합니다.
연락처·출석·평가·건강 정보는 공개 홈페이지에 연결하지 않습니다.
기존 사진 네 장은 유지하고, 새 업로드는 공개용으로 확인한 뒤 발행합니다.

## 코드 편집 위치

| 수정할 내용 | 위치 |
| --- | --- |
| 구단명·로고·공식 Instagram·뉴스 분류 | src/data/club.ts |
| 공개 데이터를 읽는 방법과 허용 필드 | src/data/cms.ts |
| 헤더·모바일·푸터 메뉴 | src/data/navigation.ts |
| 홈페이지 섹션 순서 | src/pages/index.astro |
| 추천 뉴스·경기·선수단·미디어·구단 안내 | src/components/home/ |
| 독립 페이지 | src/pages/team/, matches/, media/, club/, join/ |
| 관리자 양식의 항목·라벨·메뉴 역할 | src/lib/admin-config.ts |
| 관리자 로그인·편집·저장 | src/scripts/admin.ts |
| 메뉴·검색·필터·탭·사진 확대·YouTube | src/scripts/site.ts |
| 기본 색상·글꼴 | src/styles/base.css |
| 독립 페이지·카드·모바일 스타일 | src/styles/pages.css |
| 관리자 스타일 | src/styles/admin.css |
| 데이터 구조·RLS·게시 승인·감사 이력 | supabase/migrations/ |
| 아이디 인증·계정 복구 서버 함수 | supabase/functions/staff-auth/ |
| 배포와 정기 재구축 | .github/workflows/deploy.yml |

CMS 연결을 끄면 club.ts의 기존 기사·사진을 사용합니다. 연결 후에는 관리자 데이터가 기준입니다.
public/assets/는 수동 원본, public/cms-assets/는 빌드마다 생성하는 공개 사진 복사본입니다.
자동 생성 폴더에 직접 파일을 보관하지 않습니다.

## 개발과 검증

Node.js 24를 사용합니다. 의존성 버전과 잠금 파일을 함께 관리합니다.

~~~sh
npm ci
npm run dev
npm run test:parts
npm run test:dashboard
~~~

수정한 기능의 `test:<파트 ID>` 명령으로 필요한 테스트용 빌드를 준비하고 해당 파트만 검사합니다. 준비와 실행을 나누거나 여러 파트를 함께 고쳤다면 `npm run test:prepare -- --parts members,players` 후 `npm test -- --parts members,players`처럼 선택합니다.
화면·번들을 바꾸면 `npm run check`, `npm run build`, `npm run export:preview`로 공통 생성 결과도 확인합니다.
파트별 범위, CI의 변경 파일 선택, 새 테스트 등록은 [기능별 검사 안내](docs/PART_CHECKS.md)를 참고하세요.

.env.example을 .env로 복사하고 간사이 프로젝트 URL과 **publishable key**를 설정합니다.
PUBLIC_CMS_ENABLED=true이면 실제로 발행한 공개 데이터를 빌드합니다.
연결 이후 조회 실패는 빌드를 중단합니다. secret/service_role key를 브라우저·저장소·빌드 환경에 넣지 않습니다.

npm run preview는 빌드된 사이트를 확인합니다. preview/index.html은 CSS·사진·글꼴·스크립트를 포함한 파일 미리보기입니다.
관리자 로그인과 실제 저장은 웹으로 제공되는 관리자 주소에서 사용합니다.
`npm test -- --part <파트>`는 선택한 업무의 PostgreSQL 권한과 빌드 UI를 검사합니다. 인자 없는 `npm test`는 목록·사용법만 보여줍니다. 전체 회귀 검사는 명시적으로 필요할 때 `npm run test:full`로 실행합니다.
UI 테스트는 서버 응답을 대체하며 화면 배치를 확인하지 않습니다.
실제 DB 권한 검사는 supabase/tests/remote-permissions.sql로 별도 실행하고 테스트 행을 전부 롤백합니다.
실제 공개 API는 공개 환경 변수를 설정한 뒤 node scripts/verify-public-api.mjs로 검사합니다.

## 반영과 배포

자체 도메인 연결과 전환 순서는 [도메인 운영 안내](docs/DOMAIN.md)를 확인합니다.
GitHub Actions 배포에서는 `public/CNAME`만으로 Pages 설정이 바뀌지 않으므로 저장소의 Custom domain도 설정합니다.

GitHub Actions Variables에 다음 값을 설정합니다.

- PUBLIC_CMS_ENABLED: true
- PUBLIC_SUPABASE_URL: 간사이 프로젝트 URL
- PUBLIC_SUPABASE_PUBLISHABLE_KEY: 간사이 publishable key

PR의 CI는 변경 파일과 공통 의존 관계로 파트를 선택해 각각 검사합니다. 문서만 바꾸면 빌드·배포·업무 검사를 생략합니다. 운영 배포는 main에서만 합니다.
발행 내용은 보통 15분 간격의 재구축으로 반영되며 GitHub 작업 지연으로 더 늦어질 수 있습니다.
변경이 없으면 예약 빌드를 건너뜁니다. 관리자에서 발행 상태와 공개 사이트의 반영 상태를 구분합니다.
즉시 반영할 때는 공식 배포 workflow를 main에서 수동 실행합니다. 검사 파트의 기본 선택은 `dashboard`이며, 공개 콘텐츠 반영에는 `public`을 선택합니다. 전체 검사가 필요하면 `all`을 명시합니다.

공개 사진을 비공개로 바꾸면 연결된 기사·프로필도 비공개로 전환하고 다음 배포에서 생성 파일을 제거합니다.
기존 배포와 방문자 캐시는 재구축 전에 남을 수 있습니다. 즉시 철회가 필요하면 수동 재구축과 캐시를 점검합니다.
원본인 public/assets/ 파일은 CMS가 직접 삭제하지 않습니다.

계정·메일·백업은 [운영 안내](docs/OPERATIONS.md),
데이터 반영 방식은 [시스템 구조](docs/ARCHITECTURE.md),
선수 관리 프로그램의 연동 계약은 [연동 명세](docs/PLAYER_INTEGRATION.md)에 있습니다.
