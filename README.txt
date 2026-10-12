간사이 유나이티드 FC 일본어 홈페이지 — 디자인 1차본

현재 단계
- Astro + TypeScript + Tailwind CSS로 만든 프론트엔드입니다.
- PC 중심 레이아웃과 모바일 반응형 화면을 함께 구성했습니다.
- 대표 뉴스, 보조 뉴스 2개, Match Centre, Latest News, 선수단 프리뷰,
  United Media, 구단 소개, 참여 안내, 푸터가 있습니다.
- 뉴스 목록/상세, 뉴스 분류와 검색, 사진 확대, 모바일 메뉴가 동작합니다.
- 구단 로고는 공식 Instagram 프로필 이미지(150px)를 임시로 사용했습니다.

사용한 자료
1. https://www.instagram.com/p/DeTFBjBD0ab/
   훈련일: 2026-10-03 / 게시일: 2026-10-09 / 사진 2장
2. https://www.instagram.com/p/Dd8ytlHjx75/
   훈련일: 2026-09-26 / 게시일: 2026-10-01 / 사진 2장

일본어 기사는 위 게시물에서 확인한 내용을 요약했습니다.
사진 원본은 그대로 보관하고, 원본의 검은 여백은 화면에서만 잘라 보여줍니다.
사진 사용은 사용자가 요청한 구단·사진 권리자 허가 전제의 디자인 작업입니다.
공개 전에는 고해상도 로고 원본과 최종 사용 허가를 반영하면 됩니다.

미정 정보
- 선수 이름, 등번호, 시즌, 대진, 경기 결과, 구단 연혁을 생성하지 않았습니다.
- 선수단은 식별 가능한 실제 인물 없는 자리 표시자로 구성했습니다.
- 경기 정보는 미발표, 영상은 준비 중으로 표시합니다.
- YouTube 영상 ID가 없어 실제 영상은 연결하지 않았습니다.
- 공식 슬로건을 만들지 않았습니다.

유지한 다음 단계
- GitHub 저장소: https://github.com/RYUKKANI/kansai
- GitHub Pages 자동 배포: main 브랜치의 변경을 자동 빌드·배포
- 별도 구매 도메인 연결: 나중에 진행
- Supabase / Auth / Storage: 뉴스·선수·시즌·경기 관리자 기능 단계에서 연결
- 영상: 구단 공식 YouTube 영상 임베드
- 현재 단계는 디자인 확인용 사이트이며, 도메인 구매와 데이터베이스 연결은 하지 않습니다.

개발 환경에서 보기
추가 설치 없이 디자인만 확인하려면 preview/index.html을 브라우저로 여세요.
뉴스 상세·검색·분류·사진 확대·모바일 메뉴도 이 미리보기에서 동작합니다.

Node.js 22.12 이상(짝수 버전)을 준비한 후 프로젝트 폴더에서:
  npm ci
  npm run dev

검사와 빌드:
  npm run check
  npm run build
  npm run preview

오프라인 미리보기를 다시 만들려면 빌드 후 npm run export:preview를 실행하세요.

주요 편집 위치
- src/pages/index.astro: 홈페이지 구성
- src/styles/global.css: 색상·타이포그래피·반응형 디자인
- src/data/club.ts: 게시물 기반 기사와 사진 정보
- public/assets/: 확보한 공식 사진과 프로필 로고
- src/components/: 헤더, 푸터, 사진, 아이콘

디자인 참고
콘텐츠 중심 탐색과 뉴스/경기/미디어 흐름만 참고했습니다:
https://www.manutd.com/ko
맨체스터 유나이티드의 로고·사진·고유 그래픽은 사용하지 않았습니다.
영문 제목 폰트: Barlow Condensed. 라이선스는 public/assets/fonts/OFL.txt.

디자인 확인용이므로 모든 페이지에 noindex와 DESIGN PREVIEW 표시가 있습니다.
