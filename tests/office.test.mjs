import test from "node:test";
import assert from "node:assert/strict";
import { app, login, eventually, uid } from "./helpers/admin-app.mjs";

// 검증 데이터는 메모리의 응답에만 사용합니다. 운영 DB·실제 선수 명부에 기록하지 않습니다.
const now = new Date().toISOString();
const future = new Date(Date.now() + 86400000).toISOString();
const past = new Date(Date.now() - 86400000).toISOString();
const article = (id, status, category = "club") => ({
  id,
  slug: id,
  title: "検証用 " + id,
  summary: "検証用の概要",
  body: "本文",
  category,
  cover_alt: "検証画像",
  gallery_paths: [],
  status,
  updated_at: now,
  published_at: status === "published" ? past : null,
});
const playerId = "00000000-0000-4000-8000-000000000002";
const data = {
  articles: [
    article("published-news", "published"),
    article("draft-news", "draft"),
    article("pending-news", "pending"),
  ],
  players: [
    {
      id: playerId,
      internal_name: "検証用選手A",
      activity_status: "active",
      profile_consent: false,
      photo_consent: false,
      updated_at: now,
    },
    {
      id: "00000000-0000-4000-8000-000000000003",
      internal_name: "検証用選手B",
      activity_status: "inactive",
      profile_consent: false,
      photo_consent: false,
      updated_at: now,
    },
  ],
  public_player_profiles: [
    {
      player_id: playerId,
      slug: "test-player",
      display_name: "検証用プロフィール",
      position: "MF",
      jersey_number: 8,
      photo_path: null,
      status: "pending",
      activity_status: "active",
      updated_at: now,
    },
  ],
  fixtures: [
    {
      id: "future-match",
      opponent: "検証用対戦相手",
      kickoff_at: future,
      match_status: "scheduled",
      status: "draft",
      venue: "検証用会場",
      updated_at: now,
    },
    {
      id: "cancelled-match",
      opponent: "中止の検証",
      kickoff_at: future,
      match_status: "cancelled",
      status: "draft",
      updated_at: now,
    },
    {
      id: "past-match",
      opponent: "過去の検証",
      kickoff_at: past,
      match_status: "scheduled",
      status: "draft",
      updated_at: now,
    },
    {
      id: "undated-match",
      opponent: "未定の検証",
      kickoff_at: null,
      match_status: "scheduled",
      status: "draft",
      updated_at: now,
    },
  ],
  training_sessions: [
    {
      id: "future-training",
      title: "検証用練習",
      starts_at: future,
      session_status: "scheduled",
      venue: "検証用練習場",
      updated_at: now,
    },
    {
      id: "completed-training",
      title: "終了の検証",
      starts_at: future,
      session_status: "completed",
      updated_at: now,
    },
  ],
  audit_logs: [
    {
      id: 2,
      actor_id: uid,
      actor_role: "owner",
      entity: "articles",
      record_id: "published-news",
      operation: "UPDATE",
      occurred_at: now,
    },
    {
      id: 1,
      actor_id: uid,
      actor_role: "owner",
      entity: "articles",
      record_id: "published-news",
      operation: "INSERT",
      occurred_at: past,
    },
  ],
};
function navigate(window, resource) {
  window.document.querySelector('[data-resource="' + resource + '"]').click();
}
async function listReady(window, resource) {
  await eventually(
    () =>
      window.document
        .querySelector('[data-resource="' + resource + '"]')
        ?.getAttribute("aria-current") === "page" &&
      window.document.querySelector(".office-table-scroll") &&
      !window.document
        .querySelector(".office-table-scroll")
        .hasAttribute("aria-busy"),
  );
}
test("dashboard counts real statuses, separates internal players and exposes permitted work", async () => {
  const { dom, window, requests } = await app("owner", undefined, {}, data);
  try {
    await login(window);
    const doc = window.document;
    assert.deepEqual(
      [...doc.querySelectorAll(".admin-stat strong")].map((node) =>
        Number(node.textContent),
      ),
      [1, 2, 2, 2],
    );
    assert.deepEqual(
      [...doc.querySelectorAll(".office-nav-group > p")].map(
        (node) => node.textContent,
      ),
      ["OVERVIEW", "CONTENT", "TEAM", "OPERATIONS", "SYSTEM"],
    );
    assert.equal(doc.querySelectorAll("[data-quick-action]").length, 4);
    assert.equal(doc.querySelectorAll(".office-schedule-row").length, 2);
    assert.ok(
      doc
        .querySelector(".office-required-copy")
        .textContent.includes("承認待ち"),
    );
    assert.ok(
      doc
        .querySelector(".office-activity-list")
        .textContent.includes("検証用 published-news"),
    );
    assert.ok(
      doc.querySelector(".office-activity-list").textContent.includes("を更新"),
    );
    assert.equal(
      doc.querySelector(".office-activity-list").textContent.includes("UPDATE"),
      false,
    );
    doc.querySelector(".admin-stat").click();
    await listReady(window, "articles");
    assert.equal(doc.querySelectorAll(".admin-list-row").length, 1);
    assert.equal(doc.querySelector('select[name="status"]').value, "published");
    assert.ok(
      requests.some(
        (request) =>
          new URL(request.url).searchParams.get("status") === "eq.published",
      ),
    );
  } finally {
    dom.window.close();
  }
});
test("all nine existing resource views retain edit and registration forms", async () => {
  const { dom, window } = await app("owner", undefined, {}, data);
  try {
    await login(window);
    const doc = window.document;
    for (const resource of [
      "articles",
      "players",
      "public_player_profiles",
      "fixtures",
      "training_sessions",
      "media_albums",
      "media_assets",
      "site_pages",
      "admin_roles",
    ]) {
      navigate(window, resource);
      await listReady(window, resource);
      assert.ok(doc.querySelector(".office-toolbar"));
      if (resource === "admin_roles") {
        doc.querySelector(".admin-list-row button").click();
        await eventually(() => doc.querySelector("#editor-dialog").open);
        assert.ok(doc.querySelector("#field-role"));
        assert.ok(doc.querySelector("#field-active"));
      } else {
        doc.querySelector("#new-button").click();
        await eventually(
          () =>
            doc.querySelector("#editor-dialog").open &&
            doc.querySelectorAll(".office-field-group").length > 0,
        );
        assert.ok(doc.querySelector('#editor-actions button[type="submit"]'));
      }
      doc.querySelector("#editor-close").click();
      assert.equal(doc.querySelector("#editor-dialog").open, false);
    }
  } finally {
    dom.window.close();
  }
});
test("news search covers all pages and category filter keeps the entered search", async () => {
  const rows = Array.from({ length: 55 }, (_, index) =>
    article("ordinary-" + index, "published"),
  );
  rows.push(
    {
      ...article("candidate-training", "pending", "training"),
      title: "Candidate Training",
    },
    {
      ...article("candidate-match", "pending", "match"),
      title: "Candidate Match",
    },
  );
  const { dom, window, requests } = await app(
    "owner",
    undefined,
    {},
    { articles: rows },
  );
  try {
    await login(window);
    navigate(window, "articles");
    await listReady(window, "articles");
    const doc = window.document;
    assert.equal(doc.querySelectorAll(".admin-list-row").length, 50);
    const search = doc.querySelector('.office-toolbar input[name="search"]');
    search.value = "Candidate";
    doc
      .querySelector(".office-toolbar")
      .dispatchEvent(
        new window.Event("submit", { bubbles: true, cancelable: true }),
      );
    await eventually(
      () => doc.querySelectorAll(".admin-list-row").length === 2,
    );
    const category = doc.querySelector('select[name="category"]');
    category.value = "match";
    category.dispatchEvent(new window.Event("change", { bubbles: true }));
    await eventually(
      () => doc.querySelectorAll(".admin-list-row").length === 1,
    );
    assert.equal(search.value, "Candidate");
    assert.ok(
      doc
        .querySelector(".admin-list-row")
        .textContent.includes("Candidate Match"),
    );
    assert.ok(
      requests.some(
        (request) =>
          new URL(request.url).searchParams.get("title") ===
          "ilike.%Candidate%",
      ),
    );
    assert.ok(
      requests.some(
        (request) =>
          new URL(request.url).searchParams.get("category") === "eq.match",
      ),
    );
  } finally {
    dom.window.close();
  }
});
test("news preview is safe and unsaved changes can be continued or discarded", async () => {
  const { dom, window, requests } = await app();
  try {
    await login(window);
    navigate(window, "articles");
    await listReady(window, "articles");
    const doc = window.document;
    doc.querySelector(".admin-list-row button").click();
    await eventually(() => doc.querySelector("#editor-dialog").open);
    const title = doc.querySelector("#field-title");
    title.value = "<img src=x onerror=alert(1)>";
    title.dispatchEvent(new window.Event("input", { bubbles: true }));
    doc.querySelector("#editor-preview-actions button").click();
    await eventually(() => doc.querySelector("#article-preview-dialog").open);
    assert.equal(
      doc.querySelector("#article-preview-content h1").textContent,
      title.value,
    );
    assert.equal(doc.querySelector("#article-preview-content img"), null);
    doc.querySelector("#preview-close").click();
    doc.querySelector("#editor-close").click();
    assert.equal(doc.querySelector("#unsaved-dialog").open, true);
    doc.querySelector("#unsaved-continue").click();
    assert.equal(doc.querySelector("#editor-dialog").open, true);
    assert.equal(title.value, "<img src=x onerror=alert(1)>");
    doc.querySelector("#editor-close").click();
    doc.querySelector("#unsaved-discard").click();
    assert.equal(doc.querySelector("#editor-dialog").open, false);
    assert.equal(
      requests.some(
        (request) =>
          ["POST", "PATCH"].includes(request.method) &&
          request.url.includes("/rest/v1/") &&
          !request.url.includes("/rpc/office_capabilities"),
      ),
      false,
    );
  } finally {
    dom.window.close();
  }
});
test("missing player consent blocks publish UI while internal and public registrations stay distinct", async () => {
  const { dom, window } = await app("owner", undefined, {}, data);
  try {
    await login(window);
    navigate(window, "players");
    await listReady(window, "players");
    const doc = window.document;
    assert.ok(
      doc.querySelector(".office-table").textContent.includes("内部の選手登録"),
    );
    assert.ok(
      doc.querySelector(".office-table").textContent.includes("MF / 8"),
    );
    navigate(window, "public_player_profiles");
    await listReady(window, "public_player_profiles");
    doc.querySelector(".admin-list-row button").click();
    await eventually(() => doc.querySelector("#editor-dialog").open);
    assert.equal(doc.querySelector("#field-player_id").disabled, true);
    assert.equal(
      doc.querySelector('[data-save-status="published"]').disabled,
      true,
    );
    assert.ok(
      doc
        .querySelector("#profile-consent-state")
        .textContent.includes("公開同意が必要"),
    );
    assert.equal(doc.querySelector("#field-internal_name"), null);
  } finally {
    dom.window.close();
  }
});
test("month calendar uses JST and editing does not fabricate an undated fixture", async () => {
  const month = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
  }).format(new Date());
  const fixture = {
    id: "jst-fixture",
    opponent: "JST検証",
    kickoff_at: month + "-01T16:00:00Z",
    match_status: "scheduled",
    status: "draft",
    updated_at: now,
  };
  const { dom, window, requests } = await app(
    "owner",
    undefined,
    {},
    { fixtures: [fixture, data.fixtures[3]] },
  );
  try {
    await login(window);
    navigate(window, "fixtures");
    await listReady(window, "fixtures");
    const doc = window.document;
    doc.querySelector('[data-view="calendar"]').click();
    await eventually(() => doc.querySelector(".office-calendar-grid"));
    assert.equal(doc.querySelectorAll(".office-calendar-event").length, 1);
    assert.ok(
      doc
        .querySelector(".office-calendar-event")
        .textContent.includes("01:00 JST検証"),
    );
    assert.ok(
      doc
        .querySelector(".office-calendar-note")
        .textContent.includes("日時未定"),
    );
    const request = requests.findLast((item) =>
      item.url.includes("/rest/v1/fixtures"),
    );
    assert.equal(
      new URL(request.url).searchParams.get("kickoff_at"),
      "gte." + new Date(month + "-01T00:00:00+09:00").toISOString(),
    );
    doc.querySelector(".office-calendar-event").click();
    await eventually(() => doc.querySelector("#editor-dialog").open);
    assert.equal(
      doc.querySelector("#field-kickoff_at").value,
      month + "-02T01:00",
    );
  } finally {
    dom.window.close();
  }
});
test("mobile drawer, Escape and desktop collapse expose accurate accessibility state", async () => {
  const { dom, window } = await app("owner", undefined, { mobile: true });
  try {
    await login(window);
    const doc = window.document;
    assert.equal(doc.querySelector("#admin-sidebar").inert, true);
    doc.querySelector("#sidebar-open").click();
    assert.equal(doc.querySelector("#admin-sidebar").inert, false);
    assert.equal(
      doc.querySelector("#sidebar-open").getAttribute("aria-expanded"),
      "true",
    );
    doc.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    assert.equal(doc.querySelector("#admin-sidebar").inert, true);
    assert.equal(
      doc.querySelector("#sidebar-open").getAttribute("aria-expanded"),
      "false",
    );
    assert.equal(doc.activeElement.id, "sidebar-open");
    doc.querySelector("#sidebar-collapse").click();
    assert.equal(doc.body.dataset.sidebarCollapsed, "true");
    assert.equal(
      doc.querySelector("#sidebar-collapse").getAttribute("aria-expanded"),
      "false",
    );
  } finally {
    dom.window.close();
  }
});
test("late search response cannot overwrite the newest results", async () => {
  const { dom, window } = await app(
    "owner",
    undefined,
    {
      beforeRead: async (name, url) => {
        if (
          name === "articles" &&
          url.searchParams.get("title")?.includes("Slow")
        )
          await new Promise((resolve) => setTimeout(resolve, 150));
      },
    },
    {
      articles: [
        { ...article("slow", "published"), title: "Slow result" },
        { ...article("fast", "published"), title: "Fast result" },
      ],
    },
  );
  try {
    await login(window);
    navigate(window, "articles");
    await listReady(window, "articles");
    const doc = window.document;
    const search = doc.querySelector('input[name="search"]');
    search.value = "Slow";
    doc
      .querySelector(".office-toolbar")
      .dispatchEvent(new window.Event("submit", { cancelable: true }));
    search.value = "Fast";
    doc
      .querySelector(".office-toolbar")
      .dispatchEvent(new window.Event("submit", { cancelable: true }));
    await eventually(
      () =>
        doc.querySelectorAll(".admin-list-row").length === 1 &&
        doc
          .querySelector(".admin-list-row")
          .textContent.includes("Fast result"),
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok(
      doc.querySelector(".admin-list-row").textContent.includes("Fast result"),
    );
  } finally {
    dom.window.close();
  }
});
