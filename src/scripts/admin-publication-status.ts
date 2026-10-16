import type { SupabaseClient } from "@supabase/supabase-js";
import { text as t } from "../lib/i18n";
import { dateLabel, icon, node } from "../lib/admin-ui";

type Options = {
  client: SupabaseClient;
  base: string;
  scheduleEnabled: boolean;
  isCurrent: () => boolean;
  element: HTMLElement;
};

// 공개 반영 안내만 담당합니다. 계정·업무 화면이 바뀐 뒤 도착한 결과는 호출자가 제공한 검사로 버립니다.
// 실제 게시·배포는 기존 서버 경로에서 수행하며 이 모듈은 상태를 읽어 표시하기만 합니다.
export async function renderPublicationStatus({ client, base, scheduleEnabled, isCurrent, element }: Options) {
  const state = await client
    .from("publication_state")
    .select("version,changed_at")
    .eq("id", 1)
    .single();
  if (state.error) throw state.error;
  let text = t(
    "公開内容は次回の更新でサイトに反映されます（通常15分間隔。遅れる場合があります）。",
  );
  let status = "unknown";
  try {
    const response = await fetch(base + "build.json", { cache: "no-store" });
    if (response.ok) {
      const deployed = await response.json();
      if (
        !Number.isFinite(Number(deployed.version)) ||
        !Number.isFinite(Number(state.data?.version))
      )
        throw new Error(t("公開版を確認できません。"));
      if (!deployed.fromCms)
        text = t(
          "サイトへの反映をまだ確認できません。時間をおいて再確認してください。",
        );
      else if (scheduleEnabled && deployed.schedulesEnabled !== true) {
        status = "waiting";
        text = t(
          "公開予定のサイト連携は準備中です。保存した予定はまだホームページに表示されません。運営責任者に連携設定をご確認ください。",
        );
      } else if (Number(deployed.version) < Number(state.data?.version)) {
        status = "waiting";
        text = t(
          "サイトへの反映待ちです。通常15分間隔で更新しますが、処理状況により遅れる場合があります。",
        );
      } else {
        status = "synced";
        text =
          t("公開サイトに反映済みです。最終更新：") +
          dateLabel(deployed.builtAt, true);
      }
    }
  } catch {
    /* 배포 상태 조회 실패가 성공한 저장 작업을 취소하지 않도록 합니다. */
  }
  if (!isCurrent()) return;
  element.hidden = false;
  element.dataset.state = status;
  element.replaceChildren(
    icon(status === "synced" ? "check" : "clock"),
    node("span", text),
  );
}
