import { stories, gallery } from "../src/data/club.ts";
// [편집 안내] 기존 홈페이지의 콘텐츠만 CMS로 옮깁니다. 선수·경기·동의 기록을 새로 만들지 않습니다.
// 중복 실행 시 운영진이 수정한 내용을 덮어쓰지 않습니다.
const quote = (value) =>
  value === null || value === undefined
    ? "null"
    : "'" + String(value).replaceAll("'", "''") + "'";
const sql = [];
sql.push("begin;");
sql.push("do $$ declare october uuid; september uuid; begin");
for (const [variable, title, date, description] of [
  [
    "october",
    "10月3日 トレーニング",
    "2026-10-03",
    "攻撃をテーマにした練習の様子。",
  ],
  [
    "september",
    "9月26日 トレーニング",
    "2026-09-26",
    "雨のピッチで守備に取り組みました。",
  ],
]) {
  sql.push(
    "select id into " +
      variable +
      " from public.media_albums where title=" +
      quote(title) +
      " limit 1;",
  );
  sql.push(
    "if " +
      variable +
      " is null then insert into public.media_albums(title,description,captured_on,status) values(" +
      [title, description, date, "published"].map(quote).join(",") +
      ") returning id into " +
      variable +
      "; end if;",
  );
}
gallery.forEach((photo, index) => {
  const values = [
    photo.label,
    photo.image,
    photo.alt,
    photo.alt,
    photo.source,
    index < 2 ? "2026-10-03" : "2026-09-26",
  ]
    .map(quote)
    .join(",");
  sql.push(
    "insert into public.media_assets(title,legacy_path,alt_text,description,source_url,captured_on,album_id,status) select " +
      values +
      "," +
      (index < 2 ? "october" : "september") +
      ",'published' where not exists(select 1 from public.media_assets where legacy_path=" +
      quote(photo.image) +
      ");",
  );
});
sql.push("end $$;");
stories.forEach((story, index) => {
  const values = [
    story.id,
    story.title,
    story.summary,
    story.category,
    story.paragraphs.join("\n\n"),
    story.image,
    story.alt,
    story.source,
    index === 0 ? "2026-10-03" : index === 1 ? "2026-09-26" : null,
    story.published.replaceAll(".", "-") + "T00:00:00+09:00",
  ]
    .map(quote)
    .join(",");
  sql.push(
    "insert into public.articles(slug,title,summary,category,body,cover_path,cover_alt,source_url,activity_date,published_at,gallery_paths,featured,status) values(" +
      values +
      ",array[" +
      story.gallery.map(quote).join(",") +
      "]," +
      (index === 0 ? "true" : "false") +
      ",'published') on conflict(slug) do nothing;",
  );
});
for (const page of [
  [
    "club",
    "関西ユナイテッドFC",
    "ピッチでつながる。チームの今を、ここから。",
    "トレーニングの様子や参加に関する情報を、公式Instagramで発信しています。\n\n服部緑地公園での練習風景を紹介しています。選手・スタッフ、活動方針などの詳しいプロフィールは、確認された公式情報を掲載します。",
  ],
  [
    "join",
    "チームへの参加をお考えの方へ。",
    "プレーする、教える、運営を支える。",
    "選手・コーチ・運営スタッフとしての参加や見学のご相談は、公式InstagramのDMへ。\n\n初参加はご連絡順にご案内しています。現在の受付状況や参加条件は、DMでご確認ください。",
  ],
])
  sql.push(
    "insert into public.site_pages(id,title,introduction,body,status) values(" +
      page.map(quote).join(",") +
      ",'published') on conflict(id) do nothing;",
  );
sql.push("commit;");
process.stdout.write(JSON.stringify({ query: sql.join("\n") }));
