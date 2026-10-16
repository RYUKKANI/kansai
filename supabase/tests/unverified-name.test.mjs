import assert from "node:assert/strict";
import { officeDatabase } from "./office-database.mjs";

// [편집 안내] 실제 서비스 계정 없이, 미완료 레거시 Owner와 확인된 실명의 경계를 검증합니다.
const { db, as, user } = await officeDatabase();
let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks++; };
const value = async (sql, params = []) => (await db.query(sql, params)).rows[0]?.value;
const reject = async (sql, params = [], pattern) => {
  await assert.rejects(db.query(sql, params), pattern);
  checks++;
};
const state = () => value("select public.office_account_state() as value");
const save = (name, reason = "TEST ONLY spelling correction") => value(
  "select public.office_update_unverified_name($1,$2) as value", [name, reason],
);
async function privileged(role = null) {
  await db.exec(role ? `set role ${role}` : "reset role");
  await db.query("select set_config('request.jwt.claim.sub','',false)");
}
const auditCount = () => value("select count(*)::int as value from public.audit_logs");

try {
  await db.exec("update auth.users set email='fixture-'||id::text||'@example.invalid'");
  await privileged("service_role");
  await db.query("select public.staff_auth_bootstrap_owner($1,'owner.one')", [user(1)]);
  await as(1);
  let account = await state();
  check(account.profile_enrollment_pending && !account.identity_enrolled && account.name_edit_mode === "unverified_edit" && account.can_edit_real_name,
    "legacy sole Owner sees direct unverified-name capability before department and notice enrollment");
  const changed = await save("  佐藤 李 A-B  ");
  check(changed.user_id === user(1) && changed.username === "owner.one" && changed.real_name === "佐藤 李 A-B" && changed.role === "owner" && changed.active,
    "real-name save preserves stable UUID, normalized login ID and sole Owner role");
  check(changed.profile_enrollment_pending && !changed.identity_enrolled && changed.department === null && changed.approved_real_name === null && changed.name_verified_at === null && changed.name_verified_by === null,
    "provided unverified name invents no department, consent, verifier or verified display name");
  check((await value("select public.office_staff_directory() as value")).length === 0,
    "incomplete legacy name remains outside the staff directory");
  const audit = (await value("select public.office_staff_audit(100,null) as value")).find((row) => row.action === "unverified_name_updated");
  check(audit.actor_id === user(1) && audit.record_id === user(1) && audit.actor_role === "owner" && audit.actor_name === null && audit.actor_name_status === "unverified" && audit.source === "human" && audit.requested_by === user(1),
    "audit trusts session UUID and role without presenting self-entered text as a verified actor");
  check(JSON.stringify(audit.changed_fields) === '["real_name"]' && JSON.stringify(audit.before_values) === "{}" && JSON.stringify(audit.after_values) === "{}",
    "name audit records the field change while omitting personal name values");
  const beforeNoop = await auditCount();
  await save("佐藤 李 A-B");
  check(await auditCount() === beforeNoop, "same trimmed name creates no success audit or request transition");

  for (const [name, reason] of [[null,"valid"],["","valid"],["   ","valid"],["x".repeat(151),"valid"],["Line\nBreak","valid"],["Tab\tName","valid"],["Valid",""],["Valid"," "]]) {
    await reject("select public.office_update_unverified_name($1,$2)", [name, reason]);
  }
  check((await state()).real_name === "佐藤 李 A-B" && await auditCount() === beforeNoop,
    "rejected input never clears the existing name or records a successful update");
  await reject("select public.office_update_unverified_name($1,$2,$3)", ["forged target", "reason", user(2)]);
  await reject("select public.office_verify_staff_identity($1,'佐藤 李 A-B','self verify')", [user(1)], /self_review_forbidden/);
  await reject("select public.office_set_staff_access($1,'staff',true,'self demote')", [user(1)], /self_review_forbidden/);
  await reject("select public.office_request_name_change('Other Name','enroll first')", [], /identity_enrollment_required/);

  await db.query("select public.office_enroll_identity('owner.one','佐藤 李 A-B','TEST staff',true)");
  account = await state();
  check(account.identity_enrolled && !account.profile_enrollment_pending && account.name_edit_mode === "unverified_edit" && account.name_verified_at === null,
    "normal enrollment supplies real department and notice while leaving external verification separate");
  await db.query("select public.office_request_name_change('Stale Requested Name','TEST previous request')");
  const requestId = (await state()).name_request.id;
  const afterWithdraw = await save("新しい Name");
  check(afterWithdraw.real_name === "新しい Name" && afterWithdraw.name_request.id === requestId && afterWithdraw.name_request.status === "withdrawn" && afterWithdraw.name_request.review_reason === null,
    "self-save atomically withdraws an obsolete request without approval or rejection");
  await privileged();
  const withdrawn = await value("select to_jsonb(r) as value from private.staff_name_requests r where id=$1", [requestId]);
  check(withdrawn.reviewed_by === null && withdrawn.reviewed_at === null && withdrawn.review_reason === null,
    "self-withdrawal creates no fabricated reviewer or verification time");
  await as(1);
  const withdrawalAudit = (await value("select public.office_staff_audit(100,null) as value")).find((row) => row.action === "name_request_withdrawn" && row.record_id === requestId);
  check(withdrawalAudit.actor_id === user(1) && withdrawalAudit.before_values.status === "pending" && withdrawalAudit.after_values.status === "withdrawn",
    "withdrawal has trusted requester attribution and privacy-safe state diff");
  await reject("select public.office_review_name_change($1,true,'self old request')", [requestId], /self_review_forbidden/);
  await db.query("select public.office_request_name_change('New Pending Name','TEST new request after withdrawal')");
  check((await state()).name_request.status === "pending" && (await state()).name_request.id !== requestId,
    "withdrawn request releases the one-pending-request constraint without deleting history");

  // 저장 실패 시 이름, 신청 상태, 감사 기록이 함께 롤백되어야 합니다.
  await privileged();
  await db.exec(`
    create function public.test_reject_name_audit() returns trigger language plpgsql as $$begin
      if new.action='unverified_name_updated' then raise exception 'TEST forced audit failure'; end if;
      return new;
    end$$;
    create trigger test_reject_name_audit before insert on public.audit_logs for each row execute function public.test_reject_name_audit();
  `);
  await as(1);
  const beforeFailure = await auditCount();
  await reject("select public.office_update_unverified_name('Should Not Commit','TEST transaction')", [], /TEST forced audit failure/);
  account = await state();
  check(account.real_name === "新しい Name" && account.name_request.status === "pending" && await auditCount() === beforeFailure,
    "audit failure rolls back name, request withdrawal and all success records");
  await privileged();
  await db.exec("drop trigger test_reject_name_audit on public.audit_logs; drop function public.test_reject_name_audit()");

  for (const n of [2,3,4,5]) {
    await as(n);
    await db.query("select public.office_enroll_identity($1,$2,'TEST staff',true)", [`staff.${n}`, `TEST Person ${n}`]);
  }
  await as(3);
  const editor = await save("同姓 同名 Hyphen-Name");
  check(editor.user_id === user(3) && editor.role === "staff" && editor.active && editor.name_verified_at === null,
    "ordinary approved staff can update only their own unverified name");
  await as(4);
  const coach = await save("同姓 同名 Hyphen-Name");
  check(coach.real_name === editor.real_name && coach.user_id !== editor.user_id && coach.role === "staff",
    "duplicate real names remain valid separate stable UUIDs");
  await reject("update private.staff_accounts set real_name='Forged' where user_id=$1", [user(3)]);
  await reject("select public.office_owner_update_identity($1,'owner.one','Forged','not owner')", [user(1)]);
  await as(5);
  check((await state()).name_edit_mode === "unavailable" && !(await state()).can_edit_real_name,
    "inactive staff see no direct-edit capability");
  await reject("select public.office_update_unverified_name('Suspended','forged')", [], /approved_staff_required/);

  await privileged();
  for (const [n,status] of [[6,"pending"],[7,"rejected"],[8,"suspended"]]) {
    await db.query("insert into auth.users(id,email) values($1,$2)", [user(n), `fixture-${n}@example.invalid`]);
    await db.query("insert into auth.sessions(id,user_id) values($1,$2)", [user(n+10000), user(n)]);
    await db.query("insert into private.staff_accounts(user_id,username,real_name,department,notice_accepted_at,approval_status) values($1,$2,'TEST Applicant','TEST',now(),$3)", [user(n), `applicant.${n}`, status]);
    if (n === 8) await db.query("insert into public.admin_roles(user_id,email,role,active) values($1,'fixture-8@example.invalid','coach',true)", [user(n)]);
  }
  for (const n of [6,7,8]) {
    await as(n);
    check((await state()).name_edit_mode === "unavailable", "unapproved or suspended account cannot edit internal profile");
    await reject("select public.office_update_unverified_name('Forbidden','forged')", [], /approved_staff_required/);
    await reject("select public.office_staff_directory()");
  }
  await as(null);
  await reject("select public.office_update_unverified_name('Anonymous','forged')");
  await privileged("service_role");
  await reject("select public.office_update_unverified_name('Service','forged')");
  await privileged();
  check(await value("select not has_function_privilege('anon','public.office_update_unverified_name(text,text)','execute') and not has_function_privilege('service_role','public.office_update_unverified_name(text,text)','execute') and not has_function_privilege('anon','private.office_update_unverified_name(text,text)','execute') and not has_function_privilege('service_role','private.office_update_unverified_name(text,text)','execute') and has_function_privilege('authenticated','public.office_update_unverified_name(text,text)','execute') as value"),
    "new private implementation and public wrapper grant execute only to authenticated callers");

  // 오래된 JWT가 있어도 현재 정지, 세션 회수, Owner MFA 상태가 우선합니다.
  await db.query("update auth.users set banned_until=now()+interval '1 hour' where id=$1", [user(3)]);
  await as(3);
  await reject("select public.office_update_unverified_name('Banned','forged')", [], /approved_staff_required/);
  await privileged();
  await db.query("update auth.users set banned_until=null where id=$1", [user(3)]);
  await db.query("delete from auth.sessions where id=$1", [user(10003)]);
  await as(3);
  await reject("select public.office_update_unverified_name('Revoked session','forged')", [], /approved_staff_required/);
  await privileged();
  await db.query("insert into auth.sessions(id,user_id) values($1,$2)", [user(10003), user(3)]);
  await db.query("insert into auth.mfa_factors(user_id,status) values($1,'verified')", [user(1)]);
  await as(1);
  await reject("select public.office_update_unverified_name('MFA bypass','forged')", [], /owner_mfa_required/);
  await privileged();
  await db.query("update auth.sessions set aal='aal2' where id=$1", [user(10001)]);
  await as(1);
  await db.query("select set_config('request.jwt.claim.aal','aal2',false)");
  check((await save("MFA Verified Session" )).real_name === "MFA Verified Session", "existing Owner MFA requires signed and native AAL2 before an edit");
  await privileged();
  await db.query("delete from auth.mfa_factors where user_id=$1", [user(1)]);

  await as(1);
  await db.query("select public.office_set_staff_access($1,'owner',true,'TEST second Owner')", [user(2)]);
  await as(2);
  await db.query("select public.office_verify_staff_identity($1,'MFA Verified Session','TEST independent verifier')", [user(1)]);
  await as(1);
  account = await state();
  check(account.name_edit_mode === "review_required" && !account.can_edit_real_name && account.approved_real_name === "MFA Verified Session",
    "independently verified name switches from direct save to correction review");
  await reject("select public.office_update_unverified_name('Self Unverified Again','self bypass')", [], /self_verified_name_requires_review/);
  await db.query("select public.office_request_name_change('Independent Correction','TEST reviewed change')");
  const verifiedRequest = (await state()).name_request.id;
  await reject("select public.office_review_name_change($1,true,'self bypass')", [verifiedRequest], /self_review_forbidden/);
  await as(2);
  await reject("select public.office_review_name_change($1,true,'stale cannot overwrite')", [requestId], /invalid_name_review/);
  await db.query("select public.office_review_name_change($1,true,'TEST approved by another Owner')", [verifiedRequest]);
  await as(1);
  check((await state()).real_name === "Independent Correction" && (await state()).name_verified_by === user(2) && (await state()).role === "owner",
    "different Owner can approve the correction while preserving UUID and role");
  await privileged();
  check(await value("select count(*)=2 as value from public.admin_roles where role='owner' and active"),
    "name changes never remove the last Owner or grant unexpected roles");
  check(await value("select count(*)=0 as value from public.audit_logs where (before_values::text||after_values::text) like '%新しい Name%'"),
    "personal name values never leak through history diffs");
  console.log(`PostgreSQL unverified names: ${checks} profile, approval, live-session, MFA and atomic audit checks passed.`);
} finally {
  await db.close();
}
