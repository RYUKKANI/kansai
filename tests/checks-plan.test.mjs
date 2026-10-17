import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parts, selectParts } from "../scripts/test-parts.mjs";
import { parseGitPaths, partIds, planChecks, repositoryPath, selectedPartIds } from "../scripts/checks-plan-lib.mjs";
import { changedFiles, parseArguments } from "../scripts/plan-checks.mjs";
import { executeTestRuns, parseTestArguments, planTestRuns, runTests, validateFixtures, validateManifest } from "../scripts/run-tests.mjs";
import { assessCheckResults } from "../scripts/check-results.mjs";

const execute = promisify(execFile);
const repository = path.resolve(import.meta.dirname, "..");
const planner = path.join(repository, "scripts/plan-checks.mjs");
const plan = (...files) => planChecks({ files });
const sameParts = (actual, expected) => assert.deepEqual(actual.selected_parts, partIds.filter((id) => expected.includes(id)));

test("chat and attendance modules select their own feature checks", () => {
  for (const [id, module] of [["chat", "club-chat"], ["attendance", "training-attendance"]]) {
    for (const file of [`src/scripts/${module}.ts`, `src/styles/${module}.css`]) {
      const result = plan(file);
      sameParts(result, [id]);
      assert.equal(result.native_auth, false);
    }
  }
});

// 파일 단위 선택이 작게 유지되면서 권한·기반 변경은 넓게 검사하는지 확인합니다.
test("dashboard module and extracted publication status run only the dashboard fixture", () => {
  for (const file of ["src/scripts/admin-dashboard.ts", "src/scripts/admin-publication-status.ts", "src/styles/admin-dashboard.css"]) {
    const result = plan(file);
    sameParts(result, ["dashboard"]);
    assert.equal(result.native_auth, false);
    assert.equal(result.needs_legacy, true);
    assert.equal(result.needs_identity, false);
    assert.equal(result.needs_public, false);
    assert.equal(result.needs_preview, false);
  }
});

test("documentation and an empty diff do not build or run authentication", () => {
  for (const files of [[], ["README.md", "AGENTS.md", "docs/new-check-guide.md"], ["NEW_OPERATION_GUIDE.md"]]) {
    const result = planChecks({ files });
    sameParts(result, []);
    for (const key of ["has_parts", "needs_build", "needs_legacy", "needs_identity", "needs_public", "needs_preview", "native_auth"])
      assert.equal(result[key], false, key);
  }
});

test("authentication boundaries require authentication, members, security and real Auth", () => {
  for (const file of ["src/scripts/staff-auth.ts", "src/scripts/staff-auth-help.ts", "src/scripts/owner-account-management.ts", "src/lib/member-grades.ts"]) {
    const result = plan(file);
    sameParts(result, ["auth", "members", "security"]);
    assert.equal(result.native_auth, true);
    assert.equal(result.needs_identity, true);
  }
});

test("shared admin controller stays conservative after extracting dashboard-only code", () => {
  const result = plan("src/scripts/admin.ts");
  sameParts(result, partIds.filter((id) => !["public", "tooling"].includes(id)));
  assert.equal(result.native_auth, true);
});

test("shared styles and language changes expand browser coverage without native Auth", () => {
  for (const file of ["src/styles/admin.css", "src/styles/global.css", "src/styles/new-shared.css", "src/lib/i18n.ts", "src/data/locales/ko.ts", "src/components/LanguageSwitcher.astro", "src/data/club.ts"]) {
    const result = plan(file);
    assert.ok(result.selected_parts.includes("dashboard"));
    assert.ok(result.selected_parts.includes("auth"));
    assert.ok(result.selected_parts.includes("players"));
    assert.equal(result.native_auth, false);
  }
});

test("generated file ignore rules validate build tooling without native Auth", () => {
  const result = plan(".gitignore");
  sameParts(result, ["public", "tooling"]);
  assert.equal(result.native_auth, false);
});

