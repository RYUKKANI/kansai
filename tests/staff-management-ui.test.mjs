import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

// 실제 화면 모듈을 실행하고 RPC 응답만 메모리로 대체합니다. 운영 계정·선수 정보를 만들지 않습니다.
const compiled = (
  await build({
    entryPoints: ["src/scripts/admin-staff.ts"],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "staffUi",
    platform: "browser",
    define: { "import.meta.env.BASE_URL": '"/"' },
  })
).outputFiles[0].text;
const ownerId = "00000000-0000-4000-8000-000000000001";
const peerId = "00000000-0000-4000-8000-000000000002";
const now = "2026-10-15T05:00:00Z";
const owner = {
  user_id: ownerId,
  username: "test_owner",
  real_name: "山田 韓-花",
  department: "運営",
  approval_status: "approved",
  role: "owner",
  active: true,
  email_confirmed: true,
  name_verified_at: now,
  name_verified_by: peerId,
};
async function app(page, response = {}, options = {}) {
  const dom = new JSDOM('<main id="staff"></main>', {
    url:
      "https://kansaiunited.com/admin/" +
      (options.lang ? "?lang=" + options.lang : ""),
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
    this.dispatchEvent(new window.Event("close"));
  };
  window.eval(compiled + "\nwindow.staffUi = staffUi;");
  const calls = [];
  const notices = [];
  let active = true;
  let subscriptions = 0;
  const client = {
    // 총괄의 계정↔선수 연결 선택지만 읽습니다. 이 조회가 다른 등급에서 발생하면 별도 검사가 잡습니다.
    from(table) {
      assert.equal(table, "players");
      return {
        select(columns) {
          assert.equal(columns, "id,internal_name");
          return { async order(column) {
            assert.equal(column, "internal_name");
            calls.push({ name: table, args: { select: columns, order: column } });
            return { data: response.players ?? [], error: null };
          } };
        },
      };
    },
    auth: {
      onAuthStateChange() {
        subscriptions++;
        let unsubscribed = false;
        return { data: { subscription: { unsubscribe() {
          if (!unsubscribed) { subscriptions--; unsubscribed = true; }
        } } } };
      },
    },
    async rpc(name, args) {
      calls.push({ name, args });
      const emptyWrite = ["office_request_name_change", "office_verify_staff_identity", "office_review_staff",
        "office_set_staff_access", "office_review_name_change"].includes(name);
      const value = Object.hasOwn(response, name) ? response[name]
        : name === "office_account_state" ? owner : emptyWrite ? null : [];
      if (typeof value === "function") return value(args);
      return { data: value, error: null };
    },
  };
  const container = window.document.querySelector("#staff");
  const controller = await window.staffUi.renderStaffOffice({
    client,
    container,
    page,
    role: options.role ?? "owner",
    userId: ownerId,
    notice: (...args) => notices.push(args),
    isCurrent: () => active,
    refresh: options.refresh ?? (() => {}),
  });
  return {
    dom,
    window,
    container,
    controller,
    calls,
    notices,
    subscriptions: () => subscriptions,
    logout() {
      active = false;
      controller.dispose();
    },
  };
}
async function eventually(check) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(check(), "UI did not reach expected state");
}
function send(window, form) {
  form.dispatchEvent(
    new window.Event("submit", { bubbles: true, cancelable: true }),
  );
}

// 멤버 업무는 명시적으로 검색하고 UUID가 일치하는 결과를 선택한 다음에만 열립니다.
// 기존 권한·저장 검사는 이 실제 진입 절차를 함께 통과하며, 검색 자체를 권한으로 취급하지 않습니다.
function searchMembers(context, query) {
  const form = context.container.querySelector(".member-search-form");
  assert.ok(form, "Owner member search must be available");
  form.elements.namedItem("member_query").value = query;
  send(context.window, form);
}
function selectMember(context, query, userId = peerId) {
  searchMembers(context, query);
  const result = context.container.querySelector(`[data-member-target="${userId}"]`);
  assert.ok(result, "search must return the intended account UUID");
  result.click();
  const panel = context.container.querySelector(`[data-member-workspace="${userId}"]`);
  assert.ok(panel, "only the chosen account management panel should open");
  return panel;
}

const manualApplicant = { user_id: peerId, username: "peer.staff", real_name: "李 Jean-Luc",
  department: "コーチ", approval_status: "pending", email_confirmed: false,
  email_confirmation_required: false, email_verification_status: "not_required" };

test("Owner approves an ID-only applicant after checking real name, login ID and club relationship", async () => {
  const context = await app("staff_applications", {
    office_staff_applications: [{ ...manualApplicant, email: "opaque-token@accounts.kansai.invalid" }],
    office_staff_name_requests: [], office_review_staff: null,
  });
  try {
    selectMember(context, 'peer.staff', peerId);
    const form = context.container.querySelector(".member-workspace form");
    assert.equal(form.querySelector('[data-staff-action="review"]').disabled, false);
    assert.equal(context.container.querySelector('[data-staff-action="contact"]'), null);
    assert.doesNotMatch(context.container.textContent, /メール確認|メールアドレス|accounts\.kansai\.invalid/);
    assert.match(context.container.textContent, /実名・ログインID・関係者であることを確認しました/);
    assert.ok(context.container.textContent.includes("peer.staff"));
    form.querySelector('[name="reason"]').value = "Real name, applicant ID and club role checked";
    send(context.window, form);
    assert.equal(context.calls.some(call => call.name === "office_review_staff"), false);
    form.querySelector('[name="identity_confirmed"]').checked = true;
    send(context.window, form);
    await eventually(() => context.calls.some(call => call.name === "office_review_staff"));
    const payload = context.calls.find(call => call.name === "office_review_staff").args;
    assert.equal(payload.p_decision, "approved");
    for (const privateKey of ["email", "actor_id", "actor_name", "identity_confirmed"])
      assert.equal(Object.hasOwn(payload, privateKey), false);
    assert.equal(context.calls.some(call => call.name === "office_staff_application_contact"), false);
  } finally { context.controller.dispose(); context.dom.window.close(); }
});

test("failed ID-only approval retains review input and enables retry without an email lookup", async () => {
  let settle;
  const context = await app("staff_applications", {
    office_staff_applications: [manualApplicant], office_staff_name_requests: [],
    office_review_staff: () => new Promise(resolve => { settle = resolve; }),
  });
  try {
    selectMember(context, 'peer.staff', peerId);
    const form = context.container.querySelector(".member-workspace form");
    const save = form.querySelector('[data-staff-action="review"]');
    form.querySelector('[name="identity_confirmed"]').checked = true;
    form.querySelector('[name="reason"]').value = "Confirmed club role";
    send(context.window, form); send(context.window, form);
    assert.equal(save.disabled, true);
    assert.equal(context.calls.filter(call => call.name === "office_review_staff").length, 1);
    settle({ data: null, error: { code: "42501" } });
    await eventually(() => !save.disabled && context.notices.length === 1);
    assert.equal(form.querySelector('[name="reason"]').value, "Confirmed club role");
    assert.equal(form.querySelector('[name="identity_confirmed"]').checked, true);
    assert.equal(context.notices[0][1], true);
    assert.equal(context.calls.some(call => call.name === "office_staff_application_contact"), false);
  } finally { context.controller.dispose(); context.dom.window.close(); }
});

