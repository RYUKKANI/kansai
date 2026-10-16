// [편집 안내] 헤더·모바일 메뉴·푸터의 메뉴 이름과 링크를 한곳에서 관리합니다.
// path는 배포 경로를 제외한 상대 경로입니다. 홈 내부 이동에는 #섹션-id를 사용합니다.
// 팀 메뉴는 공개된 선수 프로필로 연결합니다. 스태프 공개 기록이 있다고 단정하지 않는 이름을 씁니다.
export const joinNavigation = {
  id: "join",
  label: "チームに参加",
  english: "JOIN US",
  path: "join/",
  footerLabel: "参加・お問い合わせ",
} as const;

export const navigation = [
  {
    id: "news",
    label: "ニュース",
    english: "NEWS",
    path: "news/",
    footerLabel: "ニュース",
  },
  {
    id: "matches",
    label: "試合情報",
    english: "MATCHES",
    path: "matches/",
    footerLabel: "試合情報",
  },
  {
    id: "team",
    label: "チーム",
    english: "TEAM",
    path: "team/",
    footerLabel: "チーム",
  },
  {
    id: "media",
    label: "メディア",
    english: "MEDIA",
    path: "media/",
    footerLabel: "メディア",
  },
  {
    id: "club",
    label: "クラブ",
    english: "CLUB",
    path: "club/",
    footerLabel: "クラブについて",
  },
  joinNavigation,
] as const;

// PC 헤더의 참여 메뉴는 별도 버튼으로 표시합니다. 모바일 메뉴와 푸터에는 모두 표시합니다.
export const headerNavigation = navigation.filter((item) => item.id !== "join");
