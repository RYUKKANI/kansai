import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

// 출석 UI를 직접 실행하고 서버 경계만 대체합니다. 날짜·권한·확정 응답의 해석을 실제 폼 동작으로 검사합니다.
const compiled = (await build({
  entryPoints: ["src/scripts/training-attendance.ts"], bundle: true, write: false,
  format: "iife", globalName: "TrainingAttendance", platform: "browser",
  define: { "import.meta.env.BASE_URL": '"/"' }, loader: { ".css": "empty" },
})).outputFiles[0].text;
const userId = "00000000-0000-4000-8000-000000000001";
const otherId = "00000000-0000-4000-8000-000000000002";
const playerId = "10000000-0000-4000-8000-000000000001";
const peerPlayerId = "10000000-0000-4000-8000-000000000002";
const trainingId = "20000000-0000-4000-8000-000000000001";
const recorded = "2026-10-17T15:35:00Z";
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function until(check) {
  for (let index = 0; index < 120; index++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.ok(check(), "Attendance did not reach the expected state");
}
function fixture(options = {}) {
  const role = options.role ?? "player";
  const result = { user_id: userId, role, today: "2026-10-18", player_id: role === "player" ? playerId : null,
    linked: role === "player", trainings: [{ id: trainingId, title: "Midnight team practice",
      starts_at: "2026-10-17T15:30:00Z", ends_at: "2026-10-17T16:30:00Z", venue: "Club ground",
      session_status: "scheduled", can_check_in: role === "player",
      attendance: [{ player_id: playerId, player_name: "韓 山田 Ana-María", status: null,
        recorded_at: null, self_checked_at: null }],
    }], ...options };
  if (result.role === "player" && result.linked === false && !options.trainings) {
    result.trainings[0].can_check_in = false;
    result.trainings[0].attendance = [];
  }
  return result;
}
function app(options = {}) {
  const dom = new JSDOM("<main></main>", {
    url: "https://kansaiunited.com/admin/", runScripts: "outside-only", pretendToBeVisual: true,
  });
  const { window } = dom;
  // 기기 시계가 다른 날이어도 서버가 반환한 일본 기준일로 오늘의 훈련을 표시해야 합니다.
  const RealDate = window.Date;
  window.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : ["1999-01-01T00:00:00Z"])); } static now() { return RealDate.parse("1999-01-01T00:00:00Z"); } };
  window.eval(compiled + "\nwindow.TrainingAttendance = TrainingAttendance;");
  let active = true, listener, unsubscribed = 0;
  const calls = [];
  const defaults = {
    office_training_attendance_today: () => fixture(options.data),
    office_training_check_in: args => ({ user_id: userId, training_id: args.p_training_id,
      player_id: playerId, status: "present", recorded_at: recorded, self_checked_at: recorded }),
    office_training_set_attendance: args => ({ user_id: userId, training_id: args.p_training_id,
      player_id: args.p_player_id, status: args.p_status, recorded_at: recorded, self_checked_at: null }),
  };
  const client = {
    async rpc(name, args) {
      calls.push({ name, args: args && structuredClone(args) });
      const handler = options.responses?.[name] ?? defaults[name];
      assert.ok(handler !== undefined, `Unexpected RPC ${name}`);
      const value = typeof handler === "function" ? await handler(args) : handler;
      return value && (Object.hasOwn(value, "data") || Object.hasOwn(value, "error"))
        ? value : { data: value, error: null };
    },
    auth: { onAuthStateChange(callback) { listener = callback;
      return { data: { subscription: { unsubscribe() { unsubscribed++; } } } }; } },
  };
  const controller = window.TrainingAttendance.createTrainingAttendance({ client, userId, isCurrent: () => active });
  window.document.querySelector("main").append(controller.element);
  return { dom, window, controller, calls, unsubscribed: () => unsubscribed,
    emit(event, session) { listener?.(event, session); },
    invalidate() { active = false; },
    submit(form) { form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); },
    close() { controller.dispose(); window.close(); },
  };
}