test("Staff cannot open member management even with an Owner caller hint", async () => {
  const context = await app("staff_applications", {
    office_account_state: { ...owner, role: "staff" },
    office_staff_applications: [manualApplicant], office_staff_name_requests: [],
  });
  try {
    assert.deepEqual(context.calls.map(call => call.name), ["office_account_state"]);
    assert.equal(context.container.querySelector("form"), null);
    assert.equal(context.container.querySelector("[data-owner-account]"), null);
    assert.ok(context.container.querySelector('[role="alert"]'));
  } finally { context.controller.dispose(); context.dom.window.close(); }
});

for (const [role, pages] of [["staff", ["staff_applications"]], ["player", ["staff_directory", "staff_applications", "staff_audit"]]]) {
  for (const page of pages) {
    test(`${role} cannot fetch ${page} data or Owner player-link controls from a caller hint`, async () => {
      const context = await app(page, { office_account_state: { ...owner, role } }, { role: "owner" });
      try {
        assert.deepEqual(context.calls.map(call => call.name), ["office_account_state"]);
        assert.equal(context.container.querySelector("form,[data-owner-account],[data-staff-action='player-link']"), null);
        assert.ok(context.container.querySelector('[role="alert"]'));
      } finally { context.controller.dispose(); context.dom.window.close(); }
    });
  }
}

for (const linked of [true, false]) {
  test(`Owner ${linked ? "links" : "unlinks"} an existing player using distinct account and player UUIDs`, async () => {
    const playerId = "00000000-0000-4000-8000-000000000099";
    const context = await app("staff_applications", {
      office_staff_applications: [{ ...owner, user_id: peerId, role: "player", player_id: linked ? null : playerId }],
      players: [{ id: playerId, internal_name: "Existing player" }],
      office_owner_set_player_link: args => ({ data: { user_id: args.p_user_id, player_id: args.p_player_id }, error: null }),
    });
    try {
      selectMember(context, '山田 韓-花', peerId);
      const form = context.container.querySelector('[data-staff-action="player-link"]').form;
      const choice = form.elements.namedItem("player_id");
      assert.deepEqual([...choice.options].map(option => option.value), ["", playerId]);
      assert.equal(choice.value, linked ? "" : playerId);
      choice.value = linked ? playerId : "";
      form.elements.namedItem("reason").value = "本人の既存選手記録を確認";
      send(context.window, form);
      await eventually(() => context.notices.length === 1);
      assert.deepEqual(JSON.parse(JSON.stringify(context.calls.find(call => call.name === "office_owner_set_player_link").args)), {
        p_user_id: peerId, p_player_id: linked ? playerId : null, p_reason: "本人の既存選手記録を確認",
      });
      assert.equal(context.notices[0][1], undefined);
      assert.equal(context.calls.some(call => /create_player|save_player_office/.test(call.name)), false);
    } finally { context.controller.dispose(); context.dom.window.close(); }
  });
}

test("ID-only review response arriving after logout cannot restore private data or notify the old session", async () => {
  let settle;
  const context = await app("staff_applications", {
    office_staff_applications: [manualApplicant], office_staff_name_requests: [],
    office_review_staff: () => new Promise(resolve => { settle = resolve; }),
  });
  try {
    selectMember(context, 'peer.staff', peerId);
    const form = context.container.querySelector('.member-workspace form');
    form.querySelector('[name="identity_confirmed"]').checked = true;
    form.querySelector('[name="reason"]').value = "Club member identity checked";
    send(context.window, form);
    context.logout(); context.container.replaceChildren();
    settle({ data: null, error: null });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(context.container.textContent, "");
    assert.equal(context.notices.length, 0);
  } finally { context.controller.dispose(); context.dom.window.close(); }
});

test("support reset audit has an unknown support operator and masks credential values", async () => {
  const context = await app("staff_audit", { office_staff_audit: [{ source: "system_support", actor_id: null,
    actor_name: null, actor_name_status: "unknown", executor: "project_admin_password_support_cli",
    entity: "staff_accounts", record_id: peerId, action: "support_password_reset_succeeded", occurred_at: now,
    changed_fields: ["password"], before_values: { password: "must-not-render" }, after_values: { password: "must-not-render" } }] });
  try {
    assert.match(context.container.textContent, /管理者支援 \/ 実行者確認不可/);
    assert.match(context.container.textContent, /パスワード支援の完了/);
    assert.equal(context.container.textContent.includes("must-not-render"), false);
  } finally { context.controller.dispose(); context.dom.window.close(); }
});

test("Owner reset audit distinguishes the authenticated requester from the server executor", async () => {
  const context = await app("staff_audit", { office_staff_audit: [{ source: "owner_password_reset",
    actor_id: ownerId, actor_name: null, actor_name_status: "unverified", actor_role: "owner",
    requested_by: ownerId, executor: "staff_auth_edge_function", entity: "staff_accounts", record_id: peerId,
    action: "owner_password_reset_succeeded", occurred_at: now, changed_fields: ["password"],
    before_values: { password: "must-not-render" }, after_values: { password: "must-not-render" } }] });
  try {
    assert.match(context.container.textContent, /実名確認前のアカウント/);
    assert.match(context.container.textContent, /統括によるアカウント管理/);
    assert.match(context.container.textContent, /staff_auth_edge_function/);
    assert.ok(context.container.textContent.includes(ownerId));
    assert.equal(context.container.textContent.includes("must-not-render"), false);
    assert.equal(context.container.textContent.includes("以前の記録"), false);
  } finally { context.controller.dispose(); context.dom.window.close(); }
});

test("pending and suspended staff only receive their own application state on every staff route", async () => {
  for (const approval_status of ["pending", "suspended", "rejected"]) {
    for (const page of [
      "staff_directory",
      "staff_applications",
      "staff_audit",
    ]) {
      const context = await app(page, {
        office_account_state: {
          ...owner,
          approval_status,
          active: false,
          role: null,
          email_confirmed: false,
        },
      });
      try {
        assert.deepEqual(
          context.calls.map((call) => call.name),
          ["office_account_state"],
        );
        assert.match(
          context.container.textContent,
          /運営責任者の承認後にご利用/,
        );
        assert.equal(context.container.querySelectorAll("form").length, 0);
        assert.equal(
          context.container.textContent.includes("test_owner"),
          true,
        );
      } finally {
        context.controller.dispose();
        context.dom.window.close();
      }
    }
  }
});

