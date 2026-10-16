import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { officeDatabase } from "./office-database.mjs";

// [편집 안내] 실제 사용자나 메일을 만들지 않고 가상 PostgreSQL에서 무이메일 가입의
// 예약/확정·Owner 승인·연락처 은닉을 검증합니다. 비밀번호 검증은 별도 네이티브 Auth CI가 담당합니다.
const { db, as, user } = await officeDatabase();
let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks++; };
const value = async (sql, params = []) => (await db.query(sql, params)).rows[0]?.value;
const reject = async (sql, params = [], pattern) => { await assert.rejects(db.query(sql, params), pattern); checks++; };
async function privileged(role = null) {
  await db.exec(role ? `set role ${role}` : "reset role");
  await db.query("select set_config('request.jwt.claim.sub','',false)");
}
const contactSql = "select public.office_staff_application_contact($1) as value";
const contact = (n) => value(contactSql, [user(n)]);
const alias = `staff-${user(1010)}@accounts.kansai.invalid`;
const policy = { staff_signup_policy: "manual_approval_no_email_v1" };
const state = () => value("select public.office_account_state() as value");
async function register(n, username, address, metadata = policy, userMetadata = {}) {
  await privileged("service_role");
  const id = await value("select public.staff_auth_reserve($1,$2,'TEST 同名 김-Name','TEST Club Staff',true,false) as value", [username,address]);
  await privileged();
  await db.query("insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data) values($1,$2,$3,$4)", [user(n), address,metadata,userMetadata]);
  await db.query("insert into auth.sessions(id,user_id) values($1,$2)", [user(n+10000),user(n)]);
  await privileged("service_role");
  return { reservation: id, finalize: () => db.query("select public.staff_auth_finalize($1,$2)", [id,user(n)]) };
}
try {
  await db.exec("update auth.users set email='fixture-'||id::text||'@example.invalid'");
  const realContact = "test-existing-contact@example.invalid";
  const technical = await register(10,"opaque.ten",alias);
  await technical.finalize();
  const existing = await register(11,"existing.eleven",realContact);
  await existing.finalize();
  // 대소문자 정규화/UNIQUE는 기술 주소 도입으로 우회되지 않습니다.
  await reject("select public.staff_auth_reserve('OPAQUE.TEN','unrelated@example.invalid','TEST Name','TEST Staff',true,false)", [], /registration_unavailable/);
  const knownIdentity = await value("select public.staff_auth_identity('OPAQUE.TEN') as value");
  check(knownIdentity.user_id===user(10) && knownIdentity.email===alias, "server-only login lookup resolves normalized username to original Auth UUID/address");
  for (const n of [null,1,2,3,4,10]) {
    await as(n);
    await reject("select public.staff_auth_identity('opaque.ten')");
  }
  await as(10);
  const pending = await state();
  check(pending.user_id===user(10) && pending.approval_status==="pending" && pending.active===false && pending.role===null,
    "technical Auth address cannot authorize the pending application");
  check(pending.email_confirmation_required===false && pending.email_verification_status==="not_required" && pending.email_confirmed===false,
    "native technical confirmation is never represented as proof of email ownership");
  check(!JSON.stringify(pending).includes(alias), "own account state contains no technical contact address");
  check((await db.query("select * from public.admin_roles")).rows.length===0, "pending account cannot read any staff role rows");
  check((await db.query("select * from public.players")).rows.length===0, "pending account cannot access internal player rows");
  await reject("select public.office_staff_directory()",[],/approved_staff_required/);
  await reject("select public.office_staff_applications()",[],/live_owner_required/);
  await reject("select public.office_review_staff($1,'approved','owner','TEST self review')",[user(10)],/live_owner_required/);
  for (const n of [null,2,3,4,10,11]) {
    await as(n); await reject(contactSql,[user(10)]); await reject(contactSql,[user(11)]);
  }
  await as(1);
  const hidden = await contact(10);
  check(hidden.user_id===user(10) && hidden.email===null && hidden.contact_available===false && !JSON.stringify(hidden).includes(alias),
    "live Owner contact RPC never exposes the technical address as contact information");
  const preserved = await contact(11);
  check(preserved.email===realContact && preserved.contact_available===true, "existing real contact addresses remain available through the same restricted legacy RPC");
  const applications = await value("select public.office_staff_applications() as value");
  check(applications.length===2 && applications.every(row=>!Object.hasOwn(row,"email")) && !JSON.stringify(applications).includes(alias),
    "Owner application list includes both identities without technical or real addresses");
  check(applications[0].real_name===applications[1].real_name && applications[0].user_id!==applications[1].user_id,
    "same real names remain valid distinct UUID accounts");

  // 연락처 조회 여부는 승인 조건이 아닙니다. 실제 Owner의 관계/실명 확인 결과로만 승인합니다.
  await db.query("select public.office_review_staff($1,'approved','coach','TEST verified club relationship and name')",[user(10)]);
  const managed = await value("select public.office_owner_account($1) as value",[user(10)]);
  check(managed.user_id===user(10) && managed.username==="opaque.ten" && managed.role==="coach" && managed.active,
    "Owner approves the original technical-address UUID without collecting a contact or replacing an account");
  check(!Object.hasOwn(managed,"email") && !JSON.stringify(managed).includes(alias), "Owner identity/password-management result is contact-free");
  await reject(contactSql,[user(10)],/pending_manual_application_required/);
  await as(10);
  check((await state()).active && (await state()).approved_real_name==="TEST 同名 김-Name", "approved account receives only its DB-assigned role and verified name");
  await reject("select public.office_set_staff_access($1,'owner',true,'TEST self escalation')",[user(10)],/live_owner_required/);
  await privileged();
  const approvedAudit = await value("select to_jsonb(a) as value from public.audit_logs a where entity='staff_accounts' and record_id=$1 and action='application_approved' order by id desc limit 1",[user(10)]);
  check(approvedAudit.actor_id===user(1) && !JSON.stringify(approvedAudit).includes(alias), "approval audit identifies the real server actor without logging the Auth-only address");

  // 주소의 존재만으로 수동 정책을 위조할 수 없습니다. 변경 가능한 user_metadata도 신뢰하지 않습니다.
  const forged = await register(12,"forged.twelve",`staff-${user(1012)}@accounts.kansai.invalid`,{},policy);
  await reject("select public.staff_auth_finalize($1,$2)",[forged.reservation,user(12)],/registration_unavailable/);
  await privileged();
  check(await value("select not exists(select 1 from private.staff_accounts where user_id=$1) as value",[user(12)]), "forged metadata creates no mapped staff account");
  await as(12);
  await reject("select public.office_enroll_identity('forged.other','TEST Name','TEST Staff',true)",[],/legacy_staff_enrollment_only/);

  // 예전 조회의 MFA/세션 경계도 새 null 연락처 응답으로 완화되지 않습니다.
  await privileged();
  await db.query("insert into auth.mfa_factors(user_id,status) values($1,'verified')",[user(1)]);
  await as(1);
  await reject(contactSql,[user(11)],/owner_mfa_required/);
  await privileged();
  await db.query("update auth.sessions set aal='aal2' where id=$1",[user(10001)]);
  await as(1);
  await db.query("select set_config('request.jwt.claim.aal','aal2',false)");
  check((await contact(11)).email===realContact, "signed/native AAL2 retains legacy contact access");
  await privileged();
  await db.query("delete from auth.sessions where id=$1",[user(10001)]);
  await as(1);
  await reject(contactSql,[user(11)],/live_owner_required/);
  await privileged();
  check(await value("select has_function_privilege('authenticated','public.office_staff_application_contact(uuid)','execute') and not has_function_privilege('anon','public.office_staff_application_contact(uuid)','execute') and not has_function_privilege('service_role','public.office_staff_application_contact(uuid)','execute') as value"),
    "contact RPC privileges stay authenticated-only with server-side Owner checks");

  const before = await value("select jsonb_build_object('users',(select jsonb_agg(to_jsonb(u) order by u.id) from auth.users u),'accounts',(select jsonb_agg(to_jsonb(a) order by a.user_id) from private.staff_accounts a),'roles',(select jsonb_agg(to_jsonb(r) order by r.user_id) from public.admin_roles r),'audit',(select jsonb_agg(to_jsonb(l) order by l.id) from public.audit_logs l)) as value");
  await db.exec(await readFile("supabase/migrations/20261016073919_staff_opaque_auth_address_contact.sql","utf8"));
  const after = await value("select jsonb_build_object('users',(select jsonb_agg(to_jsonb(u) order by u.id) from auth.users u),'accounts',(select jsonb_agg(to_jsonb(a) order by a.user_id) from private.staff_accounts a),'roles',(select jsonb_agg(to_jsonb(r) order by r.user_id) from public.admin_roles r),'audit',(select jsonb_agg(to_jsonb(l) order by l.id) from public.audit_logs l)) as value");
  check(JSON.stringify(before)===JSON.stringify(after), "contact-only migration preserves every existing Auth/account/role/audit value");
  console.log(`No-email signup SQL checks: ${checks} passed.`);
} finally { await db.close(); }
