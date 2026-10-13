import type { SupabaseClient } from "@supabase/supabase-js";
import { resources, type Resource } from "../lib/admin-config";
import {
  action,
  badge,
  dateLabel,
  emptyState,
  node,
  selectFields,
  type Row,
} from "../lib/admin-ui";
import {
  addDays,
  calendarRange,
  jstDay,
  shiftPeriod,
  type ScheduleView,
} from "../lib/schedule";
import type { ListController } from "./admin-list";
type ScheduleResource = "fixtures" | "training_sessions" | "club_events";
const kinds: ScheduleResource[] = [
  "fixtures",
  "training_sessions",
  "club_events",
];
const dateField = (kind: ScheduleResource) =>
  kind === "fixtures" ? "kickoff_at" : "starts_at";
const stateField = (kind: ScheduleResource) =>
  kind === "fixtures" ? "match_status" : "session_status";
// 기존 테이블과 편집 양식을 공유하므로 일정 복사본을 만들지 않습니다.
export function createSchedule(options: {
  client: SupabaseClient;
  isCurrent: () => boolean;
  open: (resource: Resource, row: Row) => void;
  create: (resource: Resource) => void;
}): ListController {
  let day = jstDay(new Date());
  let view: ScheduleView = "month";
  let sequence = 0;
  let disposed = false;
  const element = node("section", "", "office-panel");
  const toolbar = node("div", "", "office-toolbar");
  const date = node("input");
  date.type = "date";
  date.value = day;
  date.setAttribute("aria-label", "表示する日付");
  const type = node("select");
  type.setAttribute("aria-label", "予定の種類");
  for (const kind of ["", ...kinds]) {
    const option = node(
      "option",
      kind ? resources[kind as ScheduleResource].label : "すべての予定",
    );
    option.value = kind;
    type.append(option);
  }
  const visibility = node("select");
  visibility.setAttribute("aria-label", "公開状態");
  for (const [value, label] of [
    ["", "公開・非公開すべて"],
    ["public", "公開"],
    ["private", "非公開"],
  ] as const) {
    const option = node("option", label);
    option.value = value;
    visibility.append(option);
  }
  const controls = node("div", "", "office-view-switch");
  const views = new Map<ScheduleView, HTMLButtonElement>();
  for (const [key, label] of [
    ["month", "月"],
    ["week", "週"],
    ["list", "一覧"],
  ] as const) {
    const button = action(label, "admin-secondary", () => {
      view = key;
      void refresh();
    });
    button.dataset.scheduleView = key;
    views.set(key, button);
    controls.append(button);
  }
  const period = node("h3");
  period.setAttribute("aria-live", "polite");
  toolbar.append(
    action("前へ", "admin-secondary", () => {
      day = shiftPeriod(day, view, -1);
      void refresh();
    }),
    action("今日", "admin-secondary", () => {
      day = jstDay(new Date());
      void refresh();
    }),
    action("次へ", "admin-secondary", () => {
      day = shiftPeriod(day, view, 1);
      void refresh();
    }),
    date,
    controls,
    type,
    visibility,
  );
  const actions = node("div", "", "office-toolbar");
  for (const kind of kinds)
    actions.append(
      action(
        resources[kind].singular + "を追加",
        "admin-secondary",
        () => options.create(kind),
        "plus",
      ),
    );
  const body = node("div", "", "office-schedule-body");
  body.setAttribute("aria-live", "polite");
  element.append(
    toolbar,
    period,
    actions,
    body,
    node(
      "p",
      "時刻はすべて日本時間（JST）です。中止の予定も履歴として表示します。",
      "admin-help",
    ),
  );
  date.addEventListener("change", () => {
    if (date.value) {
      day = date.value;
      void refresh();
    }
  });
  type.addEventListener("change", () => void refresh());
  visibility.addEventListener("change", () => void refresh());
  async function refresh() {
    const version = ++sequence;
    const range = calendarRange(day, view);
    date.value = day;
    views.forEach((button, key) =>
      button.setAttribute("aria-pressed", String(key === view)),
    );
    period.textContent = range.start + " — " + addDays(range.end, -1);
    body.replaceChildren(node("p", "予定を読み込み中…", "office-loading"));
    body.setAttribute("aria-busy", "true");
    try {
      const groups = await Promise.all(
        kinds
          .filter((kind) => !type.value || kind === type.value)
          .map(async (resource) => {
            let query = options.client
              .from(resource)
              .select(selectFields(resource), { count: "exact" })
              .gte(dateField(resource), range.from)
              .lt(dateField(resource), range.until)
              .order(dateField(resource))
              .order("id")
              .limit(500);
            if (visibility.value)
              query =
                resource === "fixtures"
                  ? visibility.value === "public"
                    ? query.eq("status", "published")
                    : query.neq("status", "published")
                  : query.eq("is_public", visibility.value === "public");
            const response = await query;
            if (response.error) throw response.error;
            if ((response.count ?? 0) > 500)
              throw new Error(
                "予定が多いため表示できません。週表示または種類を絞ってください。",
              );
            const rows: unknown = response.data;
            if (
              !Array.isArray(rows) ||
              rows.some((row) => !row || typeof row !== "object")
            )
              throw new Error("予定の形式を確認できません。");
            return (rows as Row[]).map((row) => ({ resource, row }));
          }),
      );
      const undated = await options.client
        .from("fixtures")
        .select("id", { head: true, count: "exact" })
        .is("kickoff_at", null);
      if (undated.error) throw undated.error;
      if (disposed || version !== sequence || !options.isCurrent()) return;
      const items = groups
        .flat()
        .sort((a, b) =>
          String(a.row[dateField(a.resource)]).localeCompare(
            String(b.row[dateField(b.resource)]),
          ),
        );
      body.replaceChildren();
      if (!items.length)
        body.append(
          emptyState(
            "この期間の予定はありません。",
            "上の追加ボタンから日程を登録できます。",
          ),
        );
      if (view === "list") {
        for (const item of items) body.append(eventCard(item));
      } else {
        const grid = node("div", "", "office-integrated-calendar");
        grid.dataset.view = view;
        let first = range.start;
        if (view === "month")
          first = addDays(
            first,
            -(new Date(first + "T00:00:00Z").getUTCDay() + 6) % 7,
          );
        const days =
          view === "week"
            ? 7
            : Math.ceil(
                (Date.parse(range.end) - Date.parse(first)) / 86400000 / 7,
              ) * 7;
        for (let n = 0; n < days; n++) {
          const currentDay = addDays(first, n);
          const cell = node("section", "", "office-schedule-day");
          cell.dataset.outside = String(
            currentDay < range.start || currentDay >= range.end,
          );
          const heading = node(
            "h4",
            new Intl.DateTimeFormat("ja-JP", {
              month: "numeric",
              day: "numeric",
              weekday: "short",
              timeZone: "UTC",
            }).format(new Date(currentDay)),
          );
          if (currentDay === jstDay(new Date()))
            heading.setAttribute("aria-current", "date");
          cell.append(heading);
          for (const item of items.filter(
            (item) =>
              jstDay(String(item.row[dateField(item.resource)])) === currentDay,
          ))
            cell.append(eventCard(item));
          grid.append(cell);
        }
        body.append(grid);
      }
      if (undated.count)
        body.append(
          node(
            "p",
            "日時未定の試合が" +
              undated.count +
              "件あります。試合メニューで確認できます。",
            "admin-help",
          ),
        );
    } catch (error) {
      if (!disposed && version === sequence && options.isCurrent()) {
        body.replaceChildren(
          node(
            "p",
            error instanceof Error
              ? error.message
              : "予定を取得できませんでした。",
            "admin-help",
          ),
          action("再試行", "admin-secondary", () => void refresh()),
        );
      }
    } finally {
      if (version === sequence) body.removeAttribute("aria-busy");
    }
  }
  function eventCard({
    resource,
    row,
  }: {
    resource: ScheduleResource;
    row: Row;
  }) {
    const button = action(
      String(row[resources[resource].titleField]),
      "office-schedule-event",
      () => options.open(resource, row),
    );
    button.dataset.kind = resource;
    button.prepend(
      node(
        "small",
        resources[resource].label +
          " · " +
          dateLabel(row[dateField(resource)], true),
      ),
    );
    button.append(
      node("small", String(row.venue || "場所未定")),
      badge(row[stateField(resource)]),
      node(
        "small",
        (resource === "fixtures" ? row.status === "published" : row.is_public)
          ? "公開"
          : "非公開",
      ),
    );
    return button;
  }
  return {
    element,
    refresh,
    dispose() {
      disposed = true;
      sequence++;
    },
  };
}

