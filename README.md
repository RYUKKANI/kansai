# 関西ユナイテッドFC — Design preview

Astro・TypeScript・Tailwind CSSで制作した日本語サイトのデザイン確認版です。
公式Instagramの指定された2投稿から写真4点を使用しています。

## プレビュー

GitHub Pagesの設定で **Source → GitHub Actions** を選ぶと、`main`への更新を自動で検査・ビルド・配信します。

## 開発

Node.js 22.12以上の偶数バージョンを使用してください。

```sh
npm ci
npm run dev
```

```sh
npm run check
npm run build
```

## 内容

ホーム、ニュース一覧・記事詳細、ニュース検索・カテゴリ、試合情報、選手団の掲載予定枠、写真ギャラリー、クラブ紹介、参加案内を実装しています。PCとモバイルに対応します。

選手名・背番号・試合日程・結果は未確認のため掲載していません。動画は準備中です。Supabase、管理画面、独自ドメインは次の段階で接続します。

写真は権利者の許可を前提としたデザイン用途です。正式公開時に最終原稿とロゴ原本を反映します。現在は全ページに `DESIGN PREVIEW` と `noindex` を付けています。

写真・出典は `public/assets/asset-sources.json`、作業の引き継ぎは `README.txt` を参照してください。