test("directory uses verified safe RPC data and preserves Unicode names as text in all locales", async () => {
  const name = '<img src=x onerror="alert(1)"> 李 Jean-Luc サトウ';
  for (const lang of ["ja", "ko", "en"]) {
    const context = await app(
      "staff_directory",
      {
        office_staff_directory: [
          {
            user_id: peerId,
            real_name: name,
            department: "코치 / Coaching",
            activity_status: "inactive",
            email: "must-not-render@example.invalid",
            phone: "private-number",
            role: "owner",
          },
          {
            user_id: ownerId,
            real_name: name,
            department: "운영",
            activity_status: "active",
          },
        ],
      },
      { lang },
    );
    try {
      assert.equal(
        context.container.querySelectorAll("h3").length,
        2,
        "same-name members remain separate",
      );
      assert.equal(context.container.querySelector("h3").textContent, name);
      assert.equal(context.container.querySelector("img"), null);
      assert.equal(
        context.container.textContent.includes("must-not-render"),
        false,
      );
      assert.equal(
        context.container.textContent.includes("private-number"),
        false,
      );
      assert.equal(
        context.container.querySelector(".staff-status").dataset.kind,
        "inactive",
      );
      assert.deepEqual(
        context.calls.map((call) => call.name),
        ["office_account_state", "office_staff_directory"],
      );
    } finally {
      context.controller.dispose();
      context.dom.window.close();
    }
  }
});

test("server state controls management access even if caller-provided role claims Owner", async () => {
  const context = await app("staff_applications", {
    office_account_state: { ...owner, role: "staff" },
  });
  try {
    assert.deepEqual(
      context.calls.map((call) => call.name),
      ["office_account_state"],
    );
    assert.ok(context.container.querySelector('[role="alert"]'));
    assert.equal(context.container.querySelector("form"), null);
  } finally {
    context.controller.dispose();
    context.dom.window.close();
  }
});

test("Owner search creates only the selected account window and defers account details until opening", async () => {
  const context = await app("staff_applications", {
    office_staff_applications: [owner, { ...owner, user_id: peerId }],
    office_staff_name_requests: [],
  });
  try {
    assert.equal(context.container.querySelectorAll('[data-owner-account],dialog,[data-member-target]').length, 0);
    searchMembers(context, owner.real_name);
    assert.equal(context.container.querySelectorAll('[data-member-target]').length, 2);
    assert.equal(context.container.querySelectorAll('[data-owner-account],dialog').length, 0);
    context.container.querySelector(`[data-member-target="${peerId}"]`).click();
    assert.equal(context.container.querySelectorAll('[data-owner-account]').length, 1);
    assert.equal(context.container.querySelectorAll('dialog').length, 1);
    assert.ok(context.container.querySelector(`[data-owner-account-target="${peerId}"]`));
    assert.equal(context.calls.some(call => call.name === "office_owner_account"), false);
    assert.equal(context.container.querySelectorAll('input[autocomplete="new-password"]').length, 0);
  } finally { context.controller.dispose(); context.dom.window.close(); }
});

// 실명 문자열이 있어도 등록 안내 확인 등이 끝나지 않은 계정은 서버에서 본인 확인을 거부합니다.
// 실패할 것이 정해진 양식은 표시하지 않고, 계정 정정과 권한 관리 경로는 그대로 둡니다.
for (const [reason, fields] of [
  ["profile enrollment remains pending", { real_name: "Legacy Name", identity_enrolled: true, profile_enrollment_pending: true }],
  ["identity enrollment is incomplete", { real_name: "Legacy Name", identity_enrolled: false }],
  ["no real name has been registered", { real_name: " ", identity_enrolled: true, profile_enrollment_pending: false }],
]) {
  test(`Owner is not offered an impossible verification form when ${reason}`, async () => {
    const member = { ...owner, ...fields, user_id: peerId, name_verified_at: null,
      name_verified_by: null, name_verification_source: null, approved_real_name: null };
    const context = await app("staff_applications", { office_staff_applications: [member] });
    try {
      selectMember(context, 'test_owner', peerId);
      const card = context.container.querySelector(`[data-staff-id="${peerId}"]`);
      assert.equal(card.querySelector('[data-staff-action="verify"]'), null);
      assert.ok(card.querySelector('[data-owner-account]'), "the Owner must still be able to correct the account");
      assert.ok(card.querySelector('[data-staff-action="access"]'));
      assert.equal(context.calls.some(call => call.name === "office_verify_staff_identity"), false);
    } finally { context.controller.dispose(); context.dom.window.close(); }
  });
}

test("a completely enrolled unverified peer still requires an explicit verification action even without optional duty", async () => {
  const member = { ...owner, user_id: peerId, real_name: "金 Ana-María", department: null,
    identity_enrolled: true, profile_enrollment_pending: false, name_verified_at: null,
    name_verified_by: null, name_verification_source: null, approved_real_name: null };
  const context = await app("staff_applications", { office_staff_applications: [member] });
  try {
    selectMember(context, 'test_owner', peerId);
    const button = context.container.querySelector('[data-staff-action="verify"]');
    assert.ok(button);
    assert.equal(context.calls.some(call => call.name === "office_verify_staff_identity"), false);
    button.form.elements.namedItem("reason").value = "本人の登録氏名と関係者であることを確認";
    send(context.window, button.form);
    await eventually(() => context.notices.length === 1);
    assert.deepEqual(JSON.parse(JSON.stringify(context.calls.find(call => call.name === "office_verify_staff_identity").args)), {
      p_user_id: peerId, p_real_name: member.real_name, p_reason: "本人の登録氏名と関係者であることを確認",
    });
    assert.equal(context.notices[0][1], undefined);
  } finally { context.controller.dispose(); context.dom.window.close(); }
});

for (const [lang, label, disclaimer] of [
  ["ja", "初代統括の登録確認", "他の関係者による確認ではありません"],
  ["ko", "최초 총괄 등록 확인", "다른 관계자가 확인한 기록이 아닙니다"],
  ["en", "Initial Lead registration confirmed", "No independent staff verification recorded"],
]) {
  for (const page of ["staff_account", "staff_applications"]) {
    test(`${page} reports the initial Owner setup origin without a human reviewer in ${lang}`, async () => {
      const initial = { ...owner, identity_enrolled: true, profile_enrollment_pending: false,
        approved_real_name: owner.real_name, name_edit_mode: "review_required",
        name_verified_by: null, name_verified_by_name: "must-not-invent-a-reviewer",
        name_verification_source: "initial_owner_setup" };
      const context = await app(page, { office_account_state: initial, office_staff_applications: [initial] }, { lang });
      try {
        if (page === "staff_applications") selectMember(context, initial.username, ownerId);
        const card = context.container.querySelector('[data-name-verification-source="initial_owner_setup"]');
        assert.ok(card);
        assert.ok(card.querySelector(".staff-details").textContent.includes(label));
        assert.ok(card.querySelector(".staff-details").textContent.includes(disclaimer));
        assert.equal(card.textContent.includes("must-not-invent-a-reviewer"), false);
        assert.equal(card.querySelector('[data-staff-action="verify"]'), null);
        assert.equal(context.calls.some(call => /initial_owner|verify_staff/.test(call.name)), false);
      } finally { context.controller.dispose(); context.dom.window.close(); }
    });
  }
}

