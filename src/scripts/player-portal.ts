import type { SupabaseClient } from "@supabase/supabase-js";
import { text as t } from "../lib/i18n";
import { node, dateLabel, badge, type Row } from "../lib/admin-ui";
import type { ListController } from "./admin-list";

// 선수 화면은 내부 선수·운영 메모·감사 테이블을 읽지 않습니다. 본인 RPC와 이미 공개된 일정만 사용합니다.
export function createPlayerPortal(options: {
  client: SupabaseClient;
  userId: string;
  isCurrent: () => boolean;
}): ListController {
  const element = node("section", "", "office-player-portal staff-directory");
  element.dataset.playerPortal = "true";
  let disposed = false;
  let sequence = 0;
  const current = () => !disposed && options.isCurrent();
  function detail(label: string, value: unknown) {
    const row = node("div", "", "staff-detail");
    row.append(node("dt", label), node("dd", typeof value === "string" || typeof value === "number" ? String(value) || "—" : "—"));
    return row;
  }
  async function refresh() {
    const version = ++sequence;
    element.setAttribute("aria-busy", "true");
    element.replaceChildren(node("p", t("選手ホームを読み込み中…"), "office-loading"));
    try {
      const [account, schedule] = await Promise.all([
        options.client.rpc("office_player_portal"),
        options.client.from("published_schedule")
          .select("resource,id,title,starts_at,ends_at,venue,schedule_status,description")
          .gte("starts_at", new Date().toISOString())
          .order("starts_at").limit(30),
      ]);
      if (!current() || version !== sequence) return;
      if (account.error) throw account.error;
      if (schedule.error) throw schedule.error;
      const data = account.data as Row | null;
      if (!data || data.user_id !== options.userId || !Array.isArray(schedule.data)) throw new Error("invalid_response");
      const profile = data.player && typeof data.player === "object" ? data.player as Row : null;
      const publicProfile = profile?.public_profile && typeof profile.public_profile === "object" ? profile.public_profile as Row : null;
      const own = node("section", "", "staff-card");
      own.append(node("h2", t("自分の選手情報")));
      const fields = node("dl", "", "staff-details");
      fields.append(detail(t("実名"), data.approved_real_name || data.real_name));
      if (data.linked === true && profile) {
        fields.append(
          detail(t("選手の識別番号"), data.player_id),
          detail(t("公開する名前"), publicProfile?.display_name),
          detail(t("ローマ字表記"), publicProfile?.romanized_name),
          detail(t("背番号"), publicProfile?.jersey_number),
          detail(t("ポジション"), publicProfile?.position),
          detail(t("選手紹介"), publicProfile?.bio),
        );
        own.append(fields, node("p", t("選手情報の変更は統括またはスタッフにご相談ください。"), "staff-help"));
      } else {
        own.append(fields, node("p", t("選手情報はまだアカウントに紐付けられていません。統括にご相談ください。"), "staff-help"));
      }
      const events = node("section", "", "staff-card");
      events.append(node("h2", t("参加できる公開予定")), node("p", t("公開が承認された予定のみ表示します。時刻は日本時間です。"), "staff-help"));
      if (!schedule.data.length) events.append(node("p", t("今後の公開予定はありません。"), "staff-help"));
      for (const event of schedule.data as Row[]) {
        const card = node("article", "", "staff-card");
        card.append(node("h3", String(event.title ?? "")), badge(event.schedule_status));
        const values = node("dl", "", "staff-details");
        values.append(detail(t("開始（日本時間）"), dateLabel(event.starts_at, true)), detail(t("終了（日本時間）"), dateLabel(event.ends_at, true)), detail(t("会場"), event.venue));
        card.append(values);
        if (typeof event.description === "string" && event.description) card.append(node("p", event.description));
        events.append(card);
      }
      element.replaceChildren(own, events);
    } catch {
      if (current() && version === sequence) element.replaceChildren(node("p", t("選手情報を取得できませんでした。再読み込みして現在の権限を確認してください。"), "staff-help"));
    } finally {
      if (current() && version === sequence) element.removeAttribute("aria-busy");
    }
  }
  return { element, refresh, dispose() { disposed = true; sequence++; element.replaceChildren(); } };
}
