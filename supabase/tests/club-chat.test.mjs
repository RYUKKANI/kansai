import assert from "node:assert/strict";
import { officeDatabase } from "./office-database.mjs";

// [편집 안내] 가상 관계자와 메모리 DB만 사용합니다. Realtime 전송 자체가 아니라
// 발행 대상 표의 최소 정보·RLS와 실제 원문 RPC의 현재 세션 경계를 검증합니다.
const { db, as, user } = await officeDatabase();
let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks++; };
const value = async (sql, params = []) => (await db.query(sql, params)).rows[0]?.value;
const reject = async (sql, params = [], pattern) => { await assert.rejects(db.query(sql, params), pattern); checks++; };
const rooms = () => value("select public.office_chat_rooms() as value");
const messages = (room, before = null) => value("select public.office_chat_messages($1,$2) as value", [room,before]);
const send = (room, body, nonce) => value("select public.office_chat_send($1,$2,$3) as value", [room,body,user(nonce)]);
async function server(role = null) {
  await db.exec(role ? `set role ${role}` : "reset role");
  await db.query("select set_config('request.jwt.claim.sub','',false)");
}
async function snapshot() {
  await server();
  return value("select jsonb_build_object('messages',(select count(*) from private.office_chat_messages),'events',(select count(*) from public.office_chat_events),'audits',(select count(*) from public.audit_logs)) as value");
}
async function denyAll(n) {
  await as(n);
  await reject("select public.office_chat_rooms()", [], /approved_club_member_required|permission denied/);
  await reject("select public.office_chat_messages('players')", [], /approved_club_member_required|permission denied/);
  await reject("select public.office_chat_send('players','TEST denied',$1)", [user(9000)], /approved_club_member_required|permission denied/);
  if (n !== null) check((await db.query("select * from public.office_chat_events")).rows.length === 0, "unauthorized existing session receives no invalidation events");
}

