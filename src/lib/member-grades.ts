import { text as t } from "./i18n";

// [편집 안내] 실제 소속은 서버가 승인한 role로만 판단합니다. 희망 소속·담당 업무는 권한이 아닙니다.
export const memberGrades = ["owner", "staff", "player"] as const;
export type MemberGrade = (typeof memberGrades)[number];
export function isMemberGrade(value: unknown): value is MemberGrade {
  return typeof value === "string" && memberGrades.includes(value as MemberGrade);
}

// 전환 전 저장된 역할은 삭제하지 않고 스태프 권한으로 읽습니다. 새 승인에는 세 값만 보냅니다.
export function normalizeMemberGrade(value: unknown): MemberGrade | null {
  if (isMemberGrade(value)) return value;
  return ["administrator", "editor", "coach"].includes(String(value)) ? "staff" : null;
}
export function memberGradeLabel(value: unknown): string {
  const grade = normalizeMemberGrade(value);
  return grade ? t({ owner: "統括", staff: "スタッフ", player: "選手" }[grade]) : t("未設定");
}
