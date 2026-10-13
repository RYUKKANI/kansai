import type { Resource } from "./admin-config";
// 콘텐츠 초안만 브라우저에 보관합니다. 선수·연락처·건강 정보는 지원 대상에 추가하지 않습니다.
export const contentResources: Resource[] = [
  "articles",
  "media_assets",
  "media_albums",
  "site_pages",
];
export type LocalDraft = {
  savedAt: number;
  expected: string | null;
  values: [string, string][];
};
export const draftKey = (user: string, resource: Resource, id: string | null) =>
  "kansai-office-draft:" + user + ":" + resource + ":" + (id || "new");
export function readDraft(
  storage: Storage,
  key: string,
  now = Date.now(),
): LocalDraft | null {
  try {
    const value = JSON.parse(storage.getItem(key) || "null");
    if (
      !value ||
      typeof value.savedAt !== "number" ||
      now - value.savedAt > 7 * 86400000 ||
      value.savedAt > now + 60000 ||
      !Array.isArray(value.values) ||
      value.values.some(
        (pair: unknown) =>
          !Array.isArray(pair) ||
          pair.length !== 2 ||
          pair.some((item) => typeof item !== "string"),
      )
    ) {
      storage.removeItem(key);
      return null;
    }
    return value as LocalDraft;
  } catch {
    return null;
  }
}
export function writeDraft(storage: Storage, key: string, draft: LocalDraft) {
  const text = JSON.stringify(draft);
  if (text.length > 2_000_000)
    throw new Error(
      "このブラウザの一時保存サイズを超えています。下書き保存をご利用ください。",
    );
  storage.setItem(key, text);
}
export function clearUserDrafts(storage: Storage, user: string) {
  for (let i = storage.length - 1; i >= 0; i--) {
    const key = storage.key(i);
    if (key?.startsWith("kansai-office-draft:" + user + ":"))
      storage.removeItem(key);
  }
}
