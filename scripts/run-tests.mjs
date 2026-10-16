import { spawnSync } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureDirectories, fixtureIds, parts, selectParts, testConnection } from "./test-parts.mjs";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// [편집 안내] 전체 실행은 --all일 때만 허용합니다. 인자 누락을 전체 검사로 해석하지 않습니다.
export function parseTestArguments(argv) {
  if (!Array.isArray(argv)) throw new Error("검사 인자를 배열로 전달하세요.");
  const ids = [];
  let list = false;
  let all = false;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (["--list", "--help", "-h"].includes(argument)) list = true;
    else if (argument === "--all") all = true;
    else if (argument === "--part" || argument === "--parts") {
      const value = argv[++index];
      if (typeof value !== "string" || !value || value.startsWith("--"))
        throw new Error(`${argument} 뒤에 검사 파트를 지정하세요.`);
      const values = argument === "--parts" ? value.split(",").map(id => id.trim()) : [value.trim()];
      if (values.some(id => !id)) throw new Error("빈 검사 파트는 지정할 수 없습니다.");
      ids.push(...values);
    } else throw new Error(`알 수 없는 검사 인자: ${String(argument)}`);
  }
  if (all && ids.length || list && (all || ids.length))
    throw new Error("--list, --all, 파트 지정은 함께 사용할 수 없습니다.");
  if (!argv.length || list) return { list: true, parts: [] };
  return { list: false, parts: selectParts(all ? Object.keys(parts) : ids).parts };
}

export function printParts(log = console.log) {
  log("검사 파트 (전체 검사는 --all을 명시한 경우에만 실행):");
  for (const [id, part] of Object.entries(parts))
    log(`  ${id.padEnd(10)} ${part.label} — SQL ${part.sql.length}, JS ${part.js.length}, 아이디 화면 ${part.identity.length}`);
  log("\n예: npm run test:prepare -- --part dashboard → npm test -- --part dashboard");
  log("여러 파트: npm test -- --parts dashboard,content | 전체: npm run test:full");
  log("실제 Auth 통합 검사는 별도 명령 npm run test:auth:native로 실행합니다.");
  log("위 목록만 표시했으며 검사는 실행하지 않았습니다.");
}

// 테스트 파일을 추가하고 파트 배정을 빠뜨려도 녹색으로 넘어가지 않도록 전체 목록을 대조합니다.
export async function validateManifest(root = project) {
  const assigned = new Set();
  for (const [id, part] of Object.entries(parts)) {
    if (!part.label || !["sql", "js", "identity", "fixtures"].every(key => Array.isArray(part[key])))
      throw new Error(`검사 파트 정의가 올바르지 않습니다: ${id}`);
    for (const fixture of part.fixtures)
      if (!fixtureIds.includes(fixture)) throw new Error(`알 수 없는 fixture: ${id}/${fixture}`);
    if (part.identity.length && !part.fixtures.includes("identity"))
      throw new Error(`아이디 화면 검사에 identity fixture가 없습니다: ${id}`);
    for (const kind of ["sql", "js", "identity"]) {
      for (const file of part[kind]) {
        const pattern = kind === "sql" ? /^supabase\/tests\/[a-z0-9.-]+\.test\.mjs$/ : /^tests\/[a-z0-9.-]+\.test\.mjs$/;
        if (typeof file !== "string" || !pattern.test(file)) throw new Error(`잘못된 검사 파일: ${id}/${String(file)}`);
        if (!(await stat(path.join(root, file)).catch(() => null))?.isFile())
          throw new Error(`등록된 검사 파일이 없습니다: ${file}`);
        assigned.add(file);
      }
    }
  }
  for (const directory of ["tests", "supabase/tests"]) {
    for (const file of await readdir(path.join(root, directory), { withFileTypes: true })) {
      const name = `${directory}/${file.name}`;
      if (file.isFile() && file.name.endsWith(".test.mjs") && !assigned.has(name))
        throw new Error(`파트가 지정되지 않은 검사입니다. scripts/test-parts.mjs에 추가하세요: ${name}`);
    }
  }
}

