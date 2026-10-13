import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { app, login, eventually, uid } from "./helpers/admin-app.mjs";
const compiled = await build({
  entryPoints: ["src/lib/content-drafts.ts"],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
});
const { draftKey, readDraft, writeDraft, clearUserDrafts } = await import(
  "data:text/javascript;base64," +
    Buffer.from(compiled.outputFiles[0].text).toString("base64")
);
function memoryStorage() {
  const values = new Map();
  return {
    get length() {
      return values.size;
    },
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    key: (i) => [...values.keys()][i] ?? null,
  };
}
test("local drafts are scoped to user and document, expire and reject damaged data", () => {
  const storage = memoryStorage();
  const a = draftKey("a", "articles", "one"),
    b = draftKey("b", "articles", "one"),
    c = draftKey("a", "articles", "two");
  writeDraft(storage, a, {
    savedAt: 1000,
    expected: null,
    values: [["title", "A"]],
  });
  writeDraft(storage, b, {
    savedAt: 1000,
    expected: null,
    values: [["title", "B"]],
  });
  assert.equal(readDraft(storage, a, 1001).values[0][1], "A");
  assert.equal(readDraft(storage, c, 1001), null);
  clearUserDrafts(storage, "a");
  assert.equal(storage.getItem(a), null);
  assert.notEqual(storage.getItem(b), null);
  assert.equal(readDraft(storage, b, 8 * 86400000), null);
  storage.setItem(a, '{"values":"invalid"}');
  assert.equal(readDraft(storage, a), null);
  assert.throws(() =>
    writeDraft(storage, a, {
      savedAt: 1000,
      expected: null,
      values: [["body", "x".repeat(2_000_001)]],
    }),
  );
});
const clickText = (document, text) => {
  const button = [...document.querySelectorAll("button")].find(
    (button) => button.textContent.trim() === text,
  );
  assert.ok(button, "Missing button: " + text);
  button.click();
};
const article = {
  id: "10000000-0000-4000-8000-000000000001",
  slug: "test-article",
  title: "Test title",
  summary: "Summary",
  body: "Body",
  category: "club",
  cover_path: null,
  cover_alt: "Alt",
  gallery_paths: [],
  status: "draft",
  published_at: null,
  updated_at: "2026-10-01T00:00:00Z",
};
test("browser autosave is clearly local and logout clears the account drafts", async () => {
  const context = await app("owner", undefined, {
    content: true,
    rpc: () => ({ revisions: [] }),
  });
  try {
    await login(context.window);
    const document = context.window.document;
    document.querySelector('[data-resource="articles"]').click();
    await eventually(
      () =>
        document.querySelector("#resource-title").textContent === "ニュース",
    );
    document.querySelector("#new-button").click();
    await eventually(() => document.querySelector(".office-content-tools"));
    const title = document.querySelector("#field-title");
    title.value = "Unsaved local title";
    title.dispatchEvent(new context.window.Event("input", { bubbles: true }));
    const key = draftKey(uid, "articles", null);
    await eventually(() => context.window.localStorage.getItem(key));
    assert.match(
      document.querySelector(".office-content-tools").textContent,
      /サーバー未送信/,
    );
    assert.equal(
      context.requests.some((request) =>
        request.url.includes("/rpc/save_office_content"),
      ),
      false,
    );
    document.querySelector("#logout-button").click();
    await eventually(() => !document.querySelector("#login-panel").hidden);
    assert.equal(context.window.localStorage.getItem(key), null);
  } finally {
    context.dom.window.close();
  }
});
test("saved local draft is offered for explicit restore and booking sends JST timestamp", async () => {
  let booking;
  const context = await app("owner", undefined, {
    content: true,
    publisher: true,
    rpc: (name, payload) => {
      if (name === "save_office_content") {
        booking = payload;
        return { ...article, ...payload.p_values };
      }
      return { revisions: [] };
    },
  });
  try {
    context.window.localStorage.setItem(
      draftKey(uid, "articles", null),
      JSON.stringify({
        savedAt: Date.now(),
        expected: null,
        values: Object.entries({
          slug: "new-test",
          title: "Recovered title",
          summary: "Summary",
          body: "Body",
          category: "club",
          cover_alt: "Alt",
        }),
      }),
    );
    await login(context.window);
    const document = context.window.document;
    document.querySelector('[data-resource="articles"]').click();
    await eventually(
      () =>
        document.querySelector("#resource-title").textContent === "ニュース",
    );
    document.querySelector("#new-button").click();
    await eventually(() => document.querySelector(".office-draft-prompt"));
    assert.equal(document.querySelector("#field-title").value, "");
    clickText(document, "一時保存を編集画面に戻す");
    assert.equal(
      document.querySelector("#field-title").value,
      "Recovered title",
    );
    document.querySelector("#scheduled-publish-at").value = "2030-01-02T00:30";
    // 폼을 통과한 제출 이벤트와 SDK 요청 본문을 검사합니다. DB 조건은 별도 SQL 테스트가 담당합니다.
    const submitter = document.querySelector('[data-save-status="scheduled"]');
    document
      .querySelector("#editor-form")
      .dispatchEvent(
        new context.window.SubmitEvent("submit", {
          bubbles: true,
          cancelable: true,
          submitter,
        }),
      );
    await eventually(() => booking);
    assert.equal(booking.p_publish_at, "2030-01-01T15:30:00.000Z");
    assert.equal(booking.p_values.status, "draft");
    assert.equal(booking.p_values.title, "Recovered title");
    await eventually(() =>
      document
        .querySelector("#admin-notice")
        .textContent.includes("予約を保存"),
    );
    assert.equal(
      context.window.localStorage.getItem(draftKey(uid, "articles", null)),
      null,
    );
  } finally {
    context.dom.window.close();
  }
});
test("revision restore needs explicit confirmation and preserves draft state", async () => {
  let restored = false;
  const context = await app(
    "owner",
    undefined,
    {
      content: true,
      rpc: (name) => {
        if (name === "restore_content_revision") {
          restored = true;
          return {
            ...article,
            title: "Older version",
            updated_at: "2026-10-13T10:00:00Z",
          };
        }
        return {
          revisions: [
            {
              id: "revision-id",
              title: "Older version",
              captured_at: "2026-10-01T00:00:00Z",
              actor_role: "editor",
              reason: "update",
            },
          ],
        };
      },
    },
    { articles: [article] },
  );
  try {
    await login(context.window);
    const document = context.window.document;
    document.querySelector('[data-resource="articles"]').click();
    await eventually(() => document.querySelector(".admin-list"));
    await eventually(() =>
      [...document.querySelectorAll("button")].some((button) =>
        button.textContent.includes("編集"),
      ),
    );
    await eventually(() => document.querySelector(".admin-list-row button"));
    document.querySelector(".admin-list-row button").click();
    await eventually(() => document.querySelector(".office-revision"));
    clickText(document, "この版を下書きに復元");
    assert.equal(restored, false);
    clickText(document, "復元を確定");
    await eventually(() => restored);
    await eventually(
      () => document.querySelector("#field-title")?.value === "Older version",
    );
    assert.match(
      document.querySelector("#admin-notice").textContent,
      /下書きとして復元/,
    );
  } finally {
    context.dom.window.close();
  }
});
