import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import ts from "typescript";

// [편집 안내] 공개 번들에 전체 번역 사전이 다시 유입되거나 새 동적 문구의 번역이 빠지는 회귀를 막습니다.
const define = { "import.meta.env.BASE_URL": '"/"' };
const runtimeBundle = await build({ entryPoints: ["src/lib/public-i18n.ts"], bundle: true, write: false, format: "iife", globalName: "PublicI18n", define });
const messages = JSON.parse(await readFile("src/data/locales/messages.json", "utf8"));
function runtime(value) {
  const dom = new JSDOM("<body></body>", { runScripts: "outside-only" });
  if (value !== undefined) dom.window.document.body.dataset.publicMessages = value;
  dom.window.eval(runtimeBundle.outputFiles[0].text + "\nwindow.__publicI18n = PublicI18n;");
  return { dom, api: dom.window.__publicI18n };
}

test("public browser graph excludes the complete server/admin translation catalog", async () => {
  const result = await build({ entryPoints: ["src/scripts/site.ts"], bundle: true, write: false, metafile: true, define });
  const inputs = Object.keys(result.metafile.inputs);
  assert.ok(inputs.includes("src/lib/locale.ts"));
  assert.ok(!inputs.includes("src/lib/i18n.ts"));
  assert.ok(!inputs.includes("src/data/locales/messages.json"));
});

test("each public language receives exactly the current runtime translations", async () => {
  const app = runtime();
  try {
    const keys = Array.from(app.api.publicRuntimeSources);
    for (const locale of ["ja", "ko", "en"]) {
      const prefix = locale === "ja" ? "" : locale + "/";
      const html = await readFile("dist/" + prefix + "index.html", "utf8");
      const dom = new JSDOM(html);
      try {
        const catalog = JSON.parse(dom.window.document.body.dataset.publicMessages);
        assert.deepEqual(Object.keys(catalog), keys);
        for (const key of keys) {
          assert.ok(messages[key], "Missing catalog entry: " + key);
          assert.equal(catalog[key], locale === "ja" ? key : messages[key][locale]);
        }
      } finally { dom.window.close(); }
    }
  } finally { app.dom.window.close(); }
});

test("new public dynamic strings must be added to the small runtime catalog", async () => {
  const app = runtime();
  try {
    const keys = new Set(app.api.publicRuntimeSources);
    for (const file of ["src/scripts/site.ts", "src/scripts/languages.ts"]) {
      const source = ts.createSourceFile(file, await readFile(file, "utf8"), ts.ScriptTarget.Latest, true);
      const checkMessage = (expression) => {
        if (ts.isStringLiteral(expression)) assert.ok(keys.has(expression.text), "Runtime catalog missing: " + expression.text);
        if (ts.isConditionalExpression(expression)) {
          checkMessage(expression.whenTrue);
          checkMessage(expression.whenFalse);
        }
      };
      const visit = (node) => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ["t", "text", "format"].includes(node.expression.text) && node.arguments[0]) checkMessage(node.arguments[0]);
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  } finally { app.dom.window.close(); }
});

test("public runtime formats text without HTML and safely falls back for an absent or damaged payload", () => {
  for (const value of [undefined, "not-json", "[]", "null", '{"メニューを開く":12}']) {
    const app = runtime(value);
    try { assert.equal(app.api.publicText("メニューを開く"), "メニューを開く"); }
    finally { app.dom.window.close(); }
  }
  const app = runtime('{"{0} STORIES":"{0}건의 소식","メニューを開く":"메뉴 열기"}');
  try {
    assert.equal(app.api.publicText("メニューを開く"), "메뉴 열기");
    assert.equal(app.api.publicFormat("{0} STORIES", "<b>2</b>"), "<b>2</b>건의 소식");
    assert.equal(app.api.publicText("toString"), "toString");
  } finally { app.dom.window.close(); }
});
