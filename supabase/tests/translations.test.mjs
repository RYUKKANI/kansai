import assert from "node:assert/strict";
import { officeDatabase } from "./office-database.mjs";
const { db, as, user } = await officeDatabase();
let checks = 0;
const check = (condition, message) => {
  assert.ok(condition, message);
  checks++;
};
const denied = async (sql, params = []) => {
  await assert.rejects(db.query(sql, params));
  checks++;
};
const complete = {
  ko: {
    title: "한국어 제목",
    summary: "요약",
    body: "한국어 본문",
    cover_alt: "사진 설명",
  },
  en: {
    title: "English title",
    summary: "Summary",
    body: "English body",
    cover_alt: "Description",
  },
};
const save = async (id, expected, values) =>
  (
    await db.query(
      "select public.save_office_content($1,$2,$3,$4,null) as item",
      ["articles", id, expected, values],
    )
  ).rows[0].item;
try {
  await as(3);
  const base = {
    slug: "test-only-multilingual",
    title: "日本語",
    summary: "概要",
    body: "本文",
    cover_alt: "説明",
    status: "draft",
  };
  let article = await save(null, null, {
    ...base,
    translations: { ko: { title: "작성 중" } },
  });
  check(
    article.translations.ko.title === "작성 중",
    "partial translation saved as draft",
  );
  await denied("update public.articles set status=$1 where id=$2", [
    "published",
    article.id,
  ]);
  for (const invalid of [
    { fr: { title: "No" } },
    { ko: ["No"] },
    { en: { title: 3 } },
    { en: { unexpected: "No" } },
    [],
    null,
    { en: { title: "x".repeat(201) } },
  ])
    await denied("update public.articles set translations=$1 where id=$2", [
      invalid,
      article.id,
    ]);
  await denied("select public.save_office_content('articles',$1,$2,$3,null)", [article.id, article.updated_at, { translations: complete, status: "published" }]);
  await as(1);
  article = await save(article.id, article.updated_at, {
    translations: complete,
    status: "published",
  });
  check(
    article.translations.en.body === "English body" &&
      article.status === "published",
    "three languages share one publication",
  );
  await as(null);
  const visible = (
    await db.query("select id,translations from public.articles where id=$1", [
      article.id,
    ])
  ).rows[0];
  check(
    visible.translations.ko.body === "한국어 본문",
    "published translation is available to anon",
  );
  await denied("update public.articles set translations=$1 where id=$2", [
    {},
    article.id,
  ]);
  await as(4);
  await denied("select public.save_office_content($1,$2,$3,$4,null)", [
    "articles",
    article.id,
    article.updated_at,
    { translations: complete },
  ]);
  await as(3);
  const state = (
    await db.query("select public.office_content_state($1,$2) as item", [
      "articles",
      article.id,
    ])
  ).rows[0].item;
  check(
    state.revisions.length === 2,
    "translation save captured in actual revision",
  );
  const publishedRevision = state.revisions[0];
  await denied("select public.save_office_content('articles',$1,$2,$3,null)", [article.id, article.updated_at, { translations: {}, status: "draft" }]);
  await as(1);
  article = await save(article.id, article.updated_at, {
    translations: {},
    status: "draft",
  });
  article = (
    await db.query("select public.restore_content_revision($1,$2) as item", [
      publishedRevision.id,
      article.updated_at,
    ])
  ).rows[0].item;
  check(
    article.translations.en.title === complete.en.title &&
      article.status === "draft",
    "restore includes translations and remains draft",
  );
  check(article.slug === base.slug, "restore keeps single URL");
  await as(null);
  check(
    (await db.query("select id from public.articles where id=$1", [article.id]))
      .rows.length === 0,
    "draft translations are private",
  );
  await as(1);
  let page = (
    await db.query(
      "select public.save_office_content('site_pages',null,null,$1,null) as item",
      [
        {
          id: "club",
          title: "クラブ",
          body: "本文",
          introduction: "概要",
          translations: {
            ko: { title: "구단", body: "내용", introduction: "소개" },
          },
          status: "published",
        },
      ],
    )
  ).rows[0].item;
  check(
    page.translations.ko.body === "내용",
    "club page uses same language editor contract",
  );
  await denied("update public.site_pages set translations=$1 where id=$2", [
    { ko: { title: "부분" } },
    "club",
  ]);
  // 운영 DB에는 생성하지 않는 테스트 사진과 선수입니다. 승인/동의/역할의 허용과 거부를 함께 확인합니다.
  await as(3);
  const path = user(3) + "/11111111-1111-4111-8111-111111111111.jpg";
  await db.query(
    "insert into storage.objects(bucket_id,name) values('kansai-media',$1)",
    [path],
  );
  await as(1);
  const photo = (
    await db.query(
      "insert into public.media_assets(title,alt_text,storage_path,consent_confirmed,status,media_category) values('Test photo','Test description',$1,true,'published','player') returning *",
      [path],
    )
  ).rows[0];
  const training = (
    await db.query(
      "insert into public.media_assets(title,alt_text,legacy_path,media_category,status) values('Existing training','Description','assets/training-october-01.jpg','training','published') returning *",
    )
  ).rows[0];
  await denied("update public.media_assets set media_category=$1 where id=$2", [
    "unknown",
    photo.id,
  ]);
  await as(4);
  await denied(
    "insert into public.players(internal_name,photo_asset_id) values($1,$2)",
    ["Test player", training.id],
  );
  const player = (
    await db.query(
      "insert into public.players(internal_name,photo_asset_id) values($1,$2) returning *",
      ["Test player", photo.id],
    )
  ).rows[0];
  check(
    player.photo_asset_id === photo.id,
    "coach can select an approved player photo",
  );
  check(
    (
      await db.query(
        "select * from public.public_player_profiles where player_id=$1",
        [player.id],
      )
    ).rows.length === 0,
    "registering player never auto publishes profile",
  );
  await denied("update public.media_assets set media_category=$1 where id=$2", ["training", photo.id]);
  await as(null);
  check(
    (
      await db.query(
        "select media_category from public.media_assets where id=$1",
        [photo.id],
      )
    ).rows[0].media_category === "player",
    "public category is safe metadata",
  );
  await denied("select photo_asset_id from public.players");
  await as(1);
  await denied(
    "insert into public.public_player_profiles(player_id,slug,display_name,position,photo_path,status) values($1,'test-only-profile','Test name','MF',$2,'published')",
    [player.id, path],
  );
  await db.query(
    "update public.players set profile_consent=true,photo_consent=true where id=$1",
    [player.id],
  );
  await db.query(
    "insert into public.public_player_profiles(player_id,slug,display_name,position,photo_path,status) values($1,'test-only-profile','Test name','MF',$2,'published')",
    [player.id, path],
  );
  await as(3);
  await denied("update public.media_assets set consent_confirmed=false,status=$1 where id=$2", ["draft", photo.id]);
  await as(1);
  await db.query(
    "update public.media_assets set consent_confirmed=false,status=$1 where id=$2",
    ["draft", photo.id],
  );
  await as(null);
  check(
    (await db.query("select player_id from public.public_player_profiles")).rows
      .length === 0,
    "withdrawn photo unpublishes linked profile",
  );
  await as(1);
  const internalPhotoPlayer = (
    await db.query(
      "insert into public.players(internal_name,photo_asset_id) values($1,$2) returning photo_asset_id",
      ["Other player", photo.id],
    )
  ).rows[0];
  check(
    internalPhotoPlayer.photo_asset_id === photo.id,
    "owner can link a private player photo internally without publishing it",
  );
  await as(4);
  const staffPrivatePhoto = (await db.query("insert into public.players(internal_name,photo_asset_id) values($1,$2) returning photo_asset_id", ["TEST Staff private draft", photo.id])).rows[0];
  check(staffPrivatePhoto.photo_asset_id === photo.id, "staff can select private photos for internal unpublished drafts");
  await as(1);
  await denied("delete from public.media_assets where id=$1", [photo.id]);
  console.log("Translation/photo PostgreSQL checks passed:", checks);
} finally {
  await db.close();
}
