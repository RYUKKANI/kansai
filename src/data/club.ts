// Editorial copy is summarized from the two posts supplied by the user.
// No player names, results, fixtures, or club history have been invented.
export const club = {
  name: '関西ユナイテッドFC',
  englishName: 'KANSAI UNITED FC',
  instagram: 'https://www.instagram.com/kansai_united_fc/',
  logo: 'assets/club-profile.jpg',
};

export interface Story {
  id: string;
  category: 'training' | 'club';
  label: string;
  title: string;
  summary: string;
  published: string;
  activityDate?: string;
  image: string;
  alt: string;
  source: string;
  paragraphs: string[];
  gallery: string[];
}

export const stories: Story[] = [
  {
    id: 'attacking-training',
    category: 'training',
    label: 'TRAINING REPORT',
    title: 'ゴールを目指す、攻撃のトレーニング。',
    summary: '10月3日の練習は、攻撃をテーマに。動き出しからフィニッシュまでを意識しました。',
    published: '2026.10.09',
    activityDate: '2026年10月3日',
    image: 'assets/training-october-01.jpg',
    alt: '青空の下、服部緑地公園のピッチで練習する関西ユナイテッドFCのメンバー',
    source: 'https://www.instagram.com/p/DeTFBjBD0ab/',
    paragraphs: [
      '10月3日の練習には、初参加の方を含めて14名が参加しました。基礎練習やパス練習のあと、ゴールを想定した攻撃に取り組みました。',
      '3対2＋GK、2対2＋GKでは、動き出し、パスのタイミング、フィニッシュを意識。最後のゲームでも、積極的にゴールを狙う場面が見られました。',
    ],
    gallery: ['assets/training-october-01.jpg', 'assets/training-october-02.jpg'],
  },
  {
    id: 'defending-training',
    category: 'training',
    label: 'TRAINING REPORT',
    title: '雨のピッチで、守備を磨く。',
    summary: '9月26日の練習は、3対3で守備の寄せとカバーリングを意識しました。',
    published: '2026.10.01',
    activityDate: '2026年9月26日',
    image: 'assets/training-september-01.jpg',
    alt: '照明のついた夜のピッチで行われた関西ユナイテッドFCの練習',
    source: 'https://www.instagram.com/p/Dd8ytlHjx75/',
    paragraphs: [
      '9月26日は雨模様の中、初参加の方を含めて14名が集まりました。基礎練習、スクエアパス、鳥かご、3対3、ゲームに取り組みました。',
      '3対3では、守備の寄せの速さとカバーリングを意識。雨の中でも最後までボールを追いかけるメンバーの姿が見られました。',
    ],
    gallery: ['assets/training-september-01.jpg', 'assets/training-september-02.jpg'],
  },
  {
    id: 'join-united',
    category: 'club',
    label: 'CLUB INFORMATION',
    title: '選手・コーチ・運営スタッフとして、チームへ。',
    summary: '参加や見学のご相談は、公式InstagramのDMへ。初参加は順番にご案内します。',
    published: '2026.10.09',
    image: 'assets/training-october-02.jpg',
    alt: '関西ユナイテッドFCのメンバーがピッチでトレーニングする様子',
    source: 'https://www.instagram.com/p/DeTFBjBD0ab/',
    paragraphs: [
      '公式Instagramでは、選手としての参加に加え、コーチ・指導者・運営としてチームに関わりたい方からのご相談を受け付けています。',
      '初参加の人数には上限があり、連絡順にご案内しています。現在の受付状況や参加条件は、公式InstagramのDMでご確認ください。',
    ],
    gallery: ['assets/training-october-02.jpg'],
  },
];

// Future seasons, players, and matches remain empty until official data is supplied.
export const fixtures = [];
export const players = [];
export const videos = [];

export const gallery = [
  { image: 'assets/training-october-01.jpg', alt: stories[0]!.alt, label: '10.03 / TRAINING', source: stories[0]!.source },
  { image: 'assets/training-october-02.jpg', alt: '10月3日の攻撃トレーニングの様子', label: '10.03 / ON THE PITCH', source: stories[0]!.source },
  { image: 'assets/training-september-01.jpg', alt: stories[1]!.alt, label: '09.26 / TRAINING', source: stories[1]!.source },
  { image: 'assets/training-september-02.jpg', alt: '9月26日の夜間トレーニングの様子', label: '09.26 / UNDER THE LIGHTS', source: stories[1]!.source },
];
