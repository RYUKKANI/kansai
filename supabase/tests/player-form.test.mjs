import assert from "node:assert/strict";
import { officeDatabase } from "./office-database.mjs";
// 선수·사진은 격리된 테스트 DB 안에만 만듭니다. 실제 구단 자료를 추가하지 않습니다.
const { db, as, user } = await officeDatabase();
let checks = 0;
const check = (value, label) => {
  assert.ok(value, label);
  checks++;
};
const denied = async (args, pattern) => {
  await assert.rejects(save(args), pattern);
  checks++;
};
const id = (n) => "10000000-0000-4000-8000-" + String(n).padStart(12, "0");
const person = {
  internal_name: "Test only internal",
  activity_status: "active",
  profile_consent: false,
  photo_consent: false,
};
const details = (n) => ({
  slug: "test-only-" + n,
  display_name: "Test only public",
  romanized_name: "Test",
  jersey_number: 8,
  position: "MF",
  bio: "Test only biography",
  activity_status: "active",
  display_order: 0,
});
const save = async (v) =>
  (
    await db.query(
      "select public.save_player_office($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) as item",
      [
        v.id,
        v.expected ?? null,
        v.profileExpected ?? null,
        v.player ?? person,
        v.profile ?? null,
        v.photoId ?? null,
        v.photoChanged ?? false,
        v.upload ?? null,
        v.photoExpected ?? null,
        v.status ?? "draft",
      ],
    )
  ).rows[0].item;
const counts = async () =>
  (
    await db.query(
      "select (select count(*) from public.players) players,(select count(*) from public.public_player_profiles) profiles,(select count(*) from public.media_assets) photos",
    )
  ).rows[0];
