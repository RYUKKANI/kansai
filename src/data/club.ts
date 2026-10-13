// [편집 안내] 구단 기본 정보와 기사·사진을 이 파일에서 관리합니다.
// 기사 내용은 제공된 공식 게시물을 요약한 것이며, 확인되지 않은 정보를 추가하지 않습니다.
export const club = {
  name: "関西ユナイテッドFC",
  englishName: "KANSAI UNITED FC",
  instagram: "https://www.instagram.com/kansai_united_fc/",
  logo: "assets/club-profile.jpg",
  instagramHandle: "@kansai_united_fc",
  description:
    "関西ユナイテッドFCの日本語公式サイト。ニュース、試合日程、選手プロフィール、写真・動画、参加案内をお届けします。",
};

// 분류를 추가하면 뉴스 필터에도 자동으로 반영됩니다. 검색어와 화면 표기도 함께 지정합니다.
export const storyCategories = {
  training: {
    badge: "TRAINING",
    label: "トレーニング",
    filterLabel: "トレーニング",
    searchTerms: "トレーニング 練習",
  },
  club: {
    badge: "CLUB",
    label: "クラブ情報",
    filterLabel: "クラブ",
    searchTerms: "クラブ 参加 募集",
  },
  match: {
    badge: "MATCH",
    label: "試合",
    filterLabel: "試合",
    searchTerms: "試合 結果 日程",
  },
  announcement: {
    badge: "NOTICE",
    label: "お知らせ",
    filterLabel: "お知らせ",
    searchTerms: "お知らせ 公告",
  },
} as const;

// id는 기사 주소에 사용하므로, 이미 공개된 기사는 제목을 바꿔도 id를 유지합니다.
export interface Story {
  id: string;
  category: keyof typeof storyCategories;
  label: string;
  title: string;
  summary: string;
  published: string; // 화면에 표시할 게시일: YYYY.MM.DD 형식
  activityDate?: string;
  image: string;
  homeCardImage?: string; // 홈의 뉴스 카드만 다른 사진을 쓰고 싶을 때 지정
  alt: string;
  source: string;
  paragraphs: string[];
  gallery: string[];
  featured?: boolean;
}

// 기사마다 이름을 붙여 홈·갤러리가 배열 순서에 의존하지 않도록 합니다.
const attackingTraining: Story = {
  id: "attacking-training",
  category: "training",
  label: "TRAINING REPORT",
  title: "ゴールを目指す、攻撃のトレーニング。",
  summary:
    "10月3日の練習は、攻撃をテーマに。動き出しからフィニッシュまでを意識しました。",
  published: "2026.10.09",
  activityDate: "2026年10月3日",
  image: "assets/training-october-01.jpg",
  homeCardImage: "assets/training-october-02.jpg",
  alt: "青空の下、服部緑地公園のピッチで練習する関西ユナイテッドFCのメンバー",
  source: "https://www.instagram.com/p/DeTFBjBD0ab/",
  paragraphs: [
    "10月3日の練習には、初参加の方を含めて14名が参加しました。基礎練習やパス練習のあと、ゴールを想定した攻撃に取り組みました。",
    "3対2＋GK、2対2＋GKでは、動き出し、パスのタイミング、フィニッシュを意識。最後のゲームでも、積極的にゴールを狙う場面が見られました。",
  ],
  gallery: ["assets/training-october-01.jpg", "assets/training-october-02.jpg"],
};

const defendingTraining: Story = {
  id: "defending-training",
  category: "training",
  label: "TRAINING REPORT",
  title: "雨のピッチで、守備を磨く。",
  summary: "9月26日の練習は、3対3で守備の寄せとカバーリングを意識しました。",
  published: "2026.10.01",
  activityDate: "2026年9月26日",
  image: "assets/training-september-01.jpg",
  alt: "照明のついた夜のピッチで行われた関西ユナイテッドFCの練習",
  source: "https://www.instagram.com/p/Dd8ytlHjx75/",
  paragraphs: [
    "9月26日は雨模様の中、初参加の方を含めて14名が集まりました。基礎練習、スクエアパス、鳥かご、3対3、ゲームに取り組みました。",
    "3対3では、守備の寄せの速さとカバーリングを意識。雨の中でも最後までボールを追いかけるメンバーの姿が見られました。",
  ],
  gallery: [
    "assets/training-september-01.jpg",
    "assets/training-september-02.jpg",
  ],
};

const joinUnited: Story = {
  id: "join-united",
  category: "club",
  label: "CLUB INFORMATION",
  title: "選手・コーチ・運営スタッフとして、チームへ。",
  summary:
    "参加や見学のご相談は、公式InstagramのDMへ。初参加は順番にご案内します。",
  published: "2026.10.09",
  image: "assets/training-october-02.jpg",
  alt: "関西ユナイテッドFCのメンバーがピッチでトレーニングする様子",
  source: "https://www.instagram.com/p/DeTFBjBD0ab/",
  paragraphs: [
    "公式Instagramでは、選手としての参加に加え、コーチ・指導者・運営としてチームに関わりたい方からのご相談を受け付けています。",
    "初参加の人数には上限があり、連絡順にご案内しています。現在の受付状況や参加条件は、公式InstagramのDMでご確認ください。",
  ],
  gallery: ["assets/training-october-02.jpg"],
};

// 뉴스 목록은 이 배열에 적힌 순서대로 표시됩니다. 기사 추가 시 여기에 등록합니다.
export const stories: Story[] = [
  attackingTraining,
  defendingTraining,
  joinUnited,
];

export interface GalleryPhoto {
  image: string;
  alt: string;
  label: string;
  source: string;
}

// 활동 사진을 추가할 때 대체 텍스트(alt), 짧은 설명(label), 출처(source)를 함께 적습니다.
export const gallery: GalleryPhoto[] = [
  {
    image: attackingTraining.image,
    alt: attackingTraining.alt,
    label: "10.03 / TRAINING",
    source: attackingTraining.source,
  },
  {
    image: "assets/training-october-02.jpg",
    alt: "10月3日の攻撃トレーニングの様子",
    label: "10.03 / ON THE PITCH",
    source: attackingTraining.source,
  },
  {
    image: defendingTraining.image,
    alt: defendingTraining.alt,
    label: "09.26 / TRAINING",
    source: defendingTraining.source,
  },
  {
    image: "assets/training-september-02.jpg",
    alt: "9月26日の夜間トレーニングの様子",
    label: "09.26 / UNDER THE LIGHTS",
    source: defendingTraining.source,
  },
];