// 반복 정보는 저장할 DB 열과 구분해 양식에 붙입니다. 취소는 상태를 '中止'로 저장합니다.
export function recurrenceControls(row: Row | null): HTMLElement {
  const group = node("fieldset", "", "office-field-group");
  group.append(node("legend", "繰り返し・変更範囲"));
  if (!row) {
    for (const [name, label, min, max, value] of [
      ["_repeat_count", "回数（1＝単発）", 1, 52, 1],
      ["_repeat_weeks", "間隔（週）", 1, 12, 1],
    ] as const) {
      const wrap = node("label", label);
      const input = node("input");
      input.type = "number";
      input.name = name;
      input.min = String(min);
      input.max = String(max);
      input.value = String(value);
      wrap.append(input);
      group.append(wrap);
    }
    group.append(
      node(
        "p",
        "初回と同じ曜日・時刻で繰り返します。最大52回・1年以内。曜日が複数の場合は曜日ごとに登録してください。",
        "admin-help",
      ),
    );
  } else if (row.series_id) {
    const label = node("label", "変更する範囲");
    const select = node("select");
    select.name = "_repeat_scope";
    for (const [value, text] of [
      ["single", "この回だけ"],
      ["series", "このシリーズの未実施回すべて"],
    ] as const) {
      const option = node("option", text);
      option.value = value;
      select.append(option);
    }
    label.append(select);
    group.append(
      label,
      node(
        "p",
        "全体変更は過去・実施済みを除き、個別変更した回も含めて内容を置き換えます。日時は今回からの差分で移動します。中止も選択した範囲に適用されます。",
        "admin-help",
      ),
    );
  } else group.append(node("p", "単発の予定です。", "admin-help"));
  return group;
}