async function object(n, owner = 1) {
  const path = user(owner) + "/" + id(n) + ".jpg";
  await db.query(
    "insert into storage.objects(bucket_id,name) values('kansai-media',$1)",
    [path],
  );
  return {
    id: id(n),
    storage_path: path,
    title: "Test photo",
    alt_text: "Test only photo",
    captured_on: null,
  };
}
try {
  await as(1);
  const upload = await object(101);
  const draft = await save({
    id: id(1),
    profile: details(1),
    photoChanged: true,
    upload,
  });
  check(
    draft.player_id === id(1) && draft.photo_asset_id === upload.id,
    "one UUID links registration, profile and uploaded photo",
  );
  check(
    (await counts()).players === 1 &&
      (await counts()).profiles === 1 &&
      (await counts()).photos === 1,
    "one save creates all three rows",
  );
  check(
    (
      await db.query(
        "select media_category,status,consent_confirmed from public.media_assets",
      )
    ).rows[0].media_category === "player",
    "uploaded photo category is automatic",
  );
  await as(null);
  check(
    (await db.query("select player_id from public.public_player_profiles")).rows
      .length === 0,
    "draft profile is private",
  );
  check(
    (await db.query("select id from public.media_assets")).rows.length === 0,
    "draft photo is private",
  );
  await denied({ id: id(2), profile: details(2) }, /permission/);
  await as(1);
  await denied({ id: id(1), profile: details(1) }, /changed/);
  check(
    (await counts()).players === 1,
    "retry after uncertain save does not duplicate a player",
  );
  const failedPhoto = await object(102);
  await denied(
    {
      id: id(2),
      profile: { ...details(2), slug: "Invalid slug" },
      photoChanged: true,
      upload: failedPhoto,
    },
    /check constraint/,
  );
  check(
    (await counts()).players === 1 && (await counts()).photos === 1,
    "bad profile rolls back player and photo records",
  );
  await denied(
    {
      id: id(2),
      profile: details(2),
      photoChanged: true,
      upload: failedPhoto,
      status: "published",
    },
    /profile consent/,
  );
  check(
    (await counts()).photos === 1,
    "missing consent rolls back photo insertion",
  );
  await denied(
    {
      id: id(2),
      player: { ...person, profile_consent: true },
      profile: details(2),
      photoChanged: true,
      upload: failedPhoto,
      status: "published",
    },
    /photo consent/,
  );
  const published = await save({
    id: id(2),
    player: { ...person, profile_consent: true, photo_consent: true },
    profile: details(2),
    photoChanged: true,
    upload: failedPhoto,
    status: "published",
  });
  check(
    published.profile_status === "published",
    "owner publishes profile and photo together with both consents",
  );
  await as(null);
  check(
    (
      await db.query(
        "select player_id,photo_path from public.public_player_profiles",
      )
    ).rows[0].photo_path === failedPhoto.storage_path,
    "approved photo reaches public profile",
  );
  check(
    (await db.query("select id from public.media_assets")).rows.length === 1,
    "only published photo is public",
  );
  await assert.rejects(db.query("select internal_name from public.players"));
  checks++;
  await as(3);
  const editorialStaffDraft = await save({ id: id(13), profile: details(13) });
  check(editorialStaffDraft.profile_status === "draft", "legacy editor shares staff player draft access");
  await as(5);
  await denied({ id: id(3), profile: details(3) }, /permission/);
  await as(4);
  const photo = (
    await db.query("select updated_at from public.media_assets where id=$1", [
      failedPhoto.id,
    ])
  ).rows[0];
  const coachDraft = await save({
    id: id(3),
    profile: details(3),
    photoChanged: true,
    photoId: failedPhoto.id,
    photoExpected: photo.updated_at,
  });
  check(
    coachDraft.photo_asset_id === failedPhoto.id,
    "staff can choose an approved player photo in the same form",
  );
  await denied(
    {
      id: id(4),
      player: { ...person, profile_consent: true },
      profile: details(4),
      status: "published",
    },
    /approval|owner_publication_required/,
  );
  await denied(
    { id: id(4), profile: details(4), photoChanged: true, upload },
    /upload/,
  );
  const privatePhotoVersion = (await db.query("select updated_at from public.media_assets where id=$1", [upload.id])).rows[0].updated_at;
  const privatePhotoDraft = await save({ id: id(14), profile: details(14), photoChanged: true, photoId: upload.id, photoExpected: privatePhotoVersion });
  check(privatePhotoDraft.photo_asset_id === upload.id && privatePhotoDraft.profile_status === "draft", "shared staff may select a private photo for an unpublished draft only");
  await as(1);
  await denied(
    { id: id(5), player: { ...person, role: "owner" } },
    /unsupported/,
  );
  await denied(
    { id: id(5), profile: { ...details(5), approved_by: user(1) } },
    /unsupported/,
  );
  await denied(
    {
      id: id(5),
      photoChanged: true,
      upload: {
        ...upload,
        id: id(105),
        storage_path: user(2) + "/" + id(105) + ".jpg",
      },
    },
    /upload/,
  );
  const oldPlayer = (
    await db.query("select * from public.players where id=$1", [id(2)])
  ).rows[0];
  const oldProfile = (
    await db.query(
      "select * from public.public_player_profiles where player_id=$1",
      [id(2)],
    )
  ).rows[0];
  await denied(
    {
      id: id(2),
      expected: oldPlayer.updated_at,
      profileExpected: "2000-01-01T00:00:00Z",
      profile: details(2),
    },
    /changed/,
  );
  const oldPhoto = (
    await db.query("select * from public.media_assets where id=$1", [
      failedPhoto.id,
    ])
  ).rows[0];
  await denied(
    {
      id: id(2),
      expected: oldPlayer.updated_at,
      profileExpected: oldProfile.updated_at,
      player: { ...person, profile_consent: true, photo_consent: true },
      profile: details(2),
      photoExpected: "2000-01-01T00:00:00Z",
      status: "published",
    },
    /changed/,
  );
  await denied(
    {
      id: id(2),
      expected: oldPlayer.updated_at,
      profileExpected: oldProfile.updated_at,
      player: { ...person, profile_consent: true, photo_consent: true },
      profile: { ...details(2), slug: "changed-url" },
      photoExpected: oldPhoto.updated_at,
      status: "published",
    },
    /immutable/,
  );
  check(
    (
      await db.query(
        "select status from public.public_player_profiles where player_id=$1",
        [id(2)],
      )
    ).rows[0].status === "published",
    "failed published edit preserves old publication",
  );
  await save({
    id: id(2),
    expected: oldPlayer.updated_at,
    profileExpected: oldProfile.updated_at,
    profile: details(2),
    player: person,
  });
  await as(null);
  check(
    (await db.query("select player_id from public.public_player_profiles")).rows
      .length === 0,
    "withdrawn consent hides the profile",
  );
  await as(2);
  const internal = await save({ id: id(6) });
  check(
    internal.profile_status === null,
    "registration alone remains supported without creating a public profile",
  );
  console.log(`Player single-form SQL checks: ${checks} passed`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await db.close();
}
