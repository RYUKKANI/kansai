import type { Client } from "./gateway.ts";

type ResetInput = {
  client: Client;
  service: Client;
  actorId: string;
  targetId: string;
  operationId: string;
  password: string;
  reason: string;
};
type ResetReply = { status: number; body: Record<string, unknown> };
type Outcome = "succeeded" | "failed" | "uncertain";

// [편집 안내] Auth 비밀번호 변경과 DB 감사 기록은 하나의 트랜잭션으로 묶을 수 없습니다.
// DB의 일회용 executing 전환을 얻은 요청만 Auth를 한 번 호출하고, 불명확한 결과를 자동 재시도하지 않습니다.
export async function resetOwnerManagedPassword(input: ResetInput): Promise<ResetReply> {
  const { client, service, actorId, targetId, operationId } = input;
  const reply = (code: string, status: number, success = false): ResetReply => ({ status, body: {
    ...(success ? { success: true, code } : { error: code }), operation_id: operationId,
  } });
  const uncertain = () => reply("owner_password_reset_uncertain", 409);
  const denied = () => reply("owner_password_reset_denied", 403);
  const failed = () => reply("owner_password_reset_failed", 400);
  const boundOperation = (value: any) => value?.operation_id === operationId && value?.target_user_id === targetId && value?.actor_id === actorId;
  try {
    // actor/session은 브라우저 인자가 아니라 현재 JWT와 DB에서 결합합니다. 비밀번호는 RPC 인자에 넣지 않습니다.
    const begun = await client.rpc("office_owner_begin_password_reset", { p_user_id: targetId, p_operation_id: operationId, p_reason: input.reason });
    if (begun.error) return begun.error.code === "42501" ? denied() : uncertain();
    if (!boundOperation(begun.data)) return uncertain();
    if (begun.data.state === "succeeded") return reply("owner_password_reset_already_succeeded", 200, true);
    if (begun.data.state === "failed") return failed();
    if (begun.data.state !== "requested") return uncertain();
    const claimed = await service.rpc("staff_auth_owner_password_claim", { p_operation_id: operationId, p_actor_id: actorId });
    if (claimed.error) return claimed.error.code === "42501" ? denied() : uncertain();
    if (!boundOperation(claimed.data) || claimed.data.state !== "executing") return uncertain();

    let outcome: Outcome = "uncertain";
    try {
      // 기존 비밀번호·해시를 조회하지 않습니다. 사용자 UUID에 새 password 필드만 전달합니다.
      const changed = await service.auth.admin.updateUserById(claimed.data.target_user_id, { password: input.password });
      if (!changed.error && changed.data?.user?.id === targetId) outcome = "succeeded";
      else if (changed.error && Number.isInteger(changed.error.status) && changed.error.status >= 400 && changed.error.status < 500 && changed.error.status !== 408) outcome = "failed";
    } catch { /* 요청 전송 뒤 네트워크가 끊겼을 수 있습니다. 변경되지 않았다고 단정하지 않습니다. */ }

    try {
      // 자신을 초기화해 Auth 세션이 사라져도, 시작 때 결합된 작업의 결과 기록은 서비스 경로로 마칩니다.
      const completed = await service.rpc("staff_auth_owner_password_finish", { p_operation_id: operationId, p_actor_id: actorId, p_state: outcome });
      if (completed.error || completed.data !== null) return uncertain();
    } catch { return uncertain(); }
    if (outcome === "succeeded") return reply("owner_password_reset_succeeded", 200, true);
    return outcome === "failed" ? failed() : uncertain();
  } catch {
    // Auth/DB 오류 원문에는 이메일·내부 정보가 들어갈 수 있어 전달하거나 기록하지 않습니다.
    return uncertain();
  }
}
