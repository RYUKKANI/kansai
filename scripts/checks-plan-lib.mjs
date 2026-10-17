import path from "node:path";
import { parts } from "./test-parts.mjs";

export const partIds = Object.freeze(Object.keys(parts));
const operational = partIds.filter((id) => !["public", "tooling"].includes(id));
const browserParts = partIds.filter((id) => id !== "tooling");
const events = new Set(["local", "push", "pull_request", "workflow_dispatch", "schedule"]);
const fixtureNames = new Set(["legacy", "identity", "public", "preview"]);

// 경로는 Git 출력과 명시 입력 모두 같은 규칙으로 검사합니다. 저장소 밖 경로나
// 옵션처럼 해석될 입력을 다른 도구에 전달하지 않습니다. 파일명의 공백·개행은 보존합니다.
export function repositoryPath(value) {
  if (typeof value !== "string" || !value || value.includes("\0") || value.includes("\\") ||
      path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value) ||
      value.split("/").some((segment) => segment === "..") || value.startsWith("-")) {
    throw new Error("invalid_repository_path");
  }
  const normalized = path.posix.normalize(value);
  if (normalized === "." || normalized.startsWith("../")) throw new Error("invalid_repository_path");
  return normalized.replace(/^\.\//, "");
}

export function selectedPartIds(value) {
  if (value === undefined || value === null) return [];
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : null;
  if (!values || !values.length) throw new Error("invalid_parts");
  const ids = values.map((id) => typeof id === "string" ? id.trim() : "");
  if (ids.some((id) => !partIds.includes(id))) throw new Error("unknown_part");
  return partIds.filter((id) => ids.includes(id));
}

export function parseGitPaths(value) {
  if (typeof value !== "string" || (value && !value.endsWith("\0"))) throw new Error("invalid_git_paths");
  return [...new Set(value.split("\0").filter(Boolean).map(repositoryPath))];
}

function manifestParts(file) {
  return partIds.filter((id) => ["sql", "js", "identity"].some((kind) => (parts[id][kind] ?? []).includes(file)));
}