test("migrations, dependencies, workflows and unknown code never silently skip tests", () => {
  for (const file of ["supabase/migrations/20990101000000_new_policy.sql", "supabase/functions/staff-auth/gateway.ts", "package-lock.json", ".github/workflows/deploy.yml", "scripts/run-tests.mjs", "scripts/prepare-test-fixtures.mjs", "scripts/check-results.mjs", "scripts/release-checks.mjs", "src/lib/new-unmapped-helper.ts", "tests/new-unmapped.test.mjs"]) {
    const result = plan(file);
    sameParts(result, partIds);
    assert.equal(result.native_auth, true);
    assert.equal(result.needs_build, true);
  }
});

test("test-only changes select every owning part from the manifest", () => {
  const file = "tests/office.test.mjs";
  const owners = partIds.filter((id) => ["sql", "js", "identity"].some((kind) => parts[id][kind].includes(file)));
  const result = plan(file);
  sameParts(result, owners);
  assert.equal(result.native_auth, false);
});

test("multiple changed parts form one stable union with exact fixture requirements", () => {
  const result = plan("src/scripts/admin-dashboard.ts", "src/scripts/admin-player.ts", "src/pages/ko/index.astro", "src/scripts/admin-dashboard.ts");
  sameParts(result, ["dashboard", "players", "media", "content", "public"]);
  assert.equal(result.files_count, 3);
  assert.equal(result.needs_legacy, true);
  assert.equal(result.needs_identity, true);
  assert.equal(result.needs_public, true);
  assert.equal(result.needs_preview, true);
  assert.equal(result.native_auth, false);
  assert.deepEqual(result.matrix, { part: result.selected_parts });
});

test("scheduled CMS checks use only public tests and no Auth or private fixture", () => {
  const result = planChecks({ event: "schedule", files: ["supabase/functions/staff-auth/gateway.ts"] });
  sameParts(result, ["public"]);
  assert.equal(result.native_auth, false);
  assert.equal(result.needs_legacy, false);
  assert.equal(result.needs_identity, false);
  assert.equal(result.needs_public, true);
  assert.equal(result.needs_preview, true);
  assert.deepEqual(parts.public.sql, []);
  assert.deepEqual(parts.public.identity, []);
  assert.equal(parts.public.js.some((file) => /auth|admin|staff|member|localization/.test(file)), false);
});

test("explicit parts and all are intentional selections; missing baseline expands all", () => {
  sameParts(planChecks({ forceParts: "dashboard,players,dashboard" }), ["dashboard", "players"]);
  assert.equal(planChecks({ forceParts: "dashboard" }).native_auth, false);
  assert.equal(planChecks({ forceParts: "auth" }).native_auth, true);
  assert.equal(planChecks({ forceParts: "members" }).native_auth, true);
  sameParts(planChecks({ event: "workflow_dispatch" }), ["dashboard"]);
  assert.equal(planChecks({ event: "workflow_dispatch" }).native_auth, false);
  for (const result of [planChecks({ all: true }), planChecks({ fallbackReason: "baseline_unavailable" })]) {
    sameParts(result, partIds);
    assert.equal(result.native_auth, true);
  }
});

test("invalid flags, unknown or empty parts and outside paths fail explicitly", () => {
  for (const args of [["--unknown"], ["dashboard"], ["--parts"], ["--parts", ""], ["--parts", "unknown"], ["--all", "--parts", "dashboard"], ["--event", "push", "--event", "schedule"]])
    assert.throws(() => parseArguments(args));
  for (const value of ["", "unknown", [], ["dashboard", "unknown"]]) assert.throws(() => selectedPartIds(value));
  for (const file of ["../outside.ts", "/tmp/outside.ts", "C:\\outside.ts", "src/../../outside.ts", "src\0bad.ts", "-option"])
    assert.throws(() => repositoryPath(file));
  assert.throws(() => planChecks({ files: "README.md" }));
  assert.throws(() => planChecks({ event: "pull_requests" }));
});

