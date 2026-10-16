import test from "node:test";
import assert from "node:assert/strict";
import { app, login, eventually, uid } from "./helpers/admin-app.mjs";

// 실제 빌드·SDK로 오래 걸리는 이전 저장/복원과 새 세션을 교차시킵니다. 운영 자료는 사용하지 않습니다.
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 45));
async function openArticle(context) {
  const document = context.window.document;
  document.querySelector('[data-resource="articles"]').click();
  await eventually(() => Boolean(document.querySelector(".admin-list-row button")));
  document.querySelector(".admin-list-row button").click();
  await eventually(() => document.querySelector("#editor-dialog").open && Boolean(document.querySelector("#field-title")));
  return document.querySelector("#editor-form");
}
async function relogin(context) {
  context.window.document.querySelector("#logout-button").click();
  await eventually(() => context.window.document.querySelector("#workspace").hidden);
  await login(context.window);
}
function submit(context) {
  const document = context.window.document;
  document.querySelector("#editor-form").dispatchEvent(new context.window.SubmitEvent("submit", {
    bubbles: true, cancelable: true, submitter: document.querySelector('[data-save-status="draft"]'),
  }));
}
function clickText(document, text) {
  const button = [...document.querySelectorAll("button")].find(button => button.textContent === text);
  assert.ok(button, text);
  button.click();
}
const revisions = [{ id: "test-revision", title: "Older test revision", captured_at: "2026-10-01T00:00:00Z", actor_role: "editor", reason: "update" }];

test("a pending old save cannot keep the next session locked or unlock its new save", async () => {
  const first = deferred(), second = deferred();
  let saves = 0;
  const context = await app("owner", undefined, {
    content: true,
    rpc(name) {
      if (name === "save_office_content") return (++saves === 1 ? first : second).promise;
      return { revisions: [] };
    },
  });
  try {
    await login(context.window);
    let form = await openArticle(context);
    const document = context.window.document;
    submit(context);
    await eventually(() => saves === 1);
    assert.equal(form.inert, true);
    await relogin(context);
    form = await openArticle(context);
    assert.equal(form.inert, false, "a previous session's pending save must not lock the new editor");
    assert.equal(form.hasAttribute("aria-busy"), false);
    submit(context);
    await eventually(() => saves === 2);
    assert.equal(form.inert, true);
    first.resolve({ id: "article-1" });
    await settle();
    assert.equal(form.inert, true, "the old finally must not release the new save's lock");
    assert.equal(form.getAttribute("aria-busy"), "true");
    assert.equal(document.querySelector("#editor-dialog").open, true);
    second.resolve({ id: "article-1" });
    await eventually(() => !document.querySelector("#editor-dialog").open && !form.inert);
    assert.equal(form.hasAttribute("aria-busy"), false);
  } finally { first.resolve({}); second.resolve({}); context.dom.window.close(); }
});

for (const outcome of ["success", "error"]) {
  test(`a disposed revision restore ${outcome} cannot change the next session's editor, draft or notice`, async () => {
    const pending = deferred();
    let requested = false;
    const context = await app("owner", undefined, {
      content: true,
      rpc(name) {
        if (name === "restore_content_revision") { requested = true; return pending.promise; }
        return { revisions };
      },
    });
    try {
      await login(context.window);
      await openArticle(context);
      const document = context.window.document;
      await eventually(() => Boolean(document.querySelector(".office-revision")));
      clickText(document, "この版を下書きに復元");
      clickText(document, "復元を確定");
      await eventually(() => requested);
      await relogin(context);
      await openArticle(context);
      const newField = document.querySelector("#field-title");
      newField.value = "New independent draft";
      newField.dispatchEvent(new context.window.Event("input", { bubbles: true }));
      context.window.dispatchEvent(new context.window.Event("beforeunload", { cancelable: true }));
      const draftKey = "kansai-office-draft:" + uid + ":articles:article-1";
      const newDraft = context.window.localStorage.getItem(draftKey);
      assert.ok(newDraft?.includes("New independent draft"));
      const noticeBefore = document.querySelector("#admin-notice").textContent;
      pending.resolve(outcome === "success"
        ? { ...context.tables.articles[0], title: "Late old revision", updated_at: "2026-10-16T01:00:00Z" }
        : Response.json({ code: "42501", message: "permission denied" }, { status: 403 }));
      await settle();
      assert.equal(document.querySelector("#field-title"), newField,
        "an old revision response must not rebuild the current editor");
      assert.equal(newField.value, "New independent draft");
      assert.equal(context.window.localStorage.getItem(draftKey), newDraft,
        "a disposed restore must not clear a newly written draft with the same account key");
      assert.equal(document.querySelector("#admin-notice").textContent, noticeBefore,
        "old success or permission errors must not appear in the new session");
    } finally { pending.resolve({}); context.dom.window.close(); }
  });
}
