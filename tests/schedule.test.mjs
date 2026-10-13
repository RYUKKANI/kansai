import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { app, login, eventually } from "./helpers/admin-app.mjs";
const compiled = await build({
  entryPoints: ["src/lib/schedule.ts"],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
});
const { jstDay, calendarRange, shiftPeriod } = await import(
  "data:text/javascript;base64," +
    Buffer.from(compiled.outputFiles[0].text).toString("base64")
);
test("JST boundaries, leap month and Monday week are independent of host timezone", () => {
  assert.equal(jstDay("2026-10-31T15:00:00Z"), "2026-11-01");
  assert.deepEqual(calendarRange("2024-02-29", "month"), {
    start: "2024-02-01",
    end: "2024-03-01",
    from: "2024-01-31T15:00:00.000Z",
    until: "2024-02-29T15:00:00.000Z",
  });
  assert.equal(calendarRange("2026-11-01", "week").start, "2026-10-26");
  assert.equal(shiftPeriod("2026-12-31", "month", 1), "2027-01-01");
});
test("integrated calendar provides three views and recurrence form without exposing a false capability", async () => {
  const context = await app(
    "owner",
    undefined,
    { schedule: true },
    { club_events: [] },
  );
  try {
    await login(context.window);
    const document = context.window.document;
    document.querySelector('[data-resource="schedule"]').click();
    await eventually(() =>
      document.querySelector('[data-schedule-view="week"]'),
    );
    document.querySelector('[data-schedule-view="week"]').click();
    await eventually(() =>
      document.querySelector('.office-integrated-calendar[data-view="week"]'),
    );
    assert.equal(document.querySelectorAll(".office-schedule-day").length, 7);
    document.querySelector('[data-schedule-view="list"]').click();
    await eventually(
      () => !document.querySelector(".office-integrated-calendar"),
    );
    document.querySelector('[data-resource="training_sessions"]').click();
    await eventually(
      () =>
        document.querySelector("#resource-title").textContent === "練習予定",
    );
    document.querySelector("#new-button").click();
    await eventually(() => document.querySelector('[name="_repeat_count"]'));
    assert.equal(document.querySelector('[name="_repeat_count"]').value, "1");
    assert.ok(document.querySelector('[name="public_description"]'));
  } finally {
    context.dom.window.close();
  }
});
