import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const gateName = "Required part checks complete";
const apiOrigin = "https://api.github.com";
const reasons = {
  superseded: "현재 main 커밋이 달라 이전 산출물의 배포를 생략합니다.",
  current_checks_passed: "현재 main의 이번 코드 검사가 통과했습니다.",
  push_run_missing: "같은 main 커밋의 push 검사 실행이 없어 배포를 생략합니다.",
  push_gate_missing: "같은 커밋의 필수 코드 검사 결과가 없어 배포를 생략합니다.",
  push_gate_not_passed: "같은 커밋의 필수 코드 검사가 완료·통과하지 않아 배포를 생략합니다.",
  verified_push: "현재 main 커밋의 push 코드 검사 통과를 확인했습니다.",
};
const invalid = code => new Error(code);
const validSha = value => typeof value === "string" && /^[0-9a-f]{40}$/i.test(value);
const positiveInteger = value => Number.isSafeInteger(value) && value > 0;

// GitHub가 제공한 payload URL도 인증 헤더의 전송 대상으로 쓰지 않습니다.
// 외부 리다이렉트와 오류 원문을 차단해 토큰·응답 데이터가 로그에 남지 않게 합니다.
async function readApi(route, token, request) {
  let response;
  try {
    response = await request(new URL(route, apiOrigin).href, {
      method: "GET", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(30000),
      headers: {
        Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "kansai-release-checks",
      },
    });
  } catch { throw invalid("release_api_unavailable"); }
  if (!response?.ok) throw invalid("release_api_request_failed");
  try { return await response.json(); }
  catch { throw invalid("release_api_invalid_response"); }
}

function latestPushRun(listing, commit) {
  if (!Array.isArray(listing?.workflow_runs)) throw invalid("release_api_invalid_response");
  const candidates = listing.workflow_runs.filter(run => run?.event === "push" && run.head_branch === "main" &&
    typeof run.head_sha === "string" && run.head_sha.toLowerCase() === commit);
  if (!candidates.length) return null;
  if (candidates.some(run => !positiveInteger(run.id) || !positiveInteger(run.run_attempt)))
    throw invalid("release_api_invalid_response");
  // 같은 workflow의 더 최근 실행이 실패했으면 오래된 성공으로 되돌아가지 않습니다.
  return candidates.reduce((latest, item) => item.id > latest.id ? item : latest);
}

function validateRequest({ repository, sha, token, request }) {
  if (typeof repository !== "string" || repository.length > 200 ||
      !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(repository) ||
      [".", ".."].includes(repository.split("/")[1])) throw invalid("release_invalid_repository");
  if (!validSha(sha)) throw invalid("release_invalid_sha");
  if (typeof token !== "string" || !token || token.length > 4096 || /[\x00-\x20\x7f]/.test(token))
    throw invalid("release_missing_token");
  if (typeof request !== "function") throw invalid("release_invalid_request");
  return { commit: sha.toLowerCase(), prefix: `/repos/${repository}` };
}

// 변경 범위의 비교 기준이 현재 main보다 이전일 수 있으므로, 이 함수는 main 위치와 별개로
// 지정한 SHA 자체의 push 코드 검증만 확인합니다. 과거 성공/실패는 새 실행으로 추측하지 않습니다.
export async function verifiedPushGate({ repository, sha, token, request = fetch }) {
  const { commit, prefix } = validateRequest({ repository, sha, token, request });
  const query = new URLSearchParams({ event: "push", branch: "main", head_sha: commit, per_page: "100" });
  const runsRoute = `${prefix}/actions/workflows/deploy.yml/runs?${query}`;
  const run = latestPushRun(await readApi(runsRoute, token, request), commit);
  if (!run) return { eligible: false, reason: "push_run_missing" };
  const gates = [];
  for (let page = 1; page <= 20; page++) {
    const jobs = await readApi(`${prefix}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100&page=${page}`, token, request);
    if (!Array.isArray(jobs?.jobs) || !Number.isSafeInteger(jobs.total_count) || jobs.total_count < 0)
      throw invalid("release_api_invalid_response");
    gates.push(...jobs.jobs.filter(job => job?.name === gateName));
    if (page * 100 >= jobs.total_count) break;
    if (page === 20) throw invalid("release_api_page_limit");
  }
  if (!gates.length) return { eligible: false, reason: "push_gate_missing" };
  if (gates.length !== 1 || gates[0].status !== "completed" || gates[0].conclusion !== "success")
    return { eligible: false, reason: "push_gate_not_passed" };
  // 검사 재실행이 조회 도중 시작되면 직전 시도의 성공을 현재 결과로 재사용하지 않습니다.
  const latest = latestPushRun(await readApi(runsRoute, token, request), commit);
  if (!latest || latest.id !== run.id || latest.run_attempt !== run.run_attempt)
    return { eligible: false, reason: "push_gate_not_passed" };
  return { eligible: true, reason: "verified_push" };
}

