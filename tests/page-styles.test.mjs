import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

// [편집 안내] 실제 생성 페이지의 스타일 의존성을 검사합니다. 화면을 분리해도 공통 접근성 규칙은 남아야 합니다.
async function pageStyles(route) {
  const html = await readFile(path.join("dist", route, "index.html"), "utf8");
  const sheets = [...html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g)].map(match => match[1]);
  assert.ok(sheets.length > 0, "The page must load its visual styles");
  const inline = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].map(match => match[1]);
  return [...inline, ...await Promise.all(sheets.map(file => readFile(path.join("dist", file.replace(/^\//, "")), "utf8")))].join("\n");
}

test("admin and recovery pages skip public card styles and retain keyboard and reduced-motion support", async () => {
  for (const route of ["admin", "admin/help"]) {
    const styles = await pageStyles(route);
    assert.ok(!styles.includes(".lead-grid"), "Public homepage styles must not be required for account tasks");
    assert.ok(!styles.includes(".news-card"), "Public news cards must not be required for account tasks");
    assert.ok(styles.includes(".admin-body"));
    assert.ok(styles.includes(":focus-visible"));
    assert.ok(styles.includes("prefers-reduced-motion:reduce"));
    assert.ok(/\[hidden\][^{]*\{[^}]*display:none!important/.test(styles));
  }
});

test("public pages retain the card, navigation and reduced-motion styles", async () => {
  const styles = await pageStyles("");
  for (const selector of [".lead-grid", ".news-card", ".mobile-menu", ".photo", "prefers-reduced-motion:reduce"])
    assert.ok(styles.includes(selector), "Missing public style: " + selector);
});
