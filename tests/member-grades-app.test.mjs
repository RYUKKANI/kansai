import test from "node:test";
import assert from "node:assert/strict";
import { app, login, eventually, uid } from "./helpers/admin-app.mjs";

// 실제 빌드와 SDK를 실행합니다. 서버 응답은 가상 값만 사용하며, RLS 우회 검사는 SQL suite가 담당합니다.
const identityEnabled = Boolean(process.env.STAFF_IDENTITY_TEST_DIST);
const stamp = "2026-10-01T00:00:00Z";
const playerId = "00000000-0000-4000-8000-000000000099";
const account = role => ({ user_id: uid, username: "grade.member", real_name: "李 Ana-María",
  approved_real_name: "李 Ana-María", department: "", role, active: true,
  approval_status: "approved", identity_enrolled: true, legacy_account: false,
  email_confirmation_required: false, email_confirmed: false, name_verified_at: stamp });
const portal = { user_id: uid, real_name: "李 Ana-María", approved_real_name: "李 Ana-María",
  player_id: playerId, linked: true, player: { player_id: playerId, activity_status: "active",
    profile_consent: true, photo_consent: true, public_profile: { display_name: "Safe public name",
      romanized_name: "Ana-María", jersey_number: 7, position: "MF", bio: "Safe profile" } } };
const route = request => new URL(request.url).pathname.split("/").pop();
function options(role, overrides = {}) {
  return { staffIdentity: identityEnabled, accountState: identityEnabled ? account(role) : undefined,
    schedule: true, content: true, publisher: true,
    rpc(name) { return name === "office_player_portal" ? portal : []; }, ...overrides };
}
function navigation(document) {
  return [...document.querySelectorAll("#admin-navigation [data-resource]")].map(button => button.dataset.resource);
}
async function dispose(context) {
  context.window.document.querySelector("#logout-button")?.click();
  await new Promise(resolve => setTimeout(resolve, 10));
  context.dom.window.close();
}

for (const role of ["owner", "staff"]) {
  test(`${role} gets operational draft areas while only Owner gets account management`, async () => {
    const context = await app(role, undefined, options(role));
    try {
      await login(context.window);
      const document = context.window.document;
      const available = navigation(document);
      for (const resource of ["dashboard", "articles", "players", "fixtures", "training_sessions", "media_assets", "media_albums", "site_pages", "club_events", "schedule"])
        assert.ok(available.includes(resource), `${role}: ${resource}`);
      assert.equal(available.includes("player_portal"), false);
      if (identityEnabled) {
        assert.equal(available.includes("staff_applications"), role === "owner");
        assert.ok(available.includes("staff_account"));
        assert.equal(available.includes("admin_roles"), false);
      } else assert.equal(available.includes("admin_roles"), role === "owner");
    } finally { await dispose(context); }
  });
}

test("Staff can create a news draft but cannot publish, delete or restore already public content", async () => {
  const context = await app("staff", undefined, options("staff", { content: false }));
  try {
    await login(context.window);
    const document = context.window.document;
    document.querySelector('[data-resource="articles"]').click();
    await eventually(() => Boolean(document.querySelector(".admin-list-row")));
    document.querySelector(".admin-list-row button").click();
    await eventually(() => document.querySelector("#editor-dialog").open);
    assert.equal(document.querySelector('#editor-actions button[type="submit"]'), null,
      "editing a published record directly would immediately change the public site");
    assert.equal(document.querySelector('[data-save-status="published"]'), null);
    assert.equal(document.querySelector('[data-content-action="restore"]'), null);
    assert.equal(document.querySelector('[data-content-action="schedule"]'), null);
    const before = context.requests.length;
    document.querySelector("#editor-form").dispatchEvent(new context.window.SubmitEvent("submit", { bubbles: true, cancelable: true }));
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(context.requests.slice(before).some(request => ["POST", "PATCH", "DELETE"].includes(request.method)), false,
      "forcing a submit event cannot save changes to the existing public record");
    document.querySelector("#editor-close").click();
    document.querySelector("#new-button").click();
    await eventually(() => document.querySelector("#editor-dialog").open && Boolean(document.querySelector("#field-title")));
    for (const [field, value] of Object.entries({ title: "Staff draft", slug: "staff-draft", summary: "Summary", body: "Body", cover_alt: "Description" }))
      document.querySelector("#field-" + field).value = value;
    assert.equal(document.querySelector('[data-save-status="published"]'), null);
    const forged = document.createElement("button");
    forged.dataset.saveStatus = "published";
    const beforePublish = context.requests.length;
    document.querySelector("#editor-form").dispatchEvent(new context.window.SubmitEvent("submit", {
      bubbles: true, cancelable: true, submitter: forged,
    }));
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(context.requests.slice(beforePublish).some(request => ["POST", "PATCH", "DELETE"].includes(request.method)), false,
      "a forged publish submitter cannot promote a Staff draft");
    document.querySelector('[data-save-status="draft"]').click();
    await eventually(() => !document.querySelector("#editor-dialog").open);
    assert.equal(context.tables.articles.find(row => row.slug === "staff-draft")?.status, "draft");
    assert.equal(context.requests.some(request => request.method === "DELETE"), false);
    assert.equal(context.requests.some(request => /restore|schedule_content/.test(route(request))), false);
  } finally { await dispose(context); }
});

