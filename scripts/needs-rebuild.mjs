import { appendFile } from "node:fs/promises";
// [편집 안내] 예약 실행에서는 발행 버전이 달라졌을 때만 사이트를 다시 만듭니다.
// 조회에는 공개 키만 사용합니다. GitHub 배포용 비밀키를 관리자 브라우저에 넣지 않습니다.
const url = process.env.PUBLIC_SUPABASE_URL;
const key = process.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY;
let changed = true;
if (process.env.EVENT_NAME === "schedule") {
  if (process.env.PUBLIC_CMS_ENABLED !== "true") changed = false;
  else {
    if (!url || !key?.startsWith("sb_publishable_"))
      throw new Error("CMS 공개 연결 설정이 없습니다.");
    const response = await fetch(
      url + "/rest/v1/publication_state?select=version&id=eq.1",
      { headers: { apikey: key } },
    );
    if (!response.ok) throw new Error("발행 상태를 읽지 못했습니다.");
    const [state] = await response.json();
    if (!state) throw new Error("발행 버전이 없습니다.");
    const live = await fetch(
      "https://ryukkani.github.io/kansai/build.json?check=" + Date.now(),
      { cache: "no-store" },
    );
    if (live.ok) {
      const deployed = await live.json();
      changed =
        !deployed.fromCms || Number(deployed.version) !== Number(state.version);
      // 다가오는 일정은 시각에 따라 달라집니다. 일정 기능 사용 시 예약 빌드마다 갱신합니다.
      if (process.env.PUBLIC_SCHEDULE_ENABLED === "true") changed = true;
    }
  }
}
if (process.env.GITHUB_OUTPUT)
  await appendFile(process.env.GITHUB_OUTPUT, "changed=" + changed + "\n");
console.log(
  changed
    ? "공개 사이트 재구축이 필요합니다."
    : "발행된 콘텐츠에 변경이 없습니다.",
);
