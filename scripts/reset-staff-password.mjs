import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";

// [편집 안내] 이 도구는 운영자의 신뢰한 관리자 기기에서만 직접 실행합니다. 공개 웹사이트나
// Edge action으로 가져오지 않습니다. 비밀번호 검증·해시는 Supabase Auth가 전담합니다.
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const roles = new Set(["owner", "administrator", "editor", "coach"]);
const reasonCodes = new Set([
  "credential_recovery",
  "operator_requested_password_reset",
]);
export class SupportResetError extends Error {
  constructor(code, operationId = null) {
    super(code);
    this.name = "SupportResetError";
    this.code = code;
    this.operationId = operationId;
  }
}

// 숨김 입력은 화면·명령 기록에 값을 쓰지 않습니다. JS 문자열 메모리를 확실하게 지운다는
// 보장은 없으므로 입력 종료 뒤 참조를 버리고 프로세스를 종료합니다.
export function hiddenPrompt(
  prompt,
  input = process.stdin,
  output = process.stderr,
) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function")
    return Promise.reject(
      new SupportResetError("interactive_terminal_required"),
    );
  return new Promise((resolve, reject) => {
    let value = "";
    const wasRaw = Boolean(input.isRaw);
    const wasPaused = input.isPaused();
    let done = false;
    const finish = (error) => {
      if (done) return;
      done = true;
      input.off("data", onData);
      input.off("error", onError);
      input.off("end", onEnd);
      input.setRawMode(wasRaw);
      if (wasPaused) input.pause();
      output.write("\n");
      const result = value;
      value = "";
      if (error) reject(error);
      else resolve(result);
    };
    const onError = () => finish(new SupportResetError("input_unavailable"));
    const onEnd = () => finish(new SupportResetError("cancelled"));
    const onData = (chunk) => {
      const text = String(chunk);
      // 방향키 등 escape 조합을 비밀번호 일부로 받아들이지 않습니다.
      if (text.includes("\u001b")) return;
      for (const character of text) {
        if (character === "\u0003") {
          finish(new SupportResetError("cancelled"));
          return;
        }
        if (character === "\r" || character === "\n") {
          finish();
          return;
        }
        if (character === "\u007f" || character === "\b")
          value = [...value].slice(0, -1).join("");
        else if (!/[\x00-\x1f]/.test(character)) value += character;
      }
    };
    input.setEncoding("utf8");
    output.write(prompt);
    input.setRawMode(true);
    input.on("data", onData);
    input.once("error", onError);
    input.once("end", onEnd);
    input.resume();
  });
}
function targetUuid(value) {
  if (typeof value !== "string" || !uuidPattern.test(value.trim()))
    throw new SupportResetError("invalid_target_uuid");
  return value.trim().toLowerCase();
}
async function readTarget(client, userId) {
  let result;
  try {
    result = await client.rpc("staff_auth_support_password_target", {
      p_user_id: userId,
    });
  } catch {
    throw new SupportResetError("target_unavailable");
  }
  const row = result?.data;
  if (
    result?.error !== null ||
    !row ||
    Array.isArray(row) ||
    row.user_id !== userId ||
    row.active !== true ||
    row.approval_status !== "approved" ||
    !roles.has(row.role)
  )
    throw new SupportResetError("target_unavailable");
  return row;
}
async function audit(client, userId, operationId, state, reason) {
  try {
    const result = await client.rpc("staff_auth_support_password_audit", {
      p_user_id: userId,
      p_operation_id: operationId,
      p_state: state,
      p_reason: reason,
    });
    if (!result || result.error !== null) throw new Error("audit_unavailable");
  } catch {
    throw new SupportResetError("audit_unconfirmed", operationId);
  }
}