test("the server's Japan date selects today's training even when the device clock disagrees", async () => {
  const ctx = app();
  try {
    await ctx.controller.refresh();
    assert.ok(ctx.controller.element.textContent.includes("Midnight team practice"));
    assert.ok(ctx.controller.element.querySelector('time[datetime="2026-10-18"]'));
    assert.doesNotMatch(ctx.controller.element.textContent, /1999/);
    assert.ok(ctx.controller.element.querySelector('[data-attendance-action="check-in"]'));
  } finally { ctx.close(); }
});

test("an unlinked player sees today's sessions but cannot create or claim a player record", async () => {
  const ctx = app({ data: { linked: false, player_id: null } });
  try {
    await ctx.controller.refresh();
    assert.ok(ctx.controller.element.textContent.includes("Midnight team practice"));
    assert.equal(ctx.controller.element.querySelector('[data-attendance-action="check-in"],form'), null);
    assert.equal(ctx.calls.length, 1);
    assert.match(ctx.controller.element.textContent, /紐付|連携|登録|統括/);
  } finally { ctx.close(); }
});

test("a player cannot render another player's roster entry from an overbroad response", async () => {
  const data = fixture(); data.trainings[0].attendance.push({ player_id: peerPlayerId,
    player_name: "OTHER PLAYER INTERNAL NAME", status: "absent", recorded_at: recorded, self_checked_at: null });
  const ctx = app({ data });
  try {
    await ctx.controller.refresh();
    assert.equal(ctx.controller.element.textContent.includes("OTHER PLAYER INTERNAL NAME"), false);
    assert.equal(ctx.controller.element.querySelector(`[data-player-id="${peerPlayerId}"]`), null);
    assert.equal(ctx.controller.element.querySelector("form"), null);
  } finally { ctx.close(); }
});

test("self check-in uses only the training UUID and prevents duplicate requests while pending", async () => {
  const pending = deferred(); let checked = false;
  const ctx = app({ responses: {
    office_training_check_in: () => pending.promise,
    office_training_attendance_today: () => {
      const data = fixture();
      if (checked) Object.assign(data.trainings[0].attendance[0], {
        status: "present", recorded_at: recorded, self_checked_at: recorded,
      });
      return data;
    },
  } });
  try {
    await ctx.controller.refresh();
    const button = ctx.controller.element.querySelector('[data-attendance-action="check-in"]');
    button.click(); button.click();
    assert.equal(button.disabled, true);
    const writes = ctx.calls.filter(call => call.name === "office_training_check_in");
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0].args, { p_training_id: trainingId });
    checked = true; pending.resolve({ data: { user_id: userId, training_id: trainingId, player_id: playerId,
      status: "present", recorded_at: recorded, self_checked_at: recorded }, error: null });
    await until(() => /出席/.test(ctx.controller.element.querySelector('[data-attendance-status]')?.textContent ?? ""));
    assert.ok(ctx.controller.element.textContent.includes("出席"));
  } finally { ctx.close(); }
});

test("failed check-in does not display confirmed attendance and can be retried", async () => {
  const ctx = app({ responses: { office_training_check_in: { data: null, error: { code: "42501" } } } });
  try {
    await ctx.controller.refresh();
    const button = ctx.controller.element.querySelector('[data-attendance-action="check-in"]'); button.click();
    await until(() => ctx.controller.element.querySelector('[role="alert"]'));
    assert.equal(Boolean(ctx.controller.element.querySelector('[data-attendance-status]')?.textContent.includes("出席")), false);
    assert.equal(ctx.calls.filter(call => call.name === "office_training_check_in").length, 1);
    assert.ok(!button.disabled || !button.isConnected, "failure must permit a safe retry or require an explicit refresh");
  } finally { ctx.close(); }
});

