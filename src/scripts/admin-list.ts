import {
  text as t,
  format,
  currentLocale,
  intlLocales,
  weekdayNames,
} from "../lib/i18n";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resources, type Resource } from "../lib/admin-config";
import { contentEnabled } from "../lib/office-features";
import { contentResources } from "../lib/content-drafts";
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
  playerActions?: (row: Row) => HTMLElement[];
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
  toolbar.setAttribute(
    "aria-label",
    format("{0}の検索とフィルター", config.label),
  );
  const searchLabel = node("label", t("検索"), "office-search");
  const search = node("input");
  search.type = "search";
  search.name = "search";
  search.maxLength = 150;
  search.value = filters.search ?? "";
  search.placeholder = format("{0}を検索", config.singular);
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
    for (const option of [{ value: "", label: t("すべて") }, ...values]) {
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
  if (resource === "articles" || resource === "media_assets")
    filterSelect(
      "category",
      t("カテゴリー"),
      config.fields.find(
        (field) =>
          field.name ===
          (resource === "articles" ? "category" : "media_category"),
      )?.options ?? [],
    );
  if (config.canPublish.length || resource === "public_player_profiles")
    filterSelect("status", t("公開状態"), [
      { value: "draft", label: t("下書き") },
      { value: "pending", label: t("承認待ち") },
      { value: "published", label: t("発行済み") },
    ]);
  if (resource === "players") {
    filterSelect("profileStatus", t("プロフィールの公開状態"), [
      { value: "draft", label: t("下書き") },
      { value: "pending", label: t("承認待ち") },
      { value: "published", label: t("発行済み") },
    ]);
    filterSelect(
      "status",
      t("活動状態"),
      config.fields.find((field) => field.name === "activity_status")
        ?.options ?? [],
    );
    filterSelect("consent", t("公開同意"), [
      { value: "unconfirmed", label: t("未確認あり") },
      { value: "confirmed", label: t("両方確認済み") },
    ]);
  }
  if (resource === "admin_roles")
    filterSelect("status", t("アクセス"), [
      { value: "enabled", label: t("有効") },
      { value: "disabled", label: t("無効") },
    ]);
  const scheduleResource =
    resource === "fixtures" ||
    resource === "training_sessions" ||
    resource === "club_events";
  if (scheduleResource) {
    filterSelect("schedule", t("開催状態"), [
      { value: "scheduled", label: t("開催予定") },
      { value: "completed", label: t("終了") },
      ...(resource === "fixtures"
        ? [
            { value: "postponed", label: t("延期") },
            { value: "changed", label: t("延期・中止") },
            { value: "undated", label: t("日時未定") },
          ]
        : []),
      { value: "cancelled", label: t("中止") },
    ]);
    const views = node("div", "", "office-view-toggle");
    views.setAttribute("role", "group");
    views.setAttribute("aria-label", t("予定の表示"));
    for (const [value, label, symbol] of [
      ["list", t("一覧"), "list"],
      ["calendar", t("カレンダー"), "calendar"],
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
  const submit = action(t("検索"), "admin-secondary");
  submit.type = "submit";
  toolbar.append(submit);
  const summary = node("div", "", "office-result-line");
  const countLabel = node("span");
  countLabel.setAttribute("aria-live", "polite");
  summary.append(countLabel);
  if (filters.after)
    summary.append(
      action(t("今後の予定のみ · 解除"), "office-link-button", () => {
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
    for (const name of [
      "status",
      "category",
      "consent",
      "schedule",
      "profileStatus",
    ] as const)
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
      row.office_photo_path ??
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
        ? t("内部の選手登録")
        : resource === "public_player_profiles"
          ? row.romanized_name
          : resource === "media_assets"
            ? row.kind === "video"
              ? t("動画URL")
              : t("写真")
            : "");
    if (detail) copy.append(node("p", String(detail)));
    title.append(thumbnail(row), copy);
    return title;
  }
  function columns(): Column[] {
    const result: Column[] = [{ label: config.singular, render: titleCell }];
    if (contentEnabled && contentResources.includes(resource))
      result.push({
        label: t("予約発行"),
        render: (row) => {
          const release = row.office_release as Row | undefined;
          if (!release) return "—";
          const labels: Record<string, string> = {
            queued: t("予約済み"),
            published: t("発行済み"),
            cancelled: t("予約取消"),
            failed: t("要確認"),
          };
          const cell = node("div");
          cell.append(
            node("span", labels[String(release.state)] ?? "—"),
            node("small", dateLabel(release.scheduled_at, true)),
          );
          return cell;
        },
      });
    const add = (label: string, render: Column["render"], compact = false) =>
      result.push({ label, render, compact });
    if (resource === "articles") {
      add(t("カテゴリー"), (row) =>
        optionLabel(resource, "category", row.category),
      );
      add(t("公開状態"), (row) => badge(row.status));
      // 뉴스에는 created_at 열이 없으므로 실제 INSERT 감사 기록만 작성일로 표시합니다.
      add(t("作成日"), (row) => dateLabel(row.office_created_at), true);
      add(t("最終更新"), (row) => dateLabel(row.updated_at));
    } else if (
      resource === "players" ||
      resource === "public_player_profiles"
    ) {
      add(t("ポジション / 背番号"), (row) => {
        const profile =
          resource === "players"
            ? (row.office_profile as Row | undefined)
            : row;
        return profile
          ? String(profile.position ?? "—") +
              " / " +
              (profile.jersey_number ?? "—")
          : t("未登録");
      });
      add(t("活動状態"), (row) => badge(row.activity_status));
      add(t("公開状態"), (row) =>
        badge(
          resource === "players"
            ? ((row.office_profile as Row | undefined)?.status ?? t("未登録"))
            : row.status,
        ),
      );
      if (resource === "players")
        add(t("公開同意"), (row) => {
          const stack = node("div", "", "office-cell-stack");
          stack.append(
            node("span", t("プロフィール")),
            badge(row.profile_consent ? "confirmed" : "unconfirmed"),
            node("span", t("写真")),
            badge(row.photo_consent ? "confirmed" : "unconfirmed"),
          );
          return stack;
        });
    } else if (scheduleResource) {
      add(t("日時（日本時間）"), (row) =>
        row[resource === "fixtures" ? "kickoff_at" : "starts_at"]
          ? dateLabel(
              row[resource === "fixtures" ? "kickoff_at" : "starts_at"],
              true,
            )
          : t("日時未定"),
      );
      add(t("会場"), (row) => String(row.venue || t("会場未定")));
      add(t("開催状態"), (row) =>
        badge(row[resource === "fixtures" ? "match_status" : "session_status"]),
      );
      if (resource === "fixtures")
        add(t("公開状態"), (row) => badge(row.status));
    } else if (resource === "admin_roles") {
      add(t("権限"), (row) => roleLabels[String(row.role)] ?? String(row.role));
      add(t("アクセス"), (row) => badge(row.active ? "enabled" : "disabled"));
      add(t("最終更新"), (row) => dateLabel(row.updated_at));
    } else {
      if (resource === "media_assets") {
        add(t("種類"), (row) => (row.kind === "video" ? t("動画") : t("写真")));
        add(t("写真カテゴリー"), (row) =>
          optionLabel(resource, "media_category", row.media_category),
        );
      }
      add(t("公開状態"), (row) => badge(row.status));
      if (resource === "media_albums" || resource === "media_assets")
        add(t("撮影日"), (row) => dateLabel(row.captured_on), true);
      add(t("最終更新"), (row) => dateLabel(row.updated_at));
    }
    add(t("操作"), (row) => {
      const buttons = node("div", "", "admin-row-actions");
      buttons.append(
        action(t("編集"), "admin-secondary", () => options.open(row)),
      );
      if (resource === "players" && options.playerActions)
        buttons.append(...options.playerActions(row));
      if (
        ![
          "players",
          "public_player_profiles",
          "admin_roles",
          "site_pages",
        ].includes(resource)
      )
        buttons.append(
          action(t("削除"), "admin-danger", () => options.remove(row)),
        );
      return buttons;
    });
    return result;
  }
  function renderTable(rows: Row[]) {
    if (!rows.length) {
      body.replaceChildren(
        emptyState(
          t("該当する項目はありません"),
          filters.search ||
            filters.status ||
            filters.category ||
            filters.consent ||
            filters.schedule ||
            filters.after
            ? t("検索やフィルターを変更してお試しください。")
            : format("{0}を登録すると、ここに表示されます。", config.singular),
          action(
            format("{0}を登録", config.singular),
            "office-link-button",
            options.create,
            "plus",
          ),
        ),
      );
      return;
    }
    const table = node("table", "", "office-table");
    table.setAttribute("aria-label", config.label + t("一覧"));
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
        new Intl.DateTimeFormat(intlLocales[currentLocale()], {
          year: "numeric",
          month: "long",
          timeZone: "UTC",
        }).format(month),
      ),
    );
    const controls = node("div");
    for (const [direction, label] of [
      [-1, t("前の月")],
      [1, t("次の月")],
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
    for (const day of weekdayNames())
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
            format("{0}を編集", row[config.titleField]),
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
          ? t(
              "予定が多いため、この月の先頭500件を表示しています。すべての予定は一覧で確認できます。",
            )
          : resource === "fixtures"
            ? t(
                "日時未定の試合は一覧で確認できます。予定を選択すると編集できます。",
              )
            : t("練習予定を選択すると編集できます。"),
        "office-calendar-note",
      ),
    );
    if (!rows.length)
      body.append(
        emptyState(
          t("この月の予定はありません"),
          t("別の月を選ぶか、新しい予定を登録してください。"),
          action(t("予定を登録"), "office-link-button", options.create, "plus"),
        ),
      );
  }
  let sources = new Map<string, string>();
  async function load() {
    if (disposed || !options.isCurrent()) return;
    const version = ++sequence;
    body.setAttribute("aria-busy", "true");
    countLabel.textContent = t("読み込み中…");
    try {
      let query = client
        .from(resource)
        .select(selectFields(resource), { count: "exact" });
      if (resource === "players" && filters.profileStatus) {
        const profiles = await client
          .from("public_player_profiles")
          .select("player_id")
          .eq("status", filters.profileStatus);
        if (profiles.error) throw profiles.error;
        query = query.in(
          "id",
          (profiles.data ?? []).map((profile) => profile.player_id),
        );
      }
      if (filters.search)
        query = query.ilike(
          config.titleField,
          "%" + filters.search.replace(/[\\%_]/g, "\\$&") + "%",
        );
      if (filters.category)
        query = query.eq(
          resource === "media_assets" ? "media_category" : "category",
          filters.category,
        );
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
      if (
        contentEnabled &&
        contentResources.includes(resource) &&
        rows.length
      ) {
        const releases = await client.rpc("office_release_states", {
          p_entity: resource,
          p_ids: rows.map((row) => String(row.id)),
        });
        if (releases.error) throw releases.error;
        if (!Array.isArray(releases.data))
          throw new Error(t("予約情報を取得できませんでした。"));
        for (const row of rows)
          row.office_release = (releases.data as Row[]).find(
            (release) => release.record_id === String(row.id),
          );
      }
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
        // 공개 프로필이 아직 없어도 선수 등록에서 지정한 승인 사진을 내부 목록에서 확인합니다.
        const photoIds = rows.map((row) => row.photo_asset_id).filter(Boolean);
        if (photoIds.length) {
          const photos = await client
            .from("media_assets")
            .select("id,storage_path,legacy_path")
            .in("id", photoIds);
          if (photos.error) throw photos.error;
          for (const row of rows) {
            const photo = photos.data?.find(
              (item) => item.id === row.photo_asset_id,
            );
            row.office_photo_path = photo?.storage_path ?? photo?.legacy_path;
          }
        }
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
          row.office_photo_path,
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
        t("件") +
        (view === "list" && count
          ? " · " +
            (page * pageSize + 1) +
            "–" +
            Math.min((page + 1) * pageSize, count) +
            t("件を表示")
          : "");
      if (view === "calendar") renderCalendar(rows, count);
      else renderTable(rows);
      pager.replaceChildren();
      pager.hidden = view === "calendar" || count <= pageSize;
      if (!pager.hidden) {
        const previous = action(t("前のページ"), "admin-secondary", () => {
          page--;
          void load();
        });
        previous.disabled = page === 0;
        const next = action(t("次のページ"), "admin-secondary", () => {
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
      countLabel.textContent = t("読み込みエラー");
      body.replaceChildren(
        emptyState(
          t("項目を読み込めませんでした"),
          t("接続を確認し、もう一度お試しください。"),
          action(
            t("再読み込み"),
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
