import test from "node:test";
import assert from "node:assert/strict";
import { japanPublicationDate } from "../src/lib/dates.ts";
import {
  selectMatchCentre,
  matchSides,
  matchDate,
  matchTime,
} from "../src/lib/match-centre.ts";

// 순서가 다른 API 응답과 미정 일정을 함께 검사합니다. 실제 구단 데이터에는 테스트 경기를 넣지 않습니다.
const fixture = (id, kickoff, status = "scheduled") => ({
  id,
  kickoff,
  status,
  opponent: "Test opponent",
  competition: "",
  venue: "",
  homeAway: "home",
  ownScore: null,
  opponentScore: null,
  opponentLogo: "",
  report: [],
});

test("publication dates keep the original Japan calendar day across UTC boundaries", () => {
  assert.equal(japanPublicationDate("2026-10-08T15:00:00+00:00"), "2026.10.09");
  assert.equal(japanPublicationDate("2026-09-30T15:00:00Z"), "2026.10.01");
  assert.equal(japanPublicationDate(null), "");
});
test("match centre chooses latest result and chronological upcoming fixtures", () => {
  const rows = [
    fixture("undetermined", null),
    fixture("third", "2026-10-21T11:00:00Z"),
    fixture("cancelled", "2026-10-14T09:00:00Z", "cancelled"),
    fixture("old-scheduled", "2026-10-10T09:00:00Z"),
    fixture("latest-result", "2026-10-12T09:00:00Z", "completed"),
    fixture("second", "2026-10-18T11:00:00Z"),
    fixture("first", "2026-10-14T11:00:00Z"),
    fixture("postponed", "2026-10-13T11:00:00Z", "postponed"),
    fixture("old-result", "2026-10-01T09:00:00Z", "completed"),
  ];
  const original = rows.map((row) => row.id);
  const selected = selectMatchCentre(rows, Date.parse("2026-10-13T00:00:00Z"));
  assert.equal(selected.last.id, "latest-result");
  assert.equal(selected.next.id, "first");
  assert.equal(selected.upcoming.id, "second");
  assert.deepEqual(
    rows.map((row) => row.id),
    original,
  );
  const undetermined = selectMatchCentre([rows[0]]);
  assert.equal(undetermined.next.id, "undetermined");
  assert.equal(undetermined.upcoming, undefined);
  assert.deepEqual(selectMatchCentre([]), {
    last: undefined,
    next: undefined,
    upcoming: undefined,
  });
});
test("away fixtures swap team scores and kickoff times use Japan timezone", () => {
  const away = {
    ...fixture("away", "2026-10-14T19:00:00Z", "completed"),
    homeAway: "away",
    ownScore: 2,
    opponentScore: 1,
  };
  assert.deepEqual(matchSides(away), [
    { own: false, score: 1 },
    { own: true, score: 2 },
  ]);
  assert.deepEqual(matchSides(), [
    { own: true, score: null },
    { own: false, score: null },
  ]);
  assert.equal(matchTime(away.kickoff), "04:00");
  assert.ok(matchDate(away.kickoff).includes("15"));
  assert.equal(matchTime(null), "未定");
  assert.equal(matchDate(null), "日程未定");
});
