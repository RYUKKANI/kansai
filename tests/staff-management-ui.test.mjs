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
  window.eval(compiled + "\nwindow.staffUi = staffUi;");
  const calls = [];
  const notices = [];
  let active = true;
  const client = {
    auth: {
      onAuthStateChange() {
        return { data: { subscription: { unsubscribe() {} } } };
      },
    },
    async rpc(name, args) {
      calls.push({ name, args });
      const value =
        response[name] ?? (name === "office_account_state" ? owner : []);
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
    refresh: () => {},
  });
  return {
    dom,
    window,
    container,
    controller,
    calls,
    notices,
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

const manualApplicant = { user_id: peerId, username: "peer.staff", real_name: "李 Jean-Luc",
  department: "コーチ", approval_status: "pending", email_confirmed: false,
  email_confirmation_required: false, email_verification_status: "not_required" };

test("Owner reviews one pending manual contact and explicitly checks it before approval", async () => {
  const context = await app("staff_applications", {
    office_staff_applications: [manualApplicant], office_staff_name_requests: [],
    office_staff_application_contact: { user_id: peerId, email: "verified-externally@example.invalid" },
    office_review_staff: null,
  });
  try {
    const form = context.container.querySelector("form");
    const save = form.querySelector('[data-staff-action="review"]');
    assert.equal(save.disabled, true);
    assert.equal(context.calls.some(call => call.name === "office_staff_application_contact"), false);
    assert.equal(context.container.textContent.includes("verified-externally"), false);
    assert.match(context.container.textContent, /確認不要（メール所有未確認）/);
    assert.ok(context.container.textContent.includes("peer.staff"));
    form.querySelector('[data-staff-action="contact"]').click();
    await eventually(() => context.container.textContent.includes("verified-externally@example.invalid"));
    const contactRequest = context.calls.find(call => call.name === "office_staff_application_contact").args;
    assert.equal(contactRequest.p_user_id, peerId);
    assert.deepEqual(Object.keys(contactRequest), ["p_user_id"]);
    assert.equal(form.querySelector('[name="identity_confirmed"]').checked, false);
    form.querySelector('[name="reason"]').value = "Existing club contact and applicant ID checked";
    send(context.window, form);
    assert.equal(context.calls.some(call => call.name === "office_review_staff"), false);
    form.querySelector('[name="identity_confirmed"]').checked = true;
    send(context.window, form);
    await eventually(() => context.calls.some(call => call.name === "office_review_staff"));
    const payload = context.calls.find(call => call.name === "office_review_staff").args;
    assert.equal(payload.p_decision, "approved");
    assert.equal(Object.hasOwn(payload, "email"), false);
    assert.equal(Object.hasOwn(payload, "actor_id"), false);
  } finally { context.controller.dispose(); context.dom.window.close(); }
});

test("a delayed failed contact lookup blocks review and still allows a retry after both failures", async () => {
  let settle;
  let lookupCount = 0;
  const context = await app("staff_applications", {
    office_staff_applications: [manualApplicant], office_staff_name_requests: [],
    office_staff_application_contact: () => ++lookupCount === 1
      ? new Promise(resolve => { settle = resolve; })
      : { data: { user_id: peerId, email: "retry@example.invalid" }, error: null },
    office_review_staff: () => ({ data: null, error: { code: "42501" } }),
  });
  try {
    const form = context.container.querySelector("form");
    const contact = form.querySelector('[data-staff-action="contact"]');
    const save = form.querySelector('[data-staff-action="review"]');
    const decision = form.querySelector('[name="decision"]');
    contact.click();
    decision.value = "rejected";
    decision.dispatchEvent(new context.window.Event("change", { bubbles: true }));
    form.querySelector('[name="reason"]').value = "Check again";
    assert.equal(save.disabled, true);
    send(context.window, form);
    assert.equal(context.calls.some(call => call.name === "office_review_staff"), false);
    settle({ data: null, error: { code: "42501" } });
    await eventually(() => !contact.disabled);
    send(context.window, form);
    await eventually(() => context.calls.some(call => call.name === "office_review_staff") && !form.hasAttribute("aria-busy"));
    assert.equal(contact.disabled, false);
    decision.value = "approved";
    decision.dispatchEvent(new context.window.Event("change", { bubbles: true }));
    contact.click();
    await eventually(() => context.container.textContent.includes("retry@example.invalid") && !contact.disabled);
    assert.equal(save.disabled, false);
    assert.equal(form.querySelector('[name="identity_confirmed"]').checked, false);
  } finally { context.controller.dispose(); context.dom.window.close(); }
});

test("Administrator cannot open member management even with an Owner caller hint", async () => {
  const context = await app("staff_applications", {
    office_account_state: { ...owner, role: "administrator" },
    office_staff_applications: [manualApplicant], office_staff_name_requests: [],
  });
  try {
    assert.deepEqual(context.calls.map(call => call.name), ["office_account_state"]);
    assert.equal(context.container.querySelector("form"), null);
    assert.equal(context.container.querySelector("[data-owner-account]"), null);
    assert.ok(context.container.querySelector('[role="alert"]'));
  } finally { context.controller.dispose(); context.dom.window.close(); }
});

test("contact lookup arriving after logout cannot render the email or notify the old session", async () => {
  let settle;
  const context = await app("staff_applications", {
    office_staff_applications: [manualApplicant], office_staff_name_requests: [],
    office_staff_application_contact: () => new Promise(resolve => { settle = resolve; }),
  });
  try {
    context.container.querySelector('[data-staff-action="contact"]').click();
    context.logout();
    settle({ data: { user_id: peerId, email: "late-private@example.invalid" }, error: null });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(context.container.textContent.includes("late-private"), false);
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
    assert.match(context.container.textContent, /Ownerによるアカウント管理/);
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
          /メール確認と運営責任者の承認は別々/,
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
    office_account_state: { ...owner, role: "coach" },
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

test("Owner member cards expose account windows without fetching account details before opening", async () => {
  const context = await app("staff_applications", {
    office_staff_applications: [owner, { ...owner, user_id: peerId }],
    office_staff_name_requests: [],
  });
  try {
    assert.equal(context.container.querySelectorAll('[data-owner-account]').length, 2);
    assert.equal(context.container.querySelectorAll('dialog').length, 2);
    assert.equal(context.calls.some(call => call.name === "office_owner_account"), false);
    assert.equal(context.container.querySelectorAll('input[autocomplete="new-password"]').length, 0);
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
        requested_role: "owner",
      },
    ],
    office_staff_name_requests: [],
  });
  try {
    assert.equal(
      context.container.querySelector(`[data-staff-id="${ownerId}"] form`),
      null,
    );
    const form = context.container.querySelector(
      `[data-staff-id="${peerId}"] form`,
    );
    assert.ok(form);
    assert.deepEqual(
      [...form.querySelectorAll('[name="role"] option')].map(
        (item) => item.value,
      ),
      ["owner", "administrator", "editor", "coach"],
    );
    assert.equal(
      form.querySelector('[name="role"]').value,
      "coach",
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
    const form = context.container.querySelector("form");
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
      p_role: "coach",
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
    const form = context.container.querySelector("form");
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