// 예약/수동 공개는 같은 커밋의 코드 검사를 재사용하되 실패·진행 중·이전 시도의
// 성공을 통과로 보지 않습니다. push 호출자는 이번 checks_complete 성공 뒤에만 사용합니다.
export async function eligibility({ repository, sha, event, token, request = fetch }) {
  const { commit, prefix } = validateRequest({ repository, sha, token, request });
  if (!["push", "schedule", "workflow_dispatch"].includes(event)) throw invalid("release_invalid_event");
  const main = await readApi(`${prefix}/git/ref/heads/main`, token, request);
  if (main?.ref !== "refs/heads/main" || main?.object?.type !== "commit" || !validSha(main?.object?.sha))
    throw invalid("release_api_invalid_response");
  if (main.object.sha.toLowerCase() !== commit) return { eligible: false, reason: "superseded" };
  if (event === "push") return { eligible: true, reason: "current_checks_passed" };
  return verifiedPushGate({ repository, sha: commit, token, request });
}

// 실패한 코드 변경 다음에 문서만 push해도 검사 범위가 사라지지 않도록 비교 기준을 확인합니다.
// 이 조회가 불가능하면 선택기가 전체 영향 범위로 확장합니다. 접근 오류를 통과로 해석하지 않습니다.
export async function baselineChecksMain({ env = process.env, request = fetch, output = appendFile, log = console.log, readEvent = readFile } = {}) {
  let verified = env.GITHUB_EVENT_NAME !== "push";
  if (!verified) {
    try {
      const payload = JSON.parse(await readEvent(env.GITHUB_EVENT_PATH, "utf8"));
      if (validSha(payload?.before) && !/^0+$/.test(payload.before)) {
        const result = await verifiedPushGate({ repository: env.GITHUB_REPOSITORY, sha: payload.before, token: env.GITHUB_TOKEN, request });
        verified = result.eligible;
      }
    } catch { verified = false; }
  }
  if (env.GITHUB_OUTPUT) await output(env.GITHUB_OUTPUT, `baseline_verified=${verified}\n`);
  log(verified ? "비교 기준 확인: 검증된 기준으로 변경 파트를 선택합니다." : "비교 기준 확인: 이전 검증을 확인할 수 없어 검사 범위를 넓힙니다.");
  return { baseline_verified: verified };
}

// 정상 생략은 eligible=false로 전달합니다. API 장애는 출력 없이 실패하여 배포를 막습니다.
export async function releaseChecksMain({ env = process.env, request = fetch, output = appendFile, log = console.log } = {}) {
  const result = await eligibility({ repository: env.GITHUB_REPOSITORY, sha: env.GITHUB_SHA,
    event: env.GITHUB_EVENT_NAME, token: env.GITHUB_TOKEN, request });
  if (env.GITHUB_OUTPUT) await output(env.GITHUB_OUTPUT, `eligible=${result.eligible}\nreason=${result.reason}\n`);
  log(`배포 확인: ${reasons[result.reason]}`);
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (!args.length) await releaseChecksMain();
    else if (args.length === 1 && args[0] === "--verify-base") await baselineChecksMain();
    else throw invalid("release_invalid_argument");
  }
  catch { console.error("배포 확인에 실패했습니다. GitHub 접근과 실행 결과를 확인하세요."); process.exitCode = 1; }
}