test("another Owner can explicitly verify the same initially registered name and display a real human review afterward", async () => {
  let member = { ...owner, user_id: peerId, real_name: "初代の登録名", identity_enrolled: true,
    profile_enrollment_pending: false, approved_real_name: "初代の登録名", name_verified_by: null,
    name_verified_by_name: null, name_verification_source: "initial_owner_setup" };
  const context = await app("staff_applications", {
    office_staff_applications: () => ({ data: [member], error: null }),
    office_verify_staff_identity: () => {
      member = { ...member, name_verification_source: "staff_review", name_verified_by: ownerId,
        name_verified_by_name: owner.real_name, name_verified_at: "2026-10-17T06:00:00Z" };
      return { data: null, error: null };
    },
  });
  try {
    selectMember(context, 'test_owner', peerId);
    const initial = context.container.querySelector(`[data-staff-id="${peerId}"]`);
    assert.equal(initial.dataset.nameVerificationSource, "initial_owner_setup");
    const verify = initial.querySelector('[data-staff-action="verify"]');
    assert.ok(verify, "a different Owner must have an explicit route to record an independent review");
    assert.equal(verify.form.elements.namedItem("real_name").value, member.real_name);
    assert.equal(context.calls.some(call => call.name === "office_verify_staff_identity"), false);
    verify.form.elements.namedItem("reason").value = "初期登録後に本人と登録氏名を確認";
    send(context.window, verify.form);
    await eventually(() => context.notices.length === 1 && Boolean(context.container.querySelector('[data-name-verification-source="staff_review"]')));
    const reviewed = context.container.querySelector(`[data-staff-id="${peerId}"]`);
    assert.equal(reviewed.dataset.nameVerificationSource, "staff_review");
    assert.ok(reviewed.querySelector(".staff-details").textContent.includes(owner.real_name));
    assert.equal(reviewed.querySelector(".staff-details").textContent.includes("他の関係者による確認ではありません"), false);
    assert.equal(reviewed.querySelector('[data-staff-action="verify"]'), null);
    assert.deepEqual(JSON.parse(JSON.stringify(context.calls.find(call => call.name === "office_verify_staff_identity").args)), {
      p_user_id: peerId, p_real_name: "初代の登録名", p_reason: "初期登録後に本人と登録氏名を確認",
    });
    assert.equal(member.role, "owner");
    assert.equal(context.calls.some(call => call.name === "office_set_staff_access" || /initial_owner/.test(call.name)), false);
    assert.equal(context.notices[0][1], undefined);
  } finally { context.controller.dispose(); context.dom.window.close(); }
});

test("Owner management suppresses self approval and separates requested duty from granted authority", async () => {
  const context = await app("staff_applications", {
    office_staff_applications: [
      owner,
      {
        user_id: peerId,
        real_name: "韓 Hana",
        department: "広報",
        approval_status: "pending",
        email_confirmed: true,
        active: false,
        requested_grade: "owner",
      },
    ],
    office_staff_name_requests: [],
  });
  try {
    selectMember(context, owner.username, ownerId);
    assert.equal(
      context.container.querySelector(`[data-staff-id="${ownerId}"] form`),
      null,
    );
    selectMember(context, "韓 Hana", peerId);
    const form = context.container.querySelector(
      `[data-staff-id="${peerId}"] form`,
    );
    assert.ok(form);
    assert.deepEqual(
      [...form.querySelectorAll('[name="role"] option')].map(
        (item) => item.value,
      ),
      ["owner", "staff", "player"],
    );
    assert.equal(
      form.querySelector('[name="role"]').value,
      "player",
      "desired owner role never becomes an authority grant",
    );
    assert.equal(
      form.querySelector('[name="identity_confirmed"]').required,
      true,
    );
    assert.equal(
      context.calls.some((call) => call.name === "office_staff_name_requests"),
      true,
    );
  } finally {
    context.controller.dispose();
    context.dom.window.close();
  }
});

test("membership save is duplicate-safe, sends only reviewed values and reports success only after RPC commits", async () => {
  let settle;
  const pending = new Promise((resolve) => {
    settle = resolve;
  });
  const context = await app("staff_applications", {
    office_staff_applications: [
      {
        user_id: peerId,
        real_name: "李 Jean-Luc",
        department: "コーチ",
        approval_status: "pending",
        email_confirmed: true,
      },
    ],
    office_staff_name_requests: [],
    office_review_staff: () => pending,
  });
  try {
    selectMember(context, '李 Jean-Luc', peerId);
    const form = context.container.querySelector(".member-workspace form");
    form.querySelector('[name="reason"]').value = "所属確認済み";
    form.querySelector('[name="identity_confirmed"]').checked = true;
    send(context.window, form);
    send(context.window, form);
    assert.equal(
      context.calls.filter((call) => call.name === "office_review_staff")
        .length,
      1,
    );
    assert.equal(context.notices.length, 0);
    assert.equal(form.getAttribute("aria-busy"), "true");
    const request = context.calls.find(
      (call) => call.name === "office_review_staff",
    );
    assert.deepEqual(JSON.parse(JSON.stringify(request.args)), {
      p_user_id: peerId,
      p_decision: "approved",
      p_role: "player",
      p_reason: "所属確認済み",
    });
    assert.equal("actor_id" in request.args, false);
    assert.equal("actor_name" in request.args, false);
    settle({ data: null, error: null });
    await eventually(() => context.notices.length === 1);
    assert.equal(context.notices[0][1], undefined);
  } finally {
    context.controller.dispose();
    context.dom.window.close();
  }
});

test("failed access save retains input, announces error, restores focus and never announces success", async () => {
  const context = await app("staff_applications", {
    office_staff_applications: [{ ...owner, user_id: peerId, role: "owner" }],
    office_staff_name_requests: [],
    office_set_staff_access: () => ({
      data: null,
      error: { code: "42501", message: "last_active_owner" },
    }),
  });
  try {
    selectMember(context, 'test_owner', peerId);
    const form = context.container.querySelector(".member-workspace form");
    form.querySelector('[name="reason"]').value = "検証理由";
    send(context.window, form);
    await eventually(
      () => context.notices.length === 1 && !form.hasAttribute("aria-busy"),
    );
    assert.equal(context.notices[0][1], true);
    assert.equal(form.querySelector('[name="reason"]').value, "検証理由");
    assert.equal(
      context.window.document.activeElement,
      form.querySelector('button[type="submit"]'),
    );
    assert.equal(
      context.calls.filter((call) => call.name === "office_account_state")
        .length,
      1,
    );
  } finally {
    context.controller.dispose();
    context.dom.window.close();
  }
});

test("own name change allows international real names and pending request remains separate from approved name", async () => {
  const context = await app("staff_account", {
    office_account_state: {
      ...owner,
      name_request: { real_name: "李 Jean-Luc サトウ", status: "pending" },
    },
  });
  try {
    const form = context.container.querySelector("form");
    assert.equal(
      form.querySelector('[name="real_name"]').hasAttribute("pattern"),
      false,
    );
    form.querySelector('[name="real_name"]').value = "李 Jean-Luc サトウ";
    form.querySelector('[name="reason"]').value = "正式表記の訂正";
    send(context.window, form);
    await eventually(() =>
      context.calls.some((call) => call.name === "office_request_name_change"),
    );
    const args = context.calls.find(
      (call) => call.name === "office_request_name_change",
    ).args;
    assert.equal(args.p_real_name, "李 Jean-Luc サトウ");
    assert.equal(context.container.textContent.includes(owner.real_name), true);
  } finally {
    context.controller.dispose();
    context.dom.window.close();
  }
});

