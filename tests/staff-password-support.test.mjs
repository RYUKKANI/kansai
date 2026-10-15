import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import {
  hiddenPrompt,
  runPasswordSupport,
  SupportResetError,
} from "../scripts/reset-staff-password.mjs";

// 운영 Auth 대신 동일한 SDK 메서드의 결과와 RPC 응답만 주입합니다. 실제 비밀번호·키는 쓰지 않습니다.
const uid = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";
const operationId = "00000000-0000-4000-8000-000000000003";
const testPassword = "isolated-test-password";
function fixture(options = {}) {
  const calls = [];
  const output = [];
  let targetReads = 0;
  let passwordPrompts = 0;
  const questions = [
    ...(options.questions ?? [uid, uid, "credential_recovery"]),
  ];
  const passwords = [...(options.passwords ?? [testPassword, testPassword])];
  const io = {
    async question(prompt) {
      calls.push({ kind: "question", prompt });
      return questions.shift();
    },
    async secret(prompt) {
      passwordPrompts++;
      calls.push({ kind: "prompt", prompt });
      return passwords.shift();
    },
    write(message) {
      output.push(message);
    },
  };
  const client = {
    async rpc(name, args) {
      calls.push({ kind: "rpc", name, args: structuredClone(args) });
      if (name === "staff_auth_support_password_target") {
        targetReads++;
        return {
          data: options.target?.(targetReads) ?? {
            user_id: uid,
            role: "owner",
            active: true,
            approval_status: "approved",
          },
          error: null,
        };
      }
      if (options.audit) return options.audit(args);
      return { data: null, error: null };
    },
    auth: {
      admin: {
        async updateUserById(userId, attributes) {
          calls.push({ kind: "auth", userId, attributes });
          return options.update
            ? options.update(userId, attributes)
            : { data: { user: { id: uid } }, error: null };
        },
      },
    },
  };
  return {
    calls,
    output,
    client,
    io,
    passwordPrompts: () => passwordPrompts,
    run: () => runPasswordSupport({ client, io, operationId }),
  };
}
test("support reset uses native Auth on the same approved UUID and confirms audit before success", async () => {
  const context = fixture();
  const result = await context.run();
  assert.deepEqual(result, { status: "succeeded", operationId, userId: uid });
  const requests = context.calls.filter((call) =>
    ["rpc", "auth"].includes(call.kind),
  );
  assert.deepEqual(
    requests.map((call) => (call.kind === "auth" ? "native_auth" : call.name)),
    [
      "staff_auth_support_password_target",
      "staff_auth_support_password_target",
      "staff_auth_support_password_audit",
      "native_auth",
      "staff_auth_support_password_audit",
    ],
  );
  const native = requests.find((call) => call.kind === "auth");
  assert.equal(native.userId, uid);
  assert.deepEqual(native.attributes, { password: testPassword });
  const audits = requests.filter(
    (call) => call.name === "staff_auth_support_password_audit",
  );
  assert.deepEqual(
    audits.map((call) => call.args.p_state),
    ["requested", "succeeded"],
  );
  for (const audit of audits) {
    assert.deepEqual(Object.keys(audit.args).sort(), [
      "p_operation_id",
      "p_reason",
      "p_state",
      "p_user_id",
    ]);
    assert.equal(audit.args.p_operation_id, operationId);
    assert.equal(audit.args.p_reason, "credential_recovery");
    assert.equal(JSON.stringify(audit).includes(testPassword), false);
    for (const key of ["actor_id", "actor_name", "role", "email_confirm"])
      assert.equal(key in audit.args, false);
  }
  assert.equal(context.output.join("").includes(testPassword), false);
});
test("target UUID, external verification confirmation and fixed reason are required before password input", async () => {
  for (const questions of [
    ["not-a-uuid"],
    [uid, other],
    [uid, uid, "paste a secret password here"],
  ]) {
    const context = fixture({ questions });
    await assert.rejects(context.run(), SupportResetError);
    assert.equal(context.passwordPrompts(), 0);
    assert.equal(
      context.calls.some((call) => call.kind === "auth"),
      false,
    );
    assert.equal(
      context.calls.some((call) => call.args?.p_state),
      false,
    );
  }
});
test("pending or suspended targets and a mid-prompt revocation are refused without Auth update", async () => {
  for (const target of [
    () => ({
      user_id: uid,
      role: null,
      active: false,
      approval_status: "pending",
    }),
    () => ({
      user_id: uid,
      role: "owner",
      active: false,
      approval_status: "suspended",
    }),
    (count) =>
      count === 1
        ? {
            user_id: uid,
            role: "owner",
            active: true,
            approval_status: "approved",
          }
        : {
            user_id: uid,
            role: null,
            active: false,
            approval_status: "suspended",
          },
  ]) {
    const context = fixture({ target });
    await assert.rejects(context.run(), { code: "target_unavailable" });
    assert.equal(
      context.calls.some((call) => call.kind === "auth"),
      false,
    );
    assert.equal(
      context.calls.some((call) => call.args?.p_state),
      false,
    );
  }
});
test("password confirmation and basic policy failures do not reach Auth or audit", async () => {
  for (const passwords of [
    [testPassword, "different-password"],
    ["short", "short"],
    ["with-control\npassword", "with-control\npassword"],
  ]) {
    const context = fixture({ passwords });
    await assert.rejects(context.run(), SupportResetError);
    assert.equal(
      context.calls.some((call) => call.kind === "auth"),
      false,
    );
    assert.equal(
      context.calls.some((call) => call.args?.p_state),
      false,
    );
  }
});
test("new passwords enforce the native 72-byte UTF-8 boundary for Unicode", async () => {
  const boundary = "가".repeat(24);
  assert.equal(boundary.length, 24);
  assert.equal(Buffer.byteLength(boundary, "utf8"), 72);
  const accepted = fixture({ passwords: [boundary, boundary] });
  assert.equal((await accepted.run()).status, "succeeded");
  for (const password of [boundary + "a", "가".repeat(25), "a".repeat(73)]) {
    const context = fixture({ passwords: [password, password] });
    await assert.rejects(context.run(), { code: "invalid_password" });
    assert.equal(
      context.calls.some((call) => call.kind === "auth"),
      false,
    );
    assert.equal(
      context.calls.some((call) => call.args?.p_state),
      false,
    );
  }
});
test("audit preparation failure prevents native password mutation", async () => {
  const context = fixture({
    audit: () => ({ error: { message: "secret SDK details" } }),
  });
  await assert.rejects(context.run(), {
    code: "audit_unconfirmed",
    operationId,
  });
  assert.equal(
    context.calls.some((call) => call.kind === "auth"),
    false,
  );
  assert.equal(context.output.join("").includes("secret SDK details"), false);
});
test("native rejection records failed rather than succeeded and never exposes raw errors", async () => {
  const context = fixture({
    update: () => ({
      data: null,
      error: { status: 422, message: "includes password " + testPassword },
    }),
  });
  await assert.rejects(context.run(), { code: "reset_failed", operationId });
  assert.deepEqual(
    context.calls
      .filter((call) => call.args?.p_state)
      .map((call) => call.args.p_state),
    ["requested", "failed"],
  );
  assert.equal(context.output.join("").includes(testPassword), false);
});
test("native network errors and wrong UUID responses are indeterminate and are never retried", async () => {
  for (const update of [
    () => {
      throw new Error("secret network body " + testPassword);
    },
    () => ({ data: { user: { id: other } }, error: null }),
  ]) {
    const context = fixture({ update });
    await assert.rejects(context.run(), {
      code: "reset_indeterminate",
      operationId,
    });
    assert.deepEqual(
      context.calls
        .filter((call) => call.args?.p_state)
        .map((call) => call.args.p_state),
      ["requested", "indeterminate"],
    );
    assert.equal(
      context.calls.filter((call) => call.kind === "auth").length,
      1,
    );
    assert.equal(context.output.join("").includes(testPassword), false);
  }
});
test("post-Auth audit failure reports partial completion without retrying or fabricating success", async () => {
  const context = fixture({
    audit: (args) =>
      args.p_state === "succeeded"
        ? { error: { message: "network" } }
        : { data: null, error: null },
  });
  await assert.rejects(context.run(), {
    code: "password_changed_audit_unconfirmed",
    operationId,
  });
  assert.equal(context.calls.filter((call) => call.kind === "auth").length, 1);
  assert.deepEqual(
    context.calls
      .filter((call) => call.args?.p_state)
      .map((call) => call.args.p_state),
    ["requested", "succeeded"],
  );
  assert.equal(context.output.join("").includes("confirmed"), false);
});
test("hidden TTY prompt never echoes secrets, handles Unicode backspace and restores terminal on finish/cancel", async () => {
  const input = new EventEmitter();
  Object.assign(input, {
    isTTY: true,
    isRaw: false,
    setEncoding() {},
    isPaused: () => true,
    setRawMode(value) {
      this.isRaw = value;
    },
    resume() {},
    pause() {
      this.paused = true;
    },
  });
  const writes = [];
  const output = {
    isTTY: true,
    write(value) {
      writes.push(value);
    },
  };
  const result = hiddenPrompt("Hidden: ", input, output);
  input.emit("data", "비밀x\u007f密碼\r");
  assert.equal(await result, "비밀密碼");
  assert.equal(writes.join(""), "Hidden: \n");
  assert.equal(input.isRaw, false);
  assert.equal(input.paused, true);
  assert.equal(input.listenerCount("data"), 0);
  const cancelled = hiddenPrompt("Hidden: ", input, output);
  input.emit("data", "do-not-echo\u0003");
  await assert.rejects(cancelled, { code: "cancelled" });
  assert.equal(input.isRaw, false);
  assert.equal(writes.join("").includes("do-not-echo"), false);
});
test("CLI refuses piped input and secret command arguments without constructing a network client", () => {
  for (const args of [[], ["--password", "never-print-this"]]) {
    const result = spawnSync(
      process.execPath,
      ["scripts/reset-staff-password.mjs", ...args],
      {
        input: "never-print-this\n",
        encoding: "utf8",
        env: { PATH: process.env.PATH },
      },
    );
    assert.notEqual(result.status, 0);
    assert.equal(
      (result.stdout + result.stderr).includes("never-print-this"),
      false,
    );
    assert.match(result.stderr, /interactive terminal/);
  }
});
