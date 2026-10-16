import assert from "node:assert/strict";
import test from "node:test";
import { baselineChecksMain, eligibility, releaseChecksMain, verifiedPushGate } from "../scripts/release-checks.mjs";

const sha = "a".repeat(40);
const otherSha = "b".repeat(40);
const token = "TEST_READ_ONLY_TOKEN_SHOULD_NOT_BE_LOGGED";
const config = { repository: "TEST-Club/kansai", sha, event: "schedule", token };
const gate = { id: 999, name: "Required part checks complete", status: "completed", conclusion: "success" };
const run = { id: 301, run_attempt: 2, head_sha: sha, head_branch: "main", event: "push", status: "completed", conclusion: "success", jobs_url: "https://untrusted.invalid/never-follow" };
function fakeApi({ mainSha = sha, runs = [run], jobs = [gate], pages, status = 200, failure, payload } = {}) {
  const calls = [];
  const request = async (url, options) => {
    calls.push({ url, options });
    assert.equal(new URL(url).origin, "https://api.github.com");
    assert.equal(options.method, "GET"); assert.equal(options.redirect, "error");
    assert.equal(options.headers.Authorization, `Bearer ${token}`);
    if (failure) throw new Error(failure);
    let data;
    if (payload) data = payload(url);
    else if (url.includes("/git/ref/heads/main")) data = { ref: "refs/heads/main", object: { type: "commit", sha: mainSha } };
    else if (url.includes("/actions/workflows/deploy.yml/runs?")) data = { workflow_runs: runs };
    else {
      assert.match(url, /\/actions\/runs\/\d+\/attempts\/\d+\/jobs\?/);
      const page = Number(new URL(url).searchParams.get("page"));
      data = pages ? pages(page) : { total_count: jobs.length, jobs };
    }
    return { ok: status >= 200 && status < 300, status, json: async () => data };
  };
  return { calls, request };
}
async function check(overrides = {}, fixture = {}) {
  const api = fakeApi(fixture);
  return { result: await eligibility({ ...config, ...overrides, request: api.request }), calls: api.calls };
}

test("current push checks permit only the current main commit without querying prior runs", async () => {
  const { result, calls } = await check({ event: "push" });
  assert.deepEqual(result, { eligible: true, reason: "current_checks_passed" });
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).pathname, "/repos/TEST-Club/kansai/git/ref/heads/main");
});

test("superseded push, scheduled and manual artifacts can never deploy", async () => {
  for (const event of ["push", "schedule", "workflow_dispatch"]) {
    const { result, calls } = await check({ event }, { mainSha: otherSha });
    assert.deepEqual(result, { eligible: false, reason: "superseded" }); assert.equal(calls.length, 1);
  }
});

test("scheduled and manual releases require the exact push/main/SHA workflow and current attempt gate", async () => {
  for (const event of ["schedule", "workflow_dispatch"]) {
    const { result, calls } = await check({ event });
    assert.deepEqual(result, { eligible: true, reason: "verified_push" });
    const query = new URL(calls[1].url);
    assert.equal(query.pathname, "/repos/TEST-Club/kansai/actions/workflows/deploy.yml/runs");
    assert.equal(query.searchParams.get("event"), "push"); assert.equal(query.searchParams.get("branch"), "main");
    assert.equal(query.searchParams.get("head_sha"), sha);
    assert.equal(new URL(calls[2].url).pathname, "/repos/TEST-Club/kansai/actions/runs/301/attempts/2/jobs");
    assert.ok(calls.every(({ url }) => !url.includes("untrusted.invalid")));
  }
});

test("failed, skipped, cancelled, pending or missing code gate blocks subsequent scheduled deployment", async () => {
  for (const candidate of [
    { ...gate, conclusion: "failure" }, { ...gate, conclusion: "skipped" },
    { ...gate, conclusion: "cancelled" }, { ...gate, status: "in_progress", conclusion: null },
    { ...gate, status: "queued", conclusion: null },
  ]) assert.deepEqual((await check({}, { jobs: [candidate] })).result, { eligible: false, reason: "push_gate_not_passed" });
  assert.deepEqual((await check({}, { jobs: [] })).result, { eligible: false, reason: "push_gate_missing" });
  assert.equal((await check({}, { jobs: [gate, gate] })).result.eligible, false);
});

test("passed code gate permits retrying failed or cancelled Pages without pretending those releases succeeded", async () => {
  for (const conclusion of ["failure", "cancelled"]) {
    const { result } = await check({}, { runs: [{ ...run, conclusion }], jobs: [gate, { name: "deploy", status: "completed", conclusion }] });
    assert.deepEqual(result, { eligible: true, reason: "verified_push" });
  }
});