test("NUL-safe paths retain whitespace, rename endpoints and deleted filenames", () => {
  const value = "src/scripts/staff-auth.ts\0docs/old auth name.md\0src/data/new\nname.json\0";
  assert.deepEqual(parseGitPaths(value), ["src/scripts/staff-auth.ts", "docs/old auth name.md", "src/data/new\nname.json"]);
  assert.throws(() => parseGitPaths("src/scripts/staff-auth.ts\n"));
  const result = planChecks({ files: parseGitPaths(value) });
  assert.equal(result.native_auth, true);
  assert.ok(result.selected_parts.includes("auth"));
  assert.ok(result.selected_parts.includes("public"));
});

test("manifest selection deduplicates work within each independent fixture phase", () => {
  const selected = selectParts(["auth", "members", "security", "auth"]);
  for (const kind of ["parts", "sql", "js", "identity", "fixtures"])
    assert.equal(new Set(selected[kind]).size, selected[kind].length, kind);
  assert.ok(selected.js.includes("tests/admin-session-security.test.mjs"));
  assert.ok(selected.identity.includes("tests/admin-session-security.test.mjs"), "same suite intentionally runs against both built modes");
  assert.throws(() => selectParts(["unknown"]));
});

test("runner lists parts without executing tests and rejects ambiguous or unknown choices", async () => {
  let calls = 0;
  const run = (argv) => runTests({ argv, execute: () => { calls++; return { status: 0 }; }, log: () => {} });
  assert.equal(await run([]), 0);
  assert.equal(await run(["--list"]), 0);
  for (const args of [["--part", "unknown"], ["--part"], ["--parts", "dashboard,,auth"], ["--all", "--part", "dashboard"], ["--list", "--all"]])
    await assert.rejects(run(args));
  assert.equal(calls, 0);
  assert.deepEqual(parseTestArguments(["--parts", "dashboard,dashboard"]), { list: false, parts: ["dashboard"] });
  assert.deepEqual(parseTestArguments(["--all"]).parts, partIds);
});

test("runner prevents fixture flags from skipping or retargeting selected tests", () => {
  const result = planTestRuns(["auth", "security"], { STAFF_IDENTITY_TEST_DIST: "unsafe-old-build", ADMIN_TEST_DIST: "unsafe", PUBLIC_SUPABASE_URL: "https://live.invalid" });
  const normal = result.runs.find((run) => run.args[0] === "--test" && !run.env.STAFF_IDENTITY_TEST_DIST);
  const identity = result.runs.find((run) => run.env.STAFF_IDENTITY_TEST_DIST);
  assert.ok(normal);
  assert.equal(normal.env.ADMIN_TEST_DIST, "dist-legacy");
  assert.equal(normal.env.PUBLIC_SUPABASE_URL, "https://identity-test.supabase.co");
  assert.equal(normal.env.PUBLIC_STAFF_IDENTITY_ENABLED, "false");
  assert.equal(identity.env.STAFF_IDENTITY_TEST_DIST, "dist-identity");
  assert.equal(identity.env.PUBLIC_STAFF_IDENTITY_ENABLED, "true");
  for (const run of result.runs) assert.equal(new Set(run.args).size, run.args.length, "each suite occurs once within its fixture phase");
});

test("runner stops at the first nonzero exit and treats process failure as failure", () => {
  const runs = [1, 2, 3].map((n) => ({ label: `isolated ${n}`, args: [`test-${n}.mjs`], env: {} }));
  let calls = 0;
  assert.equal(executeTestRuns(runs, { execute: () => ({ status: ++calls === 2 ? 7 : 0 }), log: () => {} }), 7);
  assert.equal(calls, 2);
  assert.equal(executeTestRuns(runs, { execute: () => ({ status: null }), log: () => {} }), 1);
  assert.throws(() => executeTestRuns(runs, { execute: () => ({ signal: "SIGTERM" }), log: () => {} }));
  assert.throws(() => executeTestRuns(runs, { execute: () => ({ error: new Error("test launch unavailable") }), log: () => {} }));
});