for (const lang of ["ja", "ko", "en"]) {
  test(`Player sees only their own portal and safe published schedules in ${lang}`, async () => {
    const context = await app("player", `https://kansaiunited.com/admin/?lang=${lang}`, options("player", { mobile: true }), {
      players: [{ id: "other-player", internal_name: "NEVER private roster", private_notes: "NEVER private notes" }],
      articles: [{ id: "private-news", title: "NEVER draft news", status: "draft" }],
      audit_logs: [{ id: 1, actor_real_name: "NEVER audit actor" }],
      published_schedule: [{ resource: "fixtures", id: "public-match", title: "Safe approved match",
        starts_at: "2099-10-18T04:00:00Z", ends_at: "2099-10-18T06:00:00Z", venue: "Public ground", schedule_status: "scheduled", description: "Public match information" }],
    });
    try {
      await login(context.window);
      const document = context.window.document;
      assert.equal(document.documentElement.lang, lang);
      await eventually(() => !document.querySelector(".office-player-portal")?.hasAttribute("aria-busy"));
      assert.deepEqual(navigation(document), identityEnabled ? ["player_portal", "staff_account"] : ["player_portal"]);
      assert.equal(document.querySelectorAll(".admin-stat,.office-activity-list,.office-required-copy").length, 0);
      assert.ok(document.querySelector(".office-player-portal").textContent.includes("Safe public name"));
      assert.ok(document.querySelector(".office-player-portal").textContent.includes("Safe approved match"));
      assert.equal(document.querySelector("#new-button").hidden, true);
      assert.equal(document.querySelector("#publication-status").hidden, true);
      assert.doesNotMatch(document.querySelector("#admin-content").textContent, /NEVER/);
      const rest = context.requests.filter(request => new URL(request.url).pathname.startsWith("/rest/v1/"));
      const allowed = new Set(["admin_roles", "office_capabilities", "office_player_portal", "published_schedule", ...(identityEnabled ? ["office_account_state"] : [])]);
      assert.ok(rest.some(request => route(request) === "office_player_portal"));
      assert.ok(rest.every(request => allowed.has(route(request))), rest.map(route).join(","));
      assert.equal(rest.some(request => request.method === "HEAD"), false, "player must not fetch private aggregate counts");
      assert.equal(context.requests.some(request => new URL(request.url).pathname.endsWith("/build.json")), false);
      const scheduleRequest = rest.find(request => route(request) === "published_schedule");
      assert.equal(new URL(scheduleRequest.url).searchParams.get("select"), "resource,id,title,starts_at,ends_at,venue,schedule_status,description");
    } finally { await dispose(context); }
  });
}