for (const role of ["owner", "staff"]) {
  test(`${role} can record a reasoned status for a selected player without supplying an actor identity`, async () => {
    const ctx = app({ data: { role, linked: false, player_id: null } });
    try {
      await ctx.controller.refresh();
      const form = ctx.controller.element.querySelector(`[data-player-id="${playerId}"] form`)
        ?? ctx.controller.element.querySelector(`form[data-player-id="${playerId}"]`);
      assert.ok(form);
      const status = form.elements.namedItem("status"), reason = form.elements.namedItem("reason");
      assert.deepEqual([...status.options].map(option => option.value).filter(Boolean).sort(), ["absent", "excused", "late", "present"]);
      status.value = "late"; reason.value = "Arrival time confirmed by staff";
      ctx.submit(form);
      await until(() => ctx.calls.some(call => call.name === "office_training_set_attendance"));
      const args = ctx.calls.find(call => call.name === "office_training_set_attendance").args;
      assert.deepEqual(args, { p_training_id: trainingId, p_player_id: playerId,
        p_status: "late", p_reason: "Arrival time confirmed by staff" });
    } finally { ctx.close(); }
  });
}

test("staff cannot submit a blank reason and failed saves retain the selected status and reason", async () => {
  const pending = deferred();
  const ctx = app({ data: { role: "staff", linked: false, player_id: null },
    responses: { office_training_set_attendance: () => pending.promise } });
  try {
    await ctx.controller.refresh();
    const form = ctx.controller.element.querySelector("form");
    form.elements.namedItem("status").value = "excused";
    form.elements.namedItem("reason").value = "   "; ctx.submit(form);
    assert.equal(ctx.calls.some(call => call.name === "office_training_set_attendance"), false);
    form.elements.namedItem("reason").value = "Club-approved correction";
    ctx.submit(form); ctx.submit(form);
    assert.equal(ctx.calls.filter(call => call.name === "office_training_set_attendance").length, 1);
    pending.resolve({ data: null, error: { code: "40001", message: "Save failed" } });
    await until(() => ctx.controller.element.querySelector('[role="alert"]'));
    assert.equal(form.elements.namedItem("status").value, "excused");
    assert.equal(form.elements.namedItem("reason").value, "Club-approved correction");
    assert.equal(ctx.controller.element.querySelector('[data-attendance-status]')?.textContent.includes("免除"), false);
  } finally { ctx.close(); }
});

test("a manual refresh preserves a staff member's unsaved correction", async () => {
  const ctx = app({ data: { role: "staff", linked: false, player_id: null } });
  try {
    await ctx.controller.refresh();
    const form = ctx.controller.element.querySelector("form");
    form.elements.namedItem("status").value = "late";
    form.elements.namedItem("reason").value = "Unsaved staff explanation";
    for (const name of ["status", "reason"])
      form.elements.namedItem(name).dispatchEvent(new ctx.window.Event("input", { bubbles: true }));
    await ctx.controller.refresh();
    const refreshed = ctx.controller.element.querySelector("form");
    assert.equal(refreshed.elements.namedItem("status").value, "late");
    assert.equal(refreshed.elements.namedItem("reason").value, "Unsaved staff explanation");
  } finally { ctx.close(); }
});

test("a mismatched mutation receipt cannot be shown as this player's successful check-in", async () => {
  const ctx = app({ responses: { office_training_check_in: { user_id: userId,
    training_id: trainingId, player_id: peerPlayerId, status: "present", recorded_at: recorded, self_checked_at: recorded } } });
  try {
    await ctx.controller.refresh();
    ctx.controller.element.querySelector('[data-attendance-action="check-in"]').click();
    await until(() => ctx.controller.element.querySelector('[role="alert"]'));
    assert.equal(Boolean(ctx.controller.element.querySelector('[data-attendance-status]')?.textContent.includes("出席")), false);
  } finally { ctx.close(); }
});

