import test from "node:test";
import assert from "node:assert/strict";
import { app, login, eventually, uid } from "./helpers/admin-app.mjs";
const stamp = "2026-10-01T00:00:00Z";
const player = {
  id: uid,
  internal_name: "Test only player",
  activity_status: "active",
  profile_consent: false,
  photo_consent: false,
  updated_at: stamp,
};
const set = (w, name, value) => {
  const field = w.document.querySelector(`[name="${name}"]`);
  field.value = value;
  field.dispatchEvent(new w.Event("input", { bubbles: true }));
};
async function directory(ctx) {
  await login(ctx.window);
  const d = ctx.window.document;
  d.querySelector('[data-resource="players"]').click();
  await eventually(() => d.querySelector('[data-player-action="profile"]'));
  return d;
}
test("one player directory contains registration, photo upload and public profile with an unsaved-change guard", async () => {
  const ctx = await app("owner", undefined, {}, { players: [player] });
  try {
    const d = await directory(ctx);
    assert.equal(
      d.querySelector(
        '#admin-navigation [data-resource="public_player_profiles"]',
      ),
      null,
    );
    d.querySelector(".admin-list-row button").click();
    await eventually(() => d.querySelector('[data-player-part="photo"]'));
    assert.ok(d.querySelector('[name="internal_name"]'));
    d.querySelector('[data-player-part="profile"]').click();
    await eventually(() => d.querySelector('[name="display_name"]'));
    assert.equal(d.querySelector('[name="player_id"]').disabled, true);
    assert.equal(
      d.querySelector('input[type="hidden"][name="player_id"]').value,
      uid,
    );
    set(ctx.window, "display_name", "Unfinished profile");
    d.querySelector('[data-player-part="photo"]').click();
    assert.equal(d.querySelector("#unsaved-dialog").open, true);
    d.querySelector("#unsaved-continue").click();
    assert.equal(
      d.querySelector('[name="display_name"]').value,
      "Unfinished profile",
    );
    d.querySelector('[data-player-part="photo"]').click();
    d.querySelector("#unsaved-discard").click();
    await eventually(() => d.querySelector('input[type="file"]'));
    assert.equal(d.querySelector('[name="media_category"]').value, "player");
    assert.equal(d.querySelector('[name="kind"]').value, "photo");
    assert.equal(d.querySelector('[name="media_category"]').disabled, true);
    assert.equal(
      d.querySelector('[data-save-status="published"]').disabled,
      true,
    );
  } finally {
    ctx.dom.window.close();
  }
});
test("saved photo drafts link to the selected internal player and return to the same directory", async () => {
  let ctx;
  const photoId = "10000000-0000-4000-8000-000000000002";
  const rpc = (name, values) => {
    if (name === "save_office_content") {
      const row = {
        ...values.p_values,
        id: photoId,
        updated_at: new Date().toISOString(),
      };
      ctx.tables.media_assets.push(row);
      return row;
    }
    return { revisions: [] };
  };
  ctx = await app(
    "owner",
    "https://ryukkani.github.io/kansai/admin/?lang=ko",
    { content: true, rpc },
    { players: [player] },
  );
  try {
    const d = await directory(ctx);
    d.querySelector('[data-player-action="photo"]').click();
    await eventually(() => d.querySelector('input[type="file"]'));
    set(ctx.window, "title", "Test photo");
    set(ctx.window, "alt_text", "Test description");
    set(
      ctx.window,
      "storage_path",
      uid + "/11111111-1111-4111-8111-111111111111.jpg",
    );
    d.querySelector('[data-save-status="draft"]').click();
    await eventually(() => ctx.tables.players[0].photo_asset_id === photoId);
    assert.equal(ctx.tables.media_assets[0].status, "draft");
    assert.equal(ctx.tables.media_assets[0].consent_confirmed, false);
    assert.equal(ctx.tables.public_player_profiles.length, 0);
    await eventually(() => !d.querySelector("#editor-dialog").open);
    assert.equal(
      d
        .querySelector('#admin-navigation [data-resource="players"]')
        .getAttribute("aria-current"),
      "page",
    );
    assert.match(
      d.querySelector("#admin-notice").textContent,
      /등록 정보에 연결/,
    );
  } finally {
    ctx.dom.window.close();
  }
});
test("coach photo section selects approved photos without opening upload or publication access", async () => {
  const photo = {
    id: "approved-photo",
    title: "Test photo",
    kind: "photo",
    media_category: "player",
    status: "published",
    published_at: stamp,
    public_approved: true,
    legacy_path: "assets/club-profile.jpg",
    album_id: null,
  };
  const ctx = await app(
    "coach",
    undefined,
    {},
    { players: [player], media_assets: [photo] },
  );
  try {
    const d = await directory(ctx);
    d.querySelector('[data-player-action="photo"]').click();
    await eventually(() => d.querySelector('[data-player-part="photo"]'));
    assert.equal(d.querySelector('input[type="file"]'), null);
    assert.ok(d.querySelector('[name="photo_asset_id"]'));
    assert.equal(d.querySelector('[data-save-status="published"]'), null);
    set(ctx.window, "photo_asset_id", "approved-photo");
    d.querySelector('#editor-actions button[type="submit"]').click();
    await eventually(
      () => ctx.tables.players[0].photo_asset_id === "approved-photo",
    );
    assert.equal(ctx.tables.players[0].internal_name, player.internal_name);
    assert.equal(ctx.tables.public_player_profiles.length, 0);
  } finally {
    ctx.dom.window.close();
  }
});