// io를 주입해 테스트는 실제 Auth·운영 계정 없이 SDK 경계를 검사합니다. SDK 오류 원문은
// 이메일·키·요청값을 포함할 수 있어 출력하거나 예외 cause에 연결하지 않습니다.
export async function runPasswordSupport({
  client,
  io,
  operationId = randomUUID(),
}) {
  if (!uuidPattern.test(operationId))
    throw new SupportResetError("invalid_operation_id");
  const userId = targetUuid(await io.question("Target account UUID: "));
  const target = await readTarget(client, userId);
  io.write(
    `Target: ${userId} / ${target.role}. Existing UUID, role and content will be preserved.\n`,
  );
  const confirmation = targetUuid(
    await io.question(
      "After checking the existing account and the person's identity, type the same UUID again: ",
    ),
  );
  if (confirmation !== userId)
    throw new SupportResetError("target_confirmation_mismatch");
  const reason = String(
    await io.question(
      "After external identity verification, enter support reason code (credential_recovery or operator_requested_password_reset): ",
    ),
  ).trim();
  if (!reasonCodes.has(reason))
    throw new SupportResetError("invalid_verification_reason");
  let password = "";
  let confirmationPassword = "";
  try {
    password = await io.secret(
      "New password (hidden; user enters it directly): ",
    );
    confirmationPassword = await io.secret("Confirm new password (hidden): ");
    if (password !== confirmationPassword)
      throw new SupportResetError("password_mismatch");
    if (
      password.length < 12 ||
      Buffer.byteLength(password, "utf8") > 72 ||
      /[\x00-\x1f\x7f]/.test(password)
    )
      throw new SupportResetError("invalid_password");
    // 입력에 시간이 걸린 동안 승인·활동 상태가 바뀌었으면 Auth를 호출하기 전에 멈춥니다.
    await readTarget(client, userId);
    await audit(client, userId, operationId, "requested", reason);
    io.write(`Support operation: ${operationId}\n`);
    let result;
    try {
      result = await client.auth.admin.updateUserById(userId, { password });
    } catch {
      // 전송 실패는 서버 반영 여부를 증명하지 못합니다. 같은 비밀번호 요청을 자동 재시도하지 않습니다.
      await audit(client, userId, operationId, "indeterminate", reason);
      throw new SupportResetError("reset_indeterminate", operationId);
    }
    if (result?.error !== null) {
      const status = Number(result?.error?.status);
      const failed = status >= 400 && status < 500;
      await audit(
        client,
        userId,
        operationId,
        failed ? "failed" : "indeterminate",
        reason,
      );
      throw new SupportResetError(
        failed ? "reset_failed" : "reset_indeterminate",
        operationId,
      );
    }
    if (result?.data?.user?.id !== userId) {
      await audit(client, userId, operationId, "indeterminate", reason);
      throw new SupportResetError("reset_indeterminate", operationId);
    }
    // Auth와 DB는 하나의 트랜잭션이 아닙니다. 이 기록 응답까지 확인한 뒤에만 완료를 표시합니다.
    try {
      await audit(client, userId, operationId, "succeeded", reason);
    } catch {
      throw new SupportResetError(
        "password_changed_audit_unconfirmed",
        operationId,
      );
    }
    return { status: "succeeded", operationId, userId };
  } finally {
    password = "";
    confirmationPassword = "";
  }
}
function projectUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new SupportResetError("invalid_project_url");
  }
  // 이 제한된 호스팅 운영 도구는 공식 project URL만 받습니다. 임의 호스트로 서비스 키를 전송하지 않습니다.
  if (
    url.protocol !== "https:" ||
    !/^[a-z0-9-]+\.supabase\.co$/.test(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["", "/"].includes(url.pathname)
  )
    throw new SupportResetError("invalid_project_url");
  return url.origin;
}
const messages = {
  interactive_terminal_required:
    "Run this tool in an interactive terminal on a trusted administrator device. Piped passwords are not accepted.",
  input_unavailable:
    "Terminal input could not be read. Nothing was printed or saved.",
  cancelled: "Cancelled.",
  invalid_target_uuid: "Enter the verified existing account UUID.",
  invalid_operation_id: "The support operation ID is invalid.",
  invalid_project_url:
    "Use the verified canonical HTTPS project URL ending in .supabase.co.",
  project_confirmation_mismatch: "Project hostname confirmation did not match.",
  service_key_required:
    "A server-only Supabase secret/service key is required. Never use a public key.",
  target_unavailable:
    "The existing active approved staff account could not be verified. No password reset was attempted.",
  target_confirmation_mismatch:
    "The UUID confirmations did not match. No password reset was attempted.",
  invalid_verification_reason:
    "Use the exact support reason code credential_recovery or operator_requested_password_reset. Free text is not stored.",
  password_mismatch:
    "The passwords did not match. No password reset was attempted.",
  invalid_password:
    "Use at least 12 characters and no more than 72 UTF-8 bytes, without control characters. Supabase also enforces the project's password policy.",
  audit_unconfirmed:
    "The support audit state could not be confirmed. Stop and reconcile the operation; do not automatically retry.",
  reset_failed:
    "Supabase rejected the password change. No successful reset was recorded.",
  reset_indeterminate:
    "The password-change result is uncertain. Stop and reconcile this operation before retrying.",
  password_changed_audit_unconfirmed:
    "Supabase confirmed the password change, but the final support audit could not be confirmed. Completion is not confirmed; reconcile the operation before retrying.",
  unavailable:
    "The support tool could not complete. No secret values are included in this error.",
};
async function main() {
  if (process.argv.length > 2) {
    if (process.argv.length === 3 && process.argv[2] === "--help") {
      process.stdout.write(
        "Optional administrator-only password support tool.\nRun: node scripts/reset-staff-password.mjs\nUses SUPABASE_URL and optional server-only SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY; missing values are prompted. Passwords are accepted only through hidden interactive prompts. See docs/STAFF_PASSWORD_SUPPORT.md.\n",
      );
      return;
    }
    throw new SupportResetError("interactive_terminal_required");
  }
  if (!process.stdin.isTTY || !process.stderr.isTTY)
    throw new SupportResetError("interactive_terminal_required");
  const io = {
    async question(prompt) {
      const reader = createInterface({
        input: process.stdin,
        output: process.stderr,
      });
      try {
        return await reader.question(prompt);
      } finally {
        reader.close();
      }
    },
    secret: (prompt) => hiddenPrompt(prompt),
    write: (message) => process.stderr.write(message),
  };
  const url = projectUrl(
    process.env.SUPABASE_URL ||
      (await io.question("Verified Supabase project URL: ")),
  );
  const hostname = new URL(url).hostname;
  io.write(`Project: ${hostname}\n`);
  if (
    (await io.question("Type this project hostname to confirm: ")).trim() !==
    hostname
  )
    throw new SupportResetError("project_confirmation_mismatch");
  let key =
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    (await io.secret("Server-only Supabase secret/service key (hidden): "));
  if (!key || key.startsWith("sb_publishable_"))
    throw new SupportResetError("service_key_required");
  const client = createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
  key = "";
  const result = await runPasswordSupport({ client, io });
  io.write(
    `Password change and support audit confirmed for ${result.userId}. Operation: ${result.operationId}\nSign in with the existing login ID and the new password. Previously issued access JWTs may remain usable until expiry unless server session checks reject them.\n`,
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    const code =
      error instanceof SupportResetError ? error.code : "unavailable";
    process.stderr.write((messages[code] || messages.unavailable) + "\n");
    if (error instanceof SupportResetError && error.operationId)
      process.stderr.write(`Operation: ${error.operationId}\n`);
    process.exitCode = 1;
  });
}