test("missing, wrong-mode and incomplete local bundles are rejected before tests", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kansai-part-fixtures-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(validateFixtures({ fixtures: ["identity"] }, root), /fixture/);
  await mkdir(path.join(root, "dist-identity/admin/help"), { recursive: true });
  await writeFile(path.join(root, "dist-identity/admin/index.html"), '<html><body><form id="staff-login-form"></form></body></html>');
  await writeFile(path.join(root, "dist-identity/admin/help/index.html"), '<html><body><div id="staff-auth-help" data-enabled="false"></div></body></html>');
  await assert.rejects(validateFixtures({ fixtures: ["identity"] }, root), /로그인 플래그/);
  await writeFile(path.join(root, "dist-identity/admin/index.html"), '<html><body class="staff-identity-auth"><form id="staff-login-form"></form><script src="/_astro/missing.js"></script></body></html>');
  await assert.rejects(validateFixtures({ fixtures: ["identity"] }, root), /로컬 번들/);
});

test("a newly added test without a manifest assignment is rejected rather than silently omitted", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kansai-part-manifest-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const file of new Set(partIds.flatMap((id) => ["sql", "js", "identity"].flatMap((kind) => parts[id][kind])))) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), "// isolated manifest fixture\n");
  }
  await validateManifest(root);
  await writeFile(path.join(root, "tests/unassigned-new.test.mjs"), "// deliberately unassigned\n");
  await assert.rejects(validateManifest(root), /파트가 지정되지 않은 검사/);
});

// 최종 배포 관문은 계획상 정상 생략과 필요한 검사의 누락을 구분해야 합니다.
// 실제 Actions needs 구조를 사용하며 테스트 실패를 다른 단계의 성공으로 덮지 않습니다.
function gateFixture({ selected = ["dashboard"], build = true, native = false, changed = true } = {}) {
  return {
    plan: { result: "success", outputs: { needs_build: String(build), has_parts: String(selected.length > 0), native_auth: String(native), selected_parts: JSON.stringify(selected) } },
    content: { result: build ? "success" : "skipped", outputs: build ? { changed: String(changed) } : {} },
    build: { result: build && changed ? "success" : "skipped" },
    part_checks: { result: selected.length && (!build || changed) ? "success" : "skipped" },
    native_auth: { result: native ? "success" : "skipped" },
  };
}

test("deployment gate accepts documentation-only planned skips without building or deploying", () => {
  const needs = gateFixture({ selected: [], build: false });
  const report = assessCheckResults(needs);
  assert.deepEqual(report.selected, []);
  assert.deepEqual(report.expected, { content: false, build: false, part_checks: false, native_auth: false });
  assert.ok(Object.values(report.results).every((value) => value === "skipped"));
});

test("deployment gate accepts unchanged scheduled CMS after a successful content version check", () => {
  const needs = gateFixture({ selected: ["public"], changed: false });
  const report = assessCheckResults(needs, "schedule");
  assert.deepEqual(report.expected, { content: true, build: false, part_checks: false, native_auth: false });
  assert.equal(report.results.content, "success");
  for (const status of ["failure", "skipped", "cancelled"]) {
    const rejected = structuredClone(needs);
    rejected.content.result = status;
    assert.throws(() => assessCheckResults(rejected, "schedule"), /content/);
  }
});

test("only a public-only scheduled CMS check may use unchanged content to skip selected tests", () => {
  const publicUnchanged = gateFixture({ selected: ["public"], changed: false });
  for (const event of ["local", "push", "pull_request", "workflow_dispatch"])
    assert.throws(() => assessCheckResults(publicUnchanged, event), /예약 공개 검사/);
  for (const options of [
    { selected: ["dashboard"], changed: false },
    { selected: ["auth"], changed: false },
    { selected: ["public", "tooling"], changed: false },
    { selected: ["public"], native: true, changed: false },
  ]) assert.throws(() => assessCheckResults(gateFixture(options), "schedule"), /예약 공개 검사/);
});

test("deployment gate derives required build fixtures from selected parts rather than trusting a mismatched flag", () => {
  for (const options of [
    { selected: ["dashboard"], build: false },
    { selected: ["auth"], build: false },
    { selected: ["tooling"], build: true },
    { selected: [], build: true },
  ]) assert.throws(() => assessCheckResults(gateFixture(options)), /화면 준비 계획/);
});

