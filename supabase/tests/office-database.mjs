import { PGlite } from "@electric-sql/pglite";
import { readFile, readdir } from "node:fs/promises";
// 실제 서비스에 연결하지 않는 PostgreSQL 테스트 DB입니다. 가상 인물은 여기에서만 사용합니다.
export async function officeDatabase() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create schema storage;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth,storage,public to anon,authenticated,service_role;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text);
    alter table storage.objects enable row level security;
    grant select,insert,update,delete on storage.objects to anon,authenticated;
    create function storage.foldername(text) returns text[] language sql immutable as $$select string_to_array($1,'/')$$;
  `);
  for (const file of (await readdir("supabase/migrations"))
    .filter((file) => file.endsWith(".sql"))
    .sort())
    await db.exec(await readFile("supabase/migrations/" + file, "utf8"));
  const user = (n) => "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
  for (const [n, role, active] of [
    [1, "owner", true],
    [2, "administrator", true],
    [3, "editor", true],
    [4, "coach", true],
    [5, "coach", false],
  ]) {
    await db.query("insert into auth.users values($1)", [user(n)]);
    await db.query(
      "insert into public.admin_roles(user_id,email,role,active) values($1,$2,$3,$4)",
      [user(n), "test" + n + "@example.invalid", role, active],
    );
  }
  async function as(n) {
    await db.exec(n === null ? "set role anon" : "set role authenticated");
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
      n === null ? "" : user(n),
    ]);
  }
  return { db, as, user };
}
