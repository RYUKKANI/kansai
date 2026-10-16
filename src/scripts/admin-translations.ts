import { text as t } from "../lib/i18n";
import { resources, type Resource } from "../lib/admin-config";
import { node, action, type Row } from "../lib/admin-ui";
import {
  contentLanguages,
  contentLanguageNames,
  translatedFields,
  translationName,
  readTranslations,
  translationComplete,
  type ContentTranslations,
} from "../lib/content-translations";

// 기존 일본어 입력란을 그대로 이동합니다. 탭을 바꿔도 입력 요소를 다시 만들거나
// 값을 번역하지 않으며, 숨겨진 탭도 임시 저장과 서버 저장에 함께 포함됩니다.
export function attachTranslationEditor(
  form: HTMLFormElement,
  fields: HTMLElement,
  resource: Resource,
  row: Row | null,
) {
  const names = translatedFields(resource);
  if (!names.length) return;
  const section = node("section", "", "office-field-group office-translations");
  section.append(
    node("h3", t("言語別の内容")),
    node(
      "p",
      t(
        "日本語を基本に、韓国語・英語を同じ記事に入力できます。URL・写真・公開設定は共通です。",
      ),
      "admin-help",
    ),
  );
  const tabs = node("div", "", "office-language-tabs");
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", t("記事の言語"));
  const translations = (row?.translations ?? {}) as ContentTranslations;
  const buttons = new Map<string, HTMLButtonElement>();
  const panels = new Map<string, HTMLElement>();
  function activate(locale: string, focus = false) {
    form.dataset.contentLanguage = locale;
    for (const language of contentLanguages) {
      const active = language === locale;
      const button = buttons.get(language)!;
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
      panels.get(language)!.hidden = !active;
    }
    if (focus) buttons.get(locale)?.focus();
  }
  for (const [index, locale] of contentLanguages.entries()) {
    const button = action(contentLanguageNames[locale], "", () =>
      activate(locale),
    );
    button.id = "content-tab-" + locale;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-controls", "content-panel-" + locale);
    button.addEventListener("keydown", (event) => {
      const target =
        event.key === "ArrowRight"
          ? (index + 1) % 3
          : event.key === "ArrowLeft"
            ? (index + 2) % 3
            : event.key === "Home"
              ? 0
              : event.key === "End"
                ? 2
                : -1;
      if (target < 0) return;
      event.preventDefault();
      activate(contentLanguages[target]!, true);
    });
    buttons.set(locale, button);
    tabs.append(button);
    const panel = node("div", "", "office-field-group-body");
    panel.id = "content-panel-" + locale;
    panel.dataset.contentLocale = locale;
    panel.lang = locale;
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", button.id);
    panels.set(locale, panel);
    if (locale === "ja") {
      for (const name of names) {
        const original = fields
          .querySelector("#field-" + name)
          ?.closest(".admin-field");
        if (original) panel.append(original);
      }
    } else {
      panel.append(
        node(
          "p",
          t(
            "翻訳しない言語は空欄のままにできます。入力した言語は全項目を完成させてから公開してください。",
          ),
          "admin-help admin-field-wide",
        ),
      );
      for (const name of names) {
        const field = resources[resource].fields.find(
          (item) => item.name === name,
        )!;
        const container = node("div", "", "admin-field admin-field-wide");
        const input =
          field.type === "textarea" ? node("textarea") : node("input");
        input.name = translationName(locale, name);
        input.id = "field-" + input.name;
        input.value = translations[locale]?.[name] ?? "";
        if (name === "title") input.maxLength = 200;
        if (name === "body" && input instanceof HTMLTextAreaElement)
          input.rows = 10;
        const label = node("label", field.label);
        label.htmlFor = input.id;
        container.append(label, input);
        panel.append(container);
      }
    }
  }
  section.append(tabs, ...panels.values());
  fields.prepend(section);
  function status() {
    const values = readTranslations(new FormData(form), resource);
    for (const locale of ["ko", "en"] as const) {
      const state = !values[locale]
        ? "empty"
        : translationComplete(values[locale], resource)
          ? "complete"
          : "partial";
      const label =
        state === "empty"
          ? t("未入力")
          : state === "complete"
            ? t("入力済み")
            : t("入力途中");
      const button = buttons.get(locale)!;
      button.dataset.translationState = state;
      button.replaceChildren(
        node("span", contentLanguageNames[locale]),
        node("small", label),
      );
    }
  }
  section.addEventListener("input", status);
  // 숨겨진 일본어 필수 항목에 오류가 있으면 해당 탭을 열어 브라우저가 포커스할 수 있게 합니다.
  section.addEventListener(
    "invalid",
    (event) => {
      const panel = (event.target as HTMLElement).closest<HTMLElement>(
        "[data-content-locale]",
      );
      if (panel) activate(panel.dataset.contentLocale!);
    },
    true,
  );
  activate("ja");
  status();
}
