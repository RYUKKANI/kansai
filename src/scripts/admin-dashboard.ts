import { text as t, format, currentLocale, intlLocales } from "../lib/i18n";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resources, type Resource } from "../lib/admin-config";
import type { StaffRole } from "../lib/content-types";
import { resourceAvailable, scheduleEnabled } from "../lib/office-features";
import { contentEnabled } from "../lib/office-features";
import {
  action,
  badge,
  dateLabel,
  emptyState,
  icon,
  japanInput,
  node,
  panel,
  roleLabels,
  selectFields,
  type ListFilter,
  type Row,
  type OfficePage,
} from "../lib/admin-ui";

// [편집 안내] 대시보드는 실제 레코드·COUNT·감사 이력만 읽습니다. 권한 밖의 업무를 0건으로 표시하지 않습니다.
type ReadResult = { data: Row[] | null; error: unknown; count?: number | null };
async function read(
  request: PromiseLike<{
    data: unknown;
    error: unknown;
    count?: number | null;
  }>,
): Promise<ReadResult> {
  const response = await request;
  if (response.error) throw response.error;
  if (
    response.data !== null &&
    (!Array.isArray(response.data) ||
      response.data.some((row) => !row || typeof row !== "object"))
  )
    throw new Error(t("管理情報の形式を確認できませんでした。"));
  return {
    data: response.data as Row[] | null,
    error: null,
    count: response.count,
  };
}
interface Options {
  client: SupabaseClient;
  role: StaffRole;
  userId: string;
  email: string;
  go: (resource: OfficePage, filter?: ListFilter) => void;
  create: (resource: Resource) => void;
  open: (resource: Resource, row: Row) => void;
}
export async function buildDashboard({
  client,
  role,
  userId,
  email,
  go,
  create,
  open,
}: Options): Promise<HTMLElement> {
  const visible = (Object.keys(resources) as Resource[]).filter(
    (resource) =>
      resources[resource].roles.includes(role) && resourceAvailable(resource),
  );
  const allowed = (resource: Resource) => visible.includes(resource);
  const publishable = visible.filter(
    (resource) => resources[resource].canPublish.length > 0,
  );
  const now = new Date().toISOString();
  const blank: ReadResult = { data: [], error: null, count: 0 };
  const schedules: ("fixtures" | "training_sessions" | "club_events")[] = [
    "fixtures",
    "training_sessions",
    ...(scheduleEnabled ? ["club_events" as const] : []),
  ];
  // 독립적인 조회는 동시에 실행합니다. 날짜가 지났거나 취소된 일정은 '향후 일정'에 포함하지 않습니다.
  const [
    news,
    players,
    upcoming,
    pending,
    consent,
    changedMatches,
    undatedMatches,
    history,
  ] = await Promise.all([
    allowed("articles")
      ? read(
          client
            .from("articles")
            .select("id", { head: true, count: "exact" })
            .eq("status", "published"),
        )
      : blank,
    allowed("players")
      ? read(
          client.from("players").select("id", { head: true, count: "exact" }),
        )
      : blank,
    Promise.all(
      schedules.map(async (resource) => ({
        resource,
        response: allowed(resource)
          ? await read(
              client
                .from(resource)
                .select(selectFields(resource), { count: "exact" })
                .gte(resource === "fixtures" ? "kickoff_at" : "starts_at", now)
                .eq(
                  resource === "fixtures" ? "match_status" : "session_status",
                  "scheduled",
                )
                .order(resource === "fixtures" ? "kickoff_at" : "starts_at")
                .limit(5),
            )
          : blank,
      })),
    ),
    Promise.all(
      publishable.map(async (resource) => ({
        resource,
        response: await read(
          client
            .from(resource)
            .select(
              resources[resource].key + "," + resources[resource].titleField,
              { count: "exact" },
            )
            .eq("status", "pending")
            .order("updated_at", { ascending: false })
            .limit(2),
        ),
      })),
    ),
    allowed("players")
      ? read(
          client
            .from("players")
            .select("id,internal_name", { count: "exact" })
            .eq("activity_status", "active")
            .or("profile_consent.eq.false,photo_consent.eq.false")
            .limit(2),
        )
      : blank,
    allowed("fixtures")
      ? read(
          client
            .from("fixtures")
            .select("id,opponent", { count: "exact" })
            .in("match_status", ["postponed", "cancelled"])
            .gte("kickoff_at", now)
            .limit(2),
        )
      : blank,
    allowed("fixtures")
      ? read(
          client
            .from("fixtures")
            .select("id,opponent", { count: "exact" })
            .eq("match_status", "scheduled")
            .is("kickoff_at", null)
            .limit(2),
        )
      : blank,
    read(
      client
        .from("audit_logs")
        .select("id,actor_id,actor_role,entity,record_id,operation,occurred_at")
        .order("occurred_at", { ascending: false })
        .limit(6),
    ),
  ]);
  const root = node("div", "", "office-dashboard");
  const stats = node("div", "", "admin-stats");
  function stat(
    title: string,
    count: number,
    caption: string,
    iconName: string,
    callback: () => void,
  ) {
    const card = action("", "admin-stat", callback);
    card.replaceChildren();
    card.setAttribute("aria-label", title + " " + format("{0}件を確認", count));
    const top = node("div", "", "office-stat-top");
    top.append(node("span", title), icon(iconName));
    const bottom = node("div", "", "office-stat-bottom");
    bottom.append(node("span", caption), icon("arrow"));
    card.append(top, node("strong", String(count)), bottom);
    stats.append(card);
  }
  if (allowed("articles"))
    stat(t("公開ニュース"), news.count ?? 0, t("発行済みの記事"), "news", () =>
      go("articles", { status: "published" }),
    );
  if (allowed("players"))
    stat(t("登録選手"), players.count ?? 0, t("内部の選手登録"), "users", () =>
      go("players"),
    );
  const upcomingCount = upcoming.reduce(
    (count, item) => count + (item.response.count ?? 0),
    0,
  );
  const firstSchedule =
    upcoming.find((item) => item.response.count)?.resource ??
    schedules.find(allowed);
  if (firstSchedule)
    stat(
      t("今後の予定"),
      upcomingCount,
      scheduleEnabled ? t("試合・練習・クラブ行事") : t("試合・練習の開催予定"),
      "calendar",
      () =>
        go(scheduleEnabled ? "schedule" : firstSchedule, {
          schedule: "scheduled",
          after: now,
        }),
    );
  const pendingCount = pending.reduce(
    (count, item) => count + (item.response.count ?? 0),
    0,
  );
  const firstPending =
    pending.find((item) => item.response.count)?.resource ?? publishable[0];
  if (firstPending)
    stat(t("承認待ち"), pendingCount, t("公開前の確認が必要"), "shield", () =>
      go(firstPending, { status: "pending" }),
    );
  stats.dataset.count = String(stats.children.length);
  root.append(stats);

  const quick = panel("QUICK ACTIONS", t("よく使う操作"), "plus");
  const quickActions = node("div", "", "office-quick-actions");
  for (const [resource, label] of [
    ["articles", t("ニュースを書く")],
    ["fixtures", t("試合を追加")],
    ["players", t("選手を登録")],
    ["media_assets", t("写真をアップロード")],
  ] as [Resource, string][]) {
    if (allowed(resource)) {
      const button = action(
        label,
        "office-quick-action",
        () => create(resource),
        resource === "fixtures"
          ? "calendar"
          : resource === "media_assets"
            ? "image"
            : resource === "players"
              ? "users"
              : "news",
      );
      button.dataset.quickAction = resource;
      quickActions.append(button);
    }
  }
  quick.body.append(quickActions);
  root.append(quick.section);
  const grid = node("div", "", "office-dashboard-grid");
  const schedulePanel = panel(
    "UPCOMING SCHEDULE",
    t("これからの試合・練習"),
    "calendar",
  );
  const upcomingRows = upcoming
    .flatMap(({ resource, response }) =>
      (response.data ?? []).map((row) => ({
        resource,
        row,
        date: String(row[resource === "fixtures" ? "kickoff_at" : "starts_at"]),
      })),
    )
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 6);
  for (const { resource, row, date } of upcomingRows) {
    const item = node("div", "", "office-schedule-row");
    const tile = node("div", "", "office-date-tile");
    const local = japanInput(date);
    tile.append(
      node("strong", local.slice(8, 10)),
      node(
        "span",
        new Intl.DateTimeFormat(intlLocales[currentLocale()], {
          month: "short",
          timeZone: "Asia/Tokyo",
        }).format(new Date(date)),
      ),
    );
    const copy = node("div", "", "office-schedule-copy");
    copy.append(
      node("strong", String(row[resources[resource].titleField])),
      node(
        "p",
        dateLabel(date, true) + " · " + String(row.venue || t("会場未定")),
      ),
    );
    copy.append(
      badge(row[resource === "fixtures" ? "match_status" : "session_status"]),
    );
    item.append(
      tile,
      copy,
      action(
        t("確認"),
        "office-link-button",
        () => open(resource, row),
        "arrow",
      ),
    );
    schedulePanel.body.append(item);
  }
  if (!upcomingRows.length)
    schedulePanel.body.append(
      emptyState(
        t("開催予定はまだありません"),
        t("日時が決まった試合・練習を登録すると、ここに表示されます。"),
        firstSchedule
          ? action(
              t("予定を登録"),
              "office-link-button",
              () => create(firstSchedule),
              "plus",
            )
          : undefined,
      ),
    );
  const scheduleLinks = node("div", "", "office-schedule-links");
  for (const resource of schedules.filter(allowed))
    scheduleLinks.append(
      action(
        resources[resource].label + t("一覧"),
        "office-link-button",
        () => go(resource),
        "arrow",
      ),
    );
  schedulePanel.body.append(scheduleLinks);
  grid.append(schedulePanel.section);

  const required = panel("ACTION REQUIRED", t("確認が必要な項目"), "warning");
  function requiredRow(
    title: string,
    detail: string,
    count: number,
    callback: () => void,
  ) {
    const item = node("div", "", "office-required-row");
    const symbol = node("span", "", "office-required-icon");
    symbol.append(icon("warning"));
    const copy = node("div", "", "office-required-copy");
    copy.append(
      node("strong", title + " · " + count + t("件")),
      node("p", detail),
    );
    item.append(
      symbol,
      copy,
      action(t("確認"), "office-link-button", callback, "arrow"),
    );
    required.body.append(item);
  }
  for (const { resource, response } of pending)
    if (response.count)
      requiredRow(
        format("{0}の承認待ち", resources[resource].label),
        (response.data ?? [])
          .map((row) => String(row[resources[resource].titleField]))
          .join("、"),
        response.count,
        () => go(resource, { status: "pending" }),
      );
  if (consent.count)
    requiredRow(
      t("選手の公開同意"),
      t("活動中の選手に未確認の同意があります。"),
      consent.count,
      () => go("players", { consent: "unconfirmed", status: "active" }),
    );
  if (changedMatches.count)
    requiredRow(
      t("延期・中止の試合"),
      t("実際の開催状態と案内内容をご確認ください。"),
      changedMatches.count,
      () => go("fixtures", { schedule: "changed", after: now }),
    );
  if (undatedMatches.count)
    requiredRow(
      t("日時未定の試合"),
      t("日時が決まったら開催情報を更新してください。"),
      undatedMatches.count,
      () => go("fixtures", { schedule: "undated" }),
    );
  if (contentEnabled && allowed("articles")) {
    const attention = await client.rpc("office_release_attention");
    if (attention.error) throw attention.error;
    for (const item of Array.isArray(attention.data)
      ? (attention.data as Row[])
      : []) {
      const resource = String(item.entity) as Resource;
      if (resources[resource] && allowed(resource))
        requiredRow(
          format("{0}の予約発行", resources[resource].label),
          t(
            "発行できなかった予約、または予約時刻を過ぎた項目を確認してください。",
          ),
          Number(item.total),
          () => go(resource),
        );
    }
  }
  if (!required.body.children.length)
    required.body.append(
      emptyState(
        t("確認が必要な項目はありません"),
        t("現在の権限で確認できる承認待ち・同意・予定の注意項目を表示します。"),
      ),
    );
  grid.append(required.section);

  const recent = panel("RECENT ACTIVITY", t("最近の管理作業"), "clock");
  recent.section.classList.add("office-activity-panel");
  const actorIds = [
    ...new Set(
      (history.data ?? [])
        .map((row) => String(row.actor_id ?? ""))
        .filter(Boolean),
    ),
  ];
  const names = new Map<string, string>([[userId, email]]);
  // 다른 운영진 정보는 기존 SELECT RLS가 허용하는 범위만 읽습니다.
  if (actorIds.length) {
    const actors = await read(
      client
        .from("admin_roles")
        .select("user_id,email")
        .in("user_id", actorIds),
    );
    for (const actor of actors.data ?? [])
      names.set(String(actor.user_id), String(actor.email));
  }
  const targets = new Map<string, string>();
  const historyResources = visible.filter((resource) =>
    (history.data ?? []).some((row) => row.entity === resource),
  );
  await Promise.all(
    historyResources.map(async (resource) => {
      const ids = [
        ...new Set(
          (history.data ?? [])
            .filter((row) => row.entity === resource)
            .map((row) => String(row.record_id ?? ""))
            .filter(Boolean),
        ),
      ];
      if (!ids.length) return;
      const response = await read(
        client
          .from(resource)
          .select(
            resources[resource].key + "," + resources[resource].titleField,
          )
          .in(resources[resource].key, ids),
      );
      for (const row of response.data ?? [])
        targets.set(
          resource + ":" + row[resources[resource].key],
          String(row[resources[resource].titleField]),
        );
    }),
  );
  const historyList = node("ul", "", "office-activity-list");
  const operations: Record<string, string> = {
    INSERT: "{0}を登録",
    UPDATE: "{0}を更新",
    DELETE: "{0}を削除",
  };
  for (const row of history.data ?? []) {
    const item = node("li", "", "office-activity-item");
    const dot = node("span", "", "office-activity-dot");
    dot.append(icon(row.operation === "INSERT" ? "plus" : "check"));
    const copy = node("div", "", "office-activity-copy");
    const resource = String(row.entity) as Resource;
    const label = resources[resource]?.singular ?? t("管理情報");
    const target = targets.get(resource + ":" + row.record_id);
    copy.append(
      node(
        "strong",
        format(
          operations[String(row.operation)] ?? "{0}を変更",
          target ? label + "「" + target + "」" : label,
        ),
      ),
    );
    copy.append(
      node(
        "p",
        row.actor_id
          ? (names.get(String(row.actor_id)) ??
              roleLabels[String(row.actor_role)] ??
              t("運営メンバー"))
          : t("システム"),
      ),
    );
    const time = node("time", dateLabel(row.occurred_at, true));
    time.dateTime = String(row.occurred_at);
    item.append(dot, copy, time);
    historyList.append(item);
  }
  recent.body.append(
    historyList.children.length
      ? historyList
      : emptyState(
          t("管理作業の記録はまだありません"),
          t("登録・編集を行うと実際の変更履歴がここに表示されます。"),
        ),
  );
  grid.append(recent.section);
  root.append(grid);
  return root;
}