test("tooling requires its selected matrix checks even with no fixture build", () => {
  const needs = gateFixture({ selected: ["tooling"], build: false });
  assert.deepEqual(assessCheckResults(needs).expected, { content: false, build: false, part_checks: true, native_auth: false });
  for (const status of ["failure", "skipped", "cancelled", undefined]) {
    const rejected = structuredClone(needs);
    rejected.part_checks.result = status;
    assert.throws(() => assessCheckResults(rejected), /part_checks/);
  }
});

test("selected part or required native Auth failure, cancellation and unexpected skip block deployment", () => {
  const needs = gateFixture({ selected: ["auth", "security"], native: true });
  assert.equal(assessCheckResults(needs).results.native_auth, "success");
  for (const job of ["part_checks", "native_auth"]) {
    for (const status of ["failure", "cancelled", "skipped", undefined]) {
      const rejected = structuredClone(needs);
      rejected[job].result = status;
      assert.throws(() => assessCheckResults(rejected), new RegExp(job));
    }
  }
});

test("a failed or missing build cannot become green through successful later jobs", () => {
  const needs = gateFixture();
  for (const status of ["failure", "cancelled", "skipped", undefined]) {
    const rejected = structuredClone(needs);
    rejected.build.result = status;
    assert.throws(() => assessCheckResults(rejected), /build/);
  }
  const noContentResult = structuredClone(needs);
  delete noContentResult.content.outputs.changed;
  assert.throws(() => assessCheckResults(noContentResult));
});

test("gate rejects malformed plans and unexpected executed jobs instead of assuming success", () => {
  for (const status of ["failure", "cancelled", "skipped", undefined]) {
    const rejected = gateFixture();
    rejected.plan.result = status;
    assert.throws(() => assessCheckResults(rejected));
  }
  for (const outputs of [
    { needs_build: "" }, { native_auth: "yes" }, { has_parts: "false" },
    { selected_parts: "not-json" }, { selected_parts: '["unknown"]' }, { selected_parts: "{}" },
  ]) {
    const rejected = gateFixture();
    Object.assign(rejected.plan.outputs, outputs);
    assert.throws(() => assessCheckResults(rejected));
  }
  const unexpectedNative = gateFixture({ selected: [], build: false });
  unexpectedNative.native_auth.result = "success";
  assert.throws(() => assessCheckResults(unexpectedNative), /native_auth/);
});

async function temporaryGit(t) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "kansai-check-plan-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const git = async (...args) => (await execute("git", args, { cwd, encoding: "utf8" })).stdout.trim();
  const write = async (file, value) => { await mkdir(path.dirname(path.join(cwd, file)), { recursive: true }); await writeFile(path.join(cwd, file), value); };
  const commit = async (message) => { await git("add", "--all"); await git("commit", "-qm", message); return git("rev-parse", "HEAD"); };
  await git("init", "-q", "--initial-branch=main");
  await git("config", "user.name", "Isolated Check Test");
  await git("config", "user.email", "check-test@example.invalid");
  await write("README.md", "isolated fixture\n");
  const baseline = await commit("baseline");
  return { cwd, git, write, commit, baseline };
}

test("real push comparison covers every commit rather than only the last commit", async (t) => {
  const fixture = await temporaryGit(t);
  await fixture.write("src/scripts/staff-auth.ts", "first change\n");
  await fixture.commit("first auth change");
  await fixture.write("src/scripts/admin-dashboard.ts", "second change\n");
  const head = await fixture.commit("second dashboard change");
  const comparison = await changedFiles({ event: "push", payload: { before: fixture.baseline, after: head }, cwd: fixture.cwd });
  assert.deepEqual(comparison.files.sort(), ["src/scripts/admin-dashboard.ts", "src/scripts/staff-auth.ts"]);
  assert.equal(planChecks(comparison).native_auth, true);
});

