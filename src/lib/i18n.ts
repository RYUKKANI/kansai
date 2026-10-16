import messages from "../data/locales/messages.json";
import { currentLocale, intlLocales, type Locale } from "./locale";
export {
  locales,
  languageNames,
  languageCodes,
  intlLocales,
  isLocale,
  localeFromUrl,
  currentLocale,
  localizedPage,
  languageUrl,
  type Locale,
} from "./locale";

// [편집 안내] 번역 문구는 data/locales/messages.json에서 한국어·영어를 함께 편집합니다.
// 일본어를 안정적인 원문 키로 사용합니다. 원문이 바뀐 새 콘텐츠는 번역을 확인할 때까지 그대로 표시합니다.
const catalog: Record<string, { ko: string; en: string }> = messages;
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
