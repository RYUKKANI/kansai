import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

// 플레이어 편집 모듈은 실제 소스를 실행하며, 이미지 코덱과 요청 경계만 메모리에서 대체합니다.
const bundle = await build({
  entryPoints: ["src/scripts/admin-player.ts"],
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  globalName: "PlayerEditorModule",
  define: { "import.meta.env.BASE_URL": '"/"' },
});
const uid = "00000000-0000-4000-8000-000000000001";
async function until(check) {
  for (let index = 0; index < 100; index++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(check(), "Player editor did not reach its expected state");
}
async function app(options = {}) {
  const dom = new JSDOM('<form id="form"><div id="fields"></div><div id="meta"></div><div id="actions"></div></form>', {
    url: "https://kansaiunited.com/admin/",
    runScripts: "outside-only",
  });
  const { window } = dom;
  window.URL.createObjectURL = () => "blob:test-only";
  window.URL.revokeObjectURL = () => {};
  window.createImageBitmap = async () => ({ width: 100, height: 100, close() {} });
  window.HTMLCanvasElement.prototype.getContext = () => ({ fillRect() {}, drawImage() {} });
  window.HTMLCanvasElement.prototype.toBlob = (callback) =>
    callback(new window.Blob(["test image"], { type: "image/jpeg" }));
  window.eval(bundle.outputFiles[0].text + "\nwindow.PlayerEditorModule = PlayerEditorModule;");
  let current = true;
  const calls = [];
  const client = {
    from(name) {
      calls.push({ kind: "read", name });
      const request = Promise.resolve().then(() => options.read
        ? options.read(name)
        : { data: [], error: null });
      for (const method of ["select", "eq", "order", "single", "maybeSingle"])
        request[method] = () => request;
      return request;
    },
    async rpc(name, values) {
      calls.push({ kind: "rpc", name, values });
      return options.save
        ? options.save(values)
        : { data: { player_id: values.p_player_id }, error: null };
    },
    storage: {
      from() {
        return {
          async upload(path) {
            calls.push({ kind: "upload", path });
            return options.upload ? options.upload() : { error: null };
          },
        };
      },
    },
  };
  const fields = window.document.querySelector("#fields");
  const pending = window.PlayerEditorModule.attachPlayerEditor({
    client,
    role: "owner",
    userId: uid,
    base: "/",
    player: options.player ?? null,
    form: window.document.querySelector("#form"),
    fields,
    meta: window.document.querySelector("#meta"),
    actions: window.document.querySelector("#actions"),
    changed() {},
    isCurrent: () => current,
  });
  return {
    dom, window, calls, fields, pending,
    invalidate() { current = false; },
    fill() {
      for (const [name, value] of Object.entries({
        internal_name: "Test internal", display_name: "Test public", position: "MF", slug: "test-player",
      })) window.document.querySelector('[name="' + name + '"]').value = value;
    },
    chooseFile() {
      const input = window.document.querySelector("#player-photo-upload");
      Object.defineProperty(input, "files", {
        value: [new window.File(["test image"], "test.jpg", { type: "image/jpeg" })],
      });
      input.dispatchEvent(new window.Event("change", { bubbles: true }));
    },
  };
}

for (const mode of ["disposed", "another account or editor"]) {
  test("a pending player upload is abandoned when " + mode + " replaces its context", async () => {
    let release;
    const uploading = new Promise((resolve) => { release = resolve; });
    const context = await app({ upload: () => uploading });
    const controller = await context.pending;
    try {
      context.fill();
      context.chooseFile();
      const saving = controller.save("draft");
      await until(() => context.calls.some((call) => call.kind === "upload"));
      if (mode === "disposed") controller.dispose();
      else context.invalidate();
      context.fields.textContent = "New editor";
      release({ error: null });
      await assert.rejects(saving, /player_editor_inactive/);
      assert.equal(context.calls.some((call) => call.kind === "rpc"), false);
      assert.equal(context.fields.textContent, "New editor");
    } finally {
      release({ error: null });
      controller.dispose();
      context.dom.window.close();
    }
  });
}

test("an invalidated player lookup does not continue fetching the previous player's profile", async () => {
  let release;
  const loading = new Promise((resolve) => { release = resolve; });
  const context = await app({
    player: { id: uid },
    read: () => loading,
  });
  try {
    await until(() => context.calls.some((call) => call.kind === "read"));
    context.invalidate();
    release({ data: { id: uid, updated_at: "2026-10-01T00:00:00Z" }, error: null });
    assert.equal(await context.pending, null);
    assert.deepEqual(context.calls.map((call) => call.name), ["players"]);
    assert.equal(context.fields.children.length, 0);
  } finally {
    release({ data: null, error: null });
    context.dom.window.close();
  }
});
