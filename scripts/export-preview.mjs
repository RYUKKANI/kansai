import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import config from "../astro.config.mjs";
import { build } from "esbuild";

// [편집 안내] npm run build 후 실행하면 preview/에 파일로 열 수 있는 미리보기를 만듭니다.
// 실제 빌드의 CSS·스크립트·사진·글꼴을 HTML에 담고, 페이지 링크는 상대 경로로 바꿉니다.
const project = process.cwd();
const dist = path.join(project, "dist");
const preview = path.join(project, "preview");
// 배포 경로를 별도로 복사하지 않고 Astro 설정과 공유합니다.
const basePath = `/${(config.base ?? "/").replace(/^\/+|\/+$/g, "")}/`.replace(
  /\/+/g,
  "/",
);
const resources = new Map();
const styles = new Map();
const scripts = new Map();
const mime = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(file)));
    else files.push(file);
  }
  return files;
}

// /kansai/assets/...와 /kansai/_astro/...를 모두 빌드 폴더 기준으로 읽습니다.
function buildPath(url) {
  const relative = url.startsWith(basePath)
    ? url.slice(basePath.length)
    : url.replace(/^\//, "");
  const resolved = path.resolve(dist, relative);
  if (!resolved.startsWith(dist + path.sep))
    throw new Error(`빌드 폴더 밖의 리소스: ${url}`);
  return resolved;
}

const allFiles = await walk(dist);
for (const file of allFiles) {
  const type = mime[path.extname(file)];
  if (!type) continue;
  // 같은 사진·글꼴을 여러 페이지에서 사용할 때 파일은 한 번만 읽습니다.
  resources.set(
    file,
    `data:${type};base64,${(await readFile(file)).toString("base64")}`,
  );
}

function resource(url) {
  const content = resources.get(buildPath(url));
  if (!content) throw new Error(`빌드 리소스를 찾을 수 없습니다: ${url}`);
  return content;
}

async function inlineStyle(url) {
  const file = buildPath(url);
  if (!styles.has(file)) {
    const css = await readFile(file, "utf8");
    // Vite가 별도 파일로 만든 글꼴도 담아 오프라인에서 같은 글꼴을 사용합니다.
    styles.set(
      file,
      css.replace(
        /url\((['"]?)(\/[^)'"\s]+)\1\)/g,
        (_match, _quote, resourceUrl) => `url("${resource(resourceUrl)}")`,
      ),
    );
  }
  return styles.get(file);
}

async function inlineScript(url) {
  const file = buildPath(url);
  if (!scripts.has(file)) {
    // 분리된 JS 모듈도 묶어 파일 미리보기에서 상대 import가 끊기지 않게 합니다.
    const bundled = await build({
      entryPoints: [file],
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      target: "es2022",
      minify: true,
    });
    const script = bundled.outputFiles[0].text;
    scripts.set(file, script.replace(/<\/script/gi, "<\\/script"));
  }
  return scripts.get(file);
}

for (const file of allFiles.filter((file) => file.endsWith(".html"))) {
  const relative = path.relative(dist, file);
  const relativeDirectory = path.posix.dirname(
    relative.split(path.sep).join("/"),
  );
  let html = await readFile(file, "utf8");

  for (const match of [
    ...html.matchAll(/<link\b(?=[^>]*rel="stylesheet")[^>]*>/g),
  ]) {
    const href = match[0].match(/href="([^"]+)"/)?.[1];
    if (href) {
      const css = await inlineStyle(href);
      html = html.replace(
        match[0],
        () => "<style>" + css + "</style>",
      );
    }
  }

  // 코드가 커져 Astro가 외부 JS 파일을 생성해도 메뉴·검색·사진 확대가 오프라인에서 동작합니다.
  for (const match of [
    ...html.matchAll(/<script\b([^>]*\bsrc="([^"]+)"[^>]*)><\/script>/g),
  ]) {
    const attributes = match[1].replace(/\s*src="[^"]+"/, "");
    const embedded = await inlineScript(match[2]);
    // 콜백을 사용해야 JS 안의 $&가 원래 script 태그로 치환되지 않습니다.
    html = html.replace(
      match[0],
      () => "<script" + attributes + ">" + embedded + "</script>",
    );
  }

  html = html.replace(
    /\b(src|href|data-image)="(\/[^"\s]*(?:assets|_astro)\/[^"]+)"/g,
    (_match, attribute, url) => `${attribute}="${resource(url)}"`,
  );
  html = html.replace(
    /href="(\/[^"#]*)(#[^"]*)?"/g,
    (_match, url, fragment = "") => {
      if (url.startsWith(basePath)) url = "/" + url.slice(basePath.length);
      const target =
        url === "/"
          ? "index.html"
          : url.replace(/^\//, "").replace(/\/$/, "") + "/index.html";
      const local =
        path.posix.relative(relativeDirectory, target) || "index.html";
      return `href="${local}${fragment}"`;
    },
  );

  if (
    /\b(?:src|data-image)="\//.test(html) ||
    /<link\b[^>]*rel="stylesheet"/.test(html)
  ) {
    throw new Error(
      `오프라인 미리보기에 외부 리소스가 남았습니다: ${relative}`,
    );
  }
  const target = path.join(preview, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, html);
  console.log(`오프라인 미리보기: ${relative}`);
}
