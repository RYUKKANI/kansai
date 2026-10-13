import test from "node:test";
import assert from "node:assert/strict";
import { app, login, eventually, uid } from "./helpers/admin-app.mjs";
const stamp = "2026-10-01T00:00:00Z";
const player = {
  id: uid,
  internal_name: "Test internal",
  activity_status: "active",
  profile_consent: false,
  photo_consent: false,
  updated_at: stamp,
};
const photo = {
  id: "10000000-0000-4000-8000-000000000002",
  title: "Test photo",
  alt_text: "Test photo",
  kind: "photo",
  media_category: "player",
  status: "published",
  public_approved: true,
  published_at: stamp,
  updated_at: stamp,
  legacy_path: "assets/club-profile.jpg",
  album_id: null,
};
const profile = {
  player_id: uid,
  display_name: "Test public",
  romanized_name: "Test",
  position: "MF",
  jersey_number: 8,
  slug: "test-only",
  bio: "Test bio",
  status: "draft",
  activity_status: "active",
  display_order: 2,
  updated_at: stamp,
};
const set = (w, name, value) => {
  const field = w.document.querySelector(`[name="${name}"]`);
  assert.ok(field, name);
  field.value = value;
  field.dispatchEvent(new w.Event("input", { bubbles: true }));
  field.dispatchEvent(new w.Event("change", { bubbles: true }));
};
const tick = (w, name, checked) => {
  const field = w.document.querySelector(`[name="${name}"]`);
  field.checked = checked;
  field.dispatchEvent(new w.Event("change", { bubbles: true }));
};
async function open(ctx, existing = false) {
  await login(ctx.window);
  const d = ctx.window.document;
  d.querySelector('[data-resource="players"]').click();
  await eventually(() => d.querySelector(".admin-list"));
  if (existing) {
    await eventually(() => d.querySelector('[data-player-action="edit"]'));
    d.querySelector('[data-player-action="edit"]').click();
  } else d.querySelector("#new-button").click();
  await eventually(() => d.querySelector("#editor-dialog").open);
  return d;
}
function chooseFile(ctx) {
  const w = ctx.window;
  // JSDOM의 이미지 코덱·canvas만 대체합니다. 양식과 SDK는 빌드한 실제 코드를 실행합니다.
  w.URL.createObjectURL = () => "blob:test-only";
  w.URL.revokeObjectURL = () => {};
  w.createImageBitmap = async () => ({ width: 100, height: 100, close() {} });
  w.HTMLCanvasElement.prototype.getContext = () => ({
    fillRect() {},
    drawImage() {},
  });
  w.HTMLCanvasElement.prototype.toBlob = (callback) =>
    callback(new w.Blob(["test only"], { type: "image/jpeg" }));
  const input = w.document.querySelector("#player-photo-upload");
  Object.defineProperty(input, "files", {
    configurable: true,
    value: [new w.File(["test only"], "test-only.jpg", { type: "image/jpeg" })],
  });
  input.dispatchEvent(new w.Event("change", { bubbles: true }));
}
test("new player form includes full profile, file upload and consent together", async () => {
  const ctx = await app(
    "owner",
    "https://ryukkani.github.io/kansai/admin/?lang=ko",
  );
  try {
    const d = await open(ctx);
    for (const name of [
      "internal_name",
      "display_name",
      "romanized_name",
      "position",
      "jersey_number",
      "bio",
      "slug",
      "photo_asset_id",
      "profile_consent",
      "photo_consent",
    ])
      assert.ok(d.querySelector(`#editor-form [name="${name}"]`), name);
    assert.ok(d.querySelector('#editor-form input[type="file"]'));
    assert.equal(d.querySelector("[data-player-part]"), null);
    assert.match(
      d.querySelector('#editor-actions [data-save-status="draft"]').textContent,
      /선수·프로필·사진 저장/,
    );
    assert.equal(
      d.querySelector('[data-save-status="published"]').disabled,
      true,
    );
    d.querySelector("#editor-close").click();
    assert.equal(d.querySelector("#editor-dialog").open, false);
  } finally {
    ctx.dom.window.close();
  }
});
test("existing records load together and preserve published URL and unsaved edits", async () => {
  const ctx = await app(
    "owner",
    undefined,
    {},
    {
      players: [player],
      public_player_profiles: [
        { ...profile, status: "published", published_at: stamp },
      ],
    },
  );
  try {
    const d = await open(ctx, true);
    assert.equal(
      d.querySelector('[name="internal_name"]').value,
      player.internal_name,
    );
    assert.equal(
      d.querySelector('[name="display_name"]').value,
      profile.display_name,
    );
    assert.equal(d.querySelector('[name="jersey_number"]').value, "8");
    assert.equal(d.querySelector('[name="slug"]').readOnly, true);
    assert.match(d.querySelector("#editor-meta").textContent, new RegExp(uid));
    set(ctx.window, "display_name", "Changed");
    d.querySelector("#editor-close").click();
    assert.equal(d.querySelector("#unsaved-dialog").open, true);
    d.querySelector("#unsaved-continue").click();
    assert.equal(d.querySelector('[name="display_name"]').value, "Changed");
  } finally {
    ctx.dom.window.close();
  }
});
test("save sends registration and profile through one RPC without individual table writes", async () => {
  const calls = [];
  const ctx = await app("owner", undefined, {
    rpc: (name, values) => {
      calls.push({ name, values });
      return { player_id: values.p_player_id };
    },
  });
  try {
    const d = await open(ctx);
    set(ctx.window, "internal_name", "Test internal");
    set(ctx.window, "display_name", "Test public");
    set(ctx.window, "position", "MF");
    set(ctx.window, "jersey_number", "9");
    d.querySelector('[data-save-status="draft"]').click();
    await eventually(() => !d.querySelector("#editor-dialog").open);
    const saves = calls.filter((call) => call.name === "save_player_office");
    assert.equal(saves.length, 1);
    assert.match(saves[0].values.p_player_id, /^[0-9a-f-]{36}$/);
    assert.equal(saves[0].values.p_player.internal_name, "Test internal");
    assert.equal(saves[0].values.p_profile.display_name, "Test public");
    assert.equal(saves[0].values.p_profile.jersey_number, 9);
    assert.equal(saves[0].values.p_status, "draft");
    assert.equal(
      ctx.requests.some(
        (request) =>
          request.method === "POST" &&
          /\/rest\/v1\/(players|public_player_profiles|media_assets)(\?|$)/.test(
            request.url,
          ),
      ),
      false,
    );
  } finally {
    ctx.dom.window.close();
  }
});
test("photo previews in the form and publishing requires both consents", async () => {
  const ctx = await app("owner", undefined, {}, { media_assets: [photo] });
  try {
    const d = await open(ctx);
    set(ctx.window, "photo_asset_id", photo.id);
    assert.ok(d.querySelector(".office-player-photo-preview img"));
    tick(ctx.window, "profile_consent", true);
    assert.equal(
      d.querySelector('[data-save-status="published"]').disabled,
      true,
    );
    tick(ctx.window, "photo_consent", true);
    assert.equal(
      d.querySelector('[data-save-status="published"]').disabled,
      false,
    );
    tick(ctx.window, "photo_consent", false);
    assert.equal(
      d.querySelector('[data-save-status="published"]').disabled,
      true,
    );
  } finally {
    ctx.dom.window.close();
  }
});
test("file upload waits for save and is reused when an atomic save fails", async () => {
  const calls = [];
  let fail = true;
  let uploads = 0;
  const ctx = await app(
    "owner",
    "https://ryukkani.github.io/kansai/admin/?lang=ko",
    {
      rpc: (name, values) => {
        if (name !== "save_player_office") return {};
        calls.push(values);
        return fail
          ? Response.json(
              { code: "40001", message: "player form has changed" },
              { status: 409 },
            )
          : { player_id: values.p_player_id };
      },
    },
  );
  const original = ctx.window.fetch;
  ctx.window.fetch = async (url, options) => {
    if (String(url).includes("/storage/v1/object/kansai-media/")) {
      uploads++;
      return Response.json({ Key: "kansai-media/test-only.jpg" });
    }
    return original(url, options);
  };
  try {
    const d = await open(ctx);
    set(ctx.window, "internal_name", "Test");
    set(ctx.window, "display_name", "Test public");
    set(ctx.window, "position", "MF");
    chooseFile(ctx);
    assert.equal(uploads, 0);
    assert.ok(d.querySelector(".office-player-photo-preview img"));
    assert.equal(d.querySelector('[name="photo_title"]').value, "Test public");
    d.querySelector('[data-save-status="draft"]').click();
    await eventually(
      () => calls.length === 1 && !d.querySelector("#editor-form").inert,
    );
    assert.equal(d.querySelector("#editor-dialog").open, true);
    assert.match(d.querySelector("#editor-notice").textContent, /최신/);
    assert.equal(d.querySelector('[name="display_name"]').value, "Test public");
    assert.equal(uploads, 1);
    fail = false;
    d.querySelector('[data-save-status="draft"]').click();
    await eventually(() => !d.querySelector("#editor-dialog").open);
    assert.equal(uploads, 1);
    assert.equal(calls[0].p_player_id, calls[1].p_player_id);
    assert.equal(calls[0].p_upload.id, calls[1].p_upload.id);
    assert.match(calls[0].p_upload.storage_path, new RegExp("^" + uid + "/"));
    assert.equal(calls[0].p_upload.alt_text, "Test public");
  } finally {
    ctx.dom.window.close();
  }
});
test("coach uses the full form without upload or approval access", async () => {
  const calls = [];
  const ctx = await app(
    "coach",
    undefined,
    {
      rpc: (name, values) => {
        calls.push({ name, values });
        return {};
      },
    },
    {
      players: [player],
      media_assets: [
        photo,
        { ...photo, id: "private", status: "draft" },
        { ...photo, id: "training", media_category: "training" },
      ],
    },
  );
  try {
    const d = await open(ctx, true);
    assert.ok(d.querySelector('[name="display_name"]'));
    assert.equal(d.querySelector('input[type="file"]'), null);
    assert.equal(d.querySelector('[data-save-status="published"]'), null);
    assert.deepEqual(
      [...d.querySelector('[name="photo_asset_id"]').options].map(
        (option) => option.value,
      ),
      ["", photo.id],
    );
    set(ctx.window, "display_name", "Test public");
    set(ctx.window, "position", "MF");
    set(ctx.window, "photo_asset_id", photo.id);
    d.querySelector('[data-save-status="pending"]').click();
    await eventually(() => !d.querySelector("#editor-dialog").open);
    assert.equal(
      calls.find((call) => call.name === "save_player_office").values.p_status,
      "pending",
    );
  } finally {
    ctx.dom.window.close();
  }
});
test("changing names preserves differing internal and public photo connections", async () => {
  const calls = [];
  const second = {
    ...photo,
    id: "10000000-0000-4000-8000-000000000003",
    legacy_path: "assets/second-player.jpg",
  };
  const ctx = await app(
    "owner",
    undefined,
    {
      rpc: (name, values) => {
        calls.push({ name, values });
        return {};
      },
    },
    {
      players: [{ ...player, photo_asset_id: photo.id }],
      public_player_profiles: [{ ...profile, photo_path: second.legacy_path }],
      media_assets: [photo, second],
    },
  );
  try {
    const d = await open(ctx, true);
    assert.equal(d.querySelector('[name="photo_asset_id"]').value, second.id);
    set(ctx.window, "internal_name", "Revised");
    d.querySelector('[data-save-status="draft"]').click();
    await eventually(() => !d.querySelector("#editor-dialog").open);
    const saved = calls.find(
      (call) => call.name === "save_player_office",
    ).values;
    assert.equal(saved.p_photo_changed, false);
    assert.equal(saved.p_expected_player, stamp);
    assert.equal(saved.p_expected_profile, stamp);
  } finally {
    ctx.dom.window.close();
  }
});
test("partial profile is blocked and discarding a photo sends no upload", async () => {
  const ctx = await app("owner");
  try {
    const d = await open(ctx);
    set(ctx.window, "internal_name", "Test only");
    set(ctx.window, "display_name", "Partial");
    d.querySelector('[data-save-status="draft"]').click();
    await eventually(() => d.querySelector("#editor-notice").textContent);
    assert.equal(
      ctx.requests.some((request) =>
        request.url.includes("/rpc/save_player_office"),
      ),
      false,
    );
    chooseFile(ctx);
    d.querySelector("#editor-close").click();
    assert.equal(d.querySelector("#unsaved-dialog").open, true);
    assert.equal(
      ctx.requests.some((request) =>
        request.url.includes("/storage/v1/object/"),
      ),
      false,
    );
    d.querySelector("#unsaved-discard").click();
    assert.equal(d.querySelector("#editor-dialog").open, false);
  } finally {
    ctx.dom.window.close();
  }
});

