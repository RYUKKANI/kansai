import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { JSDOM } from "jsdom";
// UI는 빌드한 실제 SDK로 검사하고 서버 응답만 대체합니다. 실제 DB 권한은 supabase/tests에서 따로 검증합니다.
const html = await readFile("dist/admin/index.html", "utf8");
const uid = "00000000-0000-4000-8000-000000000001";
const token =
  Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString(
    "base64url",
  ) +
  "." +
  Buffer.from(
    JSON.stringify({
      sub: uid,
      exp: Math.floor(Date.now() / 1000) + 3600,
      aud: "authenticated",
    }),
  ).toString("base64url") +
  ".TEST";
async function eventually(condition) {
  for (let n = 0; n < 100; n++) {
    if (condition()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(condition(), "UI did not reach expected state");
}
async function app(
  staffRole = "owner",
  appUrl = "https://ryukkani.github.io/kansai/admin/",
) {
  const dom = new JSDOM(html, {
    url: appUrl,
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  Object.assign(window, {
    TextEncoder,
    TextDecoder,
    Headers,
    Request,
    Response,
    AbortController,
    AbortSignal,
    fetch,
  });
  const user = {
    id: uid,
    email: "test@example.invalid",
    aud: "authenticated",
    role: "authenticated",
    user_metadata: { role: "owner" },
    app_metadata: {},
    created_at: new Date().toISOString(),
  };
  const tables = {
    admin_roles: [
      { user_id: uid, email: user.email, role: staffRole, active: true },
    ],
    articles: [
      {
        id: "article-1",
        slug: "existing-url",
        title: "Existing title",
        summary: "summary",
        body: "body",
        category: "club",
        cover_alt: "alt",
        gallery_paths: [],
        status: "published",
        published_at: "2026-10-01T00:00:00Z",
        updated_at: new Date().toISOString(),
      },
    ],
    players: [],
    fixtures: [],
    training_sessions: [],
    public_player_profiles: [],
    media_assets: [],
    media_albums: [],
    site_pages: [],
    audit_logs: [],
    publication_state: [{ id: 1, version: 1 }],
  };
  const requests = [];
  window.fetch = async (input, options = {}) => {
    const url = new URL(
      typeof input === "string" ? input : input.url,
      window.location.href,
    );
    const headers = new Headers(options.headers ?? {});
    const method = options.method ?? "GET";
    requests.push({ url: url.href, method, body: options.body });
    if (url.pathname.endsWith("/build.json"))
      return Response.json({
        version: 1,
        fromCms: true,
        builtAt: new Date().toISOString(),
      });
    if (url.pathname.endsWith("/auth/v1/token"))
      return Response.json({
        access_token: token,
        refresh_token: "TEST-REFRESH",
        token_type: "bearer",
        expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        user,
      });
    if (url.pathname.endsWith("/auth/v1/user")) return Response.json(user);
    if (url.pathname.endsWith("/auth/v1/logout"))
      return new Response(null, { status: 204 });
    const name = url.pathname.split("/").pop();
    let data = tables[name] ?? [];
    if (method === "HEAD")
      return new Response(null, {
        status: 200,
        headers: { "Content-Range": "0-0/" + data.length },
      });
    if (method === "POST") {
      const payload = JSON.parse(options.body);
      const row = {
        ...payload,
        id: "new-row",
        updated_at: new Date().toISOString(),
      };
      tables[name].push(row);
      return Response.json(row);
    }
    if (method === "PATCH") {
      const row = data[0];
      Object.assign(row, JSON.parse(options.body));
      return Response.json(row);
    }
    if (headers.get("Accept")?.includes("object")) data = data[0] ?? null;
    return Response.json(data, {
      headers: {
        "Content-Range": "0-0/" + (Array.isArray(data) ? data.length : 1),
      },
    });
  };
  for (const script of window.document.querySelectorAll("script[src]")) {
    const relative = new URL(script.src).pathname.replace("/kansai/", "");
    window.eval(await readFile(path.join("dist", relative), "utf8"));
  }
  await eventually(() => !window.document.querySelector("#login-panel").hidden);
  return { dom, window, tables, requests };
}
async function login(window) {
  const document = window.document;
  document.querySelector('#login-form input[name="email"]').value =
    "test@example.invalid";
  document.querySelector('#login-form input[name="password"]').value =
    "TEST ONLY";
  document
    .querySelector("#login-form")
    .dispatchEvent(
      new window.Event("submit", { bubbles: true, cancelable: true }),
    );
  await eventually(
    () =>
      !document.querySelector("#workspace").hidden &&
      document.querySelectorAll(".admin-stat").length > 0,
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
  const { dom, window } = await app("coach");
  try {
    await login(window);
    const document = window.document;
    assert.equal(document.querySelector('[data-resource="admin_roles"]'), null);
    assert.equal(document.querySelector('[data-resource="articles"]'), null);
    assert.ok(document.querySelector('[data-resource="training_sessions"]'));
    document.querySelector('[data-resource="public_player_profiles"]').click();
    await eventually(
      () =>
        document.querySelector("#resource-title").textContent ===
        "公開プロフィール",
    );
    document.querySelector("#new-button").click();
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
