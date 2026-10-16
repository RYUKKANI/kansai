import test from "node:test";
import assert from "node:assert/strict";
import { app, login, eventually, uid } from "./helpers/admin-app.mjs";

// 검토용 회귀 재현입니다. 실제 빌드된 관리자 코드와 SDK를 실행하고, 늦은 조회·업로드만
// 메모리에서 지연합니다. 운영 Supabase·사진·콘텐츠는 조회하거나 변경하지 않습니다.
test("a delayed ordinary content editor cannot reopen after logout", async () => {
  let hold = false;
  let waiting = false;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const context = await app("owner", undefined, {
    beforeRead: async (name) => {
      if (hold && name === "media_assets") {
        waiting = true;
        await pending;
      }
    },
  });
  try {
    await login(context.window);
    const document = context.window.document;
    document.querySelector('[data-resource="articles"]').click();
    await eventually(() => document.querySelector(".admin-list-row"));
    hold = true;
    document.querySelector(".admin-list-row button").click();
    await eventually(() => waiting);
    document.querySelector("#logout-button").click();
    await eventually(() => document.querySelector("#workspace").hidden);
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(document.querySelector("#editor-dialog").open, false);
    assert.equal(document.querySelector("#editor-fields").children.length, 0);
  } finally {
    release();
    context.dom.window.close();
  }
});

test("an upload from a closed media editor cannot replace the next editor's photo", async () => {
  let finishUpload;
  let uploadPath = "";
  const uploaded = new Promise((resolve) => { finishUpload = resolve; });
  const context = await app();
  const originalFetch = context.window.fetch;
  context.window.fetch = async (input, options) => {
    const url = String(input);
    const prefix = "/storage/v1/object/kansai-media/";
    if (url.includes(prefix)) {
      uploadPath = url.split(prefix)[1];
      await uploaded;
      return Response.json({ Key: "kansai-media/" + uploadPath });
    }
    return originalFetch(input, options);
  };
  try {
    await login(context.window);
    const window = context.window;
    const document = window.document;
    document.querySelector('[data-resource="media_assets"]').click();
    await eventually(() => document.querySelector(".admin-list"));
    document.querySelector("#new-button").click();
    await eventually(() => document.querySelector("#editor-dialog").open);
    // 이미지 코덱과 canvas는 브라우저 제공 기능만 대체하고 저장·업로드 처리는 실제 코드로 둡니다.
    window.createImageBitmap = async () => ({ width: 100, height: 100, close() {} });
    window.HTMLCanvasElement.prototype.getContext = () => ({ fillRect() {}, drawImage() {} });
    window.HTMLCanvasElement.prototype.toBlob = (callback) =>
      callback(new window.Blob(["test image"], { type: "image/jpeg" }));
    const input = document.querySelector('#editor-form input[type="file"]');
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [new window.File(["test image"], "old-photo.jpg", { type: "image/jpeg" })],
    });
    input.dispatchEvent(new window.Event("change", { bubbles: true }));
    await eventually(() => Boolean(uploadPath));
    assert.match(uploadPath, new RegExp("^" + uid + "/"));
    document.querySelector("#editor-close").click();
    await eventually(() => !document.querySelector("#editor-dialog").open);
    document.querySelector("#new-button").click();
    await eventually(() => document.querySelector("#editor-dialog").open);
    const currentStorage = document.querySelector("#field-storage_path");
    assert.equal(currentStorage.value, "");
    finishUpload();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(document.querySelector("#field-storage_path"), currentStorage);
    assert.equal(currentStorage.value, "");
    assert.equal(
      document.querySelector("#editor-notice").textContent.includes("アップロードしました"),
      false,
    );
  } finally {
    finishUpload();
    context.dom.window.close();
  }
});

