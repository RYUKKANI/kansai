import messages from "../data/locales/messages.json";

// [편집 안내] 번역 문구는 data/locales/messages.json에서 한국어·영어를 함께 편집합니다.
// 일본어를 안정적인 원문 키로 사용합니다. 원문이 바뀐 새 콘텐츠는 번역을 확인할 때까지 그대로 표시합니다.
export const locales = ["ja", "ko", "en"] as const;
export type Locale = (typeof locales)[number];
export const languageNames = { ja: "日本語", ko: "한국어", en: "English" };
export const languageCodes = { ja: "JP", ko: "KO", en: "EN" };
export const intlLocales = { ja: "ja-JP", ko: "ko-KR", en: "en-GB" };
const catalog: Record<string, { ko: string; en: string }> = messages;
const base = import.meta.env.BASE_URL.replace(/\/?$/, "/");
export function isLocale(value: unknown): value is Locale {
  return locales.includes(value as Locale);
}
export function localeFromUrl(url: URL): Locale {
  const relative = url.pathname.startsWith(base)
    ? url.pathname.slice(base.length)
    : url.pathname.replace(/^\//, "");
  const first = relative.split("/")[0];
  if (first === "admin") {
    const query = url.searchParams.get("lang");
    return isLocale(query) ? query : "ja";
  }
  return isLocale(first) ? first : "ja";
}
export function currentLocale(): Locale {
  if (typeof window === "undefined") return "ja";
  const url = new URL(window.location.href);
  // 인증 메일의 기존 허용된 복귀 주소를 유지합니다. 관리자 언어만 이 브라우저의 선택을 기억합니다.
  if (url.pathname.startsWith(base + "admin/") && !url.searchParams.has("lang")) {
    try {
      const saved = localStorage.getItem("kansai-language");
      if (isLocale(saved)) return saved;
    } catch {}
  }
  return localeFromUrl(url);
}
export function translate(source: string, locale: Locale): string {
  return locale === "ja" ? source : (catalog[source]?.[locale] ?? source);
}
export const forLocale = (locale: Locale) => (source: string) =>
  translate(source, locale);
export const text = (source: string) => translate(source, currentLocale());
// 문장 전체를 번역한 뒤 변수만 넣어 언어마다 다른 어순을 지원합니다. HTML을 만들지 않습니다.
export function formatForLocale(locale: Locale) {
  return (source: string, ...values: unknown[]) =>
    translate(source, locale).replace(/\{(\d+)\}/g, (_, index: string) =>
      String(values[Number(index)] ?? ""),
    );
}
export const format = (source: string, ...values: unknown[]) =>
  formatForLocale(currentLocale())(source, ...values);
export function weekdayNames(locale: Locale = currentLocale()): string[] {
  return Array.from({ length: 7 }, (_, day) =>
    new Intl.DateTimeFormat(intlLocales[locale], {
      weekday: "short",
      timeZone: "UTC",
    }).format(new Date(Date.UTC(2023, 0, 1 + day))),
  );
}
export function localizedPage(path = "", locale: Locale = "ja"): string {
  const clean = path.replace(/^\//, "");
  // 관리자는 하나의 세션·화면을 유지하고 표시 언어만 query로 바꿉니다. 권한과 DB 값은 바꾸지 않습니다.
  if (clean.startsWith("admin/"))
    return base + clean + (locale === "ja" ? "" : "?lang=" + locale);
  return base + (locale === "ja" ? "" : locale + "/") + clean;
}
export function languageUrl(url: URL, locale: Locale): string {
  let relative = url.pathname.startsWith(base)
    ? url.pathname.slice(base.length)
    : "";
  const first = relative.split("/")[0];
  if (isLocale(first)) relative = relative.slice(first.length + 1);
  return localizedPage(relative, locale);
}
// 번역된 화면도 날짜는 JST를 사용합니다. 언어와 시간대를 별개로 관리합니다.
export function localizedDate(
  value: string | null,
  locale: Locale,
  time = false,
): string {
  if (!value || Number.isNaN(Date.parse(value)))
    return translate("日時 未発表", locale);
  return new Intl.DateTimeFormat(intlLocales[locale], {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "long",
    day: "numeric",
    ...(time
      ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" as const }
      : {}),
  }).format(new Date(value));
}
