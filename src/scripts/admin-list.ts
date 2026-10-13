import type { SupabaseClient } from "@supabase/supabase-js";
import { resources, type Resource } from "../lib/admin-config";
import {
  action,
  badge,
  dateLabel,
  emptyState,
  icon,
  imageSources,
  japanInput,
  node,
  officePages,
  selectFields,
  roleLabels,
  type ListFilter,
  type Row,
} from "../lib/admin-ui";

// [편집 안내] 같은 검색·필터·표·빈 상태를 9개 업무에서 사용합니다. 필터는 서버 조회에 적용되어 페이지 밖의 항목도 검색합니다.
interface Options {
  client: SupabaseClient;
  resource: Resource;
  base: string;
  initialFilter?: ListFilter;
  isCurrent: () => boolean;
  open: (row: Row) => void;
  remove: (row: Row) => void;
  create: () => void;
  onError: (error: unknown) => void;
}
export interface ListController {
  element: HTMLElement;
  refresh: () => Promise<void>;
  dispose: () => void;
}
const pageSize = 50;
const calendarLimit = 500;
type Column = {
  label: string;
  compact?: boolean;
  render: (row: Row) => string | Node;
};
function optionLabel(
  resource: Resource,
  field: string,
  value: unknown,
): string {
  return (
    resources[resource].fields
      .find((item) => item.name === field)
      ?.options?.find((option) => option.value === String(value))?.label ??
    String(value ?? "—")
  );
}
export function createList(options: Options): ListController {
  const { client, resource, base } = options;
  const config = resources[resource];
  let filters: ListFilter = { ...options.initialFilter };
  let page = 0;
  let view: "list" | "calendar" = "list";
  let sequence = 0;
  let disposed = false;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  const monthInput = japanInput(new Date()).slice(0, 7);
  let month = new Date(
    Date.UTC(
      Number(monthInput.slice(0, 4)),
      Number(monthInput.slice(5, 7)) - 1,
      1,
    ),
  );
  const element = node("section", "", "office-panel admin-list");
  const toolbar = node("form", "", "office-toolbar");
  toolbar.setAttribute("aria-label", config.label + "の検索とフィルター");
  const searchLabel = node("label", "検索", "office-search");
  const search = node("input");
  search.type = "search";
  search.name = "search";
  search.maxLength = 150;
  search.value = filters.search ?? "";
  search.placeholder = config.singular + "を検索";
  searchLabel.append(icon("search"), search);
  toolbar.append(searchLabel);
  function filterSelect(
    name: keyof ListFilter,
    label: string,
    values: { value: string; label: string }[],
  ) {
    const container = node("label", label);
    const input = node("select");
    input.name = name;
    for (const option of [{ value: "", label: "すべて" }, ...values]) {
      const item = node("option", option.label);
      item.value = option.value;
      input.append(item);
    }
    input.value = filters[name] ?? "";
    input.addEventListener("change", () => {
      page = 0;
      updateFilters();
      void load();
    });
    container.append(input);
    toolbar.append(container);
  }
  if (resource === "articles")
    filterSelect(
      "category",
      "カテゴリー",
      config.fields.find((field) => field.name === "category")?.options ?? [],
    );
  if (config.canPublish.length || resource === "public_player_profiles")
    filterSelect("status", "公開状態", [
      { value: "draft", label: "下書き" },
      { value: "pending", label: "承認待ち" },
      { value: "published", label: "発行済み" },
    ]);
  if (resource === "players") {
    filterSelect(
      "status",
      "活動状態",
      config.fields.find((field) => field.name === "activity_status")
        ?.options ?? [],
    );
    filterSelect("consent", "公開同意", [
      { value: "unconfirmed", label: "未確認あり" },
      { value: "confirmed", label: "両方確認済み" },
    ]);
  }
  if (resource === "admin_roles")
    filterSelect("status", "アクセス", [
      { value: "enabled", label: "有効" },
      { value: "disabled", label: "無効" },
    ]);
  const scheduleResource =
    resource === "fixtures" || resource === "training_sessions" || resource === "club_events";
  if (scheduleResource) {
    filterSelect("schedule", "開催状態", [
      { value: "scheduled", label: "開催予定" },
      { value: "completed", label: "終了" },
      ...(resource === "fixtures"
        ? [
            { value: "postponed", label: "延期" },
            { value: "changed", label: "延期・中止" },
            { value: "undated", label: "日時未定" },
          ]
        : []),
      { value: "cancelled", label: "中止" },
    ]);
    const views = node("div", "", "office-view-toggle");
    views.setAttribute("role", "group");
    views.setAttribute("aria-label", "予定の表示");
    for (const [value, label, symbol] of [
      ["list", "一覧", "list"],
      ["calendar", "カレンダー", "calendar"],
    ] as const) {
      const button = action(
        label,
        "",
        () => {
          view = value;
          page = 0;
          for (const item of views.querySelectorAll("button"))
            item.setAttribute(
              "aria-pressed",
              String(item.dataset.view === view),
            );
          void load();
        },
        symbol,
      );
      button.dataset.view = value;
      button.setAttribute("aria-pressed", String(view === value));
      views.append(button);
    }
    toolbar.append(views);
  }
  const submit = action("検索", "admin-secondary");
  submit.type = "submit";
  toolbar.append(submit);
  const summary = node("div", "", "office-result-line");
  const countLabel = node("span");
  countLabel.setAttribute("aria-live", "polite");
  summary.append(countLabel);
  if (filters.after)
    summary.append(
      action("今後の予定のみ · 解除", "office-link-button", () => {
        filters.after = undefined;
        page = 0;
        summary.querySelector("button")?.remove();
        void load();
      }),
    );
  const body = node("div", "", "office-table-scroll");
  const pager = node("div", "", "office-pager");
  element.append(toolbar, summary, body, pager);
  function updateFilters() {
    const data = new FormData(toolbar);
    filters = {
      ...filters,
      search: String(data.get("search") ?? "")
        .normalize("NFKC")
        .trim(),
    };
    for (const name of ["status", "category", "consent", "schedule"] as const)
      if (toolbar.querySelector('[name="' + name + '"]'))
        filters[name] = String(data.get(name) ?? "");
  }
  toolbar.addEventListener("submit", (event) => {
    event.preventDefault();
    clearTimeout(debounce);
    page = 0;
    updateFilters();
    void load();
  });
  search.addEventListener("input", () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      page = 0;
      updateFilters();
      void load();
    }, 300);
  });

  function thumbnail(row: Row): HTMLElement {
    const wrapper = node("span", "", "office-record-thumbnail");
    const profile = row.office_profile as Row | undefined;
    const path =
      row.cover_path ??
      row.photo_path ??
      profile?.photo_path ??
      row.storage_path ??
      row.legacy_path;
    const source = sources.get(String(path ?? ""));
    wrapper.dataset.player = String(
      resource === "players" || resource === "public_player_profiles",
    );
    if (source) {
      const image = node("img");
      image.src = source;
      image.alt = "";
      image.loading = "lazy";
      image.addEventListener(
        "error",
        () => wrapper.replaceChildren(icon(officePages[resource].icon)),
        { once: true },
      );
      wrapper.append(image);
    } else wrapper.append(icon(officePages[resource].icon));
    return wrapper;
  }
  function titleCell(row: Row): HTMLElement {
    const title = node("div", "", "office-record-title");
    const copy = node("div");
    copy.append(node("h2", String(row[config.titleField] ?? "")));
    const detail =
      row.summary ??
      row.description ??
      (resource === "players"
        ? "内部の選手登録"
        : resource === "public_player_profiles"
          ? row.romanized_name
          : resource === "media_assets"
            ? row.kind === "video"
              ? "動画URL"
              : "写真"
            : "");
    if (detail) copy.append(node("p", String(detail)));
    title.append(thumbnail(row), copy);
    return title;
  }
  function columns(): Column[] {
    const result: Column[] = [{ label: config.singular, render: titleCell }];
    const add = (label: string, render: Column["render"], compact = false) =>
      result.push({ label, render, compact });
    if (resource === "articles") {
      add("カテゴリー", (row) =>
        optionLabel(resource, "category", row.category),
      );
      add("公開状態", (row) => badge(row.status));
      // ニュースにはcreated_at列がありません。存在するINSERT監査記録だけを作成日として表示します。
      add("作成日", (row) => dateLabel(row.office_created_at), true);
      add("最終更新", (row) => dateLabel(row.updated_at));
    } else if (
      resource === "players" ||
      resource === "public_player_profiles"
    ) {
      add("ポジション / 背番号", (row) => {
        const profile =
          resource === "players"
            ? (row.office_profile as Row | undefined)
            : row;
        return profile
          ? String(profile.position ?? "—") +
              " / " +
              (profile.jersey_number ?? "—")
          : "未登録";
      });
      add("活動状態", (row) => badge(row.activity_status));
      add("公開状態", (row) =>
        badge(
          resource === "players"
            ? ((row.office_profile as Row | undefined)?.status ?? "未登録")
            : row.status,
        ),
      );
      if (resource === "players")
        add("公開同意", (row) => {
          const stack = node("div", "", "office-cell-stack");
          stack.append(
            node("span", "プロフィール"),
            badge(row.profile_consent ? "confirmed" : "unconfirmed"),
            node("span", "写真"),
            badge(row.photo_consent ? "confirmed" : "unconfirmed"),
          );
          return stack;
        });
    } else if (scheduleResource) {
      add("日時（日本時間）", (row) =>
        row[resource === "fixtures" ? "kickoff_at" : "starts_at"]
          ? dateLabel(
              row[resource === "fixtures" ? "kickoff_at" : "starts_at"],
              true,
            )
          : "日時未定",
      );
      add("会場", (row) => String(row.venue || "会場未定"));
      add("開催状態", (row) =>
        badge(row[resource === "fixtures" ? "match_status" : "session_status"]),
      );
      if (resource === "fixtures") add("公開状態", (row) => badge(row.status));
    } else if (resource === "admin_roles") {
      add("権限", (row) => roleLabels[String(row.role)] ?? String(row.role));
      add("アクセス", (row) => badge(row.active ? "enabled" : "disabled"));
      add("最終更新", (row) => dateLabel(row.updated_at));
    } else {
      if (resource === "media_assets")
        add("種類", (row) => (row.kind === "video" ? "動画" : "写真"));
      add("公開状態", (row) => badge(row.status));
      if (resource === "media_albums" || resource === "media_assets")
        add("撮影日", (row) => dateLabel(row.captured_on), true);
      add("最終更新", (row) => dateLabel(row.updated_at));
    }
    add("操作", (row) => {
      const buttons = node("div", "", "admin-row-actions");
      buttons.append(
        action("編集", "admin-secondary", () => options.open(row)),
      );
      if (
        ![
          "players",
          "public_player_profiles",
          "admin_roles",
          "site_pages",
        ].includes(resource)
      )
        buttons.append(
          action("削除", "admin-danger", () => options.remove(row)),
        );
      return buttons;
    });
    return result;
  }
  function renderTable(rows: Row[]) {
    if (!rows.length) {
      body.replaceChildren(
        emptyState(
          "該当する項目はありません",
          filters.search ||
            filters.status ||
            filters.category ||
            filters.consent ||
            filters.schedule ||
            filters.after
            ? "検索やフィルターを変更してお試しください。"
            : config.singular + "を登録すると、ここに表示されます。",
          action(
            config.singular + "を登録",
            "office-link-button",
            options.create,
            "plus",
          ),
        ),
      );
      return;
    }
    const table = node("table", "", "office-table");
    table.setAttribute("aria-label", config.label + "一覧");
    const head = node("thead");
    const heading = node("tr");
    const fields = columns();
    for (const column of fields) {
      const cell = node(
        "th",
        column.label,
        column.compact ? "office-compact-hidden" : "",
      );
      cell.scope = "col";
      heading.append(cell);
    }
    head.append(heading);
    const tbody = node("tbody");
    for (const row of rows) {
      const tr = node("tr", "", "admin-list-row");
      for (const column of fields) {
        const cell = node(
          "td",
          "",
          column.compact ? "office-compact-hidden" : "",
        );
        cell.dataset.label = column.label;
        const value = column.render(row);
        if (typeof value === "string") cell.textContent = value;
        else cell.append(value);
        tr.append(cell);
      }
      tbody.append(tr);
    }
    table.append(head, tbody);
    body.replaceChildren(table);
  }
  function renderCalendar(rows: Row[], count: number) {
    const header = node("div", "", "office-calendar-heading");
    header.append(
      node(
        "h2",
        month.getUTCFullYear() + "年 " + (month.getUTCMonth() + 1) + "月",
      ),
    );
    const controls = node("div");
    for (const [direction, label] of [
      [-1, "前の月"],
      [1, "次の月"],
    ] as const)
      controls.append(
        action(label, "admin-secondary", () => {
          month = new Date(
            Date.UTC(
              month.getUTCFullYear(),
              month.getUTCMonth() + direction,
              1,
            ),
          );
          void load();
        }),
      );
    header.append(controls);
    const grid = node("div", "", "office-calendar-grid");
    for (const day of ["日", "月", "火", "水", "木", "金", "土"])
      grid.append(node("div", day, "office-calendar-weekday"));
    const dateField = resource === "fixtures" ? "kickoff_at" : "starts_at";
    const today = japanInput(new Date()).slice(0, 10);
    const cells =
      Math.ceil(
        (month.getUTCDay() +
          new Date(
            Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0),
          ).getUTCDate()) /
          7,
      ) * 7;
    for (let index = 0; index < cells; index++) {
      const date = new Date(
        Date.UTC(
          month.getUTCFullYear(),
          month.getUTCMonth(),
          index - month.getUTCDay() + 1,
        ),
      );
      const dateKey = date.toISOString().slice(0, 10);
      const cell = node("div", "", "office-calendar-day");
      cell.dataset.outside = String(date.getUTCMonth() !== month.getUTCMonth());
      cell.dataset.today = String(dateKey === today);
      cell.append(node("span", String(date.getUTCDate())));
      for (const row of rows.filter(
        (row) => japanInput(row[dateField]).slice(0, 10) === dateKey,
      )) {
        const event = action(
          japanInput(row[dateField]).slice(11) +
            " " +
            String(row[config.titleField]),
          "office-calendar-event",
          () => options.open(row),
        );
        event.dataset.status = String(
          row[resource === "fixtures" ? "match_status" : "session_status"],
        );
        event.setAttribute(
          "aria-label",
          dateLabel(row[dateField], true) +
            " " +
            row[config.titleField] +
            "を編集",
        );
        cell.append(event);
      }
      grid.append(cell);
    }
    body.replaceChildren(
      header,
      grid,
      node(
        "p",
        count > calendarLimit
          ? "予定が多いため、この月の先頭500件を表示しています。すべての予定は一覧で確認できます。"
          : resource === "fixtures"
            ? "日時未定の試合は一覧で確認できます。予定を選択すると編集できます。"
            : "練習予定を選択すると編集できます。",
        "office-calendar-note",
      ),
    );
    if (!rows.length)
      body.append(
        emptyState(
          "この月の予定はありません",
          "別の月を選ぶか、新しい予定を登録してください。",
          action("予定を登録", "office-link-button", options.create, "plus"),
        ),
      );
  }
  let sources = new Map<string, string>();
  async function load() {
    if (disposed || !options.isCurrent()) return;
    const version = ++sequence;
    body.setAttribute("aria-busy", "true");
    countLabel.textContent = "読み込み中…";
    try {
      let query = client
        .from(resource)
        .select(selectFields(resource), { count: "exact" });
      if (filters.search)
        query = query.ilike(
          config.titleField,
          "%" + filters.search.replace(/[\\%_]/g, "\\$&") + "%",
        );
      if (filters.category) query = query.eq("category", filters.category);
      if (filters.status) {
        if (resource === "players")
          query = query.eq("activity_status", filters.status);
        else if (resource === "admin_roles")
          query = query.eq("active", filters.status === "enabled");
        else query = query.eq("status", filters.status);
      }
      if (filters.consent === "unconfirmed")
        query = query.or("profile_consent.eq.false,photo_consent.eq.false");
      if (filters.consent === "confirmed")
        query = query.eq("profile_consent", true).eq("photo_consent", true);
      const dateField = resource === "fixtures" ? "kickoff_at" : "starts_at";
      const stateField =
        resource === "fixtures" ? "match_status" : "session_status";
      if (scheduleResource) {
        if (filters.schedule === "changed")
          query = query.in(stateField, ["postponed", "cancelled"]);
        else if (filters.schedule === "undated")
          query = query.is(dateField, null).eq(stateField, "scheduled");
        else if (filters.schedule)
          query = query.eq(stateField, filters.schedule);
        if (filters.after) query = query.gte(dateField, filters.after);
      }
      if (view === "calendar") {
        const start = new Date(month.getTime() - 9 * 3600000).toISOString();
        const end = new Date(
          Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1) -
            9 * 3600000,
        ).toISOString();
        query = query
          .gte(dateField, start)
          .lt(dateField, end)
          .order(dateField)
          .order(config.key)
          .limit(calendarLimit);
      } else
        query = query
          .order(resource === "admin_roles" ? "email" : "updated_at", {
            ascending: resource === "admin_roles",
          })
          .order(config.key)
          .range(page * pageSize, (page + 1) * pageSize - 1);
      const response = await query.overrideTypes<Row[], { merge: false }>();
      if (response.error) throw response.error;
      const rows = (response.data ?? []) as Row[];
      if (resource === "players" && rows.length) {
        const profiles = await client
          .from("public_player_profiles")
          .select(
            "player_id,display_name,position,jersey_number,photo_path,status",
          )
          .in(
            "player_id",
            rows.map((row) => row.id),
          );
        if (profiles.error) throw profiles.error;
        const byPlayer = new Map(
          (profiles.data ?? []).map((profile) => [profile.player_id, profile]),
        );
        for (const row of rows) row.office_profile = byPlayer.get(row.id);
      }
      if (resource === "articles" && rows.length) {
        const created = await client
          .from("audit_logs")
          .select("record_id,occurred_at")
          .eq("entity", "articles")
          .eq("operation", "INSERT")
          .in(
            "record_id",
            rows.map((row) => row.id),
          )
          .order("occurred_at");
        if (!created.error)
          for (const row of rows)
            row.office_created_at = created.data?.find(
              (event) => event.record_id === row.id,
            )?.occurred_at;
      }
      const loadedSources = await imageSources(
        client,
        rows.flatMap((row) => [
          row.cover_path,
          row.photo_path,
          (row.office_profile as Row | undefined)?.photo_path,
          row.storage_path,
          row.legacy_path,
        ]),
        base,
      );
      if (disposed || version !== sequence || !options.isCurrent()) return;
      sources = loadedSources;
      const count = response.count ?? rows.length;
      countLabel.textContent =
        String(count) +
        "件" +
        (view === "list" && count
          ? " · " +
            (page * pageSize + 1) +
            "–" +
            Math.min((page + 1) * pageSize, count) +
            "件を表示"
          : "");
      if (view === "calendar") renderCalendar(rows, count);
      else renderTable(rows);
      pager.replaceChildren();
      pager.hidden = view === "calendar" || count <= pageSize;
      if (!pager.hidden) {
        const previous = action("前のページ", "admin-secondary", () => {
          page--;
          void load();
        });
        previous.disabled = page === 0;
        const next = action("次のページ", "admin-secondary", () => {
          page++;
          void load();
        });
        next.disabled = (page + 1) * pageSize >= count;
        pager.append(
          previous,
          node("span", page + 1 + " / " + Math.ceil(count / pageSize)),
          next,
        );
      }
    } catch (error) {
      if (disposed || version !== sequence || !options.isCurrent()) return;
      countLabel.textContent = "読み込みエラー";
      body.replaceChildren(
        emptyState(
          "項目を読み込めませんでした",
          "接続を確認し、もう一度お試しください。",
          action(
            "再読み込み",
            "office-link-button",
            () => {
              void load();
            },
            "arrow",
          ),
        ),
      );
      pager.hidden = true;
      options.onError(error);
    } finally {
      if (version === sequence) body.removeAttribute("aria-busy");
    }
  }
  return {
    element,
    refresh: load,
    dispose: () => {
      disposed = true;
      sequence++;
      clearTimeout(debounce);
    },
  };
}