try {
  await db.exec("update auth.users set email='chat-fixture-'||id::text||'@example.invalid'");
  for (const n of [1,2,3,4]) {
    await as(n);
    await db.query("select public.office_enroll_identity($1,$2,'TEST duty',true)", [`chat.${n}`,n === 4 ? "TEST Verified 名-김" : `TEST Name ${n}`]);
  }
  await as(1);
  await db.query("select public.office_set_staff_access($1,'player',true,'TEST player assignment')", [user(4)]);
  await db.query("select public.office_verify_staff_identity($1,'TEST Verified 名-김','TEST identity confirmation')", [user(4)]);
  await server();
  // 수정 가능한 메타데이터를 작성자·실명·권한의 근거로 삼지 않아야 합니다.
  await db.query("update auth.users set raw_user_meta_data=$1 where id=$2", [{role:"owner",real_name:"FORGED ACTOR",actor_id:user(1)},user(4)]);
  await db.query("insert into auth.users(id,email) values($1,'chat-pending@example.invalid')", [user(6)]);
  await db.query("insert into auth.sessions(id,user_id) values($1,$2)", [user(10006),user(6)]);

  const eventColumns = (await db.query("select column_name from information_schema.columns where table_schema='public' and table_name='office_chat_events' order by ordinal_position")).rows.map((r) => r.column_name);
  assert.deepEqual(eventColumns,["id","room","created_at"]); checks++;
  check(await value("select relrowsecurity as value from pg_class where oid='public.office_chat_events'::regclass"), "invalidation stream uses RLS");
  check(await value("select not has_table_privilege('anon','public.office_chat_events','select') and has_table_privilege('authenticated','public.office_chat_events','select') and not has_table_privilege('authenticated','public.office_chat_events','insert') and not has_table_privilege('authenticated','public.office_chat_events','update') and not has_table_privilege('authenticated','public.office_chat_events','delete') and not has_table_privilege('service_role','public.office_chat_events','insert') as value"), "event writes remain server-only even if the caller bypasses RLS");
  const functions = ["office_chat_rooms()","office_chat_messages(text,bigint)","office_chat_send(text,text,uuid)","office_chat_remove(bigint,text)"];
  for (const signature of functions) {
    for (const schema of ["public","private"]) {
      check(await value("select has_function_privilege('authenticated',$1,'execute') and not has_function_privilege('anon',$1,'execute') and not has_function_privilege('service_role',$1,'execute') as value", [`${schema}.${signature}`]), `${schema}.${signature} explicitly grants only authenticated clients`);
    }
    check(await value("select not prosecdef as value from pg_proc where oid=$1::regprocedure", [`public.${signature}`]), `public.${signature} stays invoker`);
  }
  check(await value("select not has_table_privilege('authenticated','private.office_chat_messages','select') and not has_table_privilege('authenticated','private.office_chat_messages','insert') and not has_table_privilege('service_role','private.office_chat_messages','select') and not has_sequence_privilege('authenticated','private.office_chat_messages_id_seq','usage') as value"), "raw message storage and its sequence are not available to clients");

  await as(1);
  const ownerRooms = await rooms();
  check(ownerRooms.user_id === user(1) && ownerRooms.role === "owner" && ownerRooms.server_time, "room response identifies current server actor");
  assert.deepEqual(ownerRooms.rooms,[{id:"players"},{id:"office"}]); checks++;
  const officeMessage = (await send("office","TEST office-only private message",4000)).message;
  check(officeMessage.sender_id === user(1) && officeMessage.sender_role === "owner" && officeMessage.sender_name === null, "unverified identity is never asserted as an approved real name");
  await as(2);
  assert.deepEqual((await rooms()).rooms,[{id:"office"}]); checks++;
  check((await messages("office")).messages[0].id === officeMessage.id, "staff can read operational room");
  await reject("select public.office_chat_messages('players')", [], /chat_room_forbidden/);
  await reject("select public.office_chat_send('players','TEST bypass',$1)", [user(4001)], /chat_room_forbidden/);
  await as(4);
  assert.deepEqual((await rooms()).rooms,[{id:"players"}]); checks++;
  await reject("select public.office_chat_messages('office')", [], /chat_room_forbidden/);
  await reject("select public.office_chat_send('office','TEST bypass',$1)", [user(4002)], /chat_room_forbidden/);
  const first = await send("players","  TEST <script>display as text only</script> 名-김  ",4003);
  check(first.user_id === user(4) && first.room === "players" && first.message.sender_id === user(4) && first.message.sender_role === "player" && first.message.sender_name === "TEST Verified 名-김", "actor ID, effective role and verified name come from current server state");
  check(first.message.body === "TEST <script>display as text only</script> 名-김" && typeof first.message.id === "string" && !first.message.is_removed, "message body is trimmed and bigint ID is safely serialized");
  await reject("select public.office_chat_send('players','TEST forged',$1,$2,'FORGED ACTOR')", [user(4004),user(1)]);
  await reject("insert into private.office_chat_messages(room,sender_id,sender_role,body,nonce) values('players',$1,'owner','TEST forged',$2)", [user(1),user(4004)]);
  await reject("insert into public.office_chat_events(room) values('office')");
  await reject("update public.office_chat_events set room='players'");
  await reject("delete from public.office_chat_events");
  const playerEvents = (await db.query("select * from public.office_chat_events")).rows;
  check(playerEvents.length === 1 && playerEvents.every((e) => e.room === "players" && !JSON.stringify(e).includes("TEST")), "player receives only a content-free own-room invalidation");
  await as(2);
  check((await db.query("select * from public.office_chat_events")).rows.every((e) => e.room === "office"), "staff event reads cannot reveal player room traffic");

  const beforeRetry = await snapshot();
  await as(4);
  assert.deepEqual(await send("players",first.message.body,4003),first); checks++;
  await reject("select public.office_chat_send('players','TEST different body',$1)", [user(4003)], /chat_nonce_conflict/);
  await as(1);
  await send("players","TEST owner nonce",4010);
  await reject("select public.office_chat_send('office','TEST owner nonce',$1)", [user(4010)], /chat_nonce_conflict/);
  const afterRetry = await snapshot();
  check(afterRetry.messages === beforeRetry.messages+1 && afterRetry.events === beforeRetry.events+1, "retry and nonce conflicts produce no duplicate message or notification");

  await as(4);
  for (const body of [null,"","   ","x".repeat(2001),"TEST\u0001control"]) await reject("select public.office_chat_send('players',$1,$2)", [body,user(4020)], /invalid_chat_message/);
  await reject("select public.office_chat_send('players','TEST null nonce',null)", [], /invalid_chat_message/);
  await reject("select public.office_chat_messages('invalid')", [], /chat_room_forbidden/);
  await reject("select public.office_chat_messages('players',0)", [], /invalid_chat_cursor/);
  await reject("select public.office_chat_messages('players',-1)", [], /invalid_chat_cursor/);
  const maxBody = await send("players","x".repeat(2000),4021);
  check(maxBody.message.body.length === 2000, "maximum supported message is accepted");
  const lines = await send("players","TEST line\nsecond\tcolumn",4022);
  check(lines.message.body.includes("\n") && lines.message.body.includes("\t"), "ordinary multiline messages are retained");

  // 새로운 메시지·이벤트의 원자성을 강제로 실패하는 테스트 트리거로 확인합니다.
  const beforeFailedSend = await snapshot();
  await db.exec("create function private.test_fail_chat_event() returns trigger language plpgsql as $$begin raise exception 'TEST event failure'; end$$; create trigger test_fail_chat_event before insert on public.office_chat_events for each row execute function private.test_fail_chat_event()");
  await as(4);
  await reject("select public.office_chat_send('players','TEST transaction rollback',$1)", [user(4030)], /TEST event failure/);
  const afterFailedSend = await snapshot();
  assert.deepEqual(afterFailedSend,beforeFailedSend); checks++;
  await db.exec("drop trigger test_fail_chat_event on public.office_chat_events; drop function private.test_fail_chat_event()");

  await as(2);
  await reject("select public.office_chat_remove($1,'TEST unauthorized moderation')", [first.message.id], /live_owner_required/);
  await as(4);
  await reject("select public.office_chat_remove($1,'TEST self removal')", [first.message.id], /live_owner_required/);
  await as(1);
  for (const reason of [null,""," ","x".repeat(501),"TEST\ncontrol"]) await reject("select public.office_chat_remove($1,$2)", [first.message.id,reason], /chat_removal_reason_required/);
  await reject("select public.office_chat_remove(999999,'TEST missing message')", [], /chat_message_unavailable/);
  const beforeFailedRemoval = await snapshot();
  await db.exec("create function private.test_fail_chat_audit() returns trigger language plpgsql as $$begin if new.action='chat_message_removed' then raise exception 'TEST audit failure'; end if; return new; end$$; create trigger test_fail_chat_audit before insert on public.audit_logs for each row execute function private.test_fail_chat_audit()");
  await as(1);
  await reject("select public.office_chat_remove($1,'TEST rollback removal')", [first.message.id], /TEST audit failure/);
  const afterFailedRemoval = await snapshot();
  assert.deepEqual(afterFailedRemoval,beforeFailedRemoval); checks++;
  check(await value("select body=$2 and removed_at is null as value from private.office_chat_messages where id=$1", [first.message.id,first.message.body]), "failed audit leaves the original message intact");
  await db.exec("drop trigger test_fail_chat_audit on public.audit_logs; drop function private.test_fail_chat_audit()");
  await as(1);
  const removed = await value("select public.office_chat_remove($1,'TEST confirmed moderation') as value", [first.message.id]);
  check(removed.message.is_removed && removed.message.body === "" && removed.message.id === first.message.id, "Owner moderation returns a tombstone instead of the previous body");
  const beforeRemovedRetry = await snapshot();
  await as(1);
  await db.query("select public.office_chat_remove($1,'TEST duplicate moderation')", [first.message.id]);
  assert.deepEqual(await snapshot(),beforeRemovedRetry); checks++;
  const removalAudit = await value("select to_jsonb(a) as value from public.audit_logs a where action='chat_message_removed' order by id desc limit 1");
  check(removalAudit.actor_id === user(1) && removalAudit.actor_role === "owner" && removalAudit.entity === "office_chat_messages" && removalAudit.record_id === first.message.id && removalAudit.reason === "TEST confirmed moderation", "moderation audit records server actor and affected message");
  check(!JSON.stringify(removalAudit).includes("display as text") && !JSON.stringify(removalAudit).includes("TEST Verified"), "moderation audit never duplicates chat content or sender name");
  await as(4);
  check((await messages("players")).messages.find((m) => m.id === first.message.id).body === "", "players cannot recover deleted body through the normal history endpoint");
  check((await send("players",first.message.body,4003)).message.is_removed, "replayed send nonce cannot restore a removed message");
  check(!(await value("select public.office_staff_audit(100,null) as value")).some((a) => a.entity === "office_chat_messages"), "player sees no moderation audit data");
  await as(2);
  check(!(await value("select public.office_staff_audit(100,null) as value")).some((a) => a.entity === "office_chat_messages"), "staff cannot inspect player-room moderation history");
  await as(1);
  check((await value("select public.office_staff_audit(100,null) as value")).some((a) => a.entity === "office_chat_messages" && a.record_id === first.message.id), "Owner can review confirmed moderation through the authorized audit endpoint");

  // 시간 제한은 전체 작성자 기준이며 방을 바꿔도 우회할 수 없어야 합니다.
  await server();
  await db.exec("update private.office_chat_messages set created_at=clock_timestamp()-interval '2 minutes'");
  await as(1);
  for (let i=0;i<20;i++) await send(i%2 ? "office":"players",`TEST rate ${i}`,4100+i);
  await reject("select public.office_chat_send('office','TEST limit',$1)", [user(4199)], /chat_rate_limited/);
  check((await send("players","TEST rate 0",4100)).message.body === "TEST rate 0", "idempotent retry remains usable at the send limit");
  await server();
  await db.exec("update private.office_chat_messages set created_at=clock_timestamp()-interval '2 minutes'");
  // 정렬/페이지 경계는 전송 제한을 우회하는 테스트 fixture만으로 충분히 큰 표본을 만듭니다.
  await db.query("insert into private.office_chat_messages(room,sender_id,sender_name,sender_role,body,nonce) select 'players',$1,'TEST page name','player','TEST page '||n,gen_random_uuid() from generate_series(1,55) n", [user(4)]);
  await as(4);
  const newest = await messages("players");
  check(newest.messages.length === 50 && newest.has_more, "history is limited to fifty newest messages");
  check(newest.messages.every((m,i,all) => i === 0 || BigInt(m.id)>BigInt(all[i-1].id)), "each page is ordered chronologically by immutable message ID");
  const older = await messages("players",newest.messages[0].id);
  check(older.messages.length > 0 && !older.has_more && older.messages.every((m) => BigInt(m.id)<BigInt(newest.messages[0].id)), "cursor returns strictly older messages without overlap");

  // 단순 sub 값과 다른 계정의 세션 UUID 조합은 정상 서명된 세션의 대체물이 아닙니다.
  await as(4);
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [user(1)]);
  await reject("select public.office_chat_rooms()", [], /approved_club_member_required/);
  await reject("select public.office_chat_remove($1,'TEST mixed identity')", [first.message.id], /live_owner_required/);
  check((await db.query("select * from public.office_chat_events")).rows.length === 0, "mismatched account and native-session UUID yields no event stream");

  await denyAll(5);
  await denyAll(6);
  await server();
  await db.query("update private.staff_accounts set approval_status='suspended' where user_id=$1", [user(4)]);
  await denyAll(4);
  await server();
  await db.query("update private.staff_accounts set approval_status='approved' where user_id=$1", [user(4)]);
  await db.query("update public.admin_roles set active=false where user_id=$1", [user(4)]);
  await denyAll(4);
  await server();
  await db.query("update public.admin_roles set active=true where user_id=$1", [user(4)]);
  await db.query("update auth.users set banned_until=clock_timestamp()+interval '1 hour' where id=$1", [user(4)]);
  await denyAll(4);
  await server();
  await db.query("update auth.users set banned_until=null where id=$1", [user(4)]);
  await db.query("delete from auth.sessions where user_id=$1", [user(4)]);
  await denyAll(4);
  await denyAll(null);
  await server("service_role");
  for (const sql of ["select public.office_chat_rooms()","select public.office_chat_messages('players')","select public.office_chat_remove(1,'TEST bypass')","select * from private.office_chat_messages","select * from public.office_chat_events"]) await reject(sql);
  console.log(`club-chat: ${checks} server permission, safe event, idempotence and atomic moderation checks passed`);
} finally { await db.close(); }
