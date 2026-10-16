import assert from "node:assert/strict";
import { officeDatabase } from "./office-database.mjs";
// 네이티브 비밀번호 변경은 Edge 테스트가 검증합니다. 여기서는 세션/권한/한 번의 claim 및 감사 원자성을 검사합니다.
const { db, as, user } = await officeDatabase();
let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks++; };
const reject = async (sql, params = []) => { await assert.rejects(db.query(sql, params)); checks++; };
const value = async (sql, params = []) => (await db.query(sql, params)).rows[0]?.value;
const get = (n) => value("select public.office_owner_account($1) as value", [user(n)]);
const update = (n, username, name, reason = "TEST ONLY identity correction") => value("select public.office_owner_update_identity($1,$2,$3,$4) as value", [user(n), username, name, reason]);
const begin = (target, operation, reason = "TEST ONLY password reset") => value("select public.office_owner_begin_password_reset($1,$2,$3) as value", [user(target), user(operation), reason]);
const claim = (operation, actor = 1) => value("select public.staff_auth_owner_password_claim($1,$2) as value", [user(operation), user(actor)]);
const finish = (operation, outcome, actor = 1) => db.query("select public.staff_auth_owner_password_finish($1,$2,$3)", [user(operation), user(actor), outcome]);
const outcomeSQL = "select public.staff_auth_owner_password_finish($1,$2,$3)";
async function privileged(role = null) {
  await db.exec(role ? `set role ${role}` : "reset role");
  await db.query("select set_config('request.jwt.claim.sub','',false)");
}
async function amr(method, age = 0) {
  await db.query("select set_config('request.jwt.claim.amr',$1,false)", [JSON.stringify([{method, timestamp:Math.floor(Date.now()/1000)-age}])]);
}
async function auditCount() { return value("select count(*)::int as value from public.audit_logs"); }
try {
  await db.exec("update auth.users set email='fixture-'||id::text||'@example.invalid'");
  await privileged("service_role");
  await db.query("select public.staff_auth_bootstrap_owner($1,'owner.one')", [user(1)]);
  await as(1);
  const beforePartial = await get(1);
  check(beforePartial.password_is_set === false && beforePartial.real_name === null && beforePartial.profile_enrollment_pending, "native empty password reports false only, legacy profile still empty");
  const partial = await update(1, "OWNER.renamed", "試験 Owner 김 A-B");
  check(partial.user_id === user(1) && partial.username === "owner.renamed" && partial.role === "owner" && partial.active, "Owner username and partial name update preserve UUID and effective role");
  check(partial.profile_enrollment_pending && partial.name_verified_at === null && partial.name_verified_by === null, "own legacy partial name never self-verifies or completes enrollment");
  const partialState = await value("select public.office_account_state() as value");
  check(!partialState.identity_enrolled && partialState.department === null && partialState.approved_real_name === null, "partial name creates no department, consent or approved display name");
  check((await value("select public.office_staff_directory() as value")).length === 0, "partial legacy name remains absent from directory");
  let partialAudit = (await value("select public.office_staff_audit(100,null) as value")).find((row) => row.action === "owner_identity_updated");
  check(partialAudit.actor_id === user(1) && partialAudit.actor_name === null && partialAudit.actor_name_status === "unverified", "partial self-name audit remains attributed to unverified stable UUID");
  check(Object.keys(partialAudit.before_values).length === 0 && Object.keys(partialAudit.after_values).length === 0, "username and real-name values are excluded from audit diffs");
  await reject("select public.office_enroll_identity('owner.one','TEST Owner','TEST staff',true)");
  await db.query("select public.office_enroll_identity('owner.renamed','試験 Owner 김 A-B','TEST staff',true)");
  check(!(await get(1)).profile_enrollment_pending && (await get(1)).name_verified_at === null, "normal self-enrollment completes changed username on same UUID without self-verification");
  for (const [n, username] of [[2,"admin.two"],[3,"editor.three"],[4,"coach.four"],[5,"inactive.five"]]) {
    await as(n); await db.query("select public.office_enroll_identity($1,$2,'TEST staff',true)", [username,"TEST Person " + n]);
  }
  for (const n of [null,2,3,4,5]) {
    await as(n);
    await reject("select public.office_owner_account($1)", [user(1)]);
    await reject("select public.office_owner_update_identity($1,'forged.name','Forged','forged')", [user(1)]);
    await reject("select public.office_owner_begin_password_reset($1,$2,'forged')", [user(1),user(600)]);
  }
  await as(2);
  await reject("select public.office_staff_applications()");
  await reject("select public.office_staff_name_requests()");
  await reject("select public.office_verify_staff_identity($1,'TEST Person 3','not Owner')", [user(3)]);
  await reject("select public.office_set_staff_access($1,'coach',true,'not Owner')", [user(3)]);
  await as(1);
  await db.query("select public.office_verify_staff_identity($1,'TEST Person 3','TEST verified')", [user(3)]);
  await as(3);
  await db.query("select public.office_request_name_change('Stale Request','TEST correction')");
  const nameRequest = (await value("select public.office_account_state() as value")).name_request.id;
  await as(2);
  await reject("select public.office_review_name_change($1,true,'not Owner')", [nameRequest]);
  await as(1);
  const corrected = await update(3,"editor.changed","別人 Test Hyphen-Name");
  check(corrected.user_id === user(3) && corrected.name_verified_by === user(1) && corrected.role === "editor", "different Owner confirms provided name without granting role or changing UUID");
  check((await value("select public.office_staff_name_requests() as value")).find((r) => r.id === nameRequest).status === "rejected", "direct correction closes stale pending request atomically");
  await reject("select public.office_review_name_change($1,true,'stale cannot overwrite')", [nameRequest]);
  await reject("select public.office_owner_update_identity($1,'EDITOR.CHANGED','TEST Person 4','duplicate')", [user(4)]);
  await reject("select public.office_owner_update_identity($1,'ab','TEST Person 4','invalid username')", [user(4)]);
  await reject("select public.office_owner_update_identity($1,'coach.four',null,'erase name')", [user(4)]);
  await reject("select public.office_owner_update_identity($1,'coach.four','TEST Person 4','')", [user(4)]);
  await privileged("service_role");
  await value("select public.staff_auth_reserve('reserved.name','reserved@example.invalid','TEST Applicant','TEST',true) as value");
  await as(1);
  await reject("select public.office_owner_update_identity($1,'RESERVED.NAME','TEST Person 4','reserved')", [user(4)]);
  await privileged();
  await db.exec("update private.staff_auth_reservations set expires_at=now()-interval '1 minute' where username='reserved.name'");
  await db.query("update auth.users set encrypted_password='TEST ONLY fixture value' where id=$1", [user(3)]);
  await as(1);
  await update(4,"reserved.name","TEST Person 4");
  const account = await get(3);
  check(account.password_is_set === true && !Object.keys(account).some((key) => /email|encrypted|hash|token/.test(key)), "native password existence exposes a boolean and no secret or contact fields");
  const beforeNoop = await auditCount();
  await update(4,"reserved.name","TEST Person 4");
  check(await auditCount()===beforeNoop,"unchanged identity save creates no misleading successful change audit");
  const beforeRollback = await auditCount();
  await db.exec("begin"); await update(4,"rolled.back","TEST Person 4"); await db.exec("rollback");
  check((await get(4)).username === "reserved.name" && await auditCount() === beforeRollback, "identity edit and audit both roll back together");
  await db.query("select public.office_set_staff_access($1,'owner',true,'TEST second Owner')", [user(2)]);
  await as(2);
  await db.query("select public.office_verify_staff_identity($1,'試験 Owner 김 A-B','TEST independently verified')", [user(1)]);
  await as(1);
  check(!(await get(1)).can_edit_real_name, "own verified name detail requires correction review");
  await reject("select public.office_owner_update_identity($1,'owner.self','Self unreviewed','self correction')", [user(1)]);
  await update(1,"owner.self","試験 Owner 김 A-B");
  check((await get(1)).username === "owner.self", "own verified name may keep its value while username changes");

  // 프로필/동의 제한과 역할 경계는 다른 Owner의 세부 편집으로도 바뀌지 않습니다.
  await privileged();
  for (const [n,status] of [[6,"pending"],[7,"rejected"],[8,"suspended"]]) {
    await db.query("insert into auth.users(id,email) values($1,$2)",[user(n),`fixture-${n}@example.invalid`]);
    await db.query("insert into private.staff_accounts(user_id,username,real_name,department,notice_accepted_at,approval_status) values($1,$2,'TEST Applicant','TEST',now(),$3)",[user(n),`applicant.${n}`,status]);
  }
  await db.query("insert into auth.users(id) values($1)",[user(99)]);
  await reject("insert into private.staff_accounts(user_id,username,real_name,department,notice_accepted_at,profile_enrollment_pending) values($1,'bad.incomplete','Provided',null,null,true)",[user(99)]);
  await as(1);
  for (const n of [6,7,8]) {
    const edit = await update(n,`updated.${n}`,"TEST Provided Name");
    check(edit.role === null && !edit.active && edit.approval_status === ({6:"pending",7:"rejected",8:"suspended"}[n]), "details edit never grants permission to unapproved or suspended member");
  }
  await privileged();
  await db.query("insert into auth.users(id,email) values($1,'legacy-nine@example.invalid')",[user(9)]);
  await db.query("insert into auth.sessions(id,user_id) values($1,$2)",[user(10009),user(9)]);
  await db.query("insert into public.admin_roles(user_id,email,role) values($1,'legacy-nine@example.invalid','owner')",[user(9)]);
  await privileged("service_role"); await db.query("select public.staff_auth_bootstrap_owner($1,'legacy.nine')",[user(9)]);
  await as(1);
  const otherPartial = await update(9,"legacy.renamed","TEST Provided Legacy Name");
  check(otherPartial.profile_enrollment_pending && otherPartial.name_verified_at===null && otherPartial.name_verified_by===null,"another Owner may enter provided legacy name but cannot confirm incomplete profile or self consent");
  await as(9);
  const otherPartialState = await value("select public.office_account_state() as value");
  check(otherPartialState.department===null && !otherPartialState.identity_enrolled && otherPartialState.approved_real_name===null,"another Owner never invents missing department or notice acceptance");
  await db.query("select public.office_enroll_identity('legacy.renamed','TEST Provided Legacy Name','TEST Provided Department',true)");
  check((await value("select public.office_account_state() as value")).identity_enrolled,"only normal self-enrollment completes provided missing profile fields and notice");
  await as(1);
  await reject("select public.office_owner_account($1)",[user(99)]);
  await reject("select public.office_owner_begin_password_reset($1,$2,'unmapped')",[user(99),user(601)]);
  await reject("select * from private.staff_owner_password_operations");
  await reject("select public.staff_auth_owner_password_claim($1,$2)",[user(601),user(1)]);
  await privileged("service_role");
  await reject("select * from private.staff_owner_password_operations");
  await reject("select public.office_owner_account($1)",[user(1)]);
  await privileged();
  check(await value("select relrowsecurity as value from pg_class where oid='private.staff_owner_password_operations'::regclass"), "operation registry has RLS enabled");
  check(await value("select count(*)=0 as value from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private') and p.proname like 'staff_auth_owner_password_%' and (has_function_privilege('anon',p.oid,'execute') or has_function_privilege('authenticated',p.oid,'execute'))"), "password claim and finish have no client EXECUTE leak");

  // 취소/만료된 실제 Auth 세션과 MFA는 직접 RPC에서도 검사합니다.
  await as(1);
  await db.query("select set_config('request.jwt.claim.session_id',$1,false)",[user(10002)]);
  await reject("select public.office_owner_account($1)",[user(1)]);
  await as(1);
  await privileged(); await db.query("update auth.sessions set not_after=now()-interval '1 minute' where id=$1",[user(10001)]);
  await as(1); await reject("select public.office_staff_applications()");
  await reject("select public.office_owner_update_identity($1,'cannot.expired','TEST Person 4','expired')",[user(4)]);
  await privileged(); await db.query("update auth.sessions set not_after=null where id=$1",[user(10001)]);
  await as(1);
  for (const method of ["recovery","invite","email_signup","token_refresh"]) {
    await amr(method); await reject("select public.office_owner_begin_password_reset($1,$2,'wrong AMR')",[user(6),user(602)]);
  }
  await amr("password",901); await reject("select public.office_owner_begin_password_reset($1,$2,'old AMR')",[user(6),user(602)]);
  await amr("password",-61); await reject("select public.office_owner_begin_password_reset($1,$2,'future AMR')",[user(6),user(602)]);
  await as(1);
  const pendingReset = await begin(6,610);
  check(pendingReset.state === "requested" && pendingReset.target_user_id === user(6) && pendingReset.actor_id === user(1), "Owner can request reset for pending mapped member without approving it");
  check((await begin(6,610)).state === "requested", "same immutable requested operation is idempotent");
  await reject("select public.office_owner_begin_password_reset($1,$2,'TEST ONLY password reset')",[user(7),user(610)]);
  await reject("select public.office_owner_begin_password_reset($1,$2,'changed reason')",[user(6),user(610)]);
  await privileged("service_role");
  await reject("select public.staff_auth_owner_password_claim($1,$2)",[user(610),user(2)]);
  await reject(outcomeSQL,[user(610),user(1),"succeeded"]);
  const executing = await claim(610);
  check(executing.state === "executing", "service claim authorizes exactly one native Auth execution");
  await reject("select public.staff_auth_owner_password_claim($1,$2)",[user(610),user(1)]);
  await reject(outcomeSQL,[user(610),user(2),"succeeded"]);
  await reject(outcomeSQL,[user(610),user(1),"requested"]);
  await finish(610,"succeeded"); await finish(610,"succeeded");
  await reject(outcomeSQL,[user(610),user(1),"failed"]);
  await as(1);
  check((await begin(6,610)).state === "succeeded", "completed retry returns terminal state without another Auth claim");
  check((await get(6)).approval_status === "pending" && !(await get(6)).active, "password outcome changes no pending member approval or access");
  const passwordLogs = (await value("select public.office_staff_audit(100,null) as value")).filter((row)=>row.reason?.includes(user(610)));
  check(passwordLogs.length === 2 && passwordLogs.every((row)=>row.actor_id===user(1) && row.actor_name==="試験 Owner 김 A-B" && row.actor_role==="owner" && row.requested_by===user(1)), "one requested and one terminal audit use trusted Owner snapshot");
  check(passwordLogs.every((row)=>Object.keys(row.before_values).length===0 && Object.keys(row.after_values).length===0 && row.source==="owner_password_reset"), "password audit contains no old/new credential values");
  await begin(8,611); await begin(8,612);
  await privileged("service_role"); await claim(611);
  await reject("select public.staff_auth_owner_password_claim($1,$2)",[user(612),user(1)]);
  await finish(611,"uncertain");
  check((await claim(612)).state==="executing","different operation UUID cannot overlap executing target; explicit later operation permitted after uncertain outcome");
  await finish(612,"failed");
  for (const [idx,method] of ["password","otp","magiclink","totp","webauthn"].entries()) {
    await as(1); await amr(method); await begin(7,620+idx);
    await privileged("service_role"); await claim(620+idx); await finish(620+idx,"failed");
  }
  check(true,"each permitted fresh native AMR method may request a password reset");
  await as(1); await begin(8,630);
  await privileged(); await db.query("update private.staff_owner_password_operations set expires_at=now()-interval '1 minute' where operation_id=$1",[user(630)]);
  await privileged("service_role"); await reject("select public.staff_auth_owner_password_claim($1,$2)",[user(630),user(1)]);
  await as(1); await begin(8,631);
  await privileged(); await db.query("delete from auth.sessions where id=$1",[user(10001)]);
  await privileged("service_role"); await reject("select public.staff_auth_owner_password_claim($1,$2)",[user(631),user(1)]);
  await privileged(); await db.query("insert into auth.sessions(id,user_id) values($1,$2)",[user(10001),user(1)]);
  await as(1); await begin(8,632);
  await privileged(); await db.query("insert into auth.mfa_factors(user_id,status) values($1,'verified')",[user(1)]);
  await as(1);
  await reject("select public.office_owner_account($1)",[user(1)]);
  await reject("select public.office_staff_name_requests()");
  await reject("select public.office_owner_begin_password_reset($1,$2,'MFA bypass')",[user(8),user(633)]);
  await privileged("service_role"); await reject("select public.staff_auth_owner_password_claim($1,$2)",[user(632),user(1)]);
  await privileged(); await db.query("update auth.sessions set aal='aal2' where id=$1",[user(10001)]);
  await as(1);
  await reject("select public.office_owner_account($1)",[user(1)]);
  await db.query("select set_config('request.jwt.claim.aal','aal2',false)");
  check((await get(1)).active, "verified MFA requires both signed AAL2 and live session AAL2");
  await begin(1,640);
  await privileged("service_role"); await claim(640);
  // 실제 Admin API의 본인 비밀번호 변경처럼 세션을 지운 다음에도 최종 결과를 기록해야 합니다.
  await privileged(); await db.query("delete from auth.sessions where id=$1",[user(10001)]);
  await privileged("service_role"); await finish(640,"succeeded");
  await as(1); await reject("select public.office_owner_account($1)",[user(1)]);
  await privileged();
  check(await value("select state='succeeded' as value from private.staff_owner_password_operations where operation_id=$1",[user(640)]), "self-reset final audit survives native session revocation");
  await db.query("insert into auth.sessions(id,user_id,aal) values($1,$2,'aal2')",[user(10001),user(1)]);
  await db.query("delete from auth.mfa_factors where user_id=$1",[user(1)]);
  await as(2); await begin(8,650);
  await as(1); await db.query("select public.office_set_staff_access($1,'owner',false,'TEST revoked Owner')",[user(2)]);
  await privileged("service_role"); await reject("select public.staff_auth_owner_password_claim($1,$2)",[user(650),user(2)]);
  await as(2); await reject("select public.office_owner_account($1)",[user(1)]);
  await as(1); await db.query("select public.office_set_staff_access($1,'owner',true,'TEST restore Owner')",[user(2)]);
  await begin(8,651); await privileged("service_role"); await claim(651);
  await as(2); await update(1,"owner.self","TEST New independently verified Name");
  await privileged("service_role"); await finish(651,"uncertain");
  await as(1);
  const snapshot = (await value("select public.office_staff_audit(100,null) as value")).find((row)=>row.action==="owner_password_reset_uncertain" && row.reason?.includes(user(651)));
  check(snapshot.actor_name==="試験 Owner 김 A-B" && snapshot.executor==="staff_auth_edge_function", "outcome retains actor name at authorization even after later independent correction");
  const rollbackCount = await auditCount();
  await db.exec("begin"); await begin(8,660); await db.exec("rollback");
  check(await auditCount()===rollbackCount,"rolled-back request creates no audit event");
  await privileged("service_role"); await reject("select public.staff_auth_owner_password_claim($1,$2)",[user(660),user(1)]);
  await privileged();
  check(await value("select count(*)=0 as value from public.audit_logs where (before_values::text||after_values::text) like '%TEST ONLY fixture value%'"),"no fixture credential value enters audit history");
  console.log(`PostgreSQL Owner accounts: ${checks} identity, live session, MFA, reset and audit checks passed.`);
} finally { await db.close(); }
