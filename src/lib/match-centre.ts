import type { PublicFixture } from "./content-types";
import { intlLocales, translate, type Locale } from "./i18n";

// [편집 안내] 홈에는 최근 결과 1개와 앞으로 열릴 경기 2개를 표시합니다.
// 미정 일정은 확정 일정 뒤에 놓고, 취소·연기되거나 이미 지난 예정 경기는 제외합니다.
export function selectMatchCentre(fixtures: PublicFixture[], now = Date.now()) {
  const scheduled = fixtures
    .filter(
      (fixture) =>
        fixture.status === "scheduled" &&
        (!fixture.kickoff || Date.parse(fixture.kickoff) >= now),
    )
    .sort(
      (a, b) =>
        (a.kickoff ? Date.parse(a.kickoff) : Infinity) -
        (b.kickoff ? Date.parse(b.kickoff) : Infinity),
    );
  const completed = fixtures
    .filter((fixture) => fixture.status === "completed")
    .sort(
      (a, b) =>
        (b.kickoff ? Date.parse(b.kickoff) : -Infinity) -
        (a.kickoff ? Date.parse(a.kickoff) : -Infinity),
    );
  return {
    last: completed[0],
    next: scheduled[0],
    upcoming: scheduled[1],
  };
}

// 홈·원정 순서에 맞춰 팀과 점수도 함께 바꿉니다. 실제로 없는 점수는 0으로 만들지 않습니다.
export function matchSides(fixture?: PublicFixture) {
  const club = { own: true, score: fixture?.ownScore ?? null };
  const opponent = { own: false, score: fixture?.opponentScore ?? null };
  return fixture?.homeAway === "away"
    ? ([opponent, club] as const)
    : ([club, opponent] as const);
}

export function matchDate(kickoff: string | null, locale: Locale = "ja") {
  if (!kickoff) return translate("日程未定", locale);
  return new Intl.DateTimeFormat(intlLocales[locale], {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(new Date(kickoff));
}

export function matchTime(kickoff: string | null, locale: Locale = "ja") {
  if (!kickoff) return translate("未定", locale);
  return new Intl.DateTimeFormat(intlLocales[locale], {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(kickoff));
}
