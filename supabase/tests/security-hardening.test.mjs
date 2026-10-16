import assert from "node:assert/strict";
import test from "node:test";
import { officeDatabase } from "./office-database.mjs";

// 승인 전 계정과 회수된 기존 세션을 실제 PostgreSQL RLS로 검사합니다.
// Auth/회원/선수 fixture는 이 메모리 DB에만 만들며 운영 프로젝트를 호출하지 않습니다.
const { db, as, user } = await officeDatabase();
const verifiedName = "TEST Coach 名-김";
async function privileged() {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub','',false),set_config('request.jwt.claim.session_id','',false)");
}
async function rows(sql, values = []) {
  return (await db.query(sql, values)).rows;
}
async function auditFor(id) {
  return rows("select * from public.audit_logs where entity='training_series' and record_id=$1 order by id", [id]);
}

try {
  await as(4);
  await db.query("select public.office_enroll_identity('test.coach',$1,'TEST Football',true)", [verifiedName]);
  await as(1);
  await db.query("select public.office_verify_staff_identity($1,$2,'TEST verified by an independent Owner')", [user(4), verifiedName]);
  await privileged();
  for (const [n, status] of [[6, "pending"], [7, "suspended"]]) {
    await db.query("insert into auth.users(id,email) values($1,$2)", [user(n), `fixture-${n}@example.invalid`]);
    await db.query("insert into auth.sessions(id,user_id) values($1,$2)", [user(n + 10000), user(n)]);
    await db.query("insert into private.staff_accounts(user_id,username,real_name,department,approval_status,email_confirmation_required,notice_accepted_at) values($1,$2,'TEST Applicant','TEST Department',$3,false,now())", [user(n), `fixture.${n}`, status]);
    // 정지 계정은 활성 역할 행을 남겨도 승인 상태가 접근을 막아야 합니다.
    if (n === 7) await db.query("insert into public.admin_roles(user_id,email,role,active) values($1,'fixture-7@example.invalid','coach',true)", [user(n)]);
  }

  await test("published profiles keep approval metadata inside the football staff boundary", async () => {
    await as(2);
    const player = (await rows("insert into public.players(internal_name,profile_consent) values('TEST Public Player',true) returning id"))[0].id;
    const draft = (await rows("insert into public.players(internal_name) values('TEST Private Player') returning id"))[0].id;
    await db.query("insert into public.public_player_profiles(player_id,slug,display_name,position,status) values($1,'test-public-player','TEST Public Player','GK','published'),($2,'test-private-player','TEST Private Player','DF','draft')", [player, draft]);

    await as(null);
    const publicRows = await rows("select player_id,slug,display_name,position,status from public.public_player_profiles");
    assert.deepEqual(publicRows.map((row) => row.player_id), [player], "anonymous public projection still shows only approved published content");
    await assert.rejects(db.query("select approved_by from public.public_player_profiles"), /permission denied/);
    await assert.rejects(db.query("select * from public.public_player_profiles"), /permission denied/);

    for (const [n, label] of [[6, "pending"], [7, "suspended"], [5, "inactive"], [3, "editor"]]) {
      await as(n);
      assert.deepEqual(await rows("select approved_by from public.public_player_profiles"), [], `${label} account cannot obtain internal approval UUIDs even from a published row`);
      assert.deepEqual(await rows("select * from public.public_player_profiles"), [], `${label} account cannot bypass the safe anonymous projection with a table-wide select`);
    }
    for (const n of [1, 2, 4]) {
      await as(n);
      const internal = await rows("select player_id,approved_by from public.public_player_profiles order by player_id");
      assert.equal(internal.length, 2, "permitted football staff retain published and draft access");
      assert.equal(internal.find((row) => row.player_id === player).approved_by, user(2), "the real server-selected approver remains available to permitted staff");
    }

    // 같은 access JWT를 계속 사용해도 현재 DB의 회수/정지 상태를 검사해야 합니다.
    for (const [setup, restore, label] of [
      ["update auth.users set banned_until=now()+interval '1 hour' where id=$1", "update auth.users set banned_until=null where id=$1", "platform-banned"],
      ["update public.admin_roles set active=false where user_id=$1", "update public.admin_roles set active=true where user_id=$1", "role-revoked"],
      ["update auth.sessions set not_after=now()-interval '1 minute' where user_id=$1", "update auth.sessions set not_after=null where user_id=$1", "expired-session"],
    ]) {
      await privileged();
      await db.query(setup, [user(4)]);
      await as(4);
      assert.deepEqual(await rows("select approved_by from public.public_player_profiles"), [], `${label} existing session loses published approval metadata`);
      await privileged();
      await db.query(restore, [user(4)]);
    }
    await privileged();
    await db.query("delete from auth.sessions where user_id=$1", [user(4)]);
    await as(4);
    assert.deepEqual(await rows("select * from public.public_player_profiles"), [], "revoked native session cannot read internal profiles with its old JWT");
    await privileged();
    await db.query("insert into auth.sessions(id,user_id) values($1,$2)", [user(10004), user(4)]);
  });

  await test("training series commits and rolls back together with its server-authored audit", async () => {
    await as(4);
    // 브라우저가 보낼 수 있는 임의의 이름/작업자 설정은 감사 작성자의 근거가 아닙니다.
    await db.query("select set_config('kansai.audit_actor_id',$1,false),set_config('kansai.audit_actor_name','TEST Forged Name',false),set_config('kansai.audit_source','scheduled',false),set_config('kansai.audit_requestor',$1,false)", [user(1)]);
    const id = (await rows("insert into public.training_series(interval_weeks,occurrences) values(1,3) returning id"))[0].id;
    await db.query("update public.training_series set interval_weeks=2 where id=$1", [id]);
    await db.query("delete from public.training_series where id=$1", [id]);
    const logs = await auditFor(id);
    assert.equal(logs.length, 3, "each committed insert, update and delete receives one audit row");
    assert.deepEqual(logs.map((row) => row.operation), ["INSERT", "UPDATE", "DELETE"]);
    assert.deepEqual(logs.map((row) => row.action), ["insert", "update", "delete"]);
    for (const log of logs) {
      assert.equal(log.actor_id, user(4));
      assert.equal(log.actor_role, "coach");
      assert.equal(log.actor_name, verifiedName);
      assert.equal(log.actor_name_status, "verified");
      assert.equal(log.source, "human");
      assert.equal(log.executor, "authenticated_user");
      assert.equal(log.requested_by, user(4));
      assert.ok(Number.isFinite(new Date(log.occurred_at).getTime()), "server assigns the audit time");
      assert.ok(!JSON.stringify(log).includes("TEST Forged Name"));
    }
    assert.deepEqual(logs[0].before_values, {});
    assert.deepEqual(logs[0].after_values, { interval_weeks: 1, occurrences: 3 });
    assert.deepEqual(logs[1].changed_fields, ["interval_weeks"]);
    assert.deepEqual(logs[1].before_values, { interval_weeks: 1 });
    assert.deepEqual(logs[1].after_values, { interval_weeks: 2 });
    assert.deepEqual(logs[2].before_values, { interval_weeks: 2, occurrences: 3 });
    assert.deepEqual(logs[2].after_values, {});

    // 이후의 정정으로 과거 로그의 당시 이름/UUID가 바뀌어서는 안 됩니다.
    await privileged();
    await db.query("update private.staff_accounts set real_name='TEST Corrected Coach' where user_id=$1", [user(4)]);
    await as(4);
    assert.ok((await auditFor(id)).every((log) => log.actor_name === verifiedName && log.actor_id === user(4)));
    await assert.rejects(db.query("insert into public.audit_logs(entity,operation) values('training_series','FORGED')"), /permission denied/);
    await assert.rejects(db.query("update public.audit_logs set actor_id=$1 where record_id=$2", [user(1), id]), /permission denied/);
    await assert.rejects(db.query("delete from public.audit_logs where record_id=$1", [id]), /permission denied/);

    await db.exec("begin");
    const rolledBackId = (await rows("insert into public.training_series(interval_weeks,occurrences) values(1,2) returning id"))[0].id;
    assert.equal((await auditFor(rolledBackId)).length, 1, "audit exists inside the same pending transaction");
    await db.exec("rollback");
    assert.deepEqual(await rows("select id from public.training_series where id=$1", [rolledBackId]), []);
    assert.deepEqual(await auditFor(rolledBackId), [], "rolled back work leaves no committed success audit");

    const beforeFailure = (await rows("select count(*)::int as n from public.audit_logs where entity='training_series'"))[0].n;
    await assert.rejects(db.query("insert into public.training_series(interval_weeks,occurrences) values(12,52)"), /check constraint/);
    const invalidTemplate = { title: "TEST Invalid Series", starts_at: "2030-01-02T00:00:00Z", ends_at: "2030-01-01T00:00:00Z" };
    await assert.rejects(db.query("select * from public.create_training_series($1,1,2)", [invalidTemplate]), /check constraint/);
    assert.equal((await rows("select count(*)::int as n from public.audit_logs where entity='training_series'"))[0].n, beforeFailure, "a failed recurrence RPC rolls back both its series insert and audit trigger");

    for (const n of [3, 5, 6, 7]) {
      await as(n);
      assert.deepEqual(await auditFor(id), [], "unapproved, inactive and unrelated staff cannot read football audit details");
      await assert.rejects(db.query("insert into public.training_series(interval_weeks,occurrences) values(1,2)"), /row-level security/);
    }
    await as(null);
    await assert.rejects(db.query("select * from public.audit_logs where entity='training_series'"), /permission denied/);
    for (const n of [1, 2, 4]) {
      await as(n);
      assert.equal((await auditFor(id)).length, 3, "permitted football staff retain committed series history");
    }
  });
} finally {
  await db.close();
}