test("audit keeps verified historical snapshots, masks sensitive diffs, labels direct DB/automation and does not render HTML", async () => {
  const context = await app("staff_audit", {
    office_staff_audit: [
      {
        id: 3,
        actor_id: peerId,
        actor_role: "editor",
        actor_name: "以前の氏名 <b>李</b>",
        actor_name_status: "verified",
        source: "human",
        executor: "authenticated",
        requested_by: ownerId,
        entity: "articles",
        record_id: "article-1",
        operation: "UPDATE",
        occurred_at: now,
        reason: "訂正",
        changed_fields: [
          "title",
          "email",
          "health_notes",
          "access_token",
          "custom_secret",
          "unknown_field",
        ],
        before_values: {
          title: "旧見出し",
          email: "private@example.invalid",
          access_token: "token-value",
        },
        after_values: {
          title: '<img onerror="alert(1)">新見出し',
          health_notes: "private-health",
          custom_secret: "private-secret",
          unknown_field: "hidden-new-field",
        },
      },
      {
        id: 2,
        actor_id: peerId,
        actor_name: "未確認の偽名",
        actor_name_status: "unverified",
        source: "legacy_unknown",
        entity: "articles",
        operation: "UPDATE",
        occurred_at: now,
      },
      {
        id: 1,
        actor_name_status: "unknown",
        source: "scheduled",
        executor: "scheduled_publish_worker",
        entity: "articles",
        operation: "UPDATE",
        occurred_at: now,
      },
      {
        id: 0,
        actor_name_status: "unknown",
        source: "database_unattributed",
        executor: "database_role",
        entity: "fixtures",
        operation: "DELETE",
        occurred_at: now,
      },
    ],
  });
  try {
    const content = context.container.textContent;
    assert.equal(content.includes("以前の氏名 <b>李</b>"), true);
    assert.equal(content.includes("未確認の偽名"), false);
    assert.match(content, /以前の記録 \/ 作業者確認不可/);
    assert.match(content, /予約処理/);
    assert.match(content, /DB直接操作/);
    assert.match(content, /認証済みアカウントの操作/);
    assert.equal(content.includes("本人の操作"), false);
    assert.equal(content.includes("scheduled_publish_worker"), true);
    assert.equal(content.includes("private@example.invalid"), false);
    for (const secret of [
      "private-health",
      "token-value",
      "private-secret",
      "hidden-new-field",
    ])
      assert.equal(content.includes(secret), false);
    assert.equal(context.container.querySelectorAll("img,b").length, 0);
    assert.equal(content.includes("旧見出し"), true);
    assert.equal(content.includes(ownerId), true);
  } finally {
    context.controller.dispose();
    context.dom.window.close();
  }
});

test("logout during in-flight request suppresses stale data and notifications", async () => {
  let finish;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const context = await app("staff_account", {
    office_request_name_change: () => pending,
  });
  try {
    const form = context.container.querySelector("form");
    form.querySelector('[name="real_name"]').value = "New Real Name";
    form.querySelector('[name="reason"]').value = "Correction";
    send(context.window, form);
    context.logout();
    context.container.replaceChildren();
    finish({ data: null, error: null });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(context.container.textContent, "");
    assert.equal(context.notices.length, 0);
    assert.equal(
      context.calls.filter((call) => call.name === "office_account_state")
        .length,
      1,
    );
  } finally {
    context.controller.dispose();
    context.dom.window.close();
  }
});

// 가입 승인·Owner 권한과 미확인 실명 입력은 다른 상태입니다. 실제 본인 계정 폼을 조작해 회귀를 검사합니다.
for (const [lang, saveText] of [["ja", "実名を保存"], ["ko", "실명 저장"], ["en", "Save real name"]]) {
  test(`partial legacy Owner edits own unverified name without a correction approval in ${lang}`, async () => {
    let account = { ...owner, real_name: "Old name", department: null,
      name_verified_at: null, name_verified_by: null, approved_real_name: null,
      identity_enrolled: false, profile_enrollment_pending: true,
      name_edit_mode: "unverified_edit", can_edit_real_name: true };
    let settle;
    let refreshes = 0;
    const context = await app("staff_account", {
      office_account_state: () => ({ data: account, error: null }),
      office_update_unverified_name: () => new Promise(resolve => { settle = () => {
        account = { ...account, real_name: "李 Jean-Luc サトウ" };
        resolve({ data: account, error: null });
      }; }),
    }, { lang, refresh: () => { refreshes++; } });
    try {
      const form = context.container.querySelector('form');
      assert.equal(form.querySelector('button[type="submit"]').textContent, saveText);
      assert.equal(context.container.querySelector('[data-staff-action="request-name"]'), null);
      form.querySelector('[name="real_name"]').value = "李 Jean-Luc サトウ";
      form.querySelector('[name="reason"]').value = "本人による未確認名の修正";
      send(context.window, form); send(context.window, form);
      assert.equal(context.calls.filter(call => call.name === "office_update_unverified_name").length, 1);
      assert.equal(context.notices.length, 0);
      const args = context.calls.find(call => call.name === "office_update_unverified_name").args;
      assert.deepEqual(JSON.parse(JSON.stringify(args)), { p_real_name: "李 Jean-Luc サトウ", p_reason: "本人による未確認名の修正" });
      assert.equal(Object.hasOwn(args, "p_user_id"), false);
      settle();
      await eventually(() => refreshes === 1);
      assert.equal(context.notices[0][1], undefined);
      assert.equal(context.container.querySelector('[name="real_name"]').value, account.real_name);
      assert.equal(context.calls.some(call => call.name === "office_verify_staff_identity" || call.name === "office_request_name_change"), false);
    } finally { context.controller.dispose(); context.dom.window.close(); }
  });
}

test("pending account cannot expose name-edit controls even with a misleading edit-mode flag", async () => {
  const context = await app("staff_account", { office_account_state: {
    ...owner, role: null, active: false, approval_status: "pending", name_edit_mode: "unverified_edit",
  } });
  try {
    assert.equal(context.container.querySelector('form'), null);
    assert.deepEqual(context.calls.map(call => call.name), ["office_account_state"]);
  } finally { context.controller.dispose(); context.dom.window.close(); }
});

for (const bad of [null, { success: false }, { ...owner, user_id: peerId },
  { ...owner, name_edit_mode: "unverified_edit", name_verified_at: now }]) {
  test(`unverified name save never reports success for malformed or different-state response ${JSON.stringify(bad)?.slice(0,35)}`, async () => {
    const account = { ...owner, name_verified_at: null, name_verified_by: null,
      approved_real_name: null, name_edit_mode: "unverified_edit" };
    const context = await app("staff_account", { office_account_state: account,
      office_update_unverified_name: () => ({ data: bad, error: null }) });
    try {
      const form = context.container.querySelector('form');
      form.querySelector('[name="real_name"]').value = "New name";
      form.querySelector('[name="reason"]').value = "理由";
      send(context.window, form);
      await eventually(() => context.notices.length > 0);
      assert.equal(context.notices.every(notice => notice[1] === true), true);
      assert.equal(form.querySelector('[name="real_name"]').value, "New name");
      assert.equal(context.calls.filter(call => call.name === "office_account_state").length, 1);
    } finally { context.controller.dispose(); context.dom.window.close(); }
  });
}