test("repeated refreshes cannot launch overlapping private roster reads", async () => {
  const late = deferred(); let reads = 0;
  const newer = fixture(); newer.trainings[0].title = "Current session";
  const ctx = app({ responses: { office_training_attendance_today: () => ++reads === 1 ? late.promise : newer } });
  try {
    const old = ctx.controller.refresh();
    await ctx.controller.refresh();
    assert.equal(reads, 1);
    late.resolve({ data: newer, error: null }); await old;
    assert.ok(ctx.controller.element.textContent.includes("Current session"));
  } finally { ctx.close(); }
});

for (const mode of ["denied", "wrong-account", "signed-out", "disposed"]) {
  test(`${mode} clears attendance records and pending private responses cannot restore them`, async () => {
    const late = deferred(); let reads = 0;
    const ctx = app({ responses: { office_training_attendance_today: () => ++reads === 1 ? fixture({ role: "staff" }) : late.promise } });
    try {
      await ctx.controller.refresh();
      assert.ok(ctx.controller.element.textContent.includes("韓 山田 Ana-María"));
      const pending = ctx.controller.refresh();
      if (mode === "signed-out") ctx.emit("SIGNED_OUT", null);
      if (mode === "disposed") ctx.controller.dispose();
      const data = fixture({ role: "staff", user_id: mode === "wrong-account" ? otherId : userId });
      data.trainings[0].title = "LATE PRIVATE TRAINING";
      late.resolve(mode === "denied" ? { data: null, error: { code: "42501" } } : { data, error: null });
      await pending;
      assert.equal(ctx.controller.element.textContent.includes("韓 山田 Ana-María"), false);
      assert.equal(ctx.controller.element.textContent.includes("LATE PRIVATE TRAINING"), false);
      assert.equal(ctx.controller.element.querySelector("form,[data-attendance-action='check-in']"), null);
      if (mode === "disposed") assert.equal(ctx.unsubscribed(), 1);
    } finally { ctx.close(); }
  });
}

test("training titles, venues and internal names cannot inject markup into attendance", async () => {
  const attack = '<img src=x onerror="window.attendanceLeak=true">';
  const data = fixture({ role: "staff" }); data.trainings[0].title = attack;
  data.trainings[0].venue = attack; data.trainings[0].attendance[0].player_name = attack;
  const ctx = app({ data });
  try {
    await ctx.controller.refresh();
    assert.ok(ctx.controller.element.textContent.includes(attack));
    assert.equal(ctx.controller.element.querySelector("img,script"), null);
    assert.equal(ctx.window.attendanceLeak, undefined);
  } finally { ctx.close(); }
});

for (const sessionStatus of ["completed", "cancelled"]) {
  test(`a player cannot self-check into a ${sessionStatus} session even with an inconsistent capability hint`, async () => {
    const data = fixture(); data.trainings[0].session_status = sessionStatus;
    data.trainings[0].can_check_in = true;
    const ctx = app({ data });
    try {
      await ctx.controller.refresh();
      assert.ok(ctx.controller.element.textContent.includes("Midnight team practice"));
      assert.equal(ctx.controller.element.querySelector('[data-attendance-action="check-in"]'), null);
      assert.equal(ctx.calls.some(call => call.name === "office_training_check_in"), false);
    } finally { ctx.close(); }
  });
}

test("a cancelled session cannot be edited by Staff", async () => {
  const data = fixture({ role: "staff" }); data.trainings[0].session_status = "cancelled";
  const ctx = app({ data });
  try {
    await ctx.controller.refresh();
    assert.ok(ctx.controller.element.textContent.includes("韓 山田 Ana-María"));
    assert.equal(ctx.controller.element.querySelector("form"), null);
  } finally { ctx.close(); }
});