// 이 표에는 편집한 모듈을 사용하는 업무도 포함합니다. 새 코드가 표에 없으면
// 검사를 생략하지 않고 전체로 확장하여 누락된 경계를 PR에서 드러냅니다.
function sourceScope(file) {
  if (/^(?:docs\/|[^/]+\.md$|LICENSE(?:\.[^/]*)?$)/.test(file)) return { ids: [], native: false, reason: "documentation" };
  if (/^(?:package(?:-lock)?\.json|npm-shrinkwrap\.json|\.npmrc|\.node-version|\.nvmrc|astro\.config\.[^/]+|tsconfig\.json)$/.test(file))
    return { ids: partIds, native: true, reason: "dependencies_or_build_config" };
  if (/^supabase\/(?:migrations\/|functions\/|config\.toml$)/.test(file))
    return { ids: partIds, native: true, reason: "database_or_auth_server" };
  if (/^\.github\//.test(file)) return { ids: partIds, native: true, reason: "workflow_or_dependency_automation" };
  if (file === ".gitignore") return { ids: ["public", "tooling"], native: false, reason: "generated_file_rules" };
  if (/^scripts\/(?:checks-plan-lib|plan-checks|test-parts|run-tests|prepare-test-fixtures|check-results|release-checks|test-checks|check-parts|run-checks)\.mjs$/.test(file))
    return { ids: partIds, native: true, reason: "check_infrastructure" };
  if (file === "scripts/test-native-auth.mjs" || file === "scripts/reset-staff-password.mjs")
    return { ids: ["auth", "members", "security", "tooling"], native: true, reason: "native_auth_tooling" };
  if (/^scripts\/(?:export-preview\.mjs|lib\/preview-csp\.mjs)$/.test(file))
    return { ids: ["public", "security", "tooling"], native: false, reason: "preview_export" };
  if (/^scripts\/(?:prepare-build|needs-rebuild|verify-public-api|initial-content)\.mjs$/.test(file))
    return { ids: ["public", "tooling"], native: false, reason: "public_build" };
  if (/^(?:tests\/helpers\/|supabase\/tests\/office-database\.mjs$)/.test(file))
    return { ids: partIds, native: true, reason: "shared_test_fixture" };

  const namedTest = manifestParts(file);
  if (namedTest.length) return { ids: namedTest, native: false, reason: "part_test" };
  if (/^(?:tests\/|supabase\/tests\/)/.test(file)) return { ids: partIds, native: true, reason: "unmapped_test" };

  if (/^src\/scripts\/admin-(?:dashboard|publication-status)\.ts$/.test(file))
    return { ids: ["dashboard"], native: false, reason: "dashboard" };
  if (/^src\/styles\/admin-dashboard\.css$/.test(file)) return { ids: ["dashboard"], native: false, reason: "dashboard_style" };
  if (file === "src/scripts/admin.ts") return { ids: operational, native: true, reason: "shared_office_auth_controller" };
  if (/^src\/scripts\/(?:staff-auth|staff-auth-help|staff-support-recovery|owner-account-management)\.ts$/.test(file) ||
      /^src\/lib\/(?:staff-auth-types|staff-auth-recovery|member-grades)\.ts$/.test(file) ||
      /^src\/components\/(?:admin\/StaffAuthPortal|StaffSupportRecovery)\.astro$/.test(file) || /^src\/pages\/admin\/help(?:\/|\.)/.test(file))
    return { ids: ["auth", "members", "security"], native: true, reason: "authentication_boundary" };
  if (file === "src/scripts/admin-staff.ts") return { ids: ["members", "auth", "security"], native: true, reason: "member_access" };
  if (file === "src/scripts/player-portal.ts") return { ids: ["players", "members", "security"], native: true, reason: "player_access" };
  // 우측 하단 위젯도 같은 비공개 채팅 컨트롤러와 권한 경계를 사용합니다.
  if (["src/scripts/club-chat.ts", "src/styles/club-chat.css", "src/scripts/club-chat-widget.ts", "src/styles/club-chat-widget.css"].includes(file))
    return { ids: ["chat"], native: false, reason: "club_chat" };
  if (file === "src/scripts/training-attendance.ts" || file === "src/styles/training-attendance.css")
    return { ids: ["attendance"], native: false, reason: "training_attendance" };
  if (/^src\/scripts\/admin-(?:content|translations)\.ts$/.test(file))
    return { ids: ["content", "media"], native: false, reason: "content_editor" };
  if (/^src\/scripts\/admin-(?:player|photo)\.ts$/.test(file))
    return { ids: ["players", "media", "content"], native: false, reason: "player_editor" };
  if (file === "src/scripts/admin-schedule.ts" || /^src\/lib\/(?:schedule|dates)\.ts$/.test(file))
    return { ids: ["schedule", "dashboard", "public", "content"], native: false, reason: "schedule_or_dates" };
  if (file === "src/scripts/admin-list.ts" || /^src\/lib\/(?:admin-config|admin-ui|content-types|office-features)\.ts$/.test(file))
    return { ids: operational, native: false, reason: "shared_office_module" };
  if (file === "src/lib/office-database.ts") return { ids: operational, native: true, reason: "shared_database_client" };
  if (/^src\/lib\/content-(?:drafts|translations)\.ts$/.test(file))
    return { ids: ["content", "players", "media", "public"], native: false, reason: "content_data" };
  if (/^src\/(?:lib\/(?:i18n|locale|urls|public-i18n)\.ts|data\/locales\/|scripts\/languages\.ts)/.test(file))
    return { ids: browserParts, native: false, reason: "shared_localization" };
  if (file === "src/components/LanguageSwitcher.astro" || file === "src/data/club.ts")
    return { ids: browserParts, native: false, reason: "shared_site_and_office_data" };
  if (/^src\/(?:lib\/.*security|components\/.*(?:Security|Csp)|layouts\/.*Security)/i.test(file))
    return { ids: browserParts, native: true, reason: "security_policy" };
  if (/^src\/styles\/(?:staff-auth|staff-support-recovery)\.css$/.test(file))
    return { ids: ["auth", "members", "security"], native: false, reason: "authentication_style" };
  if (/^src\/styles\/(?:admin[^/]*|dialogs)\.css$/.test(file))
    return { ids: operational, native: false, reason: "shared_office_style" };
  if (/^src\/styles\/(?:global|base|responsive|languages)\.css$/.test(file))
    return { ids: browserParts, native: false, reason: "shared_style" };
  if (/^src\/styles\/(?:footer|header|home|news|pages)\.css$/.test(file))
    return { ids: ["public"], native: false, reason: "public_style" };
  if (/^src\/styles\//.test(file)) return { ids: browserParts, native: false, reason: "unmapped_shared_style" };
  if (/^src\/(?:pages\/admin\/|layouts\/Admin|components\/admin\/)/.test(file))
    return { ids: operational, native: false, reason: "shared_office_markup" };
  if (/^src\/lib\/match-centre\.ts$/.test(file)) return { ids: ["schedule", "public"], native: false, reason: "match_centre" };
  if (/^(?:src\/(?:pages\/|components\/|layouts\/|data\/|assets\/|styles\/)|src\/scripts\/site\.ts$|public\/|CNAME$)/.test(file))
    return { ids: ["public"], native: false, reason: "public_site" };
  return { ids: partIds, native: true, reason: "unmapped_path" };
}

export function planChecks({ files = [], forceParts, all = false, event = "local", fallbackReason } = {}) {
  if (!events.has(event)) throw new Error("unsupported_event");
  if (!Array.isArray(files) || typeof all !== "boolean") throw new Error("invalid_plan_input");
  const safeFiles = [...new Set(files.map(repositoryPath))];
  const forced = selectedPartIds(forceParts);
  const selected = new Set();
  const reasons = new Set();
  let nativeAuth = false;
  if (all || fallbackReason) {
    partIds.forEach((id) => selected.add(id));
    reasons.add(fallbackReason ?? "explicit_all");
    nativeAuth = true;
  } else if (event === "workflow_dispatch" && !forced.length) {
    selected.add("dashboard");
    reasons.add("manual_default_dashboard");
  } else if (event === "schedule") {
    selected.add("public");
    reasons.add("scheduled_public_check");
  } else if (forced.length) {
    forced.forEach((id) => selected.add(id));
    nativeAuth = forced.some((id) => ["auth", "members", "security"].includes(id));
    reasons.add("explicit_parts");
  } else {
    for (const file of safeFiles) {
      const scope = sourceScope(file);
      scope.ids.forEach((id) => selected.add(id));
      reasons.add(scope.reason);
      nativeAuth ||= scope.native;
    }
    if (!safeFiles.length) reasons.add("no_changes");
  }
  const ids = partIds.filter((id) => selected.has(id));
  const fixtures = new Set(ids.flatMap((id) => parts[id].fixtures ?? []));
  if ([...fixtures].some((fixture) => !fixtureNames.has(fixture))) throw new Error("unknown_fixture");
  return {
    matrix: { part: ids },
    has_parts: ids.length > 0,
    needs_build: fixtures.size > 0,
    needs_legacy: fixtures.has("legacy"),
    needs_identity: fixtures.has("identity"),
    needs_public: fixtures.has("public"),
    needs_preview: fixtures.has("preview"),
    native_auth: nativeAuth,
    selected_parts: ids,
    reason: [...reasons].sort().join(","),
    files_count: safeFiles.length,
    files: safeFiles,
  };
}
