// [편집 안내] 달력의 모든 경계는 브라우저 현지 시간과 무관하게 JST 자정으로 계산합니다.
export type ScheduleView = "month" | "week" | "list";
export function jstDay(value: string | Date): string {
  return new Date(new Date(value).getTime() + 9 * 3600000)
    .toISOString()
    .slice(0, 10);
}
export function addDays(day: string, amount: number) {
  const value = new Date(day + "T00:00:00Z");
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}
export function calendarRange(day: string, view: ScheduleView) {
  const date = new Date(day + "T00:00:00Z");
  const start =
    view === "week"
      ? addDays(day, -(date.getUTCDay() + 6) % 7)
      : day.slice(0, 7) + "-01";
  const next = new Date(start + "T00:00:00Z");
  if (view === "week") next.setUTCDate(next.getUTCDate() + 7);
  else next.setUTCMonth(next.getUTCMonth() + 1);
  const end = next.toISOString().slice(0, 10);
  return {
    start,
    end,
    from: new Date(start + "T00:00:00+09:00").toISOString(),
    until: new Date(end + "T00:00:00+09:00").toISOString(),
  };
}
export function shiftPeriod(day: string, view: ScheduleView, amount: number) {
  if (view === "week") return addDays(day, amount * 7);
  const date = new Date(day.slice(0, 7) + "-01T00:00:00Z");
  date.setUTCMonth(date.getUTCMonth() + amount);
  return date.toISOString().slice(0, 10);
}
