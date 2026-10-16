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
  await reject("select public.office_set_staff_access($1,'staff',true,'not Owner')", [user(3)]);
  await as(1);
  await db.query("select public.office_verify_staff_identity($1,'TEST Person 3','TEST verified')", [user(3)]);
  await as(3);
  await db.query("select public.office_request_name_change('Stale Request','TEST correction')");
  const nameRequest = (await value("select public.office_account_state() as value")).name_request.id;
  await as(2);
  await reject("select public.office_review_name_change($1,true,'not Owner')", [nameRequest]);
  await as(1);
  const corrected = await update(3,"editor.changed","別人 Test Hyphen-Name");
  check(corrected.user_id === user(3) && corrected.name_verified_by === user(1) && corrected.role === "staff", "different Owner confirms provided name without granting role or changing UUID");
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
} finally { await db.close(); }

// 초기 총괄 등록은 위의 일반 계정 변경 시험과 분리한 격리 DB에서만 실행합니다.
// 실제 계정/이름/비밀번호를 쓰지 않으며 이미 존재하는 UUID와 권한의 유지 여부를 비교합니다.
{
  const { db: setupDb, as: setupAs, user: setupUser } = await officeDatabase();
  const setupSQL = "select private.initialize_legacy_owner_identity($1,$2,$3,$4,$5,$6) as value";
  const setupArgs = [setupUser(1), "initial.owner", "TEST Initial Owner", true, "TEST delegated request reference", "TEST explicit delegated internal-notice acknowledgment; no browser checkbox claimed"];
  const read = async (sql, params = []) => (await setupDb.query(sql, params)).rows[0]?.value;
  const deny = async (sql, params = []) => { await assert.rejects(setupDb.query(sql, params)); checks++; };
  const maintenance = async (role = null) => {
    await setupDb.exec(role ? `set role ${role}` : "reset role");
    await setupDb.query("select set_config('request.jwt.claim.sub','',false)");
  };
  const initialize = (args = setupArgs) => read(setupSQL, args);
  const setupCount = () => read("select count(*)::int as value from private.initial_owner_identity_setup");
  const logCount = () => read("select count(*)::int as value from public.audit_logs");
  const temporaryDenial = async (mutation, params = []) => {
    await setupDb.exec("begin");
    try { await setupDb.query(mutation, params); await deny(setupSQL, setupArgs); }
    finally { await setupDb.exec("rollback"); }
  };
  try {
    await maintenance("service_role");
    await setupDb.query("select public.staff_auth_bootstrap_owner($1,'initial.owner')", [setupUser(1)]);
    await setupAs(1);
    await setupDb.query("select public.office_owner_update_identity($1,'initial.owner','TEST Initial Owner','TEST provided existing name')", [setupUser(1)]);
    await maintenance();
    check(await read("select not prosecdef as value from pg_proc where oid='private.initialize_legacy_owner_identity(uuid,text,text,boolean,text,text)'::regprocedure"), "initial registration is SECURITY INVOKER rather than a privileged client RPC");
    for (const role of ["anon", "authenticated", "service_role"]) {
      check(!await read("select has_function_privilege($1,'private.initialize_legacy_owner_identity(uuid,text,text,boolean,text,text)','execute') as value", [role]), `${role} has no initializer EXECUTE grant`);
      await maintenance(role);
      await deny(setupSQL, setupArgs);
      await deny("select * from private.initial_owner_identity_setup");
      await deny("insert into private.initial_owner_identity_setup(user_id,username_at_setup,real_name_at_setup,setup_at,notice_acknowledgment,request_reference,reason) values($1,'forged','Forged',now(),'delegated_account_holder_request','forged','forged')", [setupUser(1)]);
      await maintenance();
    }
    check(await read("select count(*)=0 as value from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='initialize_legacy_owner_identity'"), "no exposed initializer wrapper exists");
    await setupDb.query("select set_config('request.jwt.claim.sub',$1,false)", [setupUser(1)]);
    await deny(setupSQL, setupArgs);
    await maintenance();
    const beforeFailures = await logCount();
    for (const [index, invalid] of [[0, setupUser(2)], [0, setupUser(99)], [1, "wrong.owner"], [2, "Different name"], [2, null], [3, false], [3, null], [4, ""], [4, "bad\nreference"], [5, ""]]) {
      const args = [...setupArgs]; args[index] = invalid;
      await deny(setupSQL, args);
    }
    await temporaryDenial("update auth.users set banned_until=now()+interval '1 hour' where id=$1", [setupUser(1)]);
    await temporaryDenial("update auth.sessions set not_after=now()-interval '1 second' where user_id=$1", [setupUser(1)]);
    await temporaryDenial("update public.admin_roles set role='owner' where user_id=$1", [setupUser(2)]);
    await setupDb.exec("begin");
    await setupDb.query("update public.admin_roles set role='owner' where user_id=$1", [setupUser(2)]);
    await setupDb.query("update auth.users set banned_until=now()+interval '1 hour' where id=$1", [setupUser(2)]);
    await deny(setupSQL, setupArgs);
    await setupDb.exec("rollback");
    await setupDb.exec("begin");
    await setupDb.query("update public.admin_roles set role='owner' where user_id=$1", [setupUser(2)]);
    await setupDb.query("update private.staff_accounts set approval_status='suspended' where user_id=$1", [setupUser(1)]);
    await deny(setupSQL, setupArgs);
    await setupDb.exec("rollback");
    check(await setupCount() === 0 && await logCount() === beforeFailures, "denied initialization creates neither ledger proof nor successful audit");
    await setupDb.exec("begin");
    const rolledBack = await initialize();
    check(rolledBack.name_verification_source === "initial_owner_setup" && await setupCount() === 1, "valid maintenance initialization creates its exact proof atomically");
    await setupDb.exec("rollback");
    check(await setupCount() === 0 && await logCount() === beforeFailures && await read("select name_verified_at is null as value from private.staff_accounts where user_id=$1", [setupUser(1)]), "rollback removes account stamp, ledger and initial audit together");
    const unchangedSQL = "select jsonb_build_object('auth',(select jsonb_agg(to_jsonb(u) order by id) from auth.users u),'sessions',(select jsonb_agg(to_jsonb(s) order by id) from auth.sessions s),'roles',(select jsonb_agg(to_jsonb(r) order by user_id) from public.admin_roles r),'players',(select count(*) from public.players),'articles',(select count(*) from public.articles)) as value";
    const unchangedBefore = await read(unchangedSQL);
    const initialized = await initialize();
    check(initialized.user_id === setupUser(1) && initialized.name_verified_by === null && initialized.profile_enrollment_pending === false, "initial registration never invents a human verifier or changes target UUID");
    assert.deepEqual(await read(unchangedSQL), unchangedBefore); checks++;
    const row = await read("select to_jsonb(a) as value from private.staff_accounts a where user_id=$1", [setupUser(1)]);
    check(row.username === "initial.owner" && row.real_name === "TEST Initial Owner" && row.department === "" && row.notice_accepted_at && row.name_verified_at && row.name_verification_source === "initial_owner_setup" && row.name_verified_by === null && !row.profile_enrollment_pending, "only delegated notice/profile completion and source-specific initial stamp are stored; no affiliation is guessed");
    const proof = await read("select to_jsonb(s) as value from private.initial_owner_identity_setup s");
    check(proof.user_id === setupUser(1) && proof.username_at_setup === row.username && proof.real_name_at_setup === row.real_name && proof.setup_at === row.name_verified_at && proof.request_reference === setupArgs[4] && proof.notice_acknowledgment === "delegated_account_holder_request", "immutable proof binds exact initial UUID/name/time/request and acknowledgment provenance");
    const setupAudit = await read("select to_jsonb(l) as value from public.audit_logs l where action='initial_owner_identity_initialized'");
    check(await logCount() === beforeFailures + 1 && setupAudit.actor_id === null && setupAudit.actor_name === null && setupAudit.actor_role === null && setupAudit.actor_name_status === "system" && setupAudit.requested_by === setupUser(1) && setupAudit.source === "initial_owner_setup" && setupAudit.executor === "ai_assisted_database_maintenance", "exactly one committed initial audit separates requesting target from automated maintenance executor");
    check(!JSON.stringify([setupAudit.before_values, setupAudit.after_values, setupAudit.reason]).includes("TEST Initial Owner") && !JSON.stringify(setupAudit).includes(setupArgs[4]), "public audit diffs contain no name or private request reference");
    await deny(setupSQL, setupArgs);
    await deny(setupSQL, [setupUser(2), ...setupArgs.slice(1)]);
    await deny("update private.initial_owner_identity_setup set request_reference='rewrite'");
    await deny("delete from private.initial_owner_identity_setup");
    await deny("truncate private.initial_owner_identity_setup");
    await deny("update private.staff_accounts set real_name='Forged stamped name' where user_id=$1", [setupUser(1)]);
    check(await logCount() === beforeFailures + 1 && await setupCount() === 1, "replay, rewrite and retained-stamp name forgery create no misleading success");
    await setupAs(1);
    const own = await read("select public.office_account_state() as value");
    check(own.approved_real_name === row.real_name && own.identity_enrolled && own.name_edit_mode === "review_required" && own.name_verification_source === "initial_owner_setup" && own.name_verified_by_name === null, "own state exposes initial source and blocks self correction without claiming a human verifier");
    const detail = await read("select public.office_owner_account($1) as value", [setupUser(1)]);
    const applications = await read("select public.office_staff_applications() as value");
    check(detail.name_verification_source === "initial_owner_setup" && detail.can_edit_real_name === false && applications.find((a) => a.user_id === setupUser(1)).profile_enrollment_pending === false, "Owner detail and member applications expose consistent initial completion source");
    await deny("select public.office_update_unverified_name('Self changed','TEST self')");
    await deny("select public.office_owner_update_identity($1,'initial.owner','Self changed','TEST self')", [setupUser(1)]);
    await deny("select public.office_verify_staff_identity($1,'TEST Initial Owner','TEST self')", [setupUser(1)]);
    await deny("select public.office_enroll_identity('initial.owner','Self changed','',true)");
    await setupDb.query("select public.office_owner_update_identity($1,'initial.renamed','TEST Initial Owner','TEST legitimate ID change')", [setupUser(1)]);
    check((await read("select public.office_account_state() as value")).name_verification_source === "initial_owner_setup", "later legitimate username change does not invalidate immutable initial name proof");
    await setupDb.query("select public.office_request_name_change('TEST Requested Later Name','TEST correction requires independent review')");
    check((await read("select public.office_account_state() as value")).real_name === row.real_name, "name correction request retains the initial name until separate approval");
    await setupAs(2);
    await setupDb.query("select public.office_enroll_identity('review.owner','TEST Other Owner','',true)");
    await maintenance();
    await deny("update private.staff_accounts set name_verification_source='initial_owner_setup',name_verified_at=now() where user_id=$1", [setupUser(2)]);
    await setupAs(1);
    await setupDb.query("select public.office_set_staff_access($1,'owner',true,'TEST independently assigned second Owner')", [setupUser(2)]);
    await setupAs(2);
    await setupDb.query("select public.office_verify_staff_identity($1,'TEST Initial Owner','TEST actual later independent review')", [setupUser(1)]);
    const reviewed = await read("select public.office_owner_account($1) as value", [setupUser(1)]);
    check(reviewed.name_verification_source === "staff_review" && reviewed.name_verified_by === setupUser(2), "later different Owner can confirm the same initial name and changes source to independent staff review");
    const reviewAudit = (await read("select public.office_staff_audit(100,null) as value")).find((entry) => entry.action === "identity_verified" && entry.record_id === setupUser(1));
    check(reviewAudit.source === "human" && reviewAudit.after_values.name_verification_source === "staff_review" && !JSON.stringify(reviewAudit).includes(setupArgs[4]), "later human verification audit preserves the safe source enum without leaking the private initial request");
    await deny("select public.office_verify_staff_identity($1,'TEST Initial Owner','TEST duplicate')", [setupUser(1)]);
    await setupDb.query("select public.office_owner_update_identity($1,'initial.renamed','TEST Other Owner Corrected','TEST actual reviewed name correction')", [setupUser(1)]);
    check((await read("select public.office_owner_account($1) as value", [setupUser(1)])).name_verification_source === "staff_review", "later real name correction retains normal other-Owner review semantics");
    await maintenance();
    assert.deepEqual(await read("select to_jsonb(s) as value from private.initial_owner_identity_setup s"), proof); checks++;
    assert.deepEqual(await read("select to_jsonb(l) as value from public.audit_logs l where action='initial_owner_identity_initialized'"), setupAudit); checks++;
  } finally { await setupDb.close(); }
}
console.log(`PostgreSQL Owner accounts: ${checks} identity, live session, MFA, reset, initial registration and audit checks passed.`);
