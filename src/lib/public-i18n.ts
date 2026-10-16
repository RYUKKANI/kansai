// [편집 안내] 공개 브라우저 동작에 필요한 원문 키만 모읍니다. 번역은 기존 messages.json이 유일한 원본입니다.
// SiteLayout이 현재 언어의 값만 HTML 속성에 넣고, 전체 관리자 번역 사전은 서버에 남깁니다.
export const publicRuntimeSources = [
  "表示言語を選択",
  "表示言語",
  "メニューを閉じる",
  "メニューを開く",
  "{0} STORY",
  "{0} STORIES",
  "関西ユナイテッドFCの活動写真",
  "公式動画",
] as const;

let runtimeMessages: Record<string, unknown> | undefined;
export function publicText(source: string): string {
  if (!runtimeMessages) {
    try {
      const value: unknown = JSON.parse(document.body.dataset.publicMessages ?? "{}");
      runtimeMessages =
        value && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : {};
    } catch {
      // 속성이 없는 이전 HTML도 원문으로 표시하여 공개 동작을 계속 사용할 수 있게 합니다.
      runtimeMessages = {};
    }
  }
  const translated = Object.hasOwn(runtimeMessages, source)
    ? runtimeMessages[source]
    : undefined;
  return typeof translated === "string" ? translated : source;
}
export function publicFormat(source: string, ...values: unknown[]): string {
  return publicText(source).replace(/\{(\d+)\}/g, (_, index: string) =>
    String(values[Number(index)] ?? ""),
  );
}
