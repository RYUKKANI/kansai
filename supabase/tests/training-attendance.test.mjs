import assert from "node:assert/strict";
import { officeDatabase } from "./office-database.mjs";

// [편집 안내] 실제 선수·운영 계정과 분리된 메모리 DB입니다. JST 날짜의 양 끝,
// 본인 연결, 정정 권한과 감사 기록 실패 시 전체 저장 취소를 검증합니다.
const { db, as, user } = await officeDatabase();
let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks++; };
const value = async (sql, params = []) => (await db.query(sql, params)).rows[0]?.value;
const reject = async (sql, params = [], pattern) => { await assert.rejects(db.query(sql, params), pattern); checks++; };
const today = () => value("select public.office_training_attendance_today() as value");
const selfCheck = (id) => value("select public.office_training_check_in($1) as value", [id]);
const mark = (training, player, status, reason = "TEST office attendance correction") => value("select public.office_training_set_attendance($1,$2,$3,$4) as value", [training,player,status,reason]);
async function server(role = null) {
  await db.exec(role ? `set role ${role}` : "reset role");
  await db.query("select set_config('request.jwt.claim.sub','',false)");
}
async function snapshot() {
  await server();
  return value("select jsonb_build_object('attendance',coalesce((select jsonb_agg(to_jsonb(a) order by training_id,player_id) from private.attendance a),'[]'::jsonb),'audits',(select count(*) from public.audit_logs)) as value");
}
async function denied(n, training, player) {
  await as(n);
  await reject("select public.office_training_attendance_today()", [], /approved_club_member_required|permission denied/);
  await reject("select public.office_training_check_in($1)", [training], /approved_club_member_required|permission denied/);
  await reject("select public.office_training_set_attendance($1,$2,'present','TEST bypass')", [training,player], /approved_club_member_required|permission denied/);
}

