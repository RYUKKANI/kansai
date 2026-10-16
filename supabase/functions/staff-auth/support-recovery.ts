import type { Client } from "./gateway.ts";

type Reply = { status: number; body: Record<string, unknown> };
type Proof = { service: Client; requestId: string; proofHash: string };
type Outcome = "succeeded" | "failed" | "uncertain";
const unavailable = (): Reply => ({ status: 403, body: { error: "support_recovery_unavailable" } });
const uncertain = (requestId: string): Reply => ({ status: 409, body: { error: "support_recovery_uncertain", request_id: requestId } });

// [편집 안내] 브라우저 비밀은 gateway의 독립 목적 HMAC 뒤에만 전달합니다. 요청 생성은 권한을 주지 않습니다.
// 실제 프로젝트 관리자가 DB의 비공개 승인 함수를 호출하기 전에는 비밀번호 변경 경로가 열리지 않습니다.
export async function supportRecoveryRequest(input: Proof & { username: string; fingerprint: string }): Promise<Reply> {
  try {
    const result = await input.service.rpc("staff_auth_support_recovery_request", {
      p_request_id: input.requestId, p_username: input.username, p_proof_hash: input.proofHash, p_fingerprint: input.fingerprint,
    });
    if (result.error || result.data?.request_id !== input.requestId || result.data?.device_fingerprint !== input.fingerprint || typeof result.data?.expires_at !== "string") return unavailable();
    // DB의 내부 대상 UUID·상태·역할을 실수로 응답에 펼치지 않습니다.
    return { status: 200, body: { success: true, code: "support_recovery_requested", request_id: input.requestId, device_fingerprint: input.fingerprint, expires_at: result.data.expires_at } };
  } catch { return unavailable(); }
}

export async function supportRecoveryStatus(input: Proof): Promise<Reply> {
  try {
    const result = await input.service.rpc("staff_auth_support_recovery_status", { p_request_id: input.requestId, p_proof_hash: input.proofHash });
    const states = ["requested", "approved", "executing", "succeeded", "failed", "uncertain", "expired"];
    if (result.error || !states.includes(result.data?.state) || result.data?.request_id !== input.requestId || !/^[0-9a-f]{16}$/.test(result.data?.device_fingerprint ?? "") || typeof result.data?.expires_at !== "string") return unavailable();
    return { status: 200, body: { success: true, code: "support_recovery_status", request_id: input.requestId, state: result.data.state, device_fingerprint: result.data.device_fingerprint, expires_at: result.data.expires_at } };
  } catch { return unavailable(); }
}

export async function completeSupportRecovery(input: Proof & { password: string }): Promise<Reply> {
  const reply = (code: string, status: number, success = false): Reply => ({ status, body: { ...(success ? { success: true, code } : { error: code }), request_id: input.requestId } });
  const denied = () => reply("support_recovery_unavailable", 403);
  try {
    const claimed = await input.service.rpc("staff_auth_support_recovery_claim", { p_request_id: input.requestId, p_proof_hash: input.proofHash });
    if (claimed.error) return claimed.error.code === "42501" ? denied() : uncertain(input.requestId);
    if (claimed.data?.request_id !== input.requestId) return denied();
    // 이미 끝난 요청에 새로운 입력을 적용했다고 표시하지 않으며 Auth를 다시 호출하지 않습니다.
    if (claimed.data.state === "succeeded") return reply("support_password_already_updated", 200, true);
    if (claimed.data.state === "failed") return reply("support_recovery_failed", 400);
    if (claimed.data.state === "uncertain") return uncertain(input.requestId);
    if (claimed.data.state !== "executing" || typeof claimed.data.target_user_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(claimed.data.target_user_id)) return uncertain(input.requestId);
    const targetId = claimed.data.target_user_id;
    let outcome: Outcome = "uncertain";
    try {
      // 비밀번호·해시는 DB/RPC/감사에 전달하지 않습니다. 같은 UUID의 공식 Auth 변경만 한 번 수행합니다.
      const result = await input.service.auth.admin.updateUserById(targetId, { password: input.password });
      if (!result.error && result.data?.user?.id === targetId) outcome = "succeeded";
      else if (result.error && Number.isInteger(result.error.status) && result.error.status >= 400 && result.error.status < 500 && result.error.status !== 408) outcome = "failed";
    } catch { /* 외부 요청의 반영 여부가 불명확하면 새 요청으로 자동 반복하지 않습니다. */ }
    try {
      const finished = await input.service.rpc("staff_auth_support_recovery_finish", { p_request_id: input.requestId, p_proof_hash: input.proofHash, p_state: outcome });
      if (finished.error || finished.data !== null) return uncertain(input.requestId);
    } catch { return uncertain(input.requestId); }
    if (outcome === "succeeded") return reply("support_password_updated", 200, true);
    return outcome === "failed" ? reply("support_recovery_failed", 400) : uncertain(input.requestId);
  } catch { return uncertain(input.requestId); }
}
