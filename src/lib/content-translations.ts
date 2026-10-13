import type { Locale } from "./i18n";

// [편집 안내] 일본어는 기존 열에 유지합니다. 번역은 같은 게시글의 JSON에 저장하므로
// URL, 사진, 발행 상태, 승인과 수정 이력을 언어별로 중복 생성하지 않습니다.
export type TranslationFields = {
  title?: string;
  summary?: string;
  body?: string;
  cover_alt?: string;
  introduction?: string;
};
export type ContentTranslations = Partial<
  Record<"ko" | "en", TranslationFields>
>;
export const contentLanguages = ["ja", "ko", "en"] as const;
export const contentLanguageNames = {
  ja: "日本語",
  ko: "한국어",
  en: "English",
};
export const translatedFields = (
  resource: string,
): (keyof TranslationFields)[] =>
  resource === "articles"
    ? ["title", "summary", "body", "cover_alt"]
    : resource === "site_pages"
      ? ["title", "introduction", "body"]
      : [];
export const translationName = (locale: "ko" | "en", field: string) =>
  `translation_${locale}_${field}`;
export function readTranslations(
  data: FormData,
  resource: string,
): ContentTranslations {
  const result: ContentTranslations = {};
  for (const locale of ["ko", "en"] as const) {
    const values: TranslationFields = {};
    for (const field of translatedFields(resource)) {
      const value = String(
        data.get(translationName(locale, field)) ?? "",
      ).trim();
      if (value) values[field] = value;
    }
    if (Object.keys(values).length) result[locale] = values;
  }
  return result;
}
export function translationComplete(
  value: TranslationFields | undefined,
  resource: string,
): boolean {
  return translatedFields(resource).every((field) =>
    Boolean(value?.[field]?.trim()),
  );
}
export function contentForLanguage(
  data: FormData,
  resource: string,
  locale: Locale,
): TranslationFields {
  const result: TranslationFields = {};
  for (const field of translatedFields(resource))
    result[field] = String(
      data.get(locale === "ja" ? field : translationName(locale, field)) ?? "",
    );
  return result;
}