test("latest matching run and attempt cannot fall back to older passing gates", async () => {
  const api = fakeApi({ runs: [{ ...run, id: 300, run_attempt: 1 }, { ...run, id: 302, run_attempt: 3, status: "in_progress", conclusion: null }], jobs: [{ ...gate, status: "queued", conclusion: null }] });
  const result = await eligibility({ ...config, request: api.request });
  assert.equal(result.eligible, false);
  assert.match(api.calls[2].url, /\/runs\/302\/attempts\/3\/jobs\?/);
});

test("a newer run or attempt starting during gate lookup invalidates the old success", async () => {
  for (const changed of [{ ...run, run_attempt: 3 }, { ...run, id: 302 }]) {
    let listings = 0;
    const api = fakeApi({ payload: url => url.includes('/git/ref/')
      ? { ref: 'refs/heads/main', object: { type: 'commit', sha } }
      : url.includes('/actions/workflows/')
        ? { workflow_runs: [++listings === 1 ? run : changed] }
        : { total_count: 1, jobs: [gate] } });
    const result = await eligibility({ ...config, request: api.request });
    assert.deepEqual(result, { eligible: false, reason: 'push_gate_not_passed' });
    assert.equal(listings, 2);
  }
});

test("wrong SHA, branch or event cannot supply a successful code gate", async () => {
  for (const candidate of [{ ...run, head_sha: otherSha }, { ...run, head_branch: "feature" }, { ...run, event: "pull_request" }]) {
    const { result, calls } = await check({}, { runs: [candidate] });
    assert.deepEqual(result, { eligible: false, reason: "push_run_missing" }); assert.equal(calls.length, 2);
  }
});

test("current attempt jobs are paged on the fixed API host without following payload URLs", async () => {
  const { result, calls } = await check({}, { pages: page => ({ total_count: 101, jobs: page === 1 ? Array.from({ length: 100 }, (_, id) => ({ id, name: `Part ${id}`, status: "completed", conclusion: "success" })) : [gate] }) });
  assert.equal(result.eligible, true); assert.equal(calls.length, 5);
  assert.equal(new URL(calls[3].url).searchParams.get("page"), "2");
});

test("API authorization, transport and malformed response errors fail closed with fixed sanitized errors", async () => {
  for (const fixture of [{ status: 401 }, { status: 500 }, { failure: token + " network body" }]) {
    const api = fakeApi(fixture);
    await assert.rejects(eligibility({ ...config, request: api.request }), error => error.message.startsWith("release_api_") && !error.message.includes(token));
  }
  for (const payload of [() => ({}), url => url.includes("/git/ref/") ? { ref: "refs/heads/main", object: { type: "commit", sha } } : { workflow_runs: [{ ...run, run_attempt: 0 }] }]) {
    const api = fakeApi({ payload });
    await assert.rejects(eligibility({ ...config, request: api.request }), /release_api_invalid_response/);
  }
  const request = async () => ({ ok: true, json: async () => { throw new Error(token); } });
  await assert.rejects(eligibility({ ...config, request }), error => error.message === "release_api_invalid_response");
});

test("invalid repositories, revisions, events and missing tokens are rejected before any request", async () => {
  let calls = 0;
  const request = () => { calls++; throw new Error("must not request"); };
  for (const override of [
    { repository: "TEST/../elsewhere" }, { repository: "https://untrusted.invalid/a" }, { repository: "TEST/." },
    { repository: "TEST/repo?token=x" }, { sha: "HEAD" }, { sha: sha + "\n" },
    { event: "pull_request" }, { token: "" }, { token: "secret\r\nInjected: value" },
  ]) await assert.rejects(eligibility({ ...config, ...override, request }));
  assert.equal(calls, 0);
});

test("CLI adapter outputs only fixed booleans/reasons and never logs tokens or API payloads", async () => {
  const logs = []; const outputs = [];
  const api = fakeApi();
  const result = await releaseChecksMain({ env: { GITHUB_REPOSITORY: config.repository, GITHUB_SHA: sha, GITHUB_EVENT_NAME: "schedule", GITHUB_TOKEN: token, GITHUB_OUTPUT: "/isolated/github-output" }, request: api.request,
    output: async (...args) => outputs.push(args), log: value => logs.push(value) });
  assert.equal(result.eligible, true);
  assert.deepEqual(outputs, [["/isolated/github-output", "eligible=true\nreason=verified_push\n"]]);
  assert.ok(!JSON.stringify({ logs, outputs }).includes(token));
  assert.ok(!JSON.stringify(logs).includes("workflow_runs"));
  const failedApi = fakeApi({ failure: token });
  await assert.rejects(releaseChecksMain({ env: { GITHUB_REPOSITORY: config.repository, GITHUB_SHA: sha, GITHUB_EVENT_NAME: "schedule", GITHUB_TOKEN: token }, request: failedApi.request,
    output: async (...args) => outputs.push(args), log: value => logs.push(value) }), /release_api_unavailable/);
  assert.equal(logs.length, 1, "API failure logs no raw exception or payload");
});

