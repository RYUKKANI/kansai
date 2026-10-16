// [편집 안내] 승인·역할은 office_account_state의 서버 응답만 사용합니다.
// 이름은 표시용 문자열이며, 계정 연결에는 변하지 않는 user_id를 사용합니다.
export type StaffAccountState = {
  user_id: string;
  username: string | null;
  real_name: string | null;
  department: string | null;
  approval_status: "legacy" | "pending" | "approved" | "rejected" | "suspended";
  email_confirmed: boolean;
  email_confirmation_required?: boolean;
  email_verification_status?: "verified" | "pending" | "not_required";
  role: import("./member-grades").MemberGrade | null;
  member_grade?: import("./member-grades").MemberGrade | null;
  requested_grade?: import("./member-grades").MemberGrade | null;
  player_id?: string | null;
  active: boolean;
  identity_enrolled: boolean;
  profile_enrollment_pending?: boolean;
  name_edit_mode?: "unverified_edit" | "review_required" | "unavailable";
  can_edit_real_name?: boolean;
  name_verified_at: string | null;
  name_verified_by: string | null;
  name_verification_source?: "staff_review" | "initial_owner_setup" | null;
  legacy_account: boolean;
  legacy?: boolean;
  approved_real_name?: string | null;
  name_request: {
    id: string;
    real_name: string;
    status: string;
    reason: string | null;
    created_at: string;
    review_reason: string | null;
  } | null;
};