test("saving another draft field preserves an unavailable gallery photo until it is explicitly removed", async () => {
  const path = "assets/withdrawn-photo.jpg";
  const article = {
    id: "draft-with-photo",
    slug: "draft-with-photo",
    title: "Existing draft",
    summary: "Existing summary",
    body: "Existing body",
    category: "club",
    cover_alt: "Existing photo description",
    gallery_paths: [path],
    status: "draft",
    updated_at: "2026-10-01T00:00:00Z",
    published_at: null,
  };
  const context = await app("owner", undefined, {}, {
    articles: [article],
    media_assets: [{
      id: "withdrawn-photo",
      kind: "photo",
      title: "Withdrawn photo",
      legacy_path: path,
      storage_path: null,
      album_id: null,
      status: "draft",
      public_approved: false,
      updated_at: "2026-10-01T00:00:00Z",
    }],
  });
  try {
    await login(context.window);
    const document = context.window.document;
    document.querySelector('[data-resource="articles"]').click();
    await eventually(() => document.querySelector(".admin-list-row"));
    document.querySelector(".admin-list-row button").click();
    await eventually(() => document.querySelector("#editor-dialog").open);
    document.querySelector("#field-title").value = "Changed title only";
    document.querySelector('[data-save-status="draft"]').click();
    await eventually(() => !document.querySelector("#editor-dialog").open);
    assert.equal(context.tables.articles[0].title, "Changed title only");
    assert.deepEqual(context.tables.articles[0].gallery_paths, [path]);
    await eventually(() => document.querySelector(".admin-list-row"));
    document.querySelector(".admin-list-row button").click();
    await eventually(() => document.querySelector("#editor-dialog").open);
    const existing = document.querySelector('[name="gallery_paths"]');
    assert.equal(existing.checked, true);
    existing.click();
    document.querySelector('[data-save-status="draft"]').click();
    await eventually(() => !document.querySelector("#editor-dialog").open);
    assert.deepEqual(context.tables.articles[0].gallery_paths, []);
  } finally {
    context.dom.window.close();
  }
});

test("a media draft waits for its own pending upload before it can be saved", async () => {
  let release;
  let waiting = false;
  const uploaded = new Promise((resolve) => { release = resolve; });
  const context = await app();
  const originalFetch = context.window.fetch;
  context.window.fetch = async (input, options) => {
    if (String(input).includes("/storage/v1/object/kansai-media/")) {
      waiting = true;
      await uploaded;
      return Response.json({ Key: "kansai-media/test-image.jpg" });
    }
    return originalFetch(input, options);
  };
  try {
    await login(context.window);
    const window = context.window;
    const document = window.document;
    document.querySelector('[data-resource="media_assets"]').click();
    await eventually(() => document.querySelector(".admin-list"));
    document.querySelector("#new-button").click();
    await eventually(() => document.querySelector("#editor-dialog").open);
    document.querySelector("#field-title").value = "A test photo";
    document.querySelector("#field-alt_text").value = "A test photo description";
    window.createImageBitmap = async () => ({ width: 100, height: 100, close() {} });
    window.HTMLCanvasElement.prototype.getContext = () => ({ fillRect() {}, drawImage() {} });
    window.HTMLCanvasElement.prototype.toBlob = (callback) =>
      callback(new window.Blob(["test image"], { type: "image/jpeg" }));
    const input = document.querySelector('#editor-form input[type="file"]');
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [new window.File(["test image"], "test.jpg", { type: "image/jpeg" })],
    });
    input.dispatchEvent(new window.Event("change", { bubbles: true }));
    await eventually(() => waiting);
    const submit = () => document.querySelector("#editor-form").dispatchEvent(
      new window.SubmitEvent("submit", {
        bubbles: true,
        cancelable: true,
        submitter: document.querySelector('[data-save-status="draft"]'),
      }),
    );
    submit();
    await eventually(() => !document.querySelector("#editor-form").inert);
    assert.equal(context.tables.media_assets.length, 0);
    assert.equal(document.querySelector("#editor-dialog").open, true);
    assert.match(document.querySelector("#editor-notice").textContent, /アップロードしています/);
    release();
    await eventually(() => Boolean(document.querySelector("#field-storage_path").value));
    submit();
    await eventually(() => context.tables.media_assets.length === 1);
    assert.match(context.tables.media_assets[0].storage_path, new RegExp("^" + uid + "/"));
  } finally {
    release();
    context.dom.window.close();
  }
});