test("real PR comparison uses merge base and excludes changes only on the base branch", async (t) => {
  const fixture = await temporaryGit(t);
  await fixture.git("checkout", "-qb", "feature");
  await fixture.write("src/scripts/admin-dashboard.ts", "feature change\n");
  const head = await fixture.commit("feature");
  await fixture.git("checkout", "-q", "main");
  await fixture.write("supabase/migrations/20990101000000_base_only.sql", "base change\n");
  const base = await fixture.commit("base-only change");
  const comparison = await changedFiles({ event: "pull_request", payload: { pull_request: { base: { sha: base }, head: { sha: head } } }, cwd: fixture.cwd });
  assert.deepEqual(comparison.files, ["src/scripts/admin-dashboard.ts"]);
  sameParts(planChecks(comparison), ["dashboard"]);
});

test("real rename and deletion keep the old authentication scope and embedded newlines", async (t) => {
  const fixture = await temporaryGit(t);
  await fixture.write("src/scripts/staff-auth.ts", "same contents\n");
  await fixture.write("src/data/deleted\nname.json", "deleted contents\n");
  const base = await fixture.commit("source fixtures");
  await mkdir(path.join(fixture.cwd, "docs"), { recursive: true });
  await rename(path.join(fixture.cwd, "src/scripts/staff-auth.ts"), path.join(fixture.cwd, "docs/auth-moved.md"));
  await rm(path.join(fixture.cwd, "src/data/deleted\nname.json"));
  const head = await fixture.commit("rename and remove");
  const comparison = await changedFiles({ event: "push", base, head, cwd: fixture.cwd });
  assert.deepEqual(comparison.files.sort(), ["docs/auth-moved.md", "src/data/deleted\nname.json", "src/scripts/staff-auth.ts"]);
  assert.equal(planChecks(comparison).native_auth, true);
});

test("missing, all-zero and unavailable Git baselines choose all; malformed revisions are rejected", async (t) => {
  const fixture = await temporaryGit(t);
  for (const base of [undefined, "0".repeat(40), "f".repeat(40)]) {
    const comparison = await changedFiles({ event: "push", base, head: fixture.baseline, cwd: fixture.cwd });
    assert.equal(comparison.fallbackReason, "baseline_unavailable");
    sameParts(planChecks(comparison), partIds);
  }
  for (const base of ["--output=/tmp/no", "HEAD; false", "../outside"]) await assert.rejects(changedFiles({ event: "push", base, head: fixture.baseline, cwd: fixture.cwd }));
});

async function runPlanner(args, env = {}, cwd = repository) {
  const clean = { ...process.env };
  for (const key of ["GITHUB_EVENT_NAME", "GITHUB_EVENT_PATH", "GITHUB_SHA", "GITHUB_OUTPUT", "BASELINE_VERIFIED"]) delete clean[key];
  return execute(process.execPath, [planner, ...args], { cwd, encoding: "utf8", env: { ...clean, ...env } });
}

test("actual CLI reads PR and multicommit push baselines from event files in an isolated Git repository", async (t) => {
  const fixture = await temporaryGit(t);
  await fixture.git("checkout", "-qb", "feature");
  await fixture.write("src/scripts/staff-auth.ts", "first feature commit\n");
  await fixture.commit("auth change");
  await fixture.write("src/scripts/admin-dashboard.ts", "second feature commit\n");
  const head = await fixture.commit("dashboard change");
  await fixture.git("checkout", "-q", "main");
  await fixture.write("supabase/migrations/20990101000000_main_only.sql", "base-only\n");
  const base = await fixture.commit("base moves independently");
  const eventPath = path.join(fixture.cwd, "event.json");
  for (const [event, payload] of [
    ["push", { before: fixture.baseline, after: head }],
    ["pull_request", { pull_request: { base: { sha: base }, head: { sha: head } } }],
  ]) {
    await writeFile(eventPath, JSON.stringify(payload));
    const result = await runPlanner([], { GITHUB_EVENT_NAME: event, GITHUB_EVENT_PATH: eventPath }, fixture.cwd);
    const selected = JSON.parse(result.stdout);
    sameParts(selected, ["dashboard", "auth", "members", "security"]);
    assert.equal(selected.files_count, 2);
    assert.equal(selected.native_auth, true);
    assert.ok(!selected.reason.includes("baseline_unavailable"));
  }
});

