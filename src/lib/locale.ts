// [편집 안내] URL·언어 코드는 번역 사전과 분리합니다. 공개 페이지는 관리자 문구 전체를 내려받지 않습니다.
export const locales = ["ja", "ko", "en"] as const;
export type Locale = (typeof locales)[number];
export const languageNames = { ja: "日本語", ko: "한국어", en: "English" };
export const languageCodes = { ja: "JP", ko: "KO", en: "EN" };
export const intlLocales = { ja: "ja-JP", ko: "ko-KR", en: "en-GB" };
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
  // 인증 콜백 URL은 유지하고 관리자 화면의 표시 언어만 브라우저에 기억합니다.
  if (url.pathname.startsWith(base + "admin/") && !url.searchParams.has("lang")) {
    try {
      const saved = localStorage.getItem("kansai-language");
      if (isLocale(saved)) return saved;
    } catch {}
  }
  return localeFromUrl(url);
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
