import assert from "node:assert/strict";
import { officeDatabase } from "./office-database.mjs";

// [편집 안내] 가상 계정/메모리 DB로만 MFA 초기 등록, 세션 없는 예약 발행, 감사 조회 경계를 검증합니다.
const { db, as, user } = await officeDatabase();
let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks++; };
const value = async (sql, params = []) => (await db.query(sql, params)).rows[0]?.value;
const reject = async (sql, params = [], pattern) => { await assert.rejects(db.query(sql, params), pattern); checks++; };
const state = () => value("select public.office_account_state() as value");
async function privileged(role = null) {
  await db.exec(role ? `set role ${role}` : "reset role");
  await db.query("select set_config('request.jwt.claim.sub','',false)");
}
const enrollSql = "select public.office_enroll_identity($1,$2,$3,true) as value";
const enroll = (id, name = "TEST Provided Name", department = "TEST Provided Department") => value(enrollSql, [id, name, department]);
const audit = () => value("select public.office_staff_audit(100,null) as value");
const directAudit = async () => (await db.query("select entity,record_id from public.audit_logs order by id")).rows;
const staffEntities = new Set(["admin_roles", "staff_accounts", "staff_name_requests"]);
async function snapshot(n) {
  return value("select jsonb_build_object('account',(select to_jsonb(a) from private.staff_accounts a where user_id=$1),'role',(select to_jsonb(r) from public.admin_roles r where user_id=$1),'audit_count',(select count(*) from public.audit_logs)) as value", [user(n)]);
}
async function ownerAal(jwtAal, nativeAal) {
  await privileged();
  await db.query("update auth.sessions set aal=$1 where id=$2", [nativeAal, user(10001)]);
  await as(1);
  await db.query("select set_config('request.jwt.claim.aal',$1,false)", [jwtAal]);
}
async function scheduled(slug) {
  await as(9);
  const row = await value("select public.save_office_content('articles',null,null,$1,now()+interval '1 hour') as value", [{slug, title:"TEST ONLY scheduled content", summary:"TEST summary", body:"TEST body", cover_alt:"TEST alt"}]);
  await privileged();
  await db.query("update private.content_releases set scheduled_at=now()-interval '1 minute' where entity='articles' and record_id=$1", [row.id]);
  return row.id;
}

