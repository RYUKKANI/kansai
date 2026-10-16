import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { preparePreviewCsp } from "../scripts/lib/preview-csp.mjs";

// [편집 안내] 실제 내보내기 명령을 격리된 빌드에서 실행합니다. 철회 자료 제거와 실패 시 이전 결과 보존을 확인합니다.
const run = promisify(execFile);
const exporter = fileURLToPath(new URL("../scripts/export-preview.mjs", import.meta.url));
const cspHash = code => `'sha256-${createHash("sha256").update(code).digest("base64")}'`;

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "kansai-preview-export-test-"));
  const write = async (file, text) => {
    const target = path.join(directory, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, text);
  };
  await write("dist/index.html", '<!doctype html><a href="/news/">News</a><h1>Current public page</h1>');
  await write("preview/index.html", "previous usable homepage");
  await write("preview/withdrawn/index.html", "withdrawn private copy");
  await write("original-photos/keep.jpg", "original photo must survive");
  return {
    directory,
    write,
    export: (nodeArguments = []) => run(process.execPath, [...nodeArguments, exporter], { cwd: directory }),
    close: () => rm(directory, { recursive: true, force: true }),
  };
}

async function snapshot(directory) {
  const files = {};
  const visit = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(file);
      else files[path.relative(directory, file)] = (await readFile(file)).toString("base64");
    }
  };
  await visit(directory);
  return files;
}

async function assertNoStaging(directory) {
  assert.deepEqual((await readdir(directory)).filter(name => name.startsWith(".preview-export-")), []);
}

