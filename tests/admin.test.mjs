import test from "node:test";
import assert from "node:assert/strict";
import { app, login, eventually } from "./helpers/admin-app.mjs";

test("confirmed member receives a login link without signup or confirmation resend", async () => {
  const { dom, window, requests } = await app();
  try {
    const document = window.document;
    document.querySelector('#login-form input[name="email"]').value =
      "TEST@EXAMPLE.INVALID";
    const button = document.querySelector("#magic-link-button");
    button.click();
    assert.equal(button.disabled, true);
    assert.equal(
      document.querySelector('#login-form button[type="submit"]').disabled,
      true,
    );
    button.click();
    await eventually(() =>
      document
        .querySelector("#admin-notice")
        .textContent.includes("ログインリンクを送信しました"),
    );
    const otpRequests = requests.filter((r) =>
      new URL(r.url).pathname.endsWith("/auth/v1/otp"),
    );
    assert.equal(otpRequests.length, 1);
    assert.equal(JSON.parse(otpRequests[0].body).create_user, false);
    assert.equal(JSON.parse(otpRequests[0].body).email, "test@example.invalid");
    assert.equal(
      new URL(otpRequests[0].url).searchParams.get("redirect_to"),
      "https://ryukkani.github.io/kansai/admin/",
    );
    assert.equal(
      requests.some((r) => new URL(r.url).pathname.endsWith("/auth/v1/resend")),
      false,
    );
    assert.equal(document.querySelector("#workspace").hidden, true);
    assert.equal(button.disabled, false);
  } finally {
    dom.window.close();
  }
});

test("unconfirmed invitation resends confirmation and keeps signup disabled", async () => {
  const { dom, window, requests } = await app("owner", undefined, {
    otpError: "signup_disabled",
  });
  try {
    const document = window.document;
    document.querySelector('#login-form input[name="email"]').value =
      "TEST@EXAMPLE.INVALID";
    document.querySelector("#magic-link-button").click();
    await eventually(() =>
      document
        .querySelector("#admin-notice")
        .textContent.includes("確認メールの送信を受け付けました"),
    );
    const authRequests = requests.filter((r) =>
      /\/auth\/v1\/(otp|resend)$/.test(new URL(r.url).pathname),
    );
    assert.equal(authRequests.length, 2);
    assert.equal(JSON.parse(authRequests[0].body).create_user, false);
    const confirmation = authRequests[1];
    assert.equal(JSON.parse(confirmation.body).type, "signup");
    assert.equal(JSON.parse(confirmation.body).email, "test@example.invalid");
    assert.equal(
      new URL(confirmation.url).searchParams.get("redirect_to"),
      "https://ryukkani.github.io/kansai/admin/",
    );
    assert.equal(
      requests.some((r) => new URL(r.url).pathname.endsWith("/auth/v1/signup")),
      false,
    );
    assert.equal(
      document.querySelector("#admin-notice").dataset.error,
      "false",
    );
    assert.equal(document.querySelector("#workspace").hidden, true);
  } finally {
    dom.window.close();
  }
});

for (const [name, authResponses] of [
  ["login link", { otpError: "over_email_send_rate_limit" }],
  [
    "confirmation",
    { otpError: "signup_disabled", resendError: "over_email_send_rate_limit" },
  ],
]) {
  test(
    name + " send failure shows Japanese guidance and unlocks retry",
    async () => {
      const { dom, window, requests } = await app(
        "owner",
        undefined,
        authResponses,
      );
      try {
        const document = window.document;
        document.querySelector('#login-form input[name="email"]').value =
          "test@example.invalid";
        document.querySelector("#magic-link-button").click();
        await eventually(
          () =>
            document.querySelector("#admin-notice").dataset.error === "true",
        );
        assert.ok(
          document
            .querySelector("#admin-notice")
            .textContent.includes("少し時間をおいて"),
        );
        assert.equal(
          document.querySelector("#magic-link-button").disabled,
          false,
        );
        assert.equal(
          document.querySelector("#login-form").hasAttribute("aria-busy"),
          false,
        );
        assert.equal(document.querySelector("#workspace").hidden, true);
        assert.equal(
          requests.some((r) =>
            new URL(r.url).pathname.endsWith("/auth/v1/signup"),
          ),
          false,
        );
      } finally {
        dom.window.close();
      }
    },
  );
}

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
    assert.equal(document.querySelector("#magic-link-button").disabled, true);
    assert.equal(
      document.querySelector('#login-form input[name="email"]').disabled,
      true,
    );
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
      document.querySelector('[data-player-action="profile"]'),
    );
    document.querySelector('[data-player-action="profile"]').click();
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
