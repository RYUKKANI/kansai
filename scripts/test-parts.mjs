// [편집 안내] 기능별 검사 목록의 단일 원본입니다. 새 검사는 반드시 관련 파트에 명시적으로 추가합니다.
// 여러 업무가 공유하는 검사는 중복 기재할 수 있고 실행기는 같은 fixture 안에서 한 번만 실행합니다.
// legacy/identity는 가짜 연결 정보로 만든 관리자 fixture, public/preview는 정적 페이지 검사용입니다.
export const parts = {
  dashboard: {
    label: "대시보드",
    sql: [],
    js: ["tests/office.test.mjs"],
    identity: [],
    fixtures: ["legacy"],
  },
  auth: {
    label: "로그인·가입·복구",
    sql: [
      "supabase/tests/staff-identity.test.mjs",
      "supabase/tests/live-session.test.mjs",
      "supabase/tests/support-recovery.test.mjs",
      "supabase/tests/registration-reservation.test.mjs",
      "supabase/tests/staff-no-email.test.mjs",
    ],
    js: [
      "tests/auth-gateway.test.mjs",
      "tests/staff-admin-provision.test.mjs",
      "tests/staff-auth-recovery.test.mjs",
      "tests/staff-auth-ui.test.mjs",
      "tests/staff-password-support.test.mjs",
      "tests/staff-support-recovery-ui.test.mjs",
      "tests/support-recovery-gateway.test.mjs",
      "tests/support-recovery-server.test.mjs",
      "tests/admin-session-security.test.mjs",
      "tests/localization.test.mjs",
    ],
    identity: [
      "tests/staff-identity-app.test.mjs",
      "tests/staff-form-focus-app.test.mjs",
      "tests/admin-session-security.test.mjs",
    ],
    fixtures: ["legacy", "identity", "public"],
  },
  members: {
    label: "회원·등급·실명",
    sql: [
      "supabase/tests/staff-identity.test.mjs",
      "supabase/tests/owner-account.test.mjs",
      "supabase/tests/unverified-name.test.mjs",
      "supabase/tests/member-grade-accounts.test.mjs",
      "supabase/tests/member-grade-permissions.test.mjs",
      "supabase/tests/live-session.test.mjs",
    ],
    js: [
      "tests/staff-management-ui.test.mjs",
      "tests/owner-account-management-ui.test.mjs",
      "tests/member-grades-app.test.mjs",
    ],
    identity: [
      "tests/staff-profile-state-app.test.mjs",
      "tests/staff-form-focus-app.test.mjs",
      "tests/member-grades-app.test.mjs",
    ],
    fixtures: ["legacy", "identity"],
  },
  content: {
    label: "뉴스·페이지·번역",
    sql: ["supabase/tests/content.test.mjs", "supabase/tests/translations.test.mjs"],
    js: [
      "tests/admin.test.mjs",
      "tests/content.test.mjs",
      "tests/translations.test.mjs",
      "tests/admin-editor-lifecycle.test.mjs",
      "tests/admin-editor-save-state.test.mjs",
      // 공개 페이지와 관리자 번역 동작을 함께 검사하는 기존 suite라서 두 fixture가 필요합니다.
      "tests/localization.test.mjs",
    ],
    identity: [],
    fixtures: ["legacy", "public"],
  },
  players: {
    label: "선수·프로필",
    sql: ["supabase/tests/player-form.test.mjs", "supabase/tests/member-grade-accounts.test.mjs"],
    js: [
      "tests/player-office.test.mjs",
      "tests/player-editor-lifecycle.test.mjs",
      "tests/member-grades-app.test.mjs",
      "tests/translations.test.mjs",
    ],
    identity: ["tests/member-grades-app.test.mjs"],
    fixtures: ["legacy", "identity"],
  },
  schedule: {
    label: "경기·훈련·행사",
    sql: ["supabase/tests/schedule.test.mjs"],
    js: ["tests/schedule.test.mjs", "tests/match-centre.test.mjs"],
    identity: [],
    fixtures: ["legacy"],
  },
  media: {
    label: "사진·영상",
    sql: ["supabase/tests/content.test.mjs"],
    js: ["tests/admin-editor-lifecycle.test.mjs", "tests/translations.test.mjs", "tests/office.test.mjs"],
    identity: [],
    fixtures: ["legacy"],
  },
  public: {
    label: "공개 홈페이지",
    sql: [],
    // CMS 예약 배포에서는 인증 UI·RLS·실제 Auth 검사를 실행하지 않습니다.
    js: ["tests/site.test.mjs", "tests/public-runtime.test.mjs", "tests/page-styles.test.mjs", "tests/match-centre.test.mjs"],
    identity: [],
    fixtures: ["public", "preview"],
  },
  security: {
    label: "권한·세션·보안 정책",
    sql: [
      "supabase/tests/rls.test.mjs",
      "supabase/tests/live-session.test.mjs",
      "supabase/tests/staff-security-boundaries.test.mjs",
      "supabase/tests/security-hardening.test.mjs",
      "supabase/tests/member-grade-permissions.test.mjs",
    ],
    js: ["tests/auth-gateway.test.mjs", "tests/admin-session-security.test.mjs", "tests/security-policy.test.mjs", "tests/member-grades-app.test.mjs"],
    identity: ["tests/admin-session-security.test.mjs", "tests/member-grades-app.test.mjs"],
    fixtures: ["legacy", "identity", "public"],
  },
  tooling: {
    label: "검사·빌드 도구",
    sql: [],
    js: ["tests/export-preview.test.mjs", "tests/checks-plan.test.mjs", "tests/release-checks.test.mjs"],
    identity: [],
    fixtures: [],
  },
};

export const fixtureIds = ["legacy", "identity", "public", "preview"];
export const fixtureDirectories = { legacy: "dist-legacy", identity: "dist-identity", public: "dist", preview: "preview" };
export const testConnection = {
  url: "https://identity-test.supabase.co",
  publishableKey: "sb_publishable_identity_test_only",
};

// CLI·변경 파일 선택기·도구 검사가 동일한 합집합을 사용할 수 있도록 계산만 하는 함수를 제공합니다.
export function selectParts(ids) {
  if (!Array.isArray(ids) || !ids.length) throw new Error("검사할 파트를 하나 이상 지정하세요.");
  const selected = [...new Set(ids)];
  for (const id of selected)
    if (!Object.hasOwn(parts, id)) throw new Error(`알 수 없는 검사 파트: ${String(id)}`);
  const unique = key => [...new Set(selected.flatMap(id => parts[id][key]))];
  return { parts: selected, sql: unique("sql"), js: unique("js"), identity: unique("identity"), fixtures: unique("fixtures") };
}