test("a successful preview replaces the complete generated tree and removes withdrawn pages", async () => {
  const app = await fixture();
  try {
    await app.write("dist/news/index.html", '<!doctype html><link rel="stylesheet" href="/_astro/site.css"><a href="/#top">Home</a><img src="/assets/logo.svg" alt="Club logo"><script type="module" src="/_astro/site.js"></script>');
    await app.write("dist/_astro/site.css", 'body{background-image:url("/assets/logo.svg")} :focus-visible{outline:2px solid blue}');
    await app.write("dist/_astro/site.js", 'document.body.dataset.offlineMenu = "ready";');
    await app.write("dist/assets/logo.svg", '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    const sourceBefore = await snapshot(path.join(app.directory, "dist"));
    await app.export();
    const output = await snapshot(path.join(app.directory, "preview"));
    assert.deepEqual(Object.keys(output).sort(), ["index.html", path.join("news", "index.html")].sort());
    const home = await readFile(path.join(app.directory, "preview/index.html"), "utf8");
    const news = await readFile(path.join(app.directory, "preview/news/index.html"), "utf8");
    assert.match(home, /href="news\/index.html"/);
    assert.match(news, /href="\.\.\/index.html#top"/);
    assert.match(news, /data:image\/svg\+xml;base64,/);
    assert.match(news, /<style>.*:focus-visible/);
    assert.match(news, /offlineMenu/);
    assert.doesNotMatch(news, /<script[^>]*\bsrc=|<link[^>]*rel="stylesheet"/);
    assert.deepEqual(await snapshot(path.join(app.directory, "dist")), sourceBefore);
    assert.equal(await readFile(path.join(app.directory, "original-photos/keep.jpg"), "utf8"), "original photo must survive");
    await assertNoStaging(app.directory);
  } finally { await app.close(); }
});

test("a failed export preserves every previous preview file and removes incomplete staging", async () => {
  const app = await fixture();
  try {
    await app.write("dist/news/index.html", '<!doctype html><img src="/assets/missing.svg" alt="Broken resource">');
    const previous = await snapshot(path.join(app.directory, "preview"));
    await assert.rejects(app.export(), error => {
      assert.match(error.stderr, /빌드 리소스를 찾을 수 없습니다/);
      return true;
    });
    assert.deepEqual(await snapshot(path.join(app.directory, "preview")), previous);
    await assertNoStaging(app.directory);
  } finally { await app.close(); }
});

test("an incomplete build without its homepage cannot replace a usable preview", async () => {
  const app = await fixture();
  try {
    await rm(path.join(app.directory, "dist/index.html"));
    await app.write("dist/news/index.html", "a partial build");
    const previous = await snapshot(path.join(app.directory, "preview"));
    await assert.rejects(app.export(), error => {
      assert.match(error.stderr, /dist\/index.html/);
      return true;
    });
    assert.deepEqual(await snapshot(path.join(app.directory, "preview")), previous);
    await assertNoStaging(app.directory);
  } finally { await app.close(); }
});

test("a preview symlink cannot cause replacement or cleanup outside the generated directory", async () => {
  const app = await fixture();
  try {
    const external = path.join(app.directory, "original-photos");
    const original = await snapshot(external);
    await rm(path.join(app.directory, "preview"), { recursive: true });
    await symlink(external, path.join(app.directory, "preview"), "dir");
    await assert.rejects(app.export(), error => {
      assert.match(error.stderr, /preview가 일반 폴더가 아니므로/);
      return true;
    });
    assert.deepEqual(await snapshot(external), original);
    await assertNoStaging(app.directory);
  } finally { await app.close(); }
});

test("a failed final directory rename restores the complete previous preview", async () => {
  const app = await fixture();
  try {
    // 실제 OS 권한을 바꾸는 대신 최종 rename만 실패시켜 백업 이후의 복원 분기를 검증합니다.
    await app.write("fail-publish.mjs", `
      import fs from "node:fs/promises";
      import path from "node:path";
      import { syncBuiltinESMExports } from "node:module";
      const rename = fs.rename;
      fs.rename = async (source, target) => {
        if (path.basename(source) === "generated") {
          const error = new Error("simulated publish rename failure");
          error.code = "EACCES";
          throw error;
        }
        return rename(source, target);
      };
      syncBuiltinESMExports();
    `);
    const previous = await snapshot(path.join(app.directory, "preview"));
    await assert.rejects(app.export(["--import", path.join(app.directory, "fail-publish.mjs")]), error => {
      assert.match(error.stderr, /simulated publish rename failure/);
      return true;
    });
    assert.deepEqual(await snapshot(path.join(app.directory, "preview")), previous);
    await assertNoStaging(app.directory);
  } finally { await app.close(); }
});

test("offline CSP approves the final bundled code and styles while dropping unused inline hashes", async () => {
  const app = await fixture();
  try {
    const existingScript = 'window.existing = "allowed";';
    const existingStyle = ".notice{display:block}";
    const unknownHash = cspHash('window.unknown = "must not be authorized";');
    const restrictions = "default-src 'self';base-uri 'none';object-src 'none';connect-src 'self';font-src 'self' data:";
    const policy = `${restrictions};script-src 'self' ${cspHash(existingScript)} ${unknownHash};style-src 'self' ${cspHash(existingStyle)};`;
    await app.write("dist/index.html", `<!doctype html><head><meta http-equiv="content-security-policy" content="${policy}"><style>${existingStyle}</style><link rel="stylesheet" href="/_astro/site.css"></head><body><script>${existingScript}</script><script type="module" src="/_astro/site.js"></script></body>`);
    await app.write("dist/_astro/site.css", '.photo{background-image:url("/assets/logo.svg")}');
    await app.write("dist/_astro/site.js", 'document.body.dataset.offlineMenu = "ready";');
    await app.write("dist/assets/logo.svg", '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    await app.export();
    const output = await readFile(path.join(app.directory, "preview/index.html"), "utf8");
    const actualPolicy = output.match(/<meta http-equiv="content-security-policy" content="([^"]+)"/)[1];
    assert.ok(actualPolicy.startsWith(restrictions + ";"));
    for (const type of ["script", "style"]) {
      const blocks = [...output.matchAll(new RegExp(`<${type}\\b[^>]*>([\\s\\S]*?)</${type}>`, "g"))];
      const expected = new Set(["'self'", ...blocks.map(match => cspHash(match[1]))]);
      const actual = actualPolicy.match(new RegExp(`(?:^|;)\\s*${type}-src ([^;]+)`))[1].split(/\s+/);
      assert.deepEqual(new Set(actual), expected);
    }
    assert.ok(!actualPolicy.includes(unknownHash), "Unneeded code hashes must not survive from the original policy");
    assert.doesNotMatch(actualPolicy, /unsafe-inline|unsafe-eval/);
    assert.match(output, /data:image\/svg\+xml;base64,/);
    await assertNoStaging(app.directory);
  } finally { await app.close(); }
});

test("unapproved inline code fails export rather than receiving a new CSP hash", async () => {
  const app = await fixture();
  try {
    const previous = await snapshot(path.join(app.directory, "preview"));
    await app.write("dist/index.html", '<!doctype html><meta http-equiv="content-security-policy" content="default-src \'self\';script-src \'self\';style-src \'self\';"><script>window.unapproved = true;</script>');
    await assert.rejects(app.export(), error => {
      assert.match(error.stderr, /기존 CSP가 승인하지 않은 인라인 script/);
      return true;
    });
    assert.deepEqual(await snapshot(path.join(app.directory, "preview")), previous);
    await assertNoStaging(app.directory);
  } finally { await app.close(); }
});

test("code introduced by a style tag breakout cannot acquire script permission during export", async () => {
  const app = await fixture();
  try {
    const previous = await snapshot(path.join(app.directory, "preview"));
    await app.write("dist/index.html", '<!doctype html><meta http-equiv="content-security-policy" content="default-src \'self\';script-src \'self\';style-src \'self\';"><link rel="stylesheet" href="/_astro/site.css">');
    await app.write("dist/_astro/site.css", '.notice{display:block}</style><script>window.unapproved=true;</script><style>');
    await assert.rejects(app.export(), error => {
      assert.match(error.stderr, /미리보기 변환 중 승인되지 않은 인라인 script/);
      return true;
    });
    assert.deepEqual(await snapshot(path.join(app.directory, "preview")), previous);
    await assertNoStaging(app.directory);
  } finally { await app.close(); }
});

test("unsupported CSP source rules are rejected instead of being loosened", () => {
  for (const policy of [
    "script-src 'self' 'unsafe-inline';style-src 'self'",
    "script-src 'self';style-src 'self' 'unsafe-eval'",
    "script-src 'self';style-src 'self';script-src-elem 'none'",
    "script-src 'self';script-src 'self';style-src 'self'",
    "script-src 'self' 'nonce-random';style-src 'self'",
  ]) {
    assert.throws(() => preparePreviewCsp(`<meta http-equiv="content-security-policy" content="${policy}">`));
  }
});
