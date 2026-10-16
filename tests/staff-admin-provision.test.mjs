import test from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
import { typescriptModule } from "./helpers/typescript-module.mjs";

const { createGateway } = await typescriptModule("supabase/functions/staff-auth/gateway.ts");

// 실제 SDK의 Admin 생성과 RPC 요청 계약을 가짜 네트워크에서 검사합니다.
// 공개 signup/메일 API로 돌아가거나 서비스 클라이언트에 사용자 세션을 저장하면 실패합니다.
test("mail-free gateway uses the pinned SDK Admin endpoint and retains isolated service credentials", async () => {
  const calls = [];
  const userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const reservationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const serverKey = "sb_secret_fixture_server_only";
  const mockFetch = async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    const body = await request.json();
    assert.equal(request.headers.get("authorization"), `Bearer ${serverKey}`);
    calls.push({ path, body });
    let result;
    if (path === "/rest/v1/rpc/staff_auth_rate_limit") result = true;
    else if (path === "/rest/v1/rpc/staff_auth_reserve") result = reservationId;
    else if (path === "/rest/v1/rpc/staff_auth_finalize") result = null;
    else if (path === "/auth/v1/admin/users") {
      assert.equal(body.email_confirm, true);
      assert.deepEqual(body.app_metadata, { staff_signup_policy: "manual_approval_no_email_v1" });
      assert.equal(Object.hasOwn(body, "password_hash"), false);
      result = { id: userId, email: body.email, app_metadata: body.app_metadata };
    } else throw new Error(`Unexpected SDK endpoint: ${path}`);
    return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
  };
  const service = createClient("https://identity-sdk-test.supabase.co", serverKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: mockFetch },
  });
  const gateway = createGateway({
    service,
    authClient: () => service,
    userClient: () => { throw new Error("Signup must not create a user client"); },
    verifyRegistrationCaptcha: () => { throw new Error("Explicit disabled policy does not call a provider"); },
    config: {
      enabled: true, registrationEnabled: true, registrationCaptchaMode: "disabled", legacyEmailEnabled: true,
      allowedOrigins: ["https://club.example.invalid"],
      emailRedirectTo: "https://club.example.invalid/admin/", recoveryRedirectTo: "https://club.example.invalid/admin/help/",
      hmacSecret: "fixture-only-shared-hmac-with-more-than-thirty-two-characters",
      ipMode: "disabled", ipHeader: "", ipHeaderAttested: false,
      forwardAuthIp: false, forwardedForOptIn: false, authSecretKey: serverKey,
    },
  });
  const response = await gateway(new Request("https://identity-sdk-test.supabase.co/functions/v1/staff-auth", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: "https://club.example.invalid" },
    body: JSON.stringify({ action: "register", username: "test.staff",
      password: "fixture-only-password", password_confirmation: "fixture-only-password",
      real_name: "テスト担当", department: "Staff", notice_accepted: true }),
  }));
  assert.equal(response.status, 200);
  const receipt = await response.json();
  assert.deepEqual(receipt, { success: true, code: "registration_received" });
  assert.deepEqual(calls.filter(call => call.path.startsWith("/auth/")).map(call => call.path), ["/auth/v1/admin/users"]);
  const technicalAddress = calls.find(call => call.path === "/auth/v1/admin/users").body.email;
  assert.match(technicalAddress, /^staff-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}@accounts\.kansai\.invalid$/);
  const reservation = calls.find(call => call.path.endsWith("staff_auth_reserve")).body;
  assert.equal(reservation.p_email, technicalAddress);
  assert.equal(reservation.p_email_confirmation_required, false);
  for (const privateValue of [technicalAddress, userId, "fixture-only-password", serverKey])
    assert.equal(JSON.stringify(receipt).includes(privateValue), false);
  assert.deepEqual(calls.find(call => call.path.endsWith("staff_auth_finalize")).body, { p_reservation: reservationId, p_user_id: userId });
  assert.equal((await service.auth.getSession()).data.session, null);
});
