import { text as t } from "./i18n";

// [편집 안내] 최초 총괄의 초기 등록과 다른 관계자가 한 실명 확인을 구분합니다.
// 표시 문구는 서버의 확인 시각·출처만 사용하며 사람 확인자를 만들어내지 않습니다.
type NameVerification = {
  name_verified_at?: unknown;
  verified_at?: unknown;
  name_verification_source?: unknown;
  name_verified_by_name?: unknown;
  verified_by_name?: unknown;
  verified_by?: unknown;
  name_verified_by?: unknown;
};
const value = (input: unknown) => typeof input === "string" ? input.trim() : "";
export const isInitialOwnerNameRegistration = (account: NameVerification) =>
  account.name_verification_source === "initial_owner_setup" && Boolean(value(account.name_verified_at));

export function staffNameVerificationLabel(account: NameVerification): string {
  if (isInitialOwnerNameRegistration(account)) return t("初代統括の登録確認");
  return value(account.name_verified_at) || value(account.verified_at) ? t("確認済み") : t("未確認");
}

export function staffNameVerifierLabel(account: NameVerification): string {
  if (account.name_verification_source === "initial_owner_setup")
    return t("他の関係者による確認ではありません");
  return value(account.name_verified_by_name) || value(account.verified_by_name) ||
    value(account.verified_by) || value(account.name_verified_by) || "—";
}