test("void membership RPC with success:false is not a committed access change", async () => {
  const context = await app("staff_applications", { office_staff_applications: [{ ...owner, user_id: peerId }],
    office_set_staff_access: () => ({ data: { success: false }, error: null }) });
  try {
    selectMember(context, 'test_owner', peerId);
    const form = context.container.querySelector('[data-staff-action="access"]').form;
    form.querySelector('[name="reason"]').value = "理由";
    send(context.window, form);
    await eventually(() => context.notices.length > 0);
    assert.equal(context.notices.every(notice => notice[1] === true), true);
    assert.match(context.notices[0][0], /保存結果を確認できません/);
  } finally { context.controller.dispose(); context.dom.window.close(); }
});

test("confirmed profile save remains saved when the header refresh later fails", async () => {
  const account = { ...owner, name_verified_at: null, name_verified_by: null,
    approved_real_name: null, name_edit_mode: "unverified_edit" };
  const context = await app("staff_account", { office_account_state: account,
    office_update_unverified_name: () => ({ data: { ...account, real_name: "New name" }, error: null })
  }, { refresh: () => { throw new Error("read_unavailable"); } });
  try {
    const form = context.container.querySelector('form');
    form.querySelector('[name="real_name"]').value = "New name";
    form.querySelector('[name="reason"]').value = "理由";
    send(context.window, form);
    await eventually(() => context.notices.length === 2);
    assert.equal(context.notices[0][1], undefined);
    assert.match(context.notices[1][0], /変更は保存されましたが/);
  } finally { context.controller.dispose(); context.dom.window.close(); }
});

// 표시용 이름만 번역하며 원래 필드·값을 이용한 민감 정보 제한은 그대로 검사합니다.
for (const [lang, labels] of [
  ["ja", ["タイトル", "実名", "承認状況"]],
  ["ko", ["제목", "실명", "승인 상태"]],
  ["en", ["Title", "Real name", "Approval status"]],
]) {
  test(`audit field labels use office terminology without revealing masked values in ${lang}`, async () => {
    const context = await app("staff_audit", { office_staff_audit: [{
      source: "human", actor_id: ownerId, actor_name: owner.real_name, actor_name_status: "verified",
      entity: "staff_accounts", record_id: peerId, action: "update", occurred_at: now,
      changed_fields: ["title", "real_name", "approval_status", "email", "private_unknown_field"],
      before_values: { real_name: "田中 旧名", email: "must-not-render@example.invalid", private_unknown_field: "must-not-render" },
      after_values: { title: "Test title", real_name: "田中 新名", approval_status: "approved", email: "must-not-render@example.invalid" },
    }] }, { lang });
    try {
      assert.deepEqual([...context.container.querySelectorAll(".staff-audit-fields strong")].map(item => item.textContent), labels);
      assert.match(context.container.textContent, /田中 旧名 → 田中 新名/);
      assert.equal(context.container.textContent.includes("must-not-render"), false);
      assert.equal(context.container.textContent.includes("private_unknown_field"), false);
      assert.equal(context.calls.every(call => ["office_account_state", "office_staff_audit"].includes(call.name)), true);
    } finally { context.controller.dispose(); context.dom.window.close(); }
  });
}

// 검색은 조회 편의 기능입니다. 서버 권한 검사는 유지하면서 초기 화면·선택·폐기 경계를 따로 확인합니다.
for (const lang of ["ja", "ko", "en"]) {
  test(`member search starts without private management forms and requires an explicit search in ${lang}`, async () => {
    const context = await app("staff_applications", { office_staff_applications: [owner, manualApplicant] }, { lang });
    try {
      const input = context.container.querySelector('input[type="search"][name="member_query"]');
      assert.ok(input);
      assert.ok(input.labels.length, "the search field needs a visible, associated label");
      assert.ok(context.container.querySelector('[data-member-search-action="search"]'));
      assert.equal(context.container.querySelectorAll("form").length, 1);
      assert.equal(context.container.querySelectorAll('[data-member-target],[data-member-workspace],dialog,[data-owner-account]').length, 0);
      assert.equal(context.container.textContent.includes(manualApplicant.real_name), false);
      assert.equal(context.container.textContent.includes(peerId), false);
      input.value = "peer.staff";
      input.dispatchEvent(new context.window.Event("input", { bubbles: true }));
      assert.equal(context.container.querySelectorAll('[data-member-target]').length, 0,
        "typing alone must not enumerate accounts or auto-open a panel");
      send(context.window, input.form);
      assert.equal(context.container.querySelectorAll('[data-member-target]').length, 1);
      assert.equal(context.container.querySelector('[data-member-workspace]'), null);
      assert.equal(context.calls.some(call => call.name === "office_owner_account"), false);
    } finally { context.controller.dispose(); context.dom.window.close(); }
  });
}

test("blank, whitespace, and unmatched searches never enumerate accounts or preserve an old panel", async () => {
  const context = await app("staff_applications", { office_staff_applications: [owner, manualApplicant] });
  try {
    selectMember(context, "peer.staff");
    for (const query of ["", " \t\n ", "does-not-exist"]) {
      searchMembers(context, query);
      assert.equal(context.container.querySelectorAll('[data-member-target],[data-member-workspace],dialog').length, 0);
      assert.equal(context.container.querySelectorAll('[data-staff-action]').length, 0);
      assert.equal(context.subscriptions(), 0);
    }
    assert.equal(context.calls.some(call => call.name === "office_owner_account"), false);
    assert.equal(context.notices.length, 0);
  } finally { context.controller.dispose(); context.dom.window.close(); }
});

test("ID case, international names, normalized accents and duplicate names retain explicit UUID selection", async () => {
  const otherId = "00000000-0000-4000-8000-000000000003";
  const name = "김 José サトウ Jean-Luc";
  const context = await app("staff_applications", { office_staff_applications: [
    { ...manualApplicant, username: "one.member", real_name: name },
    { ...manualApplicant, user_id: otherId, username: "two.member", real_name: name },
  ] });
  try {
    searchMembers(context, " ONE.MEMBER ");
    assert.deepEqual([...context.container.querySelectorAll('[data-member-target]')].map(node => node.dataset.memberTarget), [peerId]);
    assert.equal(context.container.querySelector('[data-member-workspace]'), null);
    searchMembers(context, "김   Jose\u0301 サトウ");
    const results = [...context.container.querySelectorAll('[data-member-target]')];
    assert.equal(results.length, 2);
    for (const result of results) {
      assert.ok(result.textContent.includes(name));
      assert.equal(result.getAttribute("aria-pressed"), "false");
    }
    assert.ok(results[0].textContent.includes("one.member"));
    assert.ok(results[1].textContent.includes("two.member"));
    results[1].click();
    assert.equal(context.container.querySelectorAll('[data-member-workspace]').length, 1);
    assert.ok(context.container.querySelector(`[data-member-workspace="${otherId}"]`));
    assert.equal(context.container.querySelector(`[data-member-target="${otherId}"]`).getAttribute("aria-pressed"), "true");
    assert.equal(context.container.querySelector(`[data-staff-id="${peerId}"]`), null);
    const form = context.container.querySelector('[data-staff-action="review"]').form;
    form.elements.namedItem("identity_confirmed").checked = true;
    form.elements.namedItem("reason").value = "同姓同名の別アカウントを確認";
    send(context.window, form);
    await eventually(() => context.calls.some(call => call.name === "office_review_staff"));
    assert.equal(context.calls.find(call => call.name === "office_review_staff").args.p_user_id, otherId);
  } finally { context.controller.dispose(); context.dom.window.close(); }
});

