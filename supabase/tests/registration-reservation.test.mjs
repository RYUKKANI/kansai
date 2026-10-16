import assert from "node:assert/strict";
import { officeDatabase } from "./office-database.mjs";

// Auth API를 흉내 내어 계정을 재생성하지 않습니다. 격리 PostgreSQL에서 예약의
// 서비스 전용 해제, 실제 Auth 행이 생긴 뒤의 보호와 UUID·권한 보존을 검사합니다.
const { db, as, user } = await officeDatabase();
let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks++; };
const value = async (sql, params = []) => (await db.query(sql, params)).rows[0]?.value;
const reject = async (sql, params = []) => { await assert.rejects(db.query(sql, params)); checks++; };
const release = id => value("select public.staff_auth_release_reservation($1) as value", [id]);
async function role(name) { await db.exec(name ? "set role " + name : "reset role"); }
async function reserve(username, email) {
  await role("service_role");
  return value("select public.staff_auth_reserve($1,$2,'TEST ONLY applicant','TEST ONLY staff',true,false) as value", [username,email]);
}
try {
  const id = await reserve("retry.person", "retry-person@example.invalid");
  for (const n of [null,1,2,3,4]) {
    await as(n);
    await reject("select public.staff_auth_release_reservation($1)", [id]);
    await reject("select private.staff_auth_release_reservation($1)", [id]);
  }
  await role("service_role");
  check(await release(id), "service can release an empty failed signup reservation");
  check(await release(id), "missing or already released reservation is an idempotent no-op");
  const again = await reserve("RETRY.PERSON", "retry-person@example.invalid");
  check(typeof again === "string" && again !== id, "corrected signup can reserve normalized username and email immediately");
  await role();
  await db.query("insert into auth.users(id,email,raw_app_meta_data) values($1,'retry-person@example.invalid','{\"staff_signup_policy\":\"manual_approval_no_email_v1\"}')", [user(10)]);
  await role("service_role");
  check(!(await release(again)), "new Auth row prevents release after an ambiguous create response");
  await role();
  check(await value("select count(*)::int as value from private.staff_auth_reservations where id=$1", [again]) === 1, "guarded reservation remains for manual review");
  check(await value("select count(*)::int as value from auth.users where id=$1", [user(10)]) === 1, "release never deletes the Auth account");
  await role("service_role");
  await db.query("select public.staff_auth_finalize($1,$2)", [again,user(10)]);
  check(await release(again), "finalized reservation release is only a no-op");
  await role();
  const account = await value("select to_jsonb(a) as value from private.staff_accounts a where user_id=$1", [user(10)]);
  check(account.user_id === user(10) && account.username === "retry.person" && account.approval_status === "pending", "finalized UUID and pending identity remain unchanged");
  check(await value("select count(*)::int as value from public.admin_roles where user_id=$1", [user(10)]) === 0, "reservation release grants no roles");
  check(await value("select count(*)::int as value from public.admin_roles where role='owner' and active") === 1, "existing sole Owner is preserved");

  // 예약보다 오래된 계정과 충돌한 확정 거절은 이름 예약만 해제할 수 있습니다.
  const duplicate = await reserve("duplicate.old", "duplicate-old@example.invalid");
  await role();
  await db.query("insert into auth.users(id,email,created_at) values($1,'duplicate-old@example.invalid',now()-interval '1 day')", [user(11)]);
  await role("service_role");
  check(await release(duplicate), "definite collision with older existing Auth user releases only unused name reservation");
  await role();
  check(await value("select count(*)::int as value from auth.users where id=$1", [user(11)]) === 1, "older existing user is never recreated or deleted");
  check(await value("select count(*)=0 as value from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private') and p.proname='staff_auth_release_reservation' and (has_function_privilege('anon',p.oid,'execute') or has_function_privilege('authenticated',p.oid,'execute'))"), "no client execute grant leaks");
  console.log(`Registration reservation SQL checks: ${checks} passed`);
} finally { await db.close(); }
