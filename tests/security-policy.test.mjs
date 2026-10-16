import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { JSDOM } from "jsdom";

// [편집 안내] 설정 문자열만 검사하지 않고 실제 배포 HTML 전체의 정책과 번들을 대조합니다.
// 이 검사는 브라우저의 CSP 구현을 흉내 내지 않습니다. 실제 실행 여부는 배포 브라우저에서도 확인합니다.
const dist = path.resolve(process.env.ADMIN_TEST_DIST ?? "dist");
const digest = (value) => "'sha256-" + createHash("sha256").update(value).digest("base64") + "'";
async function pages(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await pages(file));
    else if (file.endsWith(".html")) result.push(file);
  }
  return result;
}
function directives(value) {
  return new Map(value.split(";").map(directive => directive.trim().split(/\s+/)).filter(([name]) => name).map(([name, ...sources]) => [name, sources]));
}

test("every built page restricts script execution and authorizes its actual scripts and styles", async () => {
  const files = await pages(dist);
  assert.ok(files.length >= 32);
  for (const file of files) {
    const dom = new JSDOM(await readFile(file, "utf8"), { url: "https://kansaiunited.com/" });
    try {
      const { document, Node } = dom.window;
      const metas = document.querySelectorAll('meta[http-equiv="content-security-policy"]');
      assert.equal(metas.length, 1, file);
      const meta = metas[0];
      const policy = directives(meta.content);
      assert.deepEqual(policy.get("default-src"), ["'self'"], file);
      for (const name of ["base-uri", "object-src", "worker-src"]) assert.deepEqual(policy.get(name), ["'none'"], file);
      assert.deepEqual(policy.get("form-action"), ["'self'"], file);
      // 해시가 있는 script/style 정책에는 임의의 인라인 코드·이벤트·eval 허용을 넣지 않습니다.
      assert.doesNotMatch(meta.content, /unsafe-inline|unsafe-eval|unsafe-hashes|\*/);
      assert.ok(!policy.get("script-src").includes(digest("window.__unexpectedInlineScript = true;")), file);
      // header 전용 지시어를 meta로 출력해 보호된 것으로 오인하지 않습니다.
      for (const unsupported of ["frame-ancestors", "report-uri", "sandbox"]) assert.equal(policy.has(unsupported), false, file);
      for (const element of document.querySelectorAll("script,style,link[rel=stylesheet]")) {
        assert.ok(meta.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING, file);
        const kind = element.tagName === "SCRIPT" ? "script-src" : "style-src";
        const resource = element.getAttribute("src") ?? element.getAttribute("href");
        if (resource) {
          assert.ok(resource.startsWith("/_astro/"), file);
          assert.ok(policy.get(kind).includes("'self'"), file);
          await readFile(path.join(dist, resource.replace(/^\//, "")), "utf8");
        } else {
          assert.ok(policy.get(kind).includes(digest(element.textContent)), `${file}: actual inline ${kind} digest missing`);
        }
      }
      for (const element of document.querySelectorAll("*")) {
        for (const attribute of element.attributes) assert.ok(!/^on/i.test(attribute.name) && attribute.name !== "style", `${file}: inline executable/style attribute ${attribute.name}`);
      }
    } finally { dom.window.close(); }
  }
});

test("public pages and office pages receive different connection and referrer scopes in all languages", async () => {
  for (const locale of ["", "ko/", "en/"]) {
    const dom = new JSDOM(await readFile(path.join(dist, locale, "index.html"), "utf8"));
    try {
      const document = dom.window.document;
      const policy = directives(document.querySelector('meta[http-equiv="content-security-policy"]').content);
      assert.deepEqual(policy.get("connect-src"), ["'self'"]);
      assert.deepEqual(policy.get("frame-src"), ["https://www.youtube-nocookie.com"]);
      assert.equal(document.querySelector('meta[name="referrer"]').content, "strict-origin-when-cross-origin");
    } finally { dom.window.close(); }
  }
  // 관리자·복구 화면은 언어 선택을 같은 주소에서 처리합니다.
  for (const file of ["admin/index.html", "admin/help/index.html"]) {
    const dom = new JSDOM(await readFile(path.join(dist, file), "utf8"));
    try {
      const document = dom.window.document;
      const policy = directives(document.querySelector('meta[http-equiv="content-security-policy"]').content);
      assert.deepEqual(policy.get("frame-src"), ["'none'"]);
      assert.equal(document.querySelector('meta[name="referrer"]').content, "no-referrer");
      const origins = policy.get("connect-src").filter(source => source !== "'self'");
      assert.ok(origins.length <= 1);
      for (const origin of origins) {
        const parsed = new URL(origin);
        assert.equal(parsed.origin, origin);
        assert.ok(parsed.protocol === "https:" || parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname));
        assert.ok(policy.get("img-src").includes(origin));
      }
      if (process.env.PUBLIC_SUPABASE_URL) assert.deepEqual(origins, [new URL(process.env.PUBLIC_SUPABASE_URL).origin]);
    } finally { dom.window.close(); }
  }
});
