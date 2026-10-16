import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import config from "../astro.config.mjs";
import { build } from "esbuild";
import { preparePreviewCsp } from "./lib/preview-csp.mjs";

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

// 배포 경로 아래 assets/...와 _astro/...를 모두 빌드 폴더 기준으로 읽습니다.
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
const pages = allFiles.filter((file) => file.endsWith(".html"));
// 비어 있거나 불완전한 빌드를 정상 결과로 오인해 이전 미리보기를 지우지 않습니다.
if (!pages.includes(path.join(dist, "index.html")))
  throw new Error("미리보기 생성에 필요한 dist/index.html이 없습니다.");
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

async function generatePreview(directory) {
  for (const file of pages) {
    const relative = path.relative(dist, file);
    const relativeDirectory = path.posix.dirname(
      relative.split(path.sep).join("/"),
    );
    let html = await readFile(file, "utf8");
    const csp = preparePreviewCsp(html);

    for (const match of [
      ...html.matchAll(/<link\b(?=[^>]*rel="stylesheet")[^>]*>/g),
    ]) {
      const href = match[0].match(/href="([^"]+)"/)?.[1];
      if (href) {
        const css = await inlineStyle(href);
        csp?.approveEmbedded("style", css);
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
      csp?.approveEmbedded("script", embedded);
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
    if (csp) html = csp.finalize(html);
    const target = path.join(directory, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, html);
  }
}

// 철회된 페이지가 남지 않도록 매번 새 폴더를 만듭니다. 생성 도중에는 기존 결과를 건드리지 않습니다.
// 같은 파일 시스템 안에서 이름을 바꾸기 위해 임시 폴더도 프로젝트 바로 아래에 둡니다.
const transaction = await mkdtemp(path.join(project, ".preview-export-"));
const stagedPreview = path.join(transaction, "generated");
const previousPreview = path.join(transaction, "previous");
let preserveBackup = false;

try {
  await mkdir(stagedPreview, { mode: 0o700 });
  await generatePreview(stagedPreview);

  // preview만 교체하며 dist와 사진 원본은 수정하지 않습니다. 잘못 연결된 외부 폴더도 따라가지 않습니다.
  let existingPreview;
  try {
    existingPreview = await lstat(preview);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (existingPreview && !existingPreview.isDirectory())
    throw new Error("preview가 일반 폴더가 아니므로 안전하게 교체할 수 없습니다.");

  if (existingPreview) await rename(preview, previousPreview);
  try {
    await rename(stagedPreview, preview);
  } catch (error) {
    if (existingPreview) {
      try {
        await rename(previousPreview, preview);
      } catch (restoreError) {
        // OS나 외부 프로세스가 복원을 막아도 이전 파일을 삭제하지 않고 수동 복구 위치를 남깁니다.
        preserveBackup = true;
        throw new AggregateError(
          [error, restoreError],
          `미리보기 교체와 복원에 실패했습니다. 이전 결과 보관 위치: ${previousPreview}`,
        );
      }
    }
    throw error;
  }
  for (const file of pages)
    console.log(`오프라인 미리보기: ${path.relative(dist, file)}`);
} finally {
  if (!preserveBackup) await rm(transaction, { recursive: true, force: true });
}
