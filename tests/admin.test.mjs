import test from "node:test";
import assert from "node:assert/strict";
import { app, login, eventually } from "./helpers/admin-app.mjs";

test("flag-off portal removes email sign-in and invite workflows without enabling ID authentication", async () => {
  const { dom, window, requests } = await app();
  try {
    const doc = window.document;
    assert.equal(doc.querySelector('#login-form,#magic-link-button,#invite-form,#invite-dialog,input[type="email"]'), null);
    assert.ok(doc.querySelector('#staff-login-form [name="username"]'));
    assert.equal(doc.querySelector('#staff-login-form [name="username"]').disabled, true);
    assert.equal(doc.querySelector('#staff-login-form [name="password"]').disabled, true);
    assert.equal(doc.querySelector('#config-warning').hidden, false);
    doc.querySelector('#staff-login-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    assert.equal(requests.some(r => /\/auth\/v1\/(otp|resend|signup)|\/functions\/v1\/staff-auth/.test(new URL(r.url).pathname)), false);
    assert.equal(doc.querySelector('#workspace').hidden, true);
  } finally { dom.window.close(); }
});

test("legacy member list hides internal authentication aliases without changing saved contact data", async () => {
  const privateAddress = "opaque-token@accounts.kansai.invalid";
  const { dom, window, tables } = await app("owner", undefined, { userEmail: privateAddress }, { admin_roles: [
    { user_id: "00000000-0000-4000-8000-000000000001", email: privateAddress, role: "owner", active: true },
  ] });
  try {
    await login(window);
    const doc = window.document;
    assert.equal(doc.querySelector("#account-email").textContent.includes(privateAddress), false);
    doc.querySelector('[data-resource="admin_roles"]').click();
    await eventually(() => doc.querySelector('.admin-list-row'));
    assert.equal(doc.querySelector('#admin-content').textContent.includes(privateAddress), false);
    for (const item of doc.querySelectorAll('#admin-content [aria-label]'))
      assert.equal(item.getAttribute('aria-label').includes(privateAddress), false);
    assert.equal(doc.querySelector('#new-button').hidden, true);
    assert.equal(tables.admin_roles[0].email, privateAddress);
  } finally { dom.window.close(); }
});

test("owner can create drafts and published URL stays locked in editor", async () => {
  const { dom, window, tables, requests } = await app();
  try {
    await login(window);
    const document = window.document;
    document.querySelector('[data-resource="articles"]').click();
    await eventually(() => document.querySelector(".admin-list-row"));
    document.querySelector(".admin-list-row button").click();
    await eventually(() => document.querySelector("#editor-dialog").open);
    assert.equal(document.querySelector("#field-slug").disabled, true);
    document.querySelector("#editor-close").click();
    document.querySelector("#new-button").click();
    await eventually(() => document.querySelector("#editor-dialog").open);
    for (const [field, value] of Object.entries({
      title: "<img src=x onerror=alert(1)>",
      slug: "new-story",
      summary: "summary",
      body: "Paragraph one\n\nParagraph two",
      cover_alt: "photo description",
    }))
      document.querySelector("#field-" + field).value = value;
    const save = document.querySelector('[data-save-status="draft"]');
    document.querySelector("#editor-form").dispatchEvent(
      new window.SubmitEvent("submit", {
        bubbles: true,
        cancelable: true,
        submitter: save,
      }),
    );
    await eventually(
      () =>
        tables.articles.length === 2 &&
        !document.querySelector("#editor-dialog").open,
    );
    assert.equal(tables.articles[1].status, "draft");
    assert.equal(tables.articles[1].slug, "new-story");
    await eventually(
      () => document.querySelectorAll(".admin-list-row").length === 2,
    );
    assert.equal(document.querySelector("#admin-content img"), null);
    assert.ok(
      document
        .querySelector("#admin-content")
        .textContent.includes("<img src=x"),
    );
    assert.ok(
      requests.some(
        (r) => r.method === "POST" && r.url.includes("/rest/v1/articles"),
      ),
    );
    document.querySelector("#logout-button").click();
    await eventually(() => document.querySelector("#workspace").hidden);
    assert.equal(document.querySelector("#admin-content").children.length, 0);
  } finally {
    dom.window.close();
  }
});

test("saved preview disables login and makes no authentication requests", async () => {
  const { dom, window, requests } = await app(
    "owner",
    "file:///kansai/admin/index.html",
  );
  try {
    const document = window.document;
    assert.equal(document.querySelector("#config-warning").hidden, false);
    assert.equal(document.querySelector('#staff-login-form input[name="username"]').disabled, true);
    assert.equal(document.querySelector('#staff-login-form input[name="password"]').disabled, true);
    assert.equal(document.querySelector('input[type="email"]'), null);
    assert.equal(document.querySelector("#workspace").hidden, true);
    assert.equal(requests.length, 0);
  } finally {
    dom.window.close();
  }
});
test("coach metadata cannot expose owner/editor menus or profile publishing", async () => {
  const { dom, window } = await app(
    "coach",
    undefined,
    {},
    {
      players: [
        {
          id: "00000000-0000-4000-8000-000000000001",
          internal_name: "Test only",
          activity_status: "active",
          updated_at: new Date().toISOString(),
        },
      ],
    },
  );
  try {
    await login(window);
    const document = window.document;
    assert.equal(document.querySelector('[data-resource="admin_roles"]'), null);
    assert.equal(document.querySelector('[data-resource="articles"]'), null);
    assert.ok(document.querySelector('[data-resource="training_sessions"]'));
    assert.equal(
      document.querySelector(
        '#admin-navigation [data-resource="public_player_profiles"]',
      ),
      null,
    );
    document.querySelector('[data-resource="players"]').click();
    await eventually(() =>
      document.querySelector('[data-player-action="edit"]'),
    );
    document.querySelector('[data-player-action="edit"]').click();
    await eventually(() => document.querySelector("#editor-dialog").open);
    assert.equal(
      document.querySelector('[data-save-status="published"]'),
      null,
    );
    assert.ok(document.querySelector('[data-save-status="pending"]'));
  } finally {
    dom.window.close();
  }
});