try {
  await db.exec("update auth.users set email='attendance-fixture-'||id::text||'@example.invalid'");
  for (const n of [1,2,3,4]) {
    await as(n);
    await db.query("select public.office_enroll_identity($1,$2,'TEST duty',true)", [`attendance.${n}`,n === 4 ? "TEST Verified Player 名-김" : n === 2 ? "TEST Verified Staff" : `TEST Relation ${n}`]);
  }
  await as(1);
  for (const n of [3,4]) await db.query("select public.office_set_staff_access($1,'player',true,'TEST player assignment')", [user(n)]);
  await db.query("select public.office_verify_staff_identity($1,'TEST Verified Player 名-김','TEST identity confirmation')", [user(4)]);
  await db.query("select public.office_verify_staff_identity($1,'TEST Verified Staff','TEST identity confirmation')", [user(2)]);
  await server();
  await db.query("insert into auth.users(id,email) values($1,'attendance-pending@example.invalid')", [user(6)]);
  await db.query("insert into auth.sessions(id,user_id) values($1,$2)", [user(10006),user(6)]);
  const player1 = await value("insert into public.players(internal_name,consent_note) values('TEST linked player','PRIVATE MEDICAL AND CONTACT NOTE') returning id as value");
  const player2 = await value("insert into public.players(internal_name,consent_note) values('TEST another active player','PRIVATE OTHER NOTE') returning id as value");
  const inactive = await value("insert into public.players(internal_name,activity_status,consent_note) values('TEST inactive player','inactive','PRIVATE INACTIVE NOTE') returning id as value");
  const playerCount = await value("select count(*)::int as value from public.players");
  const jstDay = await value("select (statement_timestamp() at time zone 'Asia/Tokyo')::date::text as value");
  // DB 서버의 기본 TimeZone을 바꿔도 업무상 날짜와 경계는 일본 시간을 따라야 합니다.
  await db.exec("set time zone 'Pacific/Honolulu'");
  const sessions = {};
  for (const [key,offset,time,status] of [
    ["start",0,"00:00:00","scheduled"],
    ["end",0,"23:59:59","scheduled"],
    ["middle",0,"12:00:00","scheduled"],
    ["past",-1,"23:59:59","scheduled"],
    ["future",1,"00:00:00","scheduled"],
    ["cancelled",0,"13:00:00","cancelled"],
    ["completed",0,"14:00:00","completed"],
  ]) {
    sessions[key] = await value("insert into public.training_sessions(title,starts_at,venue,session_status,notes,is_public) values($1,(($2::date+$3::int)+$4::time) at time zone 'Asia/Tokyo','TEST training ground',$5,'PRIVATE TRAINING NOTES',false) returning id as value", [`TEST ${key}`,jstDay,offset,time,status]);
  }
  // 기존 행은 작성자를 추측하거나 새 시각으로 소급해서 채우지 않습니다.
  await db.query("insert into private.attendance(training_id,player_id,attendance_status) values($1,$2,'late')", [sessions.end,player2]);
  const legacy = await value("select to_jsonb(a) as value from private.attendance a where training_id=$1 and player_id=$2", [sessions.end,player2]);
  check(legacy.recorded_by === null && legacy.recorded_at === null && legacy.self_checked_at === null, "legacy attendance is preserved without invented attribution");
  await as(1);
  await db.query("select public.office_owner_set_player_link($1,$2,'TEST explicit existing player link')", [user(4),player1]);

  await server();
  const signatures = ["office_training_attendance_today()","office_training_check_in(uuid)","office_training_set_attendance(uuid,uuid,text,text)"];
  for (const signature of signatures) {
    for (const schema of ["public","private"]) check(await value("select has_function_privilege('authenticated',$1,'execute') and not has_function_privilege('anon',$1,'execute') and not has_function_privilege('service_role',$1,'execute') as value", [`${schema}.${signature}`]), `${schema}.${signature} requires authenticated callers`);
    check(await value("select not prosecdef as value from pg_proc where oid=$1::regprocedure", [`public.${signature}`]), `public.${signature} is an invoker wrapper`);
  }
  check(await value("select not has_table_privilege('anon','private.attendance','select') and not has_table_privilege('authenticated','private.attendance','select') and not has_table_privilege('authenticated','private.attendance','insert') and not has_table_privilege('authenticated','private.attendance','update') and not has_table_privilege('authenticated','private.attendance','delete') and not has_table_privilege('service_role','private.attendance','select') as value"), "attendance remains private and raw DML is unavailable to clients");

  await as(4);
  const own = await today();
  check(own.user_id === user(4) && own.role === "player" && own.today === jstDay && own.linked && own.player_id === player1, "player envelope uses current actor, server JST day and explicit player mapping");
  assert.deepEqual(own.trainings.map((t) => t.id),[sessions.start,sessions.middle,sessions.cancelled,sessions.completed,sessions.end]); checks++;
  check(own.trainings.every((t) => t.attendance.length === 1 && t.attendance[0].player_id === player1), "player projection cannot expose another player roster or attendance");
  check(own.trainings.filter((t) => t.can_check_in).length === 3 && !own.trainings.find((t) => t.id === sessions.cancelled).can_check_in && !own.trainings.find((t) => t.id === sessions.completed).can_check_in, "only scheduled sessions today offer player check-in");
  check(!JSON.stringify(own).includes("PRIVATE") && !JSON.stringify(own).includes("another active"), "player attendance contains no training notes, consent notes or other player names");
  await reject("select public.office_training_attendance_today($1)", [user(1)]);
  await reject("select public.office_training_check_in($1,$2)", [sessions.start,player2]);
  await reject("select * from private.attendance");
  await reject("insert into private.attendance(training_id,player_id,attendance_status) values($1,$2,'present')", [sessions.start,player2]);
  await reject("select public.office_training_set_attendance($1,$2,'present','TEST player authority bypass')", [sessions.start,player2], /training_staff_required/);
  for (const key of ["past","future","cancelled","completed"]) await reject("select public.office_training_check_in($1)", [sessions[key]], /today_training_unavailable/);
  await reject("select public.office_training_check_in($1)", [user(999)], /today_training_unavailable/);
  await reject("select public.office_training_check_in(null)", [], /today_training_unavailable/);

  const first = await selfCheck(sessions.start);
  check(first.user_id === user(4) && first.training_id === sessions.start && first.player_id === player1 && first.status === "present" && first.recorded_at && first.self_checked_at, "first check-in confirms a saved own-player present record");
  const afterFirst = await snapshot();
  await as(4);
  assert.deepEqual(await selfCheck(sessions.start),first); checks++;
  assert.deepEqual(await snapshot(),afterFirst); checks++;
  const selfAudit = await value("select to_jsonb(a) as value from public.audit_logs a where action='training_self_checked_in' order by id desc limit 1");
  check(selfAudit.actor_id === user(4) && selfAudit.actor_role === "player" && selfAudit.actor_name === "TEST Verified Player 名-김" && selfAudit.entity === "attendance" && selfAudit.record_id === `${sessions.start}:${player1}` && selfAudit.after_values.status === "present", "atomic self-check audit uses approved server actor and separate training/player UUIDs");
  check(!JSON.stringify(selfAudit).includes("PRIVATE"), "attendance audit cannot duplicate private source notes");

  await as(2);
  const staffView = await today();
  check(staffView.role === "staff" && staffView.trainings.every((t) => !t.can_check_in && t.attendance.length === 2), "staff sees active player roster without an own-player check-in action");
  check(staffView.trainings.every((t) => t.attendance.every((a) => a.player_id !== inactive)) && !JSON.stringify(staffView).includes("PRIVATE"), "staff projection excludes inactive players and unnecessary internal notes");
  check(staffView.trainings.find((t) => t.id === sessions.end).attendance.find((a) => a.player_id === player2).status === "late", "existing attendance remains visible with its original status");
  await reject("select public.office_training_check_in($1)", [sessions.middle], /player_self_check_in_required/);
  for (const status of [null,"","unknown","Present"]) await reject("select public.office_training_set_attendance($1,$2,$3,'TEST invalid status')", [sessions.middle,player1,status], /invalid_attendance_update/);
  for (const reason of [null,""," ","x".repeat(501),"TEST\ncontrol"]) await reject("select public.office_training_set_attendance($1,$2,'present',$3)", [sessions.middle,player1,reason], /invalid_attendance_update/);
  for (const key of ["past","future","cancelled"]) await reject("select public.office_training_set_attendance($1,$2,'present','TEST wrong training')", [sessions[key],player1], /today_training_unavailable/);
  for (const player of [inactive,user(999),null]) await reject("select public.office_training_set_attendance($1,$2,'present','TEST wrong player')", [sessions.middle,player], /active_player_required/);
  await reject("select public.office_training_set_attendance($1,$2,'present','TEST missing training')", [user(999),player1], /today_training_unavailable/);

  const absent = await mark(sessions.middle,player1,"absent");
  check(absent.status === "absent" && absent.user_id === user(2) && absent.player_id === player1 && absent.self_checked_at === null, "staff can confirm absence on an existing player record");
  const afterAbsent = await snapshot();
  await as(2);
  assert.deepEqual(await mark(sessions.middle,player1,"absent"),absent); checks++;
  assert.deepEqual(await snapshot(),afterAbsent); checks++;
  await as(4);
  await reject("select public.office_training_check_in($1)", [sessions.middle], /attendance_managed_by_staff/);
  await as(2);
  await mark(sessions.middle,player1,"excused");
  await as(4);
  await reject("select public.office_training_check_in($1)", [sessions.middle], /attendance_managed_by_staff/);
  await as(2);
  const late = await mark(sessions.middle,player1,"late");
  await as(4);
  const lateSelf = await selfCheck(sessions.middle);
  check(lateSelf.status === "late" && lateSelf.recorded_at === late.recorded_at && lateSelf.self_checked_at !== null, "player arrival preserves a staff late decision and its original recording time");
  const afterLateSelf = await snapshot();
  await as(4);
  assert.deepEqual(await selfCheck(sessions.middle),lateSelf); checks++;
  assert.deepEqual(await snapshot(),afterLateSelf); checks++;
  await as(2);
  const corrected = await mark(sessions.middle,player1,"present","TEST attendance correction confirmed");
  check(corrected.status === "present" && corrected.self_checked_at === lateSelf.self_checked_at, "staff correction preserves the player's actual self-check time");
  const completed = await mark(sessions.completed,player2,"present");
  check(completed.status === "present", "staff may finish attendance for today's completed training");
  await server();
  const correctedRow = await value("select to_jsonb(a) as value from private.attendance a where training_id=$1 and player_id=$2", [sessions.middle,player1]);
  check(correctedRow.recorded_by === user(2), "staff record attribution is taken from auth.uid instead of payload");
  const correctionAudit = await value("select to_jsonb(a) as value from public.audit_logs a where action='training_attendance_changed' and reason='TEST attendance correction confirmed' order by id desc limit 1");
  check(correctionAudit.actor_id === user(2) && correctionAudit.actor_role === "staff" && correctionAudit.actor_name === "TEST Verified Staff" && correctionAudit.before_values.status === "late" && correctionAudit.after_values.status === "present", "staff correction audit records actual actor and allowlisted status transition");
  assert.deepEqual(Object.keys(correctionAudit.before_values),["status"]); checks++;
  assert.deepEqual(Object.keys(correctionAudit.after_values),["status"]); checks++;

  // 감사 저장 실패는 본 업무 저장도 취소해야 하며 브라우저에 성공 값을 줄 수 없습니다.
  const beforeFailure = await snapshot();
  await db.exec("create function private.test_fail_attendance_audit() returns trigger language plpgsql as $$begin if new.entity='attendance' then raise exception 'TEST attendance audit failure'; end if; return new; end$$; create trigger test_fail_attendance_audit before insert on public.audit_logs for each row execute function private.test_fail_attendance_audit()");
  await as(2);
  await reject("select public.office_training_set_attendance($1,$2,'absent','TEST failed correction')", [sessions.middle,player1], /TEST attendance audit failure/);
  await as(4);
  await reject("select public.office_training_check_in($1)", [sessions.end], /TEST attendance audit failure/);
  assert.deepEqual(await snapshot(),beforeFailure); checks++;
  await db.exec("drop trigger test_fail_attendance_audit on public.audit_logs; drop function private.test_fail_attendance_audit()");

  await as(3);
  const unlinked = await today();
  check(!unlinked.linked && unlinked.player_id === null && unlinked.trainings.every((t) => !t.can_check_in && t.attendance.length === 0), "unlinked player sees only today's safe session summary and no roster");
  await reject("select public.office_training_check_in($1)", [sessions.start], /active_player_link_required/);
  await as(1);
  await db.query("select public.office_owner_set_player_link($1,$2,'TEST inactive link preservation')", [user(4),inactive]);
  await as(4);
  check(!(await today()).linked, "inactive linked player receives no self-check capability");
  await reject("select public.office_training_check_in($1)", [sessions.start], /active_player_link_required/);
  await as(1);
  await db.query("select public.office_owner_set_player_link($1,$2,'TEST restore explicit link')", [user(4),player1]);
  await as(4);
  check((await value("select public.office_staff_audit(100,null) as value")).every((a) => a.entity !== "attendance"), "player audit reads cannot reveal any teammate attendance");
  check((await db.query("select * from public.audit_logs where entity='attendance'")).rows.length === 0, "direct audit SELECT applies the same attendance privacy boundary");
  await as(2);
  check((await value("select public.office_staff_audit(100,null) as value")).some((a) => a.entity === "attendance"), "staff can review attendance history within their own business permission");
  await reject("insert into public.audit_logs(entity,operation) values('attendance','FORGED')");
  await reject("update public.audit_logs set actor_id=$1 where entity='attendance'", [user(1)]);

  await as(4);
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [user(1)]);
  await reject("select public.office_training_attendance_today()", [], /approved_club_member_required/);
  await reject("select public.office_training_set_attendance($1,$2,'present','TEST mixed identity')", [sessions.middle,player1], /approved_club_member_required/);

  await denied(5,sessions.start,player1);
  await denied(6,sessions.start,player1);
  await server();
  await db.query("update private.staff_accounts set approval_status='suspended' where user_id=$1", [user(4)]);
  await denied(4,sessions.start,player1);
  await server();
  await db.query("update private.staff_accounts set approval_status='approved' where user_id=$1", [user(4)]);
  await db.query("update public.admin_roles set active=false where user_id=$1", [user(2)]);
  await denied(2,sessions.start,player1);
  await server();
  await db.query("update public.admin_roles set active=true where user_id=$1", [user(2)]);
  await db.query("update auth.users set banned_until=clock_timestamp()+interval '1 hour' where id=$1", [user(2)]);
  await denied(2,sessions.start,player1);
  await server();
  await db.query("update auth.users set banned_until=null where id=$1", [user(2)]);
  await db.query("update auth.sessions set not_after=clock_timestamp()-interval '1 minute' where user_id=$1", [user(2)]);
  await denied(2,sessions.start,player1);
  await server();
  await db.query("delete from auth.sessions where user_id=$1", [user(4)]);
  await denied(4,sessions.start,player1);
  await denied(null,sessions.start,player1);
  await server("service_role");
  for (const sql of ["select public.office_training_attendance_today()","select public.office_training_check_in($1)","select public.office_training_set_attendance($1,$2,'present','TEST bypass')"]) await reject(sql,sql.includes("set_attendance") ? [sessions.start,player1] : sql.includes("check_in") ? [sessions.start] : []);
  await server();
  check(await value("select count(*)::int as value from public.players") === playerCount, "attendance never creates an implicit player account record");
  const preservedLegacy = await value("select to_jsonb(a) as value from private.attendance a where training_id=$1 and player_id=$2", [sessions.end,player2]);
  assert.deepEqual(preservedLegacy,legacy); checks++;
  console.log(`training-attendance: ${checks} JST, self-check, role, audit and atomicity checks passed`);
} finally { await db.close(); }
