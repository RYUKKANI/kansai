// 모든 경기·훈련 시각은 저장 시 UTC, 방문자 화면에서는 일본 시간으로 표시합니다.
export function japanDate(value: string | null): string {
  if (!value) return "日時 未発表";
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