for (const resource of ["fixtures", "club_events"]) {
  test("a concurrent " + resource + " edit cannot overwrite another operator's committed changes", async () => {
    const field = resource === "fixtures" ? "opponent" : "title";
    const row = {
      id: "concurrent-" + resource,
      [field]: "Initial title",
      venue: "Initial venue",
      kickoff_at: "2027-01-01T10:00:00Z",
      starts_at: "2027-01-01T10:00:00Z",
      match_status: "scheduled",
      session_status: "scheduled",
      status: "draft",
      is_public: false,
      updated_at: "2026-10-01T00:00:00Z",
    };
    const context = await app("owner", undefined, { schedule: true }, { [resource]: [row] });
    const original = context.window.fetch;
    context.window.fetch = async (input, options = {}) => {
      const url = new URL(String(input));
      if (options.method === "PATCH" && url.pathname.endsWith("/" + resource)) {
        const expected = url.searchParams.get("updated_at");
        // 실제 PostgREST처럼 일치하는 행이 없는 UPDATE + .single()은 406을 반환합니다.
        if (expected && expected !== "eq." + context.tables[resource][0].updated_at)
          return Response.json({ code: "PGRST116", message: "The result contains 0 rows" }, { status: 406 });
      }
      return original(input, options);
    };
    try {
      await login(context.window);
      const document = context.window.document;
      document.querySelector('[data-resource="' + resource + '"]').click();
      await eventually(() => document.querySelector(".admin-list-row"));
      document.querySelector(".admin-list-row button").click();
      await eventually(() => document.querySelector("#editor-dialog").open);
      document.querySelector("#field-venue").value = "Second operator venue";
      context.tables[resource][0][field] = "First operator saved title";
      context.tables[resource][0].updated_at = "2026-10-01T00:00:01Z";
      const save = document.querySelector('[data-save-status="draft"]') ??
        document.querySelector('#editor-actions button[type="submit"]');
      document.querySelector("#editor-form").dispatchEvent(new context.window.SubmitEvent("submit", {
        bubbles: true, cancelable: true, submitter: save,
      }));
      await eventually(() => !document.querySelector("#editor-form").inert);
      assert.equal(context.tables[resource][0][field], "First operator saved title");
      assert.equal(context.tables[resource][0].venue, "Initial venue");
      assert.equal(document.querySelector("#editor-dialog").open, true);
      assert.equal(document.querySelector("#workspace").hidden, false);
      assert.match(document.querySelector("#editor-notice").textContent, /ほかの操作で内容が更新/);
      assert.equal(document.querySelector("#admin-notice").dataset.error, "true");
    } finally {
      context.dom.window.close();
    }
  });
}

test("a record without its expected update timestamp cannot be submitted as an unchecked replacement", async () => {
  const context = await app("owner", undefined, {}, {
    fixtures: [{ id: "missing-version", opponent: "Original opponent", match_status: "scheduled", status: "draft", updated_at: null }],
  });
  try {
    await login(context.window);
    const document = context.window.document;
    document.querySelector('[data-resource="fixtures"]').click();
    await eventually(() => document.querySelector(".admin-list-row"));
    document.querySelector(".admin-list-row button").click();
    await eventually(() => document.querySelector("#editor-dialog").open);
    document.querySelector("#field-opponent").value = "New opponent";
    document.querySelector("#editor-form").dispatchEvent(new context.window.SubmitEvent("submit", {
      bubbles: true, cancelable: true, submitter: document.querySelector('[data-save-status="draft"]'),
    }));
    await eventually(() => !document.querySelector("#editor-form").inert);
    assert.equal(context.requests.some((request) => request.method === "PATCH" && request.url.includes("/fixtures")), false);
    assert.equal(context.tables.fixtures[0].opponent, "Original opponent");
    assert.equal(document.querySelector("#editor-dialog").open, true);
    assert.match(document.querySelector("#editor-notice").textContent, /ほかの操作で内容が更新/);
  } finally {
    context.dom.window.close();
  }
});

test("a direct update permission error is not relabeled as a concurrent edit", async () => {
  const context = await app("owner", undefined, {}, {
    fixtures: [{ id: "denied-update", opponent: "Original opponent", match_status: "scheduled", status: "draft", updated_at: "2026-10-01T00:00:00Z" }],
  });
  const original = context.window.fetch;
  context.window.fetch = async (input, options = {}) =>
    options.method === "PATCH" && String(input).includes("/fixtures")
      ? Response.json({ code: "42501", message: "permission denied" }, { status: 403 })
      : original(input, options);
  try {
    await login(context.window);
    const document = context.window.document;
    document.querySelector('[data-resource="fixtures"]').click();
    await eventually(() => document.querySelector(".admin-list-row"));
    document.querySelector(".admin-list-row button").click();
    await eventually(() => document.querySelector("#editor-dialog").open);
    document.querySelector("#editor-form").dispatchEvent(new context.window.SubmitEvent("submit", {
      bubbles: true, cancelable: true, submitter: document.querySelector('[data-save-status="draft"]'),
    }));
    await eventually(() => !document.querySelector("#editor-form").inert);
    assert.match(document.querySelector("#admin-notice").textContent, /必要な権限がありません/);
    assert.doesNotMatch(document.querySelector("#admin-notice").textContent, /ほかの操作で内容が更新/);
    assert.equal(context.tables.fixtures[0].opponent, "Original opponent");
  } finally {
    context.dom.window.close();
  }
});