for (const transition of ["date", "role"]) {
  test(`a server ${transition} change clears staff correction drafts`, async () => {
    let data = fixture({ role: "staff" });
    const ctx = app({ responses: { office_training_attendance_today: () => data } });
    try {
      await ctx.controller.refresh();
      const reason = ctx.controller.element.querySelector('[name="reason"]');
      reason.value = "PRIVATE PREVIOUS CONTEXT DRAFT";
      reason.dispatchEvent(new ctx.window.Event("input", { bubbles: true }));
      data = fixture({ role: transition === "role" ? "player" : "staff",
        today: transition === "date" ? "2026-10-19" : "2026-10-18" });
      await ctx.controller.refresh();
      assert.equal(ctx.controller.element.querySelector('[name="reason"]')?.value.includes("PRIVATE PREVIOUS CONTEXT DRAFT") ?? false, false);
      if (transition === "role") assert.equal(ctx.controller.element.querySelector("form"), null);
      else assert.equal(ctx.controller.element.querySelector('time[datetime="2026-10-19"]')?.textContent.includes("2026-10-19"), true);
    } finally { ctx.close(); }
  });
}

for (const status of ["present", "late"]) {
  test(`a legacy ${status} check-in with an unknown recording time accepts its confirmed self-check timestamp`, async () => {
    let checked = false;
    const legacy = () => {
      const data = fixture(); Object.assign(data.trainings[0].attendance[0], {
        status, recorded_at: null, self_checked_at: checked ? recorded : null,
      }); return data;
    };
    const ctx = app({ responses: {
      office_training_attendance_today: legacy,
      office_training_check_in: () => {
        checked = true;
        return { user_id: userId, training_id: trainingId, player_id: playerId,
          status, recorded_at: null, self_checked_at: recorded };
      },
    } });
    try {
      await ctx.controller.refresh();
      ctx.controller.element.querySelector('[data-attendance-action="check-in"]').click();
      await until(() => ctx.controller.element.querySelector('.training-attendance-message[role="status"]')?.textContent.includes("出席を記録しました"));
      assert.equal(ctx.controller.element.querySelector('[data-attendance-status]')?.dataset.attendanceStatus, status);
      assert.ok(ctx.controller.element.textContent.includes("自分で出席確認済み"));
      assert.equal(ctx.controller.element.textContent.includes("最終記録"), false);
    } finally { ctx.close(); }
  });
}

test("Staff can confirm an unchanged legacy status without inventing an actor timestamp", async () => {
  const data = fixture({ role: "staff" }); data.trainings[0].attendance[0].status = "present";
  const ctx = app({ data, responses: { office_training_set_attendance: args => ({
    user_id: userId, training_id: args.p_training_id, player_id: args.p_player_id,
    status: args.p_status, recorded_at: null, self_checked_at: null,
  }) } });
  try {
    await ctx.controller.refresh();
    const form = ctx.controller.element.querySelector("form");
    form.elements.namedItem("reason").value = "Existing club attendance reviewed";
    ctx.submit(form);
    await until(() => ctx.controller.element.querySelector('.training-attendance-message[role="status"]')?.textContent.includes("出席の記録を保存しました"));
    assert.equal(ctx.controller.element.querySelector('[data-attendance-status]')?.dataset.attendanceStatus, "present");
    assert.equal(ctx.controller.element.textContent.includes("最終記録"), false);
    assert.equal(ctx.controller.element.textContent.includes("運営メンバーが記録"), false);
  } finally { ctx.close(); }
});

for (const status of ["absent", "excused"]) {
  test(`a player cannot replace a Staff-managed ${status} record with self check-in`, async () => {
    const data = fixture(); data.trainings[0].attendance[0].status = status;
    const ctx = app({ data });
    try {
      await ctx.controller.refresh();
      assert.equal(ctx.controller.element.querySelector('[data-attendance-action="check-in"]'), null);
      assert.match(ctx.controller.element.textContent, /運営メンバーが管理/);
      assert.equal(ctx.calls.some(call => call.name === "office_training_check_in"), false);
    } finally { ctx.close(); }
  });
}