try {
  await db.exec("update auth.users set email='fixture-'||id::text||'@example.invalid'");
  await db.query("insert into auth.mfa_factors(user_id,status) values($1,'verified')", [user(1)]);
  await privileged("service_role");
  await db.query("select public.staff_auth_bootstrap_owner($1,'mfa.owner')", [user(1)]);
  await privileged();
  const before = await snapshot(1);
  for (const [jwtAal,nativeAal] of [["aal1","aal1"],["aal2","aal1"],["aal1","aal2"]]) {
    await ownerAal(jwtAal,nativeAal);
    await reject(enrollSql, ["mfa.owner", "TEST Bypass Attempt", "TEST Department"], /owner_mfa_required/);
    await privileged();
    check(JSON.stringify(await snapshot(1)) === JSON.stringify(before), "rejected MFA enrollment changes no identity, role, consent or success audit");
  }
  await ownerAal("aal2","aal2");
  const enrolled = await enroll("mfa.owner", "  TEST Owner 名-김  ", "  TEST Club Office  ");
  check(enrolled.user_id === user(1) && enrolled.username === "mfa.owner" && enrolled.real_name === "TEST Owner 名-김" && enrolled.department === "TEST Club Office" && enrolled.role === "owner" && enrolled.active,
    "valid signed/native AAL2 completes only explicitly supplied identity on the existing Owner UUID");
  check(enrolled.identity_enrolled && !enrolled.profile_enrollment_pending && enrolled.name_verified_at === null && enrolled.name_verified_by === null && enrolled.approved_real_name === null,
    "MFA enrollment neither self-verifies a name nor fabricates an independent approver");
  await privileged();
  const saved = await snapshot(1);
  check(saved.account.notice_accepted_at !== null && saved.account.user_id === before.account.user_id && saved.role.role === before.role.role && saved.role.active === before.role.active,
    "explicit notice acceptance completes enrollment without changing authority");

  // Owner MFA 정책을 일반 레거시 관계자의 기존 초기 전환에 확장하지 않습니다.
  await db.query("insert into auth.mfa_factors(user_id,status) values($1,'verified')", [user(2)]);
  await as(2);
  check((await enroll("admin.two")).role === "administrator", "ordinary legacy staff retain their existing initial enrollment at AAL1");
  await privileged();
  await db.query("insert into auth.users(id,email) values($1,'test-nine@example.invalid')", [user(9)]);
  await db.query("insert into auth.sessions(id,user_id) values($1,$2)", [user(10009), user(9)]);
  await db.query("insert into public.admin_roles(user_id,email,role,active) values($1,'test-nine@example.invalid','owner',true)", [user(9)]);
  await privileged("service_role");
  await db.query("select public.staff_auth_bootstrap_owner($1,'owner.nine')", [user(9)]);
  await as(9);
  check((await enroll("owner.nine")).role === "owner", "Owner with no verified MFA factor keeps normal AAL1 enrollment");
  await privileged();
  await db.query("delete from auth.sessions where id=$1", [user(10009)]);
  await as(9);
  await reject(enrollSql, ["owner.nine", "TEST Revoked", "TEST"], /authentication_required/);
  await privileged();
  await db.query("insert into auth.sessions(id,user_id,not_after) values($1,$2,now()-interval '1 minute')", [user(10009), user(9)]);
  await as(9);
  await reject(enrollSql, ["owner.nine", "TEST Expired", "TEST"], /authentication_required/);
  await privileged();
  await db.query("update auth.sessions set not_after=null where id=$1", [user(10009)]);
  await db.query("update auth.users set banned_until=now()+interval '1 hour' where id=$1", [user(9)]);
  await as(9);
  await reject(enrollSql, ["owner.nine", "TEST Banned", "TEST"], /authentication_required/);
  await privileged();
  await db.query("update auth.users set banned_until=null where id=$1", [user(9)]);
  await db.query("insert into auth.users(id,email) values($1,'pending-six@example.invalid')", [user(6)]);
  await db.query("insert into auth.sessions(id,user_id) values($1,$2)", [user(10006), user(6)]);
  await as(6);
  await reject(enrollSql, ["unapproved.six", "TEST Applicant", "TEST"], /legacy_staff_enrollment_only/);

  // 자동 발행은 사람의 로그인 세션이 없어도 실행되지만, 승인자의 현재 플랫폼 정지는 따릅니다.
  await privileged();
  await db.exec("update private.office_automation_settings set publisher_enabled=true where id=1");
  const bannedArticle = await scheduled("test-banned-approver");
  await db.query("update auth.users set banned_until=now()+interval '1 hour' where id=$1", [user(9)]);
  check(await value("select private.publish_due_content() as value") === 0, "currently banned approver cannot publish a previously queued article");
  const deniedRelease = await value("select jsonb_build_object('status',a.status,'state',r.state,'error',r.last_error) as value from public.articles a join private.content_releases r on r.record_id=a.id::text where a.id=$1", [bannedArticle]);
  check(deniedRelease.status === "draft" && deniedRelease.state === "failed" && deniedRelease.error === "validation_or_approval_failed", "blocked release retains draft with a sanitized failed outcome");
  check(await value("select count(*)=0 as value from public.audit_logs where record_id=$1 and action='publish'", [bannedArticle]), "failed scheduled publication creates no successful publish audit");
  await db.query("update auth.users set banned_until=null where id=$1", [user(9)]);
  const noSessionArticle = await scheduled("test-sessionless-approver");
  await db.query("delete from auth.sessions where user_id=$1", [user(9)]);
  check(await value("select private.publish_due_content() as value") === 1, "valid approved staff can authorize a scheduled job without keeping a human session alive");
  const scheduledAudit = await value("select to_jsonb(a) as value from public.audit_logs a where record_id=$1 and action='publish' order by id desc limit 1", [noSessionArticle]);
  check(scheduledAudit.actor_id === null && scheduledAudit.source === "scheduled" && scheduledAudit.requested_by === user(9) && scheduledAudit.executor === "content_publisher", "scheduled audit separates the known requester from the system executor");
  await db.query("insert into auth.sessions(id,user_id) values($1,$2)", [user(10009), user(9)]);
  const expiredBanArticle = await scheduled("test-expired-ban-approver");
  await db.query("update auth.users set banned_until=now()-interval '1 minute' where id=$1", [user(9)]);
  check(await value("select private.publish_due_content() as value") === 1 && await value("select status='published' as value from public.articles where id=$1", [expiredBanArticle]), "expired platform ban no longer prevents an otherwise valid scheduled release");
  await db.query("update auth.users set banned_until=null where id=$1", [user(9)]);
  const revokedArticle = await scheduled("test-revoked-approver");
  await db.query("update public.admin_roles set active=false where user_id=$1", [user(9)]);
  check(await value("select private.publish_due_content() as value") === 0 && await value("select status='draft' as value from public.articles where id=$1", [revokedArticle]), "scheduled publication still honors revoked club authority independently of Auth ban");
  await db.query("update public.admin_roles set active=true where user_id=$1", [user(9)]);

  // 감사 RPC와 직접 SELECT 모두 같은 RLS helper를 사용해야 합니다.
  await as(9);
  await db.exec("insert into public.players(internal_name) values('TEST internal player')");
  const ownerLogs = await audit();
  check(ownerLogs.some((row) => staffEntities.has(row.entity)) && ownerLogs.some((row) => row.entity === "players") && ownerLogs.some((row) => row.entity === "articles"), "normal Owner session retains staff and other business audits");
  await as(2);
  await reject("select public.office_staff_applications()", [], /live_owner_required/);
  await reject("select public.office_staff_name_requests()", [], /live_owner_required/);
  const administratorLogs = await audit();
  check(administratorLogs.length > 0 && administratorLogs.every((row) => !staffEntities.has(row.entity)) && administratorLogs.some((row) => row.entity === "players") && administratorLogs.some((row) => row.entity === "articles"), "administrator loses only Owner-only staff details and retains permitted general business history");
  check((await directAudit()).every((row) => !staffEntities.has(row.entity)), "direct audit table selection cannot bypass the RPC staff filter");
  for (const n of [3,4]) { await as(n); await enroll(`staff.${n}`); }
  await as(3);
  const editorLogs = await audit();
  check(editorLogs.length > 0 && editorLogs.every((row) => ["articles","media_assets","media_albums"].includes(row.entity)), "editor retains only editorial history");
  await as(4);
  const coachLogs = await audit();
  check(coachLogs.length > 0 && coachLogs.every((row) => ["players","public_player_profiles","fixtures","training_sessions","training_series","match_events","club_events"].includes(row.entity)), "coach retains only football business history");
  await ownerAal("aal1","aal1");
  check((await audit()).length > 0 && (await audit()).every((row) => !staffEntities.has(row.entity)), "MFA Owner AAL1 hides staff details while leaving permitted general history available");
  check((await directAudit()).every((row) => !staffEntities.has(row.entity)), "MFA restriction also applies to direct audit SELECT");
  await ownerAal("aal2","aal1");
  check((await audit()).every((row) => !staffEntities.has(row.entity)), "JWT AAL2 alone cannot open staff audits when the native session is AAL1");
  await ownerAal("aal1","aal2");
  check((await audit()).every((row) => !staffEntities.has(row.entity)), "native AAL2 alone cannot open staff audits when the signed claim is AAL1");
  await ownerAal("aal2","aal2");
  check((await audit()).some((row) => staffEntities.has(row.entity)), "signed and native AAL2 restore complete Owner staff audit access");
  await reject("insert into public.audit_logs(entity,operation) values('staff_accounts','FORGED')");
  await reject("update public.audit_logs set reason='FORGED'");
  await reject("delete from public.audit_logs");
  await privileged();
  await db.query("delete from auth.sessions where id=$1", [user(10002)]);
  await as(2);
  check((await audit()).length === 0 && (await directAudit()).length === 0, "revoked existing session loses both audit access paths");
  await as(6);
  check((await audit()).length === 0 && (await directAudit()).length === 0, "unapproved account receives no business audit rows");
  await as(null);
  await reject("select public.office_staff_audit(100,null)");
  await privileged();
  check(await value("select not has_function_privilege('anon','private.can_read_audit(text)','execute') and not has_function_privilege('service_role','private.can_read_audit(text)','execute') and has_function_privilege('authenticated','private.can_read_audit(text)','execute') and not has_function_privilege('anon','private.office_enroll_identity(text,text,text,boolean)','execute') and not has_function_privilege('service_role','private.office_enroll_identity(text,text,text,boolean)','execute') as value"), "updated helpers expose no new anonymous or service client enrollment/audit capability");
  check(await value("select not has_function_privilege('authenticated','private.publish_due_content()','execute') and not has_function_privilege('anon','private.publish_due_content()','execute') and has_function_privilege('service_role','private.publish_due_content()','execute') as value"), "scheduled publisher stays limited to its server execution role");
  console.log(`PostgreSQL staff security boundaries: ${checks} MFA enrollment, scheduled ban and audit access checks passed.`);
} finally {
  await db.close();
}
