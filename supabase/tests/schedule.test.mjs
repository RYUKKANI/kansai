import assert from "node:assert/strict";
import { officeDatabase } from "./office-database.mjs";
const { db, as } = await officeDatabase();
let checks = 0;
const check = (condition, message) => {
  assert.ok(condition, message);
  checks++;
};
const reject = async (sql, values = []) => {
  await assert.rejects(db.query(sql, values));
  checks++;
};
try {
  const template = {
    title: "TEST ONLY training",
    starts_at: "2030-01-01T15:30:00Z",
    ends_at: "2030-01-01T17:00:00Z",
    venue: "TEST",
    notes: "SECRET OPERATIONS",
    is_public: false,
    public_description: "Public invitation",
  };
  await as(3);
  await reject("select public.create_training_series($1,1,3)", [{ ...template, is_public: true }]);
  await as(5);
  await reject("select public.create_training_series($1,1,3)", [template]);
  await as(4);
  const result = await db.query(
    "select * from public.create_training_series($1,2,3)",
    [template],
  );
  check(result.rows.length === 3, "all occurrences created");
  check(
    new Set(result.rows.map((row) => row.id)).size === 3,
    "immutable individual UUIDs",
  );
  check(
    new Set(result.rows.map((row) => row.series_id)).size === 1,
    "shared series",
  );
  check(
    new Date(result.rows[1].starts_at) - new Date(result.rows[0].starts_at) ===
      14 * 86400000,
    "JST recurrence interval",
  );
  await reject("select public.create_training_series($1,12,52)", [template]);
  await reject("select public.create_training_series($1,1,3)", [
    { ...template, ends_at: "2020-01-01T00:00:00Z" },
  ]);
  const count = await db.query(
    "select count(*)::int as n from public.training_sessions",
  );
  check(count.rows[0].n === 3, "failed series is rolled back");
  let first = result.rows[0];
  const single = { ...template, title: "One occurrence", is_public: true };
  await reject("select public.update_training_occurrences($1,$2,$3,$4)", [first.id, first.updated_at, single, "single"]);
  await as(1);
  await db.query("select public.update_training_occurrences($1,$2,$3,$4)", [
    first.id,
    first.updated_at,
    single,
    "single",
  ]);
  check(
    (
      await db.query(
        "select count(*)::int as n from public.training_sessions where title='One occurrence'",
      )
    ).rows[0].n === 1,
    "single edit leaves other occurrences",
  );
  await reject("select public.update_training_occurrences($1,$2,$3,$4)", [
    first.id,
    first.updated_at,
    single,
    "single",
  ]);
  first = (
    await db.query("select * from public.training_sessions where id=$1", [
      first.id,
    ])
  ).rows[0];
  const all = {
    ...template,
    title: "Whole series",
    starts_at: "2030-01-01T16:30:00Z",
    ends_at: "2030-01-01T18:00:00Z",
    is_public: true,
  };
  const updated = await db.query(
    "select public.update_training_occurrences($1,$2,$3,$4) as n",
    [first.id, first.updated_at, all, "series"],
  );
  check(updated.rows[0].n === 3, "whole future series edited");
  const moved = (
    await db.query("select * from public.training_sessions order by starts_at")
  ).rows;
  check(
    moved.every((row, i) => row.id === result.rows[i].id),
    "edits keep occurrence UUIDs",
  );
  check(
    new Date(moved[1].starts_at).toISOString() === "2030-01-15T16:30:00.000Z",
    "whole shift preserves occurrence spacing",
  );
  await as(null);
  const publicly = (await db.query("select * from public.published_schedule"))
    .rows;
  check(publicly.length === 3, "explicit public schedules readable");
  check(
    !JSON.stringify(publicly).includes("SECRET") &&
      !("notes" in publicly[0]) &&
      !("series_id" in publicly[0]),
    "internal data not in public projection",
  );
  await reject("select * from public.training_sessions");
  await reject("update public.published_schedule set title='tampered'");
  await reject("select public.update_training_occurrences($1,$2,$3,$4)", [
    first.id,
    first.updated_at,
    all,
    "series",
  ]);
  await as(3);
  check(
    (await db.query("select * from public.training_sessions")).rows.length ===
      3,
    "legacy editor uses the shared staff schedule permission",
  );
  await as(4);
  await reject("update public.training_sessions set is_public=false where id=$1", [first.id]);
  await as(1);
  await db.query(
    "update public.training_sessions set is_public=false where id=$1",
    [first.id],
  );
  check(
    (await db.query("select count(*)::int as n from public.published_schedule"))
      .rows[0].n === 2,
    "withdrawal removes public row",
  );
  const event = (
    await db.query(
      "insert into public.club_events(title,starts_at,is_public,notes) values('TEST event','2030-02-01T00:00:00Z',true,'SECRET') returning id",
    )
  ).rows[0];
  await db.query(
    "update public.club_events set session_status='cancelled' where id=$1",
    [event.id],
  );
  check(
    (
      await db.query(
        "select schedule_status from public.published_schedule where id=$1",
        [event.id],
      )
    ).rows[0].schedule_status === "cancelled",
    "cancellation remains visible",
  );
  await db.query("delete from public.club_events where id=$1", [event.id]);
  check(
    (
      await db.query("select * from public.published_schedule where id=$1", [
        event.id,
      ])
    ).rows.length === 0,
    "deletion clears projection",
  );
  console.log("Schedule PostgreSQL checks passed:", checks);
} finally {
  await db.close();
}
