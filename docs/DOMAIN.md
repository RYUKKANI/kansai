# kansaiunited.com 연결

공개 홈페이지는 https://kansaiunited.com/, 관리자는 https://kansaiunited.com/admin/을 사용합니다.
Astro의 `site`와 `base`, `public/CNAME`, 정기 발행 확인 주소, 관리자 인증·초대 주소를 함께 관리합니다.

## 전환 순서

현재 DNS가 정상 응답하지 않는 동안에는 이 변경을 main에 병합하거나 Pages의 운영 도메인을 전환하지 않습니다.
2026-10-15 확인 당시 가비아 네임서버가 위임되어 있으나 공개 DNS 조회는 SERVFAIL이었습니다.
운영 전환은 아래 항목을 준비한 다음 짧은 작업 시간에 진행합니다.

1. 가비아의 My가비아 → DNS 관리툴에서 도메인의 DNS 서비스가 활성화되었는지 확인하고 아래 레코드를 준비합니다. 기존 메일용 MX·TXT 레코드는 유지합니다.
2. Supabase 프로젝트 `hjuhdmjavvuihztbfisc`의 Authentication → URL Configuration에서 새 관리자 주소를 Redirect URLs에 추가합니다. 기존 주소는 전환 확인까지 유지합니다. `config.toml` 수정만으로 호스팅 프로젝트 설정이 바뀌지는 않습니다.
3. GitHub 저장소 Settings → Pages → Custom domain에 `kansaiunited.com`을 저장하고, 준비한 가비아 DNS 레코드를 적용합니다. 네임서버를 GitHub 주소로 바꾸지 않습니다. 운영 주소 저장 후 기존 GitHub 주소도 새 도메인으로 리디렉션되므로 DNS 오류를 먼저 해소해야 합니다.
4. DNS가 GitHub Pages를 가리키는지 확인하고 이 변경을 main에 병합해 기존 Actions로 배포합니다. 루트 경로 변경과 Custom domain 적용은 함께 진행해야 합니다.
5. 인증서 발급이 완료되면 Pages의 Enforce HTTPS를 켜고, Supabase Site URL을 `https://kansaiunited.com/`으로 변경합니다. 새 `invite-staff` 함수를 배포합니다. 함수 소스 변경도 GitHub Pages 배포만으로는 적용되지 않습니다.
6. 공개 홈·기사·선수·일본어/한국어/영어 메뉴·사진·관리자 비밀번호 로그인을 확인합니다. 로그인 메일 전송과 운영진 초대는 실제 수신자를 지정한 별도 요청이 있을 때만 시험합니다. 전환 확인 후 Auth의 예전 redirect URL을 제거합니다.

GitHub Actions로 배포하므로 `public/CNAME`은 도메인 기록용이며, 이 파일만 추가해도 Pages의 Custom domain이 자동 변경되지는 않습니다.
새 도메인은 브라우저 저장 공간이 달라서 기존 관리자 세션을 그대로 읽을 수 없습니다. 새 관리자 주소에서 다시 로그인합니다.

## 가비아 DNS 값

| 종류 | 호스트 | 값 |
| --- | --- | --- |
| A | @ | 185.199.108.153 |
| A | @ | 185.199.109.153 |
| A | @ | 185.199.110.153 |
| A | @ | 185.199.111.153 |
| CNAME | www | ryukkani.github.io. |

같은 호스트의 파킹용 A·AAAA 레코드가 있으면 GitHub Pages 값으로 정리합니다. CNAME 대상에는 저장소 경로 `/kansai`를 넣지 않습니다.
IPv6를 사용한다면 GitHub 공식 문서의 AAAA 레코드 네 개를 함께 적용합니다. 불필요한 wildcard 레코드는 만들지 않습니다.

문제가 있으면 Pages의 Custom domain과 Astro의 site/base를 이전 값으로 함께 되돌리고, Auth 및 초대 함수도 이전 주소로 복구합니다.

## 공식 문서

- [GitHub Pages 사용자 지정 도메인](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site)
- [Astro GitHub Pages 배포](https://docs.astro.build/en/guides/deploy/github/)
- [Supabase 인증 Redirect URL](https://supabase.com/docs/guides/auth/redirect-urls)
- [가비아 DNS 레코드 설정](https://customer.gabia.com/manual/38/3041/3040)
