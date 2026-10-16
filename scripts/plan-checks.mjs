import { appendFile, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { parseGitPaths, planChecks, selectedPartIds } from "./checks-plan-lib.mjs";

const run = promisify(execFile);
const supported = new Set(["event", "base", "head", "parts", "files-json"]);

export function parseArguments(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const argument = args[i];
    if (argument === "--all") { if (options.all) throw new Error("duplicate_argument"); options.all = true; continue; }
    if (!argument.startsWith("--") || !supported.has(argument.slice(2))) throw new Error("unknown_argument");
    const key = argument.slice(2);
    if (Object.hasOwn(options, key) || i + 1 >= args.length || args[i + 1].startsWith("--")) throw new Error("invalid_argument");
    options[key] = args[++i];
  }
  if (options.all && options.parts) throw new Error("conflicting_selection");
  if (options.parts !== undefined) selectedPartIds(options.parts);
  return options;
}

function safeRevision(value) {
  if (typeof value !== "string" || !value || value.startsWith("-") || !/^[A-Za-z0-9_./-]+$/.test(value) || value.includes("..")) throw new Error("invalid_revision");
  return value;
}

// CI의 비교 기준은 event payload에서 가져옵니다. 한 커밋의 부모를 가정하면
// 여러 커밋 push나 삭제/이름 변경 파일이 빠지므로 기준부터 전체 범위를 비교합니다.
export async function changedFiles({ event, payload = {}, base, head, cwd = process.cwd(), git = run }) {
  const baseline = base ?? (event === "pull_request" ? payload.pull_request?.base?.sha : payload.before);
  const target = head ?? (event === "pull_request" ? payload.pull_request?.head?.sha : payload.after) ?? "HEAD";
  if (!baseline || /^0+$/.test(baseline)) return { files: [], fallbackReason: "baseline_unavailable" };
  safeRevision(baseline);
  safeRevision(target);
  try {
    await git("git", ["rev-parse", "--verify", `${baseline}^{commit}`], { cwd, encoding: "utf8", maxBuffer: 1024 * 1024 });
    await git("git", ["rev-parse", "--verify", `${target}^{commit}`], { cwd, encoding: "utf8", maxBuffer: 1024 * 1024 });
    const range = `${baseline}${event === "pull_request" ? "..." : ".."}${target}`;
    // 이름 변경을 삭제+추가로 받으면 이전 경로와 새 경로의 검사 범위를 모두 합칠 수 있습니다.
    const result = await git("git", ["diff", "--name-only", "-z", "--no-renames", range, "--"], { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    return { files: parseGitPaths(result.stdout) };
  } catch (error) {
    if (error?.message === "invalid_git_paths" || error?.message === "invalid_repository_path") throw error;
    return { files: [], fallbackReason: "baseline_unavailable" };
  }
}

export async function main(args = process.argv.slice(2), env = process.env) {
  const options = parseArguments(args);
  const event = options.event ?? env.GITHUB_EVENT_NAME ?? "local";
  // 알 수 없는 이벤트는 Git 호출 전에 거절합니다.
  planChecks({ event });
  if (event === "push" && env.BASELINE_VERIFIED !== undefined && !["true", "false"].includes(env.BASELINE_VERIFIED))
    throw new Error("invalid_baseline_verification");
  let payload = {};
  if (env.GITHUB_EVENT_PATH) payload = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, "utf8"));
  let comparison = { files: [] };
  const requested = options.parts ?? (event === "workflow_dispatch" ? payload.inputs?.part : undefined);
  const forced = requested === "" ? undefined : requested;
  const dispatchAll = forced === "all";
  if (options["files-json"] !== undefined) comparison.files = JSON.parse(options["files-json"]);
  else if (!options.all && !dispatchAll && !forced && !["schedule", "workflow_dispatch"].includes(event))
    comparison = await changedFiles({ event, payload, base: options.base, head: options.head ?? env.GITHUB_SHA });
  // 실패한 코드 push 뒤의 문서-only push가 검증되지 않은 코드를 녹색으로 만들 수 없습니다.
  // CI가 직전 커밋의 성공을 확인하지 못하면 변경 파일의 크기와 무관하게 전체로 확장합니다.
  if (event === "push" && env.BASELINE_VERIFIED === "false") comparison.fallbackReason = "baseline_unverified";
  const plan = planChecks({ ...comparison, event, all: Boolean(options.all || dispatchAll), forceParts: dispatchAll ? undefined : forced });
  // GitHub 출력은 구조화한 값만 한 줄씩 기록합니다. 파일명 개행을 명령 구문에 넣지 않습니다.
  if (env.GITHUB_OUTPUT) {
    const keys = ["matrix", "has_parts", "needs_build", "needs_legacy", "needs_identity", "needs_public", "needs_preview", "native_auth", "selected_parts", "reason", "files_count"];
    await appendFile(env.GITHUB_OUTPUT, keys.map((key) => `${key}=${typeof plan[key] === "string" ? plan[key] : JSON.stringify(plan[key])}\n`).join(""));
  }
  process.stdout.write(JSON.stringify(plan, null, 2) + "\n");
  return plan;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  main().catch(() => { process.stderr.write("Check planning failed: invalid input or comparison metadata.\n"); process.exitCode = 1; });