test("search and result values render untrusted names as text without matching private contact fields", async () => {
  const dangerous = '<img src=x onerror="throw 1"> 李';
  const context = await app("staff_applications", { office_staff_applications: [
    { ...manualApplicant, real_name: dangerous, email: "private-match@example.invalid", phone: "secret-phone" },
  ] });
  try {
    searchMembers(context, "private-match");
    assert.equal(context.container.querySelectorAll('[data-member-target]').length, 0);
    searchMembers(context, "<img");
    const result = context.container.querySelector(`[data-member-target="${peerId}"]`);
    assert.ok(result.textContent.includes(dangerous));
    assert.equal(context.container.querySelector("img"), null);
    result.click();
    assert.ok(context.container.textContent.includes(dangerous));
    assert.equal(context.container.querySelector("img"), null);
    assert.equal(context.container.textContent.includes("private-match"), false);
    assert.equal(context.container.textContent.includes("secret-phone"), false);
  } finally { context.controller.dispose(); context.dom.window.close(); }
});

test("only the chosen account's name correction requests appear and the server receives that request ID", async () => {
  const otherId = "00000000-0000-4000-8000-000000000003";
  const context = await app("staff_applications", { office_staff_applications: [manualApplicant,
    { ...manualApplicant, user_id: otherId, username: "another.member", real_name: "別の人" }],
    office_staff_name_requests: [
      { id: "request-peer", user_id: peerId, current_real_name: manualApplicant.real_name, requested_real_name: "李 正式名", reason: "PEER_PRIVATE_REASON", status: "pending" },
      { id: "request-other", user_id: otherId, current_real_name: "別の人", requested_real_name: "別の正式名", reason: "OTHER_PRIVATE_REASON", status: "pending" },
    ],
  });
  try {
    assert.equal(context.container.textContent.includes("PRIVATE_REASON"), false);
    const panel = selectMember(context, "peer.staff");
    assert.ok(panel.textContent.includes("PEER_PRIVATE_REASON"));
    assert.equal(context.container.textContent.includes("OTHER_PRIVATE_REASON"), false);
    const review = panel.querySelector('[data-staff-action="review-name"]').form;
    review.elements.namedItem("reason").value = "本人からの訂正申請を確認";
    send(context.window, review);
    await eventually(() => context.calls.some(call => call.name === "office_review_name_change"));
    assert.deepEqual(JSON.parse(JSON.stringify(context.calls.find(call => call.name === "office_review_name_change").args)), {
      p_request_id: "request-peer", p_approve: true, p_reason: "本人からの訂正申請を確認",
    });
  } finally { context.controller.dispose(); context.dom.window.close(); }
});

for (const action of ["close", "clear", "search"]) {
  test(`${action} destroys the selected account controller, clears password inputs, and makes its old forms inert`, async () => {
    const context = await app("staff_applications", { office_staff_applications: [manualApplicant],
      office_owner_account: { ...manualApplicant, password_is_set: true, can_edit_real_name: true },
    });
    try {
      const panel = selectMember(context, "peer.staff");
      const oldReview = panel.querySelector('[data-staff-action="review"]').form;
      oldReview.elements.namedItem("identity_confirmed").checked = true;
      oldReview.elements.namedItem("reason").value = "古い管理フォーム";
      assert.equal(context.subscriptions(), 1);
      panel.querySelector('[data-owner-account-target]').click();
      await eventually(() => Boolean(panel.querySelector('[data-owner-form="password"]')));
      const password = panel.querySelector('[name="password"]');
      password.value = "temporary-local-test-value";
      if (action === "search") searchMembers(context, "unmatched-next-search");
      else context.container.querySelector(`[data-member-search-action="${action}"]`).click();
      assert.equal(password.value, "", "discarded password fields must be scrubbed even while detached");
      assert.equal(context.subscriptions(), 0);
      assert.equal(context.container.querySelector('[data-member-workspace],dialog'), null);
      send(context.window, oldReview);
      assert.equal(context.calls.some(call => call.name === "office_review_staff"), false);
      if (action === "close")
        assert.equal(context.window.document.activeElement, context.container.querySelector(`[data-member-target="${peerId}"]`));
      if (action === "clear")
        assert.equal(context.window.document.activeElement, context.container.querySelector('[name="member_query"]'));
    } finally { context.controller.dispose(); context.dom.window.close(); }
  });
}

test("a delayed account-detail response cannot repopulate a discarded panel or expose another selected account", async () => {
  let finish;
  const context = await app("staff_applications", { office_staff_applications: [manualApplicant, owner],
    office_owner_account: () => new Promise(resolve => { finish = resolve; }),
  });
  try {
    const oldPanel = selectMember(context, "peer.staff");
    oldPanel.querySelector('[data-owner-account-target]').click();
    await eventually(() => Boolean(finish));
    const currentPanel = selectMember(context, owner.username, ownerId);
    finish({ data: { ...manualApplicant, password_is_set: true, can_edit_real_name: true }, error: null });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(context.container.querySelector('[data-member-workspace]'), currentPanel);
    assert.equal(context.container.querySelector('[data-owner-form]'), null);
    assert.equal(oldPanel.querySelector('[data-owner-form]'), null);
    assert.equal(context.notices.length, 0);
    assert.equal(context.subscriptions(), 1);
  } finally { context.controller.dispose(); context.dom.window.close(); }
});

