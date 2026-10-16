import assert from "node:assert/strict";
import { officeDatabase } from "./office-database.mjs";

// 운영 Auth/비밀번호에 연결하지 않고 PostgreSQL의 승인·일회용 claim·감사 경계를 검사합니다.
const { db, as, user } = await officeDatabase();
let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks++; };
const reject = async (sql, args = []) => { await assert.rejects(db.query(sql, args)); checks++; };
const value = async (sql, args = []) => (await db.query(sql, args)).rows[0]?.value;
const proof = "a".repeat(64), wrongProof = "b".repeat(64), fingerprint = "a1b2c3d4e5f60718";
const request = (n, username = "owner.one", hash = proof, fp = fingerprint) => value("select public.staff_auth_support_recovery_request($1,$2,$3,$4) as value", [user(n), username, hash, fp]);
const status = (n, hash = proof) => value("select public.staff_auth_support_recovery_status($1,$2) as value", [user(n), hash]);
const approve = (n, target = 1, fp = fingerprint, reason = "credential_recovery") => value("select private.approve_staff_support_recovery($1,$2,$3,$4) as value", [user(n), user(target), fp, reason]);
const claim = (n, hash = proof) => value("select public.staff_auth_support_recovery_claim($1,$2) as value", [user(n), hash]);
const finish = (n, state, hash = proof) => db.query("select public.staff_auth_support_recovery_finish($1,$2,$3)", [user(n), hash, state]);
const privileged = (role) => db.exec(role ? `set role ${role}` : "reset role");
const auditCount = () => value("select count(*)::int as value from public.audit_logs where source='project_admin_recovery'");
try {
  await privileged("service_role");
  await db.query("select public.staff_auth_bootstrap_owner($1,'owner.one')", [user(1)]);
  const real = await request(700, " OWNER.ONE "), missing = await request(701, "missing.owner");
  check(Object.keys(real).sort().join() === "device_fingerprint,expires_at,request_id", "request response has no account UUID, role or email");
  check(Object.keys(real).sort().join() === Object.keys(missing).sort().join(), "unknown account receives identical pending response shape");
  check((await status(700)).state === "requested" && (await status(701)).state === "requested", "public requests never self-approve or enumerate mapping");
  const repeated = await request(700);
  check(repeated.expires_at === real.expires_at, "request replay cannot extend its original ten-minute expiry");
  check((await status(700, wrongProof)).state === "unavailable" && (await status(799)).state === "unavailable", "wrong proof and unknown request have identical status");
  await reject("select public.staff_auth_support_recovery_claim($1,$2)", [user(700), proof]);
  await reject("select private.approve_staff_support_recovery($1,$2,$3)", [user(700), user(1), fingerprint]);
  await reject("select * from private.staff_support_recovery_requests");
  await privileged();
  check(await value("select relrowsecurity as value from pg_class where oid='private.staff_support_recovery_requests'::regclass"), "private recovery registry has RLS");
  check(await value("select not has_function_privilege('service_role','private.approve_staff_support_recovery(uuid,uuid,text,text)','execute') as value"), "service role cannot approve");
  check(await value("select count(*)=0 as value from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.proname like '%support_recovery%' and n.nspname in ('public','private') and (has_function_privilege('anon',p.oid,'execute') or has_function_privilege('authenticated',p.oid,'execute'))"), "no recovery function has client EXECUTE grants");
  for (const [target, fp, reason] of [[2,fingerprint,"credential_recovery"],[1,"0".repeat(16),"credential_recovery"],[1,fingerprint,"free text must not enter audit"]]) {
    await assert.rejects(approve(700,target,fp,reason)); checks++;
  }
  await assert.rejects(approve(701)); checks++;
  const approved = await approve(700);
  check(approved.state === "approved" && Date.parse(approved.approval_expires_at) <= Date.parse(real.expires_at), "control-plane approval binds exact Owner UUID and fingerprint within original expiry");
  await db.query("update auth.users set email='changed-owner@example.invalid' where id=$1", [user(1)]);
  await privileged("service_role");
  const ready = await status(700);
  check(ready.state === "approved" && ready.device_fingerprint === fingerprint && ready.request_id === user(700), "correct device may inspect approval without any account fields");
  check(!JSON.stringify(ready).includes(user(1)), "status never exposes target UUID");
  await reject("select public.staff_auth_support_recovery_claim($1,$2)", [user(700), wrongProof]);
  const executing = await claim(700);
  check(executing.state === "executing" && executing.target_user_id === user(1), "normalized username and email change preserve the immutable claim UUID");
  check((await claim(700)).state === "uncertain" && !(await claim(700)).target_user_id, "executing retry never grants another Auth call");
  await reject("select public.staff_auth_support_recovery_finish($1,$2,'requested')", [user(700), proof]);
  await reject("select public.staff_auth_support_recovery_finish($1,$2,'succeeded')", [user(700), wrongProof]);
  await finish(700,"succeeded");
  await finish(700,"succeeded");
  await reject("select public.staff_auth_support_recovery_finish($1,$2,'failed')", [user(700), proof]);
  check((await claim(700)).state === "succeeded" && !(await claim(700)).target_user_id, "success replay reports only prior completion, not another password application");
  await privileged();
  const audit = (await db.query("select * from public.audit_logs where source='project_admin_recovery' and reason like $1 order by id", [`%${user(700)}`])).rows;
  check(audit.map(row=>row.action).join() === "project_admin_recovery_requested,project_admin_recovery_approved,project_admin_recovery_executing,project_admin_recovery_succeeded", "all committed workflow stages are audited once");
  check(audit.every(row=>row.actor_id===null && row.actor_name===null && row.requested_by===null && row.actor_role===null), "unverified project administrator is not attributed to target Owner or invented person");
  check(audit.every(row=>Object.keys(row.before_values).length===0 && Object.keys(row.after_values).length===0 && !JSON.stringify(row).includes(proof) && !JSON.stringify(row).includes(fingerprint)), "audit excludes proofs, fingerprints, credentials and contact fields");
  check(audit[1].executor === "project_admin_control_plane" && audit[2].executor === "staff_auth_edge_function", "control-plane approver and actual Edge executor are distinguished");
  check(await value("select profile_enrollment_pending as value from private.staff_accounts where user_id=$1", [user(1)]), "sole legacy Owner remains incomplete; recovery creates no real name or consent");

  // 승인/실행에서 현재 DB 권한과 Auth 정지를 다시 확인합니다.
  for (const n of [702,703,704,705,706,707,708,709]) { await privileged("service_role"); await request(n); }
  await privileged();
  await db.query("update auth.users set banned_until=clock_timestamp()+interval '1 hour' where id=$1", [user(1)]);
  await assert.rejects(approve(702)); checks++;
  await privileged("service_role"); await reject("select public.staff_auth_support_recovery_claim($1,$2)", [user(700), proof]);
  await privileged();
  await db.query("update auth.users set banned_until=null where id=$1", [user(1)]);
  await approve(702);
  await db.query("update auth.users set banned_until=clock_timestamp()+interval '1 hour' where id=$1", [user(1)]);
  await privileged("service_role"); await reject("select public.staff_auth_support_recovery_claim($1,$2)", [user(702), proof]);
  await privileged(); await db.query("update auth.users set banned_until=null where id=$1", [user(1)]);
  await db.query("update public.admin_roles set role='owner' where user_id=$1", [user(2)]);
  await assert.rejects(approve(703)); checks++;
  await db.query("update public.admin_roles set role='administrator' where user_id=$1", [user(2)]);
  await approve(703);
  await db.query("update public.admin_roles set role='owner' where user_id=$1", [user(2)]);
  await privileged("service_role"); await reject("select public.staff_auth_support_recovery_claim($1,$2)", [user(703), proof]);
  await privileged(); await db.query("update public.admin_roles set role='administrator' where user_id=$1", [user(2)]);
  // 실제 만료 시간은 기존 제약을 지키는 과거 타임스탬프로 이동합니다.
  // 만료 시나리오는 한 SQL 문장의 같은 기준 시각으로 만듭니다. clock_timestamp()를 두 번 부르면 미세한 차이로 최대 유효기간 CHECK를 넘을 수 있습니다.
  await db.query("update private.staff_support_recovery_requests set requested_at=statement_timestamp()-interval '20 minutes',expires_at=statement_timestamp()-interval '10 minutes' where request_id=$1", [user(704)]);
  await assert.rejects(approve(704)); checks++;
  await approve(705);
  await db.query("update private.staff_support_recovery_requests set approved_at=statement_timestamp()-interval '6 minutes',approval_expires_at=statement_timestamp()-interval '1 minute' where request_id=$1", [user(705)]);
  await privileged("service_role"); check((await status(705)).state === "expired", "approval expires even while original request remains within TTL");
  await reject("select public.staff_auth_support_recovery_claim($1,$2)", [user(705), proof]);
  await privileged(); await approve(706); await approve(707);
  await privileged("service_role"); await claim(706);
  await reject("select public.staff_auth_support_recovery_claim($1,$2)", [user(707), proof]);
  await finish(706,"uncertain");
  check((await claim(706)).state === "uncertain", "uncertain terminal request cannot be executed again");
  check((await claim(707)).state === "executing", "pending requests never lock a target; explicitly approved later request may execute after resolution");
  await finish(707,"failed");
  check((await claim(707)).state === "failed", "failed operation requires a new request and new platform approval");

  // 기존 Owner 웹 초기화와 같은 대상의 외부 Auth 변경이 겹치지 않습니다.
  await as(1);
  await db.query("select public.office_owner_begin_password_reset($1,$2,'TEST ONLY cross-path reset')", [user(1),user(750)]);
  await privileged(); await approve(708);
  await privileged("service_role"); await claim(708);
  await reject("select public.staff_auth_owner_password_claim($1,$2)", [user(750),user(1)]);
  await finish(708,"failed");
  await db.query("select public.staff_auth_owner_password_claim($1,$2)", [user(750),user(1)]);
  await privileged(); await approve(709);
  await privileged("service_role"); await reject("select public.staff_auth_support_recovery_claim($1,$2)", [user(709),proof]);
  await db.query("select public.staff_auth_owner_password_finish($1,$2,'failed')", [user(750),user(1)]);
  check((await claim(709)).state === "executing", "shared target lock works in both directions");
  await finish(709,"failed");

  // 업무 변경과 감사가 같은 트랜잭션에 묶여 롤백·실패가 완료로 남지 않습니다.
  await request(710);
  await privileged();
  const before = await auditCount();
  await db.exec("begin"); await approve(710); await db.exec("rollback");
  check(await auditCount()===before, "rolled-back approval has no success audit");
  await privileged("service_role"); check((await status(710)).state === "requested", "rolled-back approval never grants a claim");
  for (const role of ["anon","authenticated"]) {
    await privileged(role);
    await reject("select public.staff_auth_support_recovery_request($1,'owner.one',$2,$3)", [user(720),proof,fingerprint]);
    await reject("select public.staff_auth_support_recovery_status($1,$2)", [user(700),proof]);
    await reject("select public.staff_auth_support_recovery_claim($1,$2)", [user(700),proof]);
    await reject("select public.staff_auth_support_recovery_finish($1,$2,'succeeded')", [user(700),proof]);
    await reject("select private.approve_staff_support_recovery($1,$2,$3)", [user(710),user(1),fingerprint]);
    await reject("select * from private.staff_support_recovery_requests");
  }
  console.log(`support recovery SQL: ${checks} checks passed`);
} finally { await db.close(); }