const baselineEnv = { GITHUB_REPOSITORY: config.repository, GITHUB_SHA: otherSha, GITHUB_EVENT_NAME: "push", GITHUB_TOKEN: token,
  GITHUB_EVENT_PATH: "/isolated/push-event", GITHUB_OUTPUT: "/isolated/baseline-output" };

test("baseline verifier can verify earlier A without incorrectly requiring A to remain current main B", async () => {
  const api = fakeApi({ mainSha: otherSha });
  assert.deepEqual(await verifiedPushGate({ ...config, request: api.request }), { eligible: true, reason: "verified_push" });
  assert.ok(api.calls.every(call => !call.url.includes("/git/ref/")), "baseline validation checks the earlier commit itself");
  assert.equal(new URL(api.calls[0].url).searchParams.get("head_sha"), sha);
});

test("failed or pending critical push A cannot become a verified baseline for a later documentation-only B", async () => {
  for (const conclusion of ["failure", "cancelled", "skipped", null]) {
    const api = fakeApi({ jobs: [{ ...gate, status: conclusion === null ? "in_progress" : "completed", conclusion }] });
    const outputs = []; const logs = [];
    const result = await baselineChecksMain({ env: baselineEnv, request: api.request,
      readEvent: async () => JSON.stringify({ before: sha, after: otherSha }), output: async (...args) => outputs.push(args), log: value => logs.push(value) });
    assert.deepEqual(result, { baseline_verified: false });
    assert.deepEqual(outputs, [["/isolated/baseline-output", "baseline_verified=false\n"]]);
    assert.ok(!JSON.stringify({ outputs, logs }).includes(token));
  }
});

test("a successful earlier push code gate enables narrow checks even if its Pages deployment failed", async () => {
  const api = fakeApi({ runs: [{ ...run, conclusion: "failure" }] });
  const outputs = [];
  const result = await baselineChecksMain({ env: baselineEnv, request: api.request, readEvent: async () => JSON.stringify({ before: sha }),
    output: async (...args) => outputs.push(args), log: () => {} });
  assert.deepEqual(result, { baseline_verified: true });
  assert.deepEqual(outputs, [["/isolated/baseline-output", "baseline_verified=true\n"]]);
});

test("missing workflow, missing gate and API failure widen baseline checks instead of assuming success", async () => {
  for (const fixture of [{ runs: [] }, { jobs: [] }, { status: 401 }, { failure: token + " network detail" }]) {
    const api = fakeApi(fixture);
    const logs = []; const outputs = [];
    const result = await baselineChecksMain({ env: baselineEnv, request: api.request, readEvent: async () => JSON.stringify({ before: sha }),
      output: async (...args) => outputs.push(args), log: value => logs.push(value) });
    assert.deepEqual(result, { baseline_verified: false });
    assert.deepEqual(outputs, [["/isolated/baseline-output", "baseline_verified=false\n"]]);
    assert.ok(!JSON.stringify({ outputs, logs }).includes(token));
  }
});

test("absent, all-zero or malformed push baselines widen checks without requesting an API", async () => {
  for (const payload of ["{}", JSON.stringify({ before: "0".repeat(40) }), JSON.stringify({ before: "HEAD" }), JSON.stringify({ before: "../elsewhere" }), "not-json"]) {
    let calls = 0;
    const result = await baselineChecksMain({ env: baselineEnv, request: async () => { calls++; throw new Error("unexpected API"); },
      readEvent: async () => payload, output: async () => {}, log: () => {} });
    assert.deepEqual(result, { baseline_verified: false }); assert.equal(calls, 0);
  }
  assert.deepEqual(await baselineChecksMain({ env: baselineEnv, readEvent: async () => { throw new Error(token); }, output: async () => {}, log: () => {} }), { baseline_verified: false });
});

test("non-push planning preserves its existing baseline rules without reading event data or requesting an API", async () => {
  for (const event of ["pull_request", "schedule", "workflow_dispatch"]) {
    let calls = 0;
    const result = await baselineChecksMain({ env: { ...baselineEnv, GITHUB_EVENT_NAME: event }, request: async () => { calls++; },
      readEvent: async () => { calls++; }, output: async () => {}, log: () => {} });
    assert.deepEqual(result, { baseline_verified: true }); assert.equal(calls, 0);
  }
});