for (const success of [true, false]) {
  test(`member navigation stays locked until a ${success ? "committed" : "failed"} save settles for the selected account`, async () => {
    let finish;
    const other = { ...owner, username: "owner.member" };
    const context = await app("staff_applications", { office_staff_applications: [manualApplicant, other],
      office_review_staff: () => new Promise(resolve => { finish = resolve; }),
    });
    try {
      const panel = selectMember(context, ".");
      const form = panel.querySelector('[data-staff-action="review"]').form;
      form.elements.namedItem("identity_confirmed").checked = true;
      form.elements.namedItem("reason").value = "確認済み";
      send(context.window, form);
      assert.equal(context.calls.filter(call => call.name === "office_review_staff").length, 1);
      const navigation = [...context.container.querySelectorAll(
        '[name="member_query"],[data-member-search-action],[data-member-target],.owner-account-trigger',
      )];
      assert.ok(navigation.length >= 6);
      assert.equal(navigation.every(control => control.disabled), true,
        "search, clear, result selection and close must all visibly wait for the save");
      assert.match(context.container.textContent, /保存中/);
      context.container.querySelector(`[data-member-target="${ownerId}"]`).click();
      context.container.querySelector('[data-member-search-action="close"]').click();
      context.container.querySelector('[data-member-search-action="clear"]').click();
      context.container.querySelector('.owner-account-trigger').click();
      assert.equal(context.calls.some(call => call.name === "office_owner_account"), false,
        "account editing must wait until the selected member's business save settles");
      // 프로그램이 submit 이벤트를 보내더라도 비활성화한 화면 상태를 우회할 수 없습니다.
      searchMembers(context, "owner.member");
      assert.equal(context.container.querySelector('[data-member-workspace]'), panel);
      assert.equal(context.container.querySelector('[data-member-target][aria-pressed="true"]').dataset.memberTarget, peerId);
      assert.equal(context.notices.length, 0);
      const reads = context.calls.filter(call => call.name === "office_account_state").length;
      finish(success ? { data: null, error: null } : { data: null, error: { code: "42501" } });
      await eventually(() => context.notices.length === 1 &&
        [...context.container.querySelectorAll('[name="member_query"],[data-member-search-action],[data-member-target],.owner-account-trigger')]
          .every(control => !control.disabled));
      assert.equal(context.notices[0][1], success ? undefined : true);
      assert.equal(context.container.querySelector('[data-member-workspace]').dataset.memberWorkspace, peerId);
      assert.equal(context.calls.filter(call => call.name === "office_account_state").length, reads + (success ? 1 : 0));
      if (success) {
        assert.equal(context.window.document.activeElement, context.container.querySelector('.member-workspace-title'),
          "a successful refresh must focus the reattached selected-account heading");
        assert.equal(context.container.querySelector('[name="member_query"]').value, ".");
      } else {
        assert.equal(context.container.querySelector('[data-member-workspace]'), panel);
        assert.equal(context.window.document.activeElement, form.querySelector('[data-staff-action="review"]'));
      }
      const selected = selectMember(context, "owner.member", ownerId);
      assert.equal(context.container.querySelector('[data-member-workspace]'), selected,
        "navigation must become available again when the original save settles");
    } finally { context.controller.dispose(); context.dom.window.close(); }
  });
}

test("a save response after an external refresh revokes Owner access cannot restore private data or announce success", async () => {
  let account = owner;
  let finish;
  const context = await app("staff_applications", {
    office_account_state: () => ({ data: account, error: null }),
    office_staff_applications: [manualApplicant],
    office_review_staff: () => new Promise(resolve => { finish = resolve; }),
  });
  try {
    const panel = selectMember(context, "peer.staff");
    const form = panel.querySelector('[data-staff-action="review"]').form;
    form.elements.namedItem("identity_confirmed").checked = true;
    form.elements.namedItem("reason").value = "確認済み";
    send(context.window, form);
    account = { ...owner, role: "staff" };
    await context.controller.refresh();
    assert.equal(context.container.querySelector('[data-member-workspace],.member-search-form,dialog'), null);
    const reads = context.calls.filter(call => call.name === "office_account_state").length;
    finish({ data: null, error: null });
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(context.container.querySelector('[data-member-workspace],.member-search-form,dialog'), null);
    assert.ok(context.container.querySelector('[role="alert"]'));
    assert.equal(context.notices.length, 0);
    assert.equal(context.calls.filter(call => call.name === "office_account_state").length, reads);
    assert.equal(context.subscriptions(), 0);
  } finally { context.controller.dispose(); context.dom.window.close(); }
});

test("identity save keeps the selected UUID and query after a rename stops matching that query", async () => {
  let member = { ...manualApplicant, approval_status: "approved", active: true, role: "staff", password_is_set: true, can_edit_real_name: true };
  const context = await app("staff_applications", {
    office_staff_applications: () => ({ data: [member], error: null }),
    office_owner_account: () => ({ data: member, error: null }),
    office_owner_update_identity: args => {
      member = { ...member, username: args.p_username, real_name: args.p_real_name };
      return { data: member, error: null };
    },
  });
  try {
    const oldPanel = selectMember(context, "peer.staff");
    oldPanel.querySelector('[data-owner-account-target]').click();
    await eventually(() => Boolean(oldPanel.querySelector('[data-owner-form="identity"]')));
    const form = oldPanel.querySelector('[data-owner-form="identity"]');
    form.elements.namedItem("username").value = "renamed.account";
    form.elements.namedItem("reason").value = "ログインIDの訂正";
    send(context.window, form);
    await eventually(() => context.container.querySelector('[data-member-workspace]') !== oldPanel && context.container.querySelector('[data-member-workspace]'));
    const panel = context.container.querySelector('[data-member-workspace]');
    assert.equal(panel.dataset.memberWorkspace, peerId);
    assert.ok(panel.textContent.includes("renamed.account"));
    assert.equal(context.container.querySelector('[name="member_query"]').value, "peer.staff");
    assert.equal(context.container.querySelectorAll('[data-member-target]').length, 0);
    assert.equal(context.calls.find(call => call.name === "office_owner_update_identity").args.p_user_id, peerId);
    assert.equal(context.subscriptions(), 1);
    assert.equal(context.notices.some(notice => notice[1] === true), false);
  } finally { context.controller.dispose(); context.dom.window.close(); }
});

test("a refresh that revokes Owner access removes the selected member workspace before any new private fetch", async () => {
  let account = owner;
  const context = await app("staff_applications", { office_account_state: () => ({ data: account, error: null }),
    office_staff_applications: [manualApplicant],
  });
  try {
    selectMember(context, "peer.staff");
    const count = context.calls.filter(call => call.name === "office_staff_applications").length;
    account = { ...owner, role: "staff" };
    await context.controller.refresh();
    assert.equal(context.container.querySelector('[data-member-workspace],.member-search-form,dialog'), null);
    assert.ok(context.container.querySelector('[role="alert"]'));
    assert.equal(context.calls.filter(call => call.name === "office_staff_applications").length, count);
    assert.equal(context.subscriptions(), 0);
  } finally { context.controller.dispose(); context.dom.window.close(); }
});

test("removing a selected account on refresh never selects a different account with the same real name", async () => {
  let rows = [manualApplicant, { ...manualApplicant, user_id: ownerId, username: "other.same-name" }];
  const context = await app("staff_applications", { office_staff_applications: () => ({ data: rows, error: null }) });
  try {
    selectMember(context, manualApplicant.real_name);
    rows = [rows[1]];
    await context.controller.refresh();
    assert.equal(context.container.querySelector('[data-member-workspace],dialog'), null);
    assert.equal(context.container.querySelectorAll('[data-member-target]').length, 1);
    assert.equal(context.container.querySelector('[data-member-target]').getAttribute("aria-pressed"), "false");
    assert.equal(context.subscriptions(), 0);
  } finally { context.controller.dispose(); context.dom.window.close(); }
});