test("a documentation push after an unverified critical push requires all parts and real Auth", async (t) => {
  const fixture = await temporaryGit(t);
  await fixture.write("src/scripts/staff-auth.ts", "critical change awaiting successful checks\n");
  const unverified = await fixture.commit("unverified critical change");
  await fixture.write("README.md", "later documentation-only change\n");
  const head = await fixture.commit("documentation follows failed critical push");
  const eventPath = path.join(fixture.cwd, "event.json");
  await writeFile(eventPath, JSON.stringify({ before: unverified, after: head }));
  const context = { GITHUB_EVENT_NAME: "push", GITHUB_EVENT_PATH: eventPath };
  const required = JSON.parse((await runPlanner([], { ...context, BASELINE_VERIFIED: "false" }, fixture.cwd)).stdout);
  sameParts(required, partIds);
  assert.equal(required.reason, "baseline_unverified");
  assert.equal(required.native_auth, true);
  assert.equal(required.needs_build, true);
  assert.deepEqual(required.files, ["README.md"], "the small diff cannot hide previously untested code");
  for (const verified of [undefined, "true"]) {
    const env = verified === undefined ? context : { ...context, BASELINE_VERIFIED: verified };
    const ordinary = JSON.parse((await runPlanner([], env, fixture.cwd)).stdout);
    sameParts(ordinary, []);
    assert.equal(ordinary.native_auth, false, "verified baseline or local backward compatibility retains the normal documentation selection");
  }
});

test("push baseline verification cannot be bypassed by an explicit small part or malformed CI value", async () => {
  const result = await runPlanner(["--event", "push", "--parts", "dashboard"], { BASELINE_VERIFIED: "false" });
  sameParts(JSON.parse(result.stdout), partIds);
  assert.equal(JSON.parse(result.stdout).reason, "baseline_unverified");
  await assert.rejects(runPlanner(["--event", "push", "--files-json", '["README.md"]'], { BASELINE_VERIFIED: "unknown" }), (error) => error.code === 1 && error.stdout === "");
  const nonPush = await runPlanner(["--event", "pull_request", "--files-json", '["README.md"]'], { BASELINE_VERIFIED: "false" });
  sameParts(JSON.parse(nonPush.stdout), []);
});

test("CLI --files-json emits JSON and safe machine-readable GitHub booleans", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "kansai-plan-output-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = path.join(directory, "output.txt");
  const result = await runPlanner(["--files-json", JSON.stringify(["src/scripts/admin-dashboard.ts"])], { GITHUB_OUTPUT: output });
  sameParts(JSON.parse(result.stdout), ["dashboard"]);
  const fields = Object.fromEntries((await readFile(output, "utf8")).trim().split("\n").map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
  assert.equal(fields.has_parts, "true");
  assert.equal(fields.native_auth, "false");
  assert.equal(fields.needs_public, "false");
  assert.deepEqual(JSON.parse(fields.matrix), { part: ["dashboard"] });
  assert.deepEqual(JSON.parse(fields.selected_parts), ["dashboard"]);
});

test("CLI dispatch selects a named part or all without relying on a Git baseline", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "kansai-plan-event-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const eventPath = path.join(directory, "event.json");
  for (const selected of ["dashboard", "all", ""]) {
    await writeFile(eventPath, JSON.stringify({ inputs: { part: selected } }));
    const result = await runPlanner([], { GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_EVENT_PATH: eventPath });
    sameParts(JSON.parse(result.stdout), selected === "all" ? partIds : ["dashboard"]);
  }
});

test("CLI rejects unknown fields and repository escape paths without returning a passing empty plan", async () => {
  for (const args of [["--parts", "does-not-exist"], ["--files-json", '["../escape.ts"]'], ["--files-json", '{"file":"README.md"}'], ["--event", "pull_requests"]]) {
    await assert.rejects(runPlanner(args), (error) => error.code === 1 && error.stdout === "" && /Check planning failed/.test(error.stderr));
  }
});
