import test from "node:test";
import assert from "node:assert/strict";

// 기본 운영 화면의 기존 회귀 검사와 플래그를 켠 별도 빌드를 섞지 않습니다.
// STAFF_IDENTITY_TEST_DIST=dist-identity node --test tests/staff-identity-app.test.mjs
const enabled = Boolean(process.env.STAFF_IDENTITY_TEST_DIST);
const helper = enabled ? await import("./helpers/admin-app.mjs") : null;
const uid = "00000000-0000-4000-8000-000000000001";
const now = "2026-10-15T05:00:00Z";
const approved = {
  user_id: uid,
  username: "same.owner",
  real_name: "韓 山田 Ana-María",
  department: "運営",
  approval_status: "approved",
  role: "owner",
  active: true,
  email_confirmed: true,
  identity_enrolled: true,
  name_verified_at: now,
  name_verified_by: "00000000-0000-4000-8000-000000000002",
  approved_real_name: "韓 山田 Ana-María",
  legacy_account: true,
  legacy: false,
  name_request: null,
};
function name(request) {
  return new URL(request.url).pathname.split("/").pop();
}
async function idLogin(context) {
  const { window } = context;
  const form = window.document.querySelector("#staff-login-form");
  assert.ok(
    form,
    "This test requires a build with the staff identity flag enabled.",
  );
  form.elements.namedItem("username").value = "SAME.Owner";
  form.elements.namedItem("password").value = "test-password-only";
  form.dispatchEvent(
    new window.Event("submit", { bubbles: true, cancelable: true }),
  );
  await helper.eventually(() =>
    context.requests.some(
      (request) => name(request) === "office_account_state",
    ),
  );
}
async function ready(context) {
  await helper.eventually(
    () =>
      !context.window.document.querySelector("#workspace").hidden &&
      context.window.document.querySelectorAll(".admin-stat").length > 0,
  );
}
async function dispose(context) {
  const button = context.window.document.querySelector("#logout-button");
  button?.click();
  await new Promise((resolve) => setTimeout(resolve, 10));
  context.dom.window.close();
}
test(
  "flag-on pending and suspended accounts never request roles or internal tables",
  { skip: !enabled },
  async () => {
    for (const approval_status of ["pending", "rejected", "suspended"]) {
      const context = await helper.app("owner", undefined, {
        staffIdentity: true,
        accountState: {
          ...approved,
          role: null,
          approval_status,
          active: false,
          legacy_account: false,
          email_confirmed: false,
          email_confirmation_required: false,
          email_verification_status: "not_required",
          approved_real_name: null,
          name_verified_at: null,
        },
      });
      try {
        await idLogin(context);
        await helper.eventually(
          () =>
            !context.window.document.querySelector(
              '[data-staff-panel="account"]',
            ).hidden,
        );
        assert.equal(
          context.window.document.querySelector("#workspace").hidden,
          true,
        );
        assert.equal(
          context.window.document.querySelector("#admin-navigation").children
            .length,
          0,
        );
        assert.equal(
          context.window.document.querySelector("#admin-content").children
            .length,
          0,
        );
        const restRequests = context.requests.filter((request) =>
          new URL(request.url).pathname.startsWith("/rest/v1/"),
        );
        assert.ok(restRequests.length > 0);
        assert.equal(
          restRequests.every(
            (request) => name(request) === "office_account_state",
          ),
          true,
          "pending status must be checked before admin_roles and internal content requests",
        );
        assert.ok(
          context.window.document
            .querySelector("#staff-account-state")
            .textContent.includes(approved.real_name),
        );
      } finally {
        await dispose(context);
      }
    }
  },
);