test("internal player names are never copied into public photo metadata", async () => {
  const ctx = await app("owner");
  try {
    const d = await open(ctx);
    set(ctx.window, "internal_name", "Private staff-only name");
    chooseFile(ctx);
    assert.equal(d.querySelector('[name="photo_title"]').value, "選手写真");
    assert.equal(d.querySelector('[name="photo_alt_text"]').value, "");
    assert.equal(d.querySelector('[name="photo_alt_text"]').required, true);
  } finally {
    ctx.dom.window.close();
  }
});

test("a delayed player form response cannot reopen private fields after logout", async () => {
  let hold = false;
  let waiting = false;
  let release;
  const ready = new Promise((resolve) => {
    release = resolve;
  });
  const ctx = await app("owner", undefined, {
    beforeRead: async (name) => {
      if (hold && name === "media_assets") {
        waiting = true;
        await ready;
      }
    },
  });
  try {
    await login(ctx.window);
    const d = ctx.window.document;
    d.querySelector('[data-resource="players"]').click();
    await eventually(() => d.querySelector(".admin-list"));
    hold = true;
    d.querySelector("#new-button").click();
    await eventually(() => waiting);
    d.querySelector("#logout-button").click();
    await eventually(() => !d.querySelector("#login-panel").hidden);
    release();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(d.querySelector("#editor-dialog").open, false);
    assert.equal(d.querySelector("#editor-fields").children.length, 0);
  } finally {
    release();
    ctx.dom.window.close();
  }
});
