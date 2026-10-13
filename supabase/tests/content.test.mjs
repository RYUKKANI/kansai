import assert from "node:assert/strict";
import { officeDatabase } from "./office-database.mjs";
const { db, as, user } = await officeDatabase();
let checks = 0;
const check = (condition, message) => {
  assert.ok(condition, message);
  checks++;
};
const reject = async (sql, args = []) => {
  await assert.rejects(db.query(sql, args));
  checks++;
};
async function save(entity, id, expected, values, at = null) {
  return (
    await db.query(
      "select public.save_office_content($1,$2,$3,$4,$5) as item",
      [entity, id, expected, values, at],
    )
  ).rows[0].item;
}
async function state(entity, id) {
  return (
    await db.query("select public.office_content_state($1,$2) as item", [
      entity,
      id,
    ])
  ).rows[0].item;
}
async function service() {
  await db.exec("set role service_role");
  await db.query("select set_config('request.jwt.claim.sub','',false)");
}
try {
  const draft = {
    slug: "test-only-article",
    title: "First title",
    summary: "Test summary",
    body: "First body",
    cover_alt: "Test description",
    status: "draft",
  };
  await as(4);
  await reject(
    "select public.save_office_content('articles',null,null,$1,null)",
    [draft],
  );
  await as(5);
  await reject(
    "select public.save_office_content('articles',null,null,$1,null)",
    [draft],
  );
  await as(3);
  const first = await save("articles", null, null, draft);
  check(first.status === "draft", "draft stays private");
  const second = await save("articles", first.id, first.updated_at, {
    title: "Second title",
    body: "Second body",
    status: "pending",
  });
  check(second.status === "pending", "approval request preserved");
  await reject("select public.save_office_content('articles',$1,$2,$3,null)", [
    first.id,
    first.updated_at,
    { title: "stale edit" },
  ]);
  const history = await state("articles", first.id);
  check(history.revisions.length === 2, "real revisions recorded");
  const initial = history.revisions.find(
    (item) => item.title === "First title",
  );
  const restored = (
    await db.query("select public.restore_content_revision($1,$2) as item", [
      initial.id,
      second.updated_at,
    ])
  ).rows[0].item;
  check(
    restored.title === "First title" && restored.status === "draft",
    "restore is draft only",
  );
  check(
    restored.id === first.id && restored.slug === first.slug,
    "restore keeps identifier and URL",
  );
  await reject(
    "select public.save_office_content('players',$1,null,'{}',null)",
    [first.id],
  );
  await reject("select public.save_office_content('articles',$1,$2,$3,null)", [
    first.id,
    restored.updated_at,
    { id: user(4) },
  ]);
  await reject(
    "select public.save_office_content('site_pages',null,null,$1,null)",
    [{ id: "club", title: "forbidden" }],
  );
  const future = new Date(Date.now() + 3600000).toISOString();
  await reject("select public.save_office_content('articles',$1,$2,$3,$4)", [
    first.id,
    restored.updated_at,
    { title: "not enabled" },
    future,
  ]);
  await db.exec(
    "reset role; update private.office_automation_settings set publisher_enabled=true where id=1",
  );
  await as(3);
  let booked = await save(
    "articles",
    first.id,
    restored.updated_at,
    { title: "Scheduled article" },
    future,
  );
  check(
    booked.status === "draft" &&
      (await state("articles", first.id)).release.state === "queued",
    "booking is approval but not publication",
  );
  await as(null);
  check(
    (
      await db.query("select title from public.articles where id=$1", [
        first.id,
      ])
    ).rows.length === 0,
    "scheduled content is not public",
  );
  await reject("select * from private.content_revisions");
  await reject("select public.office_content_state('articles',$1)", [first.id]);
  await reject("select private.publish_due_content()");
  await as(3);
  await reject("select private.publish_due_content()");
  await reject("select * from private.content_releases");
  // 예약 시각을 이동시키는 테스트는 격리된 메모리 DB의 관리자 연결에서만 실행합니다.
  await db.exec(
    "reset role; update private.content_releases set scheduled_at=now()-interval '1 minute'",
  );
  await service();
  check(
    (await db.query("select private.publish_due_content() as n")).rows[0].n ===
      1,
    "server publishes due approved content",
  );
  check(
    (await db.query("select private.publish_due_content() as n")).rows[0].n ===
      0,
    "publisher is idempotent",
  );
  await as(null);
  check(
    (
      await db.query("select title from public.articles where id=$1", [
        first.id,
      ])
    ).rows[0].title === "Scheduled article",
    "published content becomes visible",
  );
  await as(3);
  const current = (
    await db.query(
      "select to_jsonb(t) as item from public.articles t where id=$1",
      [first.id],
    )
  ).rows[0].item;
  booked = await save(
    "articles",
    first.id,
    current.updated_at,
    { title: "Next booking" },
    future,
  );
  const changed = await save("articles", first.id, booked.updated_at, {
    title: "Changed after approval",
  });
  check(
    (await state("articles", first.id)).release.state === "cancelled",
    "editing cancels prior approval",
  );
  booked = await save(
    "articles",
    first.id,
    changed.updated_at,
    { title: "Explicit cancellation" },
    future,
  );
  await db.query("select public.cancel_content_release('articles',$1)", [
    first.id,
  ]);
  check(
    (await state("articles", first.id)).release.state === "cancelled",
    "explicit cancellation works",
  );
  booked = await save(
    "articles",
    first.id,
    booked.updated_at,
    { title: "Revoked approver" },
    future,
  );
  await db.exec(
    "reset role; update private.content_releases set scheduled_at=now()-interval '1 minute'",
  );
  await as(1);
  await db.query(
    "update public.admin_roles set active=false where user_id=$1",
    [user(3)],
  );
  await service();
  check(
    (await db.query("select private.publish_due_content() as n")).rows[0].n ===
      0,
    "inactive approver cannot publish",
  );
  await as(1);
  check(
    (await state("articles", first.id)).release.state === "failed",
    "failed approval is visible to staff",
  );
  // 잘못된 이미지와 동의 철회는 예약한 뒤에도 기존 제약으로 차단됩니다.
  let invalid = await save(
    "articles",
    null,
    null,
    { ...draft, slug: "invalid-image", cover_path: "assets/missing.jpg" },
    future,
  );
  await db.exec(
    "reset role; update private.content_releases set scheduled_at=now()-interval '1 minute' where state='queued'",
  );
  await service();
  check(
    (await db.query("select private.publish_due_content() as n")).rows[0].n ===
      0,
    "unapproved images block scheduled release",
  );
  await as(1);
  const photo = await save("media_assets", null, null, {
    kind: "photo",
    title: "Test photo",
    legacy_path: "assets/test-only.jpg",
    alt_text: "Test",
    consent_confirmed: true,
    status: "draft",
  });
  const photoHistory = await state("media_assets", photo.id);
  const withdrawn = await save("media_assets", photo.id, photo.updated_at, {
    consent_confirmed: false,
  });
  const recovered = (
    await db.query("select public.restore_content_revision($1,$2) as item", [
      photoHistory.revisions[0].id,
      withdrawn.updated_at,
    ])
  ).rows[0].item;
  check(
    recovered.consent_confirmed === false && recovered.status === "draft",
    "restore never restores withdrawn consent",
  );
  await as(4);
  await reject("select public.office_content_state('articles',$1)", [
    invalid.id,
  ]);
  await as(1);
  const releaseList = (
    await db.query(
      "select public.office_release_states('articles',$1) as items",
      [[first.id]],
    )
  ).rows[0].items;
  check(
    releaseList.length === 1 && !("snapshot" in releaseList[0]),
    "list returns only scoped release metadata",
  );
  await reject("select public.office_release_states('articles',$1)", [
    Array(51).fill(first.id),
  ]);
  await as(4);
  await reject("select public.office_release_states('articles',$1)", [
    [first.id],
  ]);
  await db.exec("reset role");
  const exposed = (
    await db.query(
      "select count(*)::int as n from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('private','public') and p.proname in ('save_office_content','restore_content_revision','office_content_state','publish_due_content','prune_content_history','office_release_states','office_release_attention') and has_function_privilege('anon',p.oid,'EXECUTE')",
    )
  ).rows[0].n;
  check(
    exposed === 0,
    "anonymous users cannot invoke content management functions",
  );
  const paths = (
    await db.query(
      "select count(*)::int as n from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private' and p.prosecdef and not coalesce(p.proconfig @> array['search_path=\"\"'],false)",
    )
  ).rows[0].n;
  check(paths === 0, "definer functions have an empty search path");
  await db.query(
    "update private.content_revisions set captured_at=now()-interval '91 days' where id=$1",
    [photoHistory.revisions[0].id],
  );
  await as(1);
  check(
    !(await state("media_assets", photo.id)).revisions.some(
      (item) => item.id === photoHistory.revisions[0].id,
    ),
    "expired revisions cannot be browsed",
  );
  await reject("select public.restore_content_revision($1,$2)", [
    photoHistory.revisions[0].id,
    recovered.updated_at,
  ]);
  await service();
  await db.query("select private.prune_content_history()");
  await db.exec("reset role");
  check(
    (
      await db.query("select id from private.content_revisions where id=$1", [
        photoHistory.revisions[0].id,
      ])
    ).rows.length === 0,
    "retention job removes expired revision",
  );
  console.log("Content PostgreSQL checks passed:", checks);
} catch (error) {
  console.error(error.message, error.where ?? "", error.query ?? "");
  process.exitCode = 1;
} finally {
  await db.close();
}
