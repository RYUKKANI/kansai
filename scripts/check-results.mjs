import { appendFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parts } from "./test-parts.mjs";

const boolean = value => {
  if (!["true", "false"].includes(value)) throw new Error("검사 계획의 boolean 출력이 없습니다.");
  return value === "true";
};

// [편집 안내] 선택된 검사가 실패·취소·예상 밖 생략 상태면 배포하지 않습니다.
// 문서만 수정했거나 CMS 변경이 없는 경우의 정상 생략과 검사 누락을 구분합니다.
export function assessCheckResults(needs, event = "local") {
  if (needs?.plan?.result !== "success") throw new Error("파트 선택이 완료되지 않았습니다.");
  const plan = needs.plan.outputs;
  const buildRequired = boolean(plan.needs_build);
  const hasParts = boolean(plan.has_parts);
  const nativeRequired = boolean(plan.native_auth);
  const selected = JSON.parse(plan.selected_parts);
  if (!Array.isArray(selected) || selected.some(id => !Object.hasOwn(parts, id)) ||
      hasParts !== (selected.length > 0)) throw new Error("검사 파트 목록이 올바르지 않습니다.");
  if (buildRequired !== selected.some(id => parts[id].fixtures.length > 0))
    throw new Error("선택한 파트와 화면 준비 계획이 다릅니다.");
  const changed = buildRequired ? boolean(needs.content?.outputs?.changed) : false;
  if (buildRequired && !changed &&
      !(event === "schedule" && selected.length === 1 && selected[0] === "public" && !nativeRequired))
    throw new Error("콘텐츠 변경이 없는 예약 공개 검사만 빌드를 생략할 수 있습니다.");
  const expected = {
    content: buildRequired,
    build: buildRequired && changed,
    part_checks: hasParts && (!buildRequired || changed),
    native_auth: nativeRequired,
  };
  for (const [job, required] of Object.entries(expected)) {
    const actual = needs[job]?.result;
    if (actual !== (required ? "success" : "skipped"))
      throw new Error(`${job}: ${required ? "통과 필요" : "생략 예정"}, 실제 ${actual ?? "없음"}`);
  }
  return { selected, expected, results: Object.fromEntries(Object.keys(expected).map(job => [job, needs[job].result])) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = assessCheckResults(JSON.parse(process.env.CHECK_RESULTS), process.env.GITHUB_EVENT_NAME ?? "local");
    const summary = `선택 파트: ${report.selected.join(", ") || "없음"}\n\n| 검사 단계 | 결과 |\n| --- | --- |\n` +
      Object.entries(report.results).map(([job, result]) => `| ${job} | ${result} |`).join("\n") + "\n";
    console.log(summary);
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