async function fixtureHtml(root, fixture, relative) {
  const directory = path.join(root, fixtureDirectories[fixture]);
  const file = path.join(directory, relative);
  const html = await readFile(file, "utf8").catch(() => {
    throw new Error(`${fixture} fixture가 없습니다: ${path.relative(root, file)}`);
  });
  if (!/<html\b/i.test(html)) throw new Error(`${fixture} fixture의 HTML이 올바르지 않습니다: ${relative}`);
  // 생성 HTML만 남고 번들이 지워진 경우도 준비 완료로 보지 않습니다. 외부 링크는 읽지 않습니다.
  const resources = [...html.matchAll(/<(?:script|link)\b[^>]*(?:src|href)=["']([^"']+)["'][^>]*>/gi)]
    .filter(([tag]) => /^<script\b/i.test(tag) || /\brel=["']stylesheet["']/i.test(tag));
  for (const [, href] of resources) {
    const url = new URL(href, `https://fixture.invalid/${relative}`);
    if (url.origin !== "https://fixture.invalid") continue;
    const resource = path.resolve(directory, "." + decodeURIComponent(url.pathname));
    if (!resource.startsWith(directory + path.sep) || !(await stat(resource).catch(() => null))?.isFile())
      throw new Error(`${fixture} fixture의 로컬 번들이 없습니다: ${href}`);
  }
  return html;
}

export async function validateFixtures(selection, root = project) {
  for (const fixture of selection.fixtures) {
    if (!fixtureIds.includes(fixture)) throw new Error(`알 수 없는 fixture: ${fixture}`);
    if (fixture === "legacy" || fixture === "identity") {
      const html = await fixtureHtml(root, fixture, "admin/index.html");
      const help = await fixtureHtml(root, fixture, "admin/help/index.html");
      const body = html.match(/<body\b[^>]*>/i)?.[0] ?? "";
      const enabled = /\bclass=["'][^"']*\bstaff-identity-auth\b[^"']*["']/i.test(body);
      const helpPanel = help.match(/<[^>]+\bid=["']staff-auth-help["'][^>]*>/i)?.[0] ?? "";
      if (!/\bid=["']staff-login-form["']/.test(html) || enabled !== (fixture === "identity") ||
          !new RegExp(`\\bdata-enabled=["']${fixture === "identity"}["']`).test(helpPanel))
        throw new Error(`${fixture} fixture의 로그인 플래그가 다릅니다. 전용 테스트 빌드를 다시 준비하세요.`);
    } else {
      await fixtureHtml(root, fixture, "index.html");
      if (fixture === "preview") await fixtureHtml(root, fixture, "admin/index.html");
    }
  }
}

// 실행 계획은 순수 값으로 만들어 인자·중복 제거·fixture별 환경을 운영 데이터 없이 검사할 수 있습니다.
export function planTestRuns(ids, env = process.env) {
  const selection = selectParts(ids);
  const baseline = { ...env, ASTRO_TELEMETRY_DISABLED: "1", PUBLIC_CMS_ENABLED: "false", PUBLIC_SCHEDULE_ENABLED: "false",
    PUBLIC_STAFF_IDENTITY_ENABLED: "false", PUBLIC_STAFF_LEGACY_LOGIN_ENABLED: "false",
    PUBLIC_SUPABASE_URL: testConnection.url, PUBLIC_SUPABASE_PUBLISHABLE_KEY: testConnection.publishableKey,
    ADMIN_TEST_DIST: selection.fixtures.includes("legacy") ? fixtureDirectories.legacy : fixtureDirectories.public };
  // 호출자의 플래그가 기본 검사를 아이디 전용 검사로 바꾸거나 해당 검사를 건너뛰게 하지 않습니다.
  delete baseline.STAFF_IDENTITY_TEST_DIST;
  const runs = selection.sql.map(file => ({ label: `SQL ${file}`, args: [file], env: { ...baseline } }));
  if (selection.js.length) runs.push({ label: "선택한 JavaScript 검사", args: ["--test", ...selection.js], env: { ...baseline } });
  if (selection.identity.length) runs.push({ label: "선택한 아이디 화면 검사", args: ["--test", ...selection.identity],
    env: { ...baseline, PUBLIC_STAFF_IDENTITY_ENABLED: "true", PUBLIC_STAFF_LEGACY_LOGIN_ENABLED: "true",
      STAFF_IDENTITY_TEST_DIST: fixtureDirectories.identity } });
  return { ...selection, runs };
}

export async function runTests({ argv = process.argv.slice(2), root = project, env = process.env,
  execute = spawnSync, log = console.log } = {}) {
  const parsed = parseTestArguments(argv);
  if (parsed.list) { printParts(log); return 0; }
  const plan = planTestRuns(parsed.parts, env);
  await validateManifest(root);
  try { await validateFixtures(plan, root); }
  catch (error) {
    throw new Error(`${error.message}\n준비 명령: npm run test:prepare -- --parts ${plan.parts.join(",")}`);
  }
  log(`검사 파트: ${plan.parts.join(", ")} (SQL ${plan.sql.length}, JS ${plan.js.length}, 아이디 화면 ${plan.identity.length})`);
  return executeTestRuns(plan.runs, { root, execute, log });
}

export function executeTestRuns(runs, { root = project, execute = spawnSync, log = console.log } = {}) {
  for (const run of runs) {
    log(`\n${run.label}`);
    const result = execute(process.execPath, run.args, { cwd: root, env: run.env, stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.signal) throw new Error(`검사가 중단되었습니다: ${result.signal}`);
    if (result.status !== 0) return Number.isInteger(result.status) && result.status > 0 ? result.status : 1;
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await runTests(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
