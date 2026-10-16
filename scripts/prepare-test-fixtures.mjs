import { spawnSync } from "node:child_process";
import { cp, lstat, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureDirectories, selectParts, testConnection } from "./test-parts.mjs";
import { parseTestArguments, printParts, runTests, validateFixtures, validateManifest } from "./run-tests.mjs";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// [편집 안내] 변경 파트에 필요한 화면만 매번 새로 빌드합니다. 운영 공개 연결값을
// 테스트 fixture로 물려주지 않으며, Pages 산출물(dist-site)과 별도 폴더에 둡니다.
export async function prepareTestFixtures(argv = process.argv.slice(2)) {
  const run = argv.includes("--run");
  const artifact = argv.includes("--artifact");
  const parsed = parseTestArguments(argv.filter(argument => !["--run", "--artifact"].includes(argument)));
  if (parsed.list) { printParts(); return 0; }
  await validateManifest(project);
  const selection = selectParts(parsed.parts);
  const fixtures = [...new Set([...selection.fixtures, ...(selection.fixtures.includes("preview") ? ["public"] : [])])];
  const env = {
    ...process.env,
    ASTRO_TELEMETRY_DISABLED: "1",
    PUBLIC_CMS_ENABLED: "false", PUBLIC_SCHEDULE_ENABLED: "false",
    PUBLIC_STAFF_IDENTITY_ENABLED: "false", PUBLIC_STAFF_LEGACY_LOGIN_ENABLED: "false",
    PUBLIC_SUPABASE_URL: testConnection.url,
    PUBLIC_SUPABASE_PUBLISHABLE_KEY: testConnection.publishableKey,
  };
  delete env.STAFF_IDENTITY_TEST_DIST;
  const execute = (program, args, values = env) => {
    const result = spawnSync(program, args, { cwd: project, env: values, stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.signal || result.status !== 0) throw new Error(`화면 준비 실패: ${program} ${args.join(" ")}`);
  };
  console.log(`준비할 파트: ${selection.parts.join(", ")}; 화면: ${fixtures.join(", ") || "없음"}`);
  for (const fixture of fixtures.filter(id => id !== "preview")) {
    const directory = fixtureDirectories[fixture];
    // 생성 폴더가 외부 경로의 링크로 바뀐 경우 빌드 도구가 따라가지 않게 합니다.
    if ((await lstat(path.join(project, directory)).catch(() => null))?.isSymbolicLink())
      throw new Error(`화면 준비 폴더는 심볼릭 링크일 수 없습니다: ${directory}`);
    execute(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build", "--", "--outDir", directory], {
      ...env, PUBLIC_STAFF_IDENTITY_ENABLED: String(fixture === "identity"),
      PUBLIC_STAFF_LEGACY_LOGIN_ENABLED: String(fixture === "identity"),
    });
  }
  if (fixtures.includes("preview")) execute(process.execPath, ["scripts/export-preview.mjs"]);
  await validateFixtures(selection, project);
  if (artifact && fixtures.length) {
    // 업로드 기준 폴더를 고정해 한 종류만 준비해도 dist-legacy 등의 폴더명이 보존됩니다.
    const staging = path.join(project, "part-fixtures");
    if ((await lstat(staging).catch(() => null))?.isSymbolicLink()) throw new Error("검사 산출물 폴더가 링크입니다.");
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging);
    for (const fixture of fixtures) {
      const directory = fixtureDirectories[fixture];
      await cp(path.join(project, directory), path.join(staging, directory), { recursive: true });
    }
  }
  return run ? runTests({ argv: ["--parts", selection.parts.join(",")], root: project }) : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await prepareTestFixtures(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