test("unlinked Player is never offered a fabricated player record or roster editor", async () => {
  const context = await app("player", undefined, options("player", {
    rpc(name) { return name === "office_player_portal" ? { ...portal, player_id: null, linked: false, player: null } : []; },
  }));
  try {
    await login(context.window);
    const document = context.window.document;
    await eventually(() => !document.querySelector(".office-player-portal")?.hasAttribute("aria-busy"));
    assert.match(document.querySelector(".office-player-portal").textContent, /紐付けられていません/);
    assert.equal(document.querySelector('[data-resource="players"]'), null);
    assert.equal(context.requests.some(request => ["POST", "PATCH", "DELETE"].includes(request.method) && !new URL(request.url).pathname.includes("/rpc/")), false);
  } finally { await dispose(context); }
});

test("a player portal reply with a different account UUID is never rendered", async () => {
  const context = await app("player", undefined, options("player", {
    rpc(name) { return name === "office_player_portal" ? { ...portal, user_id: playerId, real_name: "NEVER different account" } : []; },
  }));
  try {
    await login(context.window);
    const document = context.window.document;
    await eventually(() => !document.querySelector(".office-player-portal")?.hasAttribute("aria-busy"));
    assert.doesNotMatch(document.querySelector("#admin-content").textContent, /Safe public name|NEVER different account/);
    assert.match(document.querySelector("#admin-content").textContent, /取得できません/);
  } finally { await dispose(context); }
});

test("late Player portal response after logout cannot restore the previous person's data", async () => {
  let settle;
  let requested = false;
  const pending = new Promise(resolve => { settle = resolve; });
  const context = await app("player", undefined, options("player", {
    rpc(name) { if (name === "office_player_portal") { requested = true; return pending; } return []; },
  }));
  try {
    await login(context.window);
    await eventually(() => requested);
    const document = context.window.document;
    document.querySelector("#logout-button").click();
    await eventually(() => document.querySelector("#workspace").hidden);
    settle(portal);
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(document.querySelector("#admin-content").children.length, 0);
    assert.equal(document.querySelector("#admin-navigation").children.length, 0);
    assert.equal(document.querySelector("#account-email").textContent, "");
  } finally { settle(portal); await dispose(context); }
});

test("an existing Owner session demoted to Player closes private editors and starts only the limited portal", { skip: !identityEnabled }, async () => {
  let state = account("owner");
  const context = await app("owner", undefined, options("owner", { accountState: () => state }));
  try {
    await login(context.window);
    const document = context.window.document;
    document.querySelector('[data-resource="articles"]').click();
    await eventually(() => Boolean(document.querySelector(".admin-list-row")));
    document.querySelector(".admin-list-row button").click();
    await eventually(() => document.querySelector("#editor-dialog").open);
    assert.ok(document.querySelector("#editor-fields").children.length);
    state = account("player");
    context.tables.admin_roles[0].role = "player";
    const before = context.requests.length;
    context.window.dispatchEvent(new context.window.Event("focus"));
    await eventually(() => Boolean(document.querySelector(".office-player-portal")) &&
      !document.querySelector(".office-player-portal").hasAttribute("aria-busy"));
    assert.deepEqual(navigation(document), ["player_portal", "staff_account"]);
    assert.equal(document.querySelector("#editor-dialog").open, false);
    assert.equal(document.querySelector("#editor-fields").children.length, 0);
    assert.equal(document.querySelectorAll(".admin-stat").length, 0);
    const allowed = new Set(["user", "office_account_state", "admin_roles", "office_capabilities", "office_player_portal", "published_schedule"]);
    assert.ok(context.requests.slice(before).every(request => allowed.has(route(request))),
      context.requests.slice(before).map(route).join(","));
  } finally { await dispose(context); }
});

for (const legacy of ["administrator", "editor", "coach"]) {
  test(`old ${legacy} response is normalized to Staff without acquiring Owner privileges`, async () => {
    const context = await app(legacy, undefined, options("staff", { rawLegacyRole: true,
      accountState: identityEnabled ? account(legacy) : undefined }));
    try {
      await login(context.window);
      const document = context.window.document;
      assert.ok(document.querySelector('[data-resource="articles"]'));
      assert.ok(document.querySelector('[data-resource="players"]'));
      assert.equal(document.querySelector('[data-resource="staff_applications"]'), null);
      assert.equal(document.querySelector('[data-resource="admin_roles"]'), null);
      assert.equal(document.querySelector("#account-role").textContent, "スタッフ");
    } finally { await dispose(context); }
  });
}
