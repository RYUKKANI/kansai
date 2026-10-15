import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

// 실제 PostgreSQL 엔진에서 역할별 권한을 검사합니다. 테스트 데이터는 메모리 DB에만 생성합니다.
async function main() {
  const db = new PGlite();
  await db.exec(
    [
      "create role anon; create role authenticated; create role service_role bypassrls;",
      "create schema auth; create schema storage;",
      "create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz default now(),created_at timestamptz default clock_timestamp(),raw_user_meta_data jsonb default '{}',raw_app_meta_data jsonb default '{}');",
      "create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid; $$;",
      "grant usage on schema auth,storage,public to anon,authenticated;",
      "grant execute on function auth.uid() to anon,authenticated;",
      "create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);",
      "create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text);",
      "alter table storage.objects enable row level security;",
      "grant select,insert,update,delete on storage.objects to anon,authenticated;",
      "create function storage.foldername(text) returns text[] language sql immutable as $$ select string_to_array($1,'/'); $$;",
    ].join("\n"),
  );
  const files = (await readdir("supabase/migrations"))
    // pg_cron은 PGlite가 제공하지 않습니다. 이 활성화 파일은 운영 Cron 실행 이력으로 별도 검증합니다.
    .filter(
      (f) => f.endsWith(".sql") && !f.endsWith("_enable_content_publisher.sql"),
    )
    .sort();
  for (const file of files)
    await db.exec(await readFile("supabase/migrations/" + file, "utf8"));
  const user = (n) => "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
  for (let n = 1; n <= 6; n++)
    await db.query("insert into auth.users(id) values($1)", [user(n)]);
  for (const [n, role, active] of [
    [1, "owner", true],
    [2, "administrator", true],
    [3, "editor", true],
    [4, "coach", true],
    [6, "editor", false],
  ]) {
    await db.query(
      "insert into public.admin_roles(user_id,email,role,active) values($1,$2,$3,$4)",
      [user(n), "test" + n + "@example.invalid", role, active],
    );
  }
  let checks = 0;
  async function as(n) {
    await db.exec(n === null ? "set role anon" : "set role authenticated");
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
      n === null ? "" : user(n),
    ]);
  }
  async function denied(sql, params = []) {
    await assert.rejects(db.query(sql, params));
    checks++;
  }
  async function count(sql, expected) {
    const r = await db.query(sql);
    assert.equal(r.rows[0].count, expected);
    checks++;
  }
  await as(3);
  await db.exec(
    "insert into public.articles(slug,title,summary,body,cover_alt) values('draft-news','Draft','summary','body','description')",
  );
  await db.exec(
    "insert into public.articles(slug,title,summary,body,cover_alt,status) values('public-news','Public','summary','body','description','published')",
  );
  await denied("insert into public.players(internal_name) values('forbidden')");
  await denied(
    "insert into public.admin_roles(user_id,email,role) values($1,'escalation@example.invalid','owner')",
    [user(5)],
  );
  await as(null);
  await count(
    "select count(*)::int from public.articles where slug='draft-news'",
    0,
  );
  await count(
    "select count(*)::int from public.articles where slug='public-news'",
    1,
  );
  await denied("select * from public.players");
  await denied("select * from private.player_contacts");
  await denied(
    "insert into public.articles(slug,title) values('anon-write','forbidden')",
  );
  await as(5);
  await denied(
    "insert into public.articles(slug,title) values('outsider-write','forbidden')",
  );
  await count("select count(*)::int from public.admin_roles", 0);
  await as(6);
  await denied(
    "insert into public.articles(slug,title) values('inactive-write','forbidden')",
  );
  await as(4);
  const player = (
    await db.query(
      "insert into public.players(internal_name) values('TEST ONLY') returning id",
    )
  ).rows[0].id;
  await db.query(
    "insert into public.public_player_profiles(player_id,slug,display_name,position,status) values($1,'test-player','TEST ONLY','GK','pending')",
    [player],
  );
  await denied(
    "update public.public_player_profiles set status='published' where player_id=$1",
    [player],
  );
  await denied(
    "insert into public.articles(slug,title) values('coach-write','forbidden')",
  );
  await db.exec("insert into public.fixtures(opponent) values('TEST ONLY')");
  await db.exec(
    "insert into public.training_sessions(title,starts_at) values('TEST ONLY',now())",
  );
  await denied("update public.players set id=$1 where id=$2", [
    user(5),
    player,
  ]);
  await as(2);
  await denied(
    "update public.public_player_profiles set status='published' where player_id=$1",
    [player],
  );
  await db.query("update public.players set profile_consent=true where id=$1", [
    player,
  ]);
  await db.query(
    "update public.public_player_profiles set status='published' where player_id=$1",
    [player],
  );
  await denied(
    "update public.public_player_profiles set slug='changed-url' where player_id=$1",
    [player],
  );
  await as(null);
  await count(
    "select count(*)::int from public.public_player_profiles where slug='test-player'",
    1,
  );
  await denied("select approved_by from public.public_player_profiles");
  await as(4);
  await db.query(
    "update public.players set profile_consent=false where id=$1",
    [player],
  );
  await as(null);
  await count(
    "select count(*)::int from public.public_player_profiles where slug='test-player'",
    0,
  );
  await as(3);
  await denied(
    "update public.articles set slug='changed-news' where slug='public-news'",
  );
  await denied(
    "insert into public.media_assets(kind,title,video_url,alt_text,status) values('video','test','https://youtu.be/abcdefghijk','description','published')",
  );
  const path = user(3) + "/" + user(30) + ".jpg";
  await db.query(
    "insert into storage.objects(bucket_id,name) values('kansai-media',$1)",
    [path],
  );
  await denied(
    "insert into storage.objects(bucket_id,name) values('kansai-media',$1)",
    [user(1) + "/" + user(31) + ".jpg"],
  );
  await db.query(
    "insert into public.media_assets(title,storage_path,alt_text) values('TEST ONLY',$1,'description')",
    [path],
  );
  await as(null);
  await count("select count(*)::int from storage.objects", 0);
  await as(3);
  await db.query(
    "update public.media_assets set consent_confirmed=true,status='published' where storage_path=$1",
    [path],
  );
  await as(null);
  await count("select count(*)::int from storage.objects", 1);
  await as(4);
  await denied(
    "insert into storage.objects(bucket_id,name) values('kansai-media',$1)",
    [user(4) + "/" + user(32) + ".jpg"],
  );
  await as(1);
  await denied("update public.admin_roles set active=false where user_id=$1", [
    user(1),
  ]);
  await denied("delete from public.admin_roles where user_id=$1", [user(1)]);
  await count(
    "select count(*)::int from public.audit_logs where operation='INSERT' and entity='articles'",
    2,
  );
  await count(
    "select count(*)::int from public.publication_state where version > 0",
    1,
  );
  await db.close();
  console.log(
    "PostgreSQL RLS: " + checks + " permission and integrity checks passed.",
  );
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
