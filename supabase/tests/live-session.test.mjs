import assert from "node:assert/strict";
import { officeDatabase } from "./office-database.mjs";

// 실제 토큰 서명은 게이트웨이 책임입니다. 여기서는 유효한 서명을 유지한 이전 JWT도
// Auth 세션 회수/만료/정지 뒤 DB 권한을 얻지 못하는지 격리 PostgreSQL로 검사합니다.
const { db, as, user } = await officeDatabase();
let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks++; };
const reject = async (sql, params = []) => { await assert.rejects(db.query(sql, params)); checks++; };
const value = async (sql, params = []) => (await db.query(sql, params)).rows[0]?.value;
async function admin() {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub','',false)");
}
async function deniedStaff(message) {
  check(await value("select private.current_role() as value") === null, message + ": no current role");
  check(await value("select count(*)::int as value from public.articles where slug='session-test'") === 0, message + ": private content hidden");
  const result = await db.query("update public.articles set title='forged stale save' where slug='session-test' returning id");
  check(result.rows.length === 0, message + ": direct update changes no row");
  await reject("insert into public.articles(slug,title) values('session-forbidden','forbidden')");
  await reject("select public.office_staff_directory()");
  await reject("select public.office_account_state()");
  await reject("select public.office_enroll_identity('forbidden.enrollment','TEST ONLY name','TEST ONLY staff',true)");
  check(await value("select count(*)::int as value from public.audit_logs") === 0, message + ": audit hidden");
  check(await value("select count(*)::int as value from public.admin_roles") === 0, message + ": role rows hidden");
  check(Object.keys(await value("select public.office_capabilities() as value")).length === 0, message + ": capabilities hidden");
}
try {
  await as(3);
  await db.exec("insert into public.articles(slug,title) values('session-test','TEST ONLY original')");
  check(await value("select private.current_role() as value") === "staff", "valid native session retains current DB role");
  const auditBefore = await value("select count(*)::int as value from public.audit_logs where entity='articles'");
  for (const [label, sid] of [["missing claim", ""], ["malformed claim", "not-a-uuid"], ["different user's session", user(10004)], ["absent session", user(99999)]]) {
    await as(3);
    await db.query("select set_config('request.jwt.claim.session_id',$1,false)", [sid]);
    await deniedStaff(label);
  }
  await admin();
  await db.query("update auth.sessions set not_after=now()-interval '1 minute' where id=$1", [user(10003)]);
  await as(3);
  await deniedStaff("expired native session");
  await admin();
  await db.query("update auth.sessions set not_after=null where id=$1", [user(10003)]);
  await db.query("update auth.users set banned_until=now()+interval '1 hour' where id=$1", [user(3)]);
  await as(3);
  await deniedStaff("platform banned account");
  await admin();
  await db.query("update auth.users set banned_until=now()-interval '1 minute' where id=$1", [user(3)]);
  await as(3);
  check(await value("select private.current_role() as value") === "staff", "expired platform ban restores unchanged active role");
  await admin();
  await db.query("delete from auth.sessions where user_id=$1", [user(3)]);
  await as(3);
  await deniedStaff("revoked native session with previously issued JWT");
  await admin();
  check(await value("select title as value from public.articles where slug='session-test'") === "TEST ONLY original", "all denied attempts preserve actual content");
  check(await value("select count(*)::int as value from public.audit_logs where entity='articles'") === auditBefore, "failed or zero-row mutations create no successful audit");
  check(await value("select private.staff_role_for($1) as value", [user(3)]) === "staff", "session-independent role resolver remains available to scheduled jobs");
  check(await value("select count(*)::int as value from public.admin_roles where role='owner' and private.staff_role_for(user_id)='owner'") === 1, "session revocation does not change preserved Owner count");
  await db.query("insert into auth.sessions(id,user_id) values($1,$2)", [user(11003),user(3)]);
  await as(3);
  await db.query("select set_config('request.jwt.claim.session_id',$1,false)", [user(11003)]);
  check(await value("select private.current_role() as value") === "staff", "new native login session restores unchanged UUID and role");
  await db.exec("update public.articles set title='TEST ONLY new authenticated save' where slug='session-test'");
  check(await value("select title as value from public.articles where slug='session-test'") === "TEST ONLY new authenticated save", "new session can perform normal content save");

  // 승인 대기자의 권한과 유효한 세션은 별개입니다. 본인 상태만 정상적으로 조회됩니다.
  await admin();
  await db.query("insert into auth.users(id,email) values($1,'pending-session@example.invalid')", [user(6)]);
  await db.query("insert into auth.sessions(id,user_id) values($1,$2)", [user(10006),user(6)]);
  await db.query("insert into private.staff_accounts(user_id,username,real_name,department,notice_accepted_at) values($1,'pending.session','TEST ONLY applicant','TEST ONLY staff',now())", [user(6)]);
  await as(6);
  const pending = await value("select public.office_account_state() as value");
  check(pending.approval_status === "pending" && !pending.active && pending.role === null, "valid pending session can see only own pending state");
  await reject("select public.office_staff_directory()");

  // 서비스 claim에서도 요청 후 플랫폼 정지된 Owner는 실제 Auth 변경 권한을 얻지 못합니다.
  await as(1);
  await db.query("select public.office_owner_begin_password_reset($1,$2,'TEST ONLY ban before claim')", [user(6),user(700)]);
  await admin();
  await db.query("update auth.users set banned_until=now()+interval '1 hour' where id=$1", [user(1)]);
  await db.exec("set role service_role");
  await reject("select public.staff_auth_owner_password_claim($1,$2)", [user(700),user(1)]);
  await as(1);
  await reject("select public.office_owner_account($1)", [user(6)]);
  await admin();
  await db.query("update auth.users set banned_until=null where id=$1", [user(1)]);
  check(await value("select count(*)=0 as value from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private' and p.proname='live_staff_session' and (has_function_privilege('anon',p.oid,'execute') or has_function_privilege('authenticated',p.oid,'execute') or has_function_privilege('service_role',p.oid,'execute'))"), "session helper has no direct client or service execute grant");
  console.log(`PostgreSQL live sessions: ${checks} revocation, RLS, profile, platform ban and Owner checks passed.`);
} finally {
  await db.close();
}