test(
  "flag-on approved manual-policy member enters the workspace without claiming email verification",
  { skip: !enabled },
  async () => {
    const context = await helper.app("owner", undefined, {
      staffIdentity: true,
      accountState: { ...approved, legacy_account: false, email_confirmed: false,
        email_confirmation_required: false, email_verification_status: "not_required" },
    });
    try {
      await idLogin(context);
      await ready(context);
      assert.equal(context.window.document.querySelector("#workspace").hidden, false);
      assert.equal(context.requests.some(request => name(request) === "admin_roles"), true);
    } finally { await dispose(context); }
  },
);
test(
  "flag-on ID login keeps existing UUID and exposes approved role-scoped staff navigation",
  { skip: !enabled },
  async () => {
    const context = await helper.app("owner", undefined, {
      staffIdentity: true,
      accountState: approved,
      rpc: (rpc) =>
        rpc === "office_staff_directory"
          ? [
              {
                user_id: uid,
                real_name: approved.real_name,
                department: "運営",
                activity_status: "active",
              },
            ]
          : [],
    });
    try {
      await idLogin(context);
      await ready(context);
      const document = context.window.document;
      assert.equal(
        document.querySelector("#account-email").textContent,
        approved.real_name,
      );
      assert.equal(
        context.requests.some(
          (request) =>
            name(request) === "admin_roles" &&
            new URL(request.url).searchParams.get("user_id") === "eq." + uid,
        ),
        true,
      );
      for (const route of [
        "staff_directory",
        "staff_applications",
        "staff_account",
        "staff_audit",
      ])
        assert.ok(document.querySelector(`[data-resource="${route}"]`));
      assert.equal(
        document.querySelector('[data-resource="admin_roles"]'),
        null,
      );
      document.querySelector('[data-resource="staff_directory"]').click();
      await helper.eventually(() =>
        Boolean(document.querySelector(".staff-directory h3")),
      );
      assert.equal(
        document.querySelector(".staff-directory h3").textContent,
        approved.real_name,
      );
      assert.equal(document.querySelector("#new-button").hidden, true);
      const gateway = context.requests.find(
        (request) => name(request) === "staff-auth",
      );
      assert.equal(JSON.parse(gateway.body).username, "same.owner");
    } finally {
      await dispose(context);
    }
  },
);
test(
  "flag-on revoked session clears already rendered private workspace on revalidation",
  { skip: !enabled },
  async () => {
    let account = { ...approved };
    const context = await helper.app("owner", undefined, {
      staffIdentity: true,
      accountState: () => account,
    });
    try {
      await idLogin(context);
      await ready(context);
      const document = context.window.document;
      account = {
        ...approved,
        active: false,
        role: null,
        approval_status: "suspended",
      };
      document.dispatchEvent(new context.window.Event("visibilitychange"));
      await helper.eventually(
        () =>
          document.querySelector("#workspace").hidden &&
          !document.querySelector('[data-staff-panel="account"]').hidden,
      );
      assert.equal(document.body.dataset.authenticated, "false");
      assert.equal(document.querySelector("#admin-content").children.length, 0);
      assert.equal(
        document.querySelector("#admin-navigation").children.length,
        0,
      );
      assert.equal(document.querySelector("#header-account").hidden, true);
      assert.equal(document.querySelector("#account-email").textContent, "");
      assert.equal(document.querySelector("#editor-dialog").open, false);
    } finally {
      await dispose(context);
    }
  },
);
test(
  "flag-on legacy unregistered Owner retains access and can start migration without guessing a name",
  { skip: !enabled },
  async () => {
    const context = await helper.app("owner", undefined, {
      staffIdentity: true,
      initialSession: true,
      accountState: {
        ...approved,
        username: null,
        real_name: null,
        department: null,
        approval_status: "legacy",
        identity_enrolled: false,
        approved_real_name: null,
        name_verified_at: null,
        name_verified_by: null,
        legacy: true,
      },
    });
    try {
      await ready(context);
      const document = context.window.document;
      assert.equal(
        document.querySelector("#account-email").textContent.includes("test@"),
        false,
      );
      document.querySelector('[data-resource="staff_account"]').click();
      await helper.eventually(
        () =>
          Boolean(
            document.querySelector("#admin-content [data-staff-migration]"),
          ) ||
          Boolean(
            [...document.querySelectorAll("#admin-content button")].find(
              (button) => /ログインIDを登録/.test(button.textContent),
            ),
          ),
      );
      const migration =
        document.querySelector("#admin-content [data-staff-migration]") ??
        [...document.querySelectorAll("#admin-content button")].find((button) =>
          /ログインIDを登録/.test(button.textContent),
        );
      migration.click();
      await helper.eventually(
        () => !document.querySelector('[data-staff-panel="migration"]').hidden,
      );
      assert.equal(document.querySelector("#staff-enroll-real-name").value, "");
      assert.equal(document.querySelector("#staff-enroll-username").value, "");
      assert.equal(
        context.requests.some((request) =>
          ["signup", "staff_auth_finalize"].includes(name(request)),
        ),
        false,
      );
      assert.equal(
        context.requests.some((request) => name(request) === "staff-auth"),
        false,
        "legacy account access is restored from its existing session, before username enrollment",
      );
    } finally {
      await dispose(context);
    }
  },
);

test(
  "flag-on username-only legacy Owner keeps the same account and completes only missing profile fields",
  { skip: !enabled },
  async () => {
    const context = await helper.app("owner", undefined, {
      staffIdentity: true,
      accountState: {
        ...approved, username: "bootstrap.owner", real_name: null, department: null,
        identity_enrolled: false, approved_real_name: null,
        name_verified_at: null, name_verified_by: null, legacy: true,
      },
    });
    try {
      await idLogin(context);
      await ready(context);
      const document = context.window.document;
      assert.equal(document.querySelector("#account-email").textContent.includes("test@"), false);
      document.querySelector('[data-resource="staff_account"]').click();
      await helper.eventually(() => document.querySelector("#admin-content [data-staff-migration]"));
      document.querySelector("#admin-content [data-staff-migration]").click();
      await helper.eventually(() => !document.querySelector('[data-staff-panel="migration"]').hidden);
      assert.equal(document.querySelector("#staff-enroll-username").value, "bootstrap.owner");
      assert.equal(document.querySelector("#staff-enroll-username").readOnly, true);
      assert.equal(document.querySelector("#staff-enroll-real-name").value, "");
      assert.equal(document.querySelector("#staff-enroll-department").value, "");
      assert.equal(document.querySelector('#staff-enroll-form input[name="notice_accepted"]').checked, false);
      assert.equal(context.requests.some(request => ["signup", "staff_auth_bootstrap_owner", "staff_auth_finalize"].includes(name(request))), false);
    } finally { await dispose(context); }
  },
);
