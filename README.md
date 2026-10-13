# 간사이 유나이티드 FC 홈페이지

[현재 사이트](https://ryukkani.github.io/kansai/)의 Astro·TypeScript·Tailwind CSS 소스입니다.
방문자에게 보이는 문구는 일본어로 유지하고, 코드의 주석과 편집 안내는 한국어로 작성합니다.

## 이번 단계의 원칙

사람이 직접 읽고 편집하기 쉽게 만드는 것이 기본 원칙입니다. 디자인 개편은 다음 단계에서 진행합니다.
기존 화면, 페이지 주소, 사진 원본과 기능을 유지하면서 반복 코드를 줄이고 편집 위치를 정리했습니다.
앞으로의 작업 원칙은 [AGENTS.md](AGENTS.md)에 있습니다.

현재는 디자인 확인용입니다. 모든 페이지의 `DESIGN PREVIEW` 표시와 `noindex, nofollow` 설정을 유지합니다.
선수 이름·등번호, 경기 일정·결과, 구단 연혁 등 확인되지 않은 정보는 게시하지 않습니다.

## 무엇을 어디서 편집하나요?

| 바꾸려는 내용 | 편집할 파일 |
| --- | --- |
| 구단명·로고 경로·Instagram·기본 페이지 설명 | `src/data/club.ts`의 `club` |
| 기사 제목·날짜·본문·사진·출처 | `src/data/club.ts`의 기사 객체와 `stories` |
| 홈 대표 기사·보조 기사·제목 줄바꿈 | `src/data/club.ts`의 `homeHighlights` |
| 뉴스 분류·필터 이름·분류 검색어 | `src/data/club.ts`의 `storyCategories` |
| 갤러리 사진·설명·출처 | `src/data/club.ts`의 `gallery` |
| 헤더·모바일·푸터 메뉴 문구와 주소 | `src/data/navigation.ts` |
| 홈 섹션 순서·상단 소개 | `src/pages/index.astro` |
| 홈 각 섹션의 구조·안내 문구 | `src/components/home/` |
| 공통 뉴스 카드·필터 | `src/components/NewsCard.astro`, `NewsFilters.astro` |
| 뉴스 목록·상세 페이지 구성 | `src/pages/news/index.astro`, `[slug].astro` |
| 공통 페이지 틀·메타 정보 | `src/layouts/SiteLayout.astro` |
| 검색·사진 확대 화면 | `src/components/SearchDialog.astro`, `PhotoDialog.astro` |
| 메뉴·필터·탭·검색·사진 확대 동작 | `src/scripts/site.ts` |
| 대표 색상·글꼴·공통 폭 | `src/styles/base.css`의 `@theme`와 공통 규칙 |
| 화면별 스타일 | `src/styles/header.css`, `home.css`, `footer.css`, `dialogs.css`, `news.css` |
| PC·태블릿·모바일 화면별 조정 | `src/styles/responsive.css` |
| 도메인·GitHub Pages 하위 경로 | `astro.config.mjs`의 `site`, `base` |
| 사진 원본 | `public/assets/` |
| 제목용 글꼴 원본 | `src/assets/fonts/barlow-condensed-bold.woff2` |

`global.css`는 스타일을 순서대로 불러오는 진입점입니다. 반응형 규칙은 기본 규칙 다음에 적용되므로
불러오는 순서와 화면 크기 구간의 순서를 유지합니다. 홈 섹션의 `id`는 메뉴의 `#섹션-id`와 연결됩니다.
반투명 색과 보조색은 해당 화면의 CSS에서, 브라우저 주소창 색은 `SiteLayout.astro`의 `theme-color`에서 조정합니다.

## 기사 추가·수정

1. `src/data/club.ts`에서 기존 기사 객체를 참고해 제목, 설명, 날짜, 사진, 본문, 출처를 작성합니다.
2. `id`는 기사 주소가 됩니다. 이미 공개된 기사는 제목을 수정해도 기존 `id`를 유지합니다.
3. `category`는 `storyCategories`에 등록된 값을 사용하고, 게시일은 `YYYY.MM.DD`로 적습니다.
4. `stories` 배열에 등록하면 뉴스 목록·검색·상세 페이지에 반영됩니다. 배열 순서가 목록 순서입니다.
5. 홈 상단 추천 영역은 `homeHighlights`에서 별도로 지정합니다. `titleLines`와 `summaryLines`의 각 항목이 한 줄입니다.

홈 뉴스 카드에만 다른 사진을 쓰려면 `homeCardImage`를 지정합니다. 없으면 기사의 `image`를 사용합니다.
갤러리 사진에는 대체 텍스트와 출처를 함께 적습니다. `Photo.astro`는 기본적으로 지연 로딩하며,
홈과 기사 상세의 대표 사진에만 높은 로딩 우선순위를 사용합니다.

## 개발과 확인

Node.js 22.12 이상인 짝수 버전을 사용합니다. 배포 환경은 Node.js 24입니다.

```sh
npm ci
npm run dev
```

수정 후 형식·타입 검사, 정적 페이지 빌드, 오프라인 미리보기를 확인합니다.

```sh
npm run check
npm run build
npm run export:preview
```

빌드한 사이트는 `npm run preview`로 확인합니다. 오프라인 미리보기는 `preview/index.html`을 직접 열면 됩니다.
홈, 뉴스 목록, 기사 상세의 다섯 페이지가 생성되며 CSS·스크립트·사진·글꼴을 HTML에 담습니다.
메뉴, 뉴스 검색·분류, 키보드 탭 전환, 사진 확대를 수정했다면 PC와 모바일에서 해당 기능을 확인합니다.

## 배포

GitHub Pages의 Source를 **GitHub Actions**로 설정하면 `main` 변경이 검사·빌드·배포됩니다.
PR은 검사·빌드만 수행합니다. 검토용 코드는 별도 브랜치에서 준비하고, 반영 시점을 정한 뒤 병합합니다.

`src/lib/urls.ts`의 `page()`와 `asset()`이 배포 하위 경로를 붙입니다.
오프라인 변환도 같은 Astro 설정을 읽으므로 `/kansai/`를 각 파일에 반복해서 적지 않습니다.

## 자료와 다음 단계

기사와 훈련 사진은 제공된 공식 Instagram 게시물 두 개를 바탕으로 했습니다.

- [10월 3일 훈련 게시물](https://www.instagram.com/p/DeTFBjBD0ab/) — 2026년 10월 9일 게시, 사진 두 장
- [9월 26일 훈련 게시물](https://www.instagram.com/p/Dd8ytlHjx75/) — 2026년 10월 1일 게시, 사진 두 장

사진 파일과 출처는 `public/assets/asset-sources.json`을 참조합니다.
사진의 검은 여백은 CSS에서만 잘라 보여주며 원본 바이트는 유지합니다.
구단 로고는 공식 프로필 이미지의 임시본입니다. 정식 공개 단계에서 고해상도 원본과 최종 원고를 반영합니다.
사진 사용은 요청된 구단·사진 권리자의 허가를 전제로 한 디자인 작업입니다.
제목용 Barlow Condensed 글꼴 라이선스는 `public/assets/fonts/OFL.txt`에 있습니다.

다음 디자인 단계의 참고 사이트는 [맨체스터 유나이티드](https://www.manutd.com/ko)와
[카라바흐 FK](https://qarabagh.com/en)입니다. 이번 단계에서는 새로운 디자인을 적용하지 않습니다.

선수단, 경기 일정·결과, 공식 영상, 관리자 기능, 데이터베이스와 별도 도메인은 이후 단계에서 다룹니다.
