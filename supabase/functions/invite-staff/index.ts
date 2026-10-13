import { requireOwner } from "../_shared/auth.ts";
// [편집 안내] 이메일 전송과 Auth 관리용 비밀키는 이 서버 함수에만 둡니다.
// 최초 Owner는 운영자가 별도 부트스트랩하고, 이후 초대는 현재 활성 Owner만 실행합니다.
const origin = "https://ryukkani.github.io";
const headers = {
  "Access-Control-Allow-Origin": origin,
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  Vary: "Origin",
  "Content-Type": "application/json",
};
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers });
Deno.serve(async (request) => {
  if (request.headers.get("Origin") && request.headers.get("Origin") !== origin)
    return reply({ error: "Origin denied" }, 403);
  if (request.method === "OPTIONS")
    return new Response(null, { status: 204, headers });
  if (request.method !== "POST")
    return reply({ error: "Method not allowed" }, 405);
  try {
    const { client, service } = await requireOwner(request);
    const body = await request.json();
    const email =
      typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const role = body.role;
    if (
      !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ||
      email.length > 254 ||
      !["owner", "administrator", "editor", "coach"].includes(role)
    )
      return reply({ error: "Invalid invitation" }, 400);
    const existing = await client
      .from("admin_roles")
      .select("user_id")
      .eq("email", email)
      .maybeSingle();
    if (existing.error) return reply({ error: "権限を確認できません。" }, 500);
    if (existing.data)
      return reply(
        {
          error:
            "登録済みのメンバーです。メンバー一覧で権限を編集してください。",
        },
        409,
      );
    const invite = await service.auth.admin.inviteUserByEmail(email, {
      redirectTo: origin + "/kansai/admin/",
    });
    if (invite.error || !invite.data.user)
      return reply(
        {
          error:
            "招待メールを送信できません。メール設定と送信制限を確認してください。",
        },
        502,
      );
    // Auth 초대에만 관리용 키를 사용하고, 역할 등록은 현재 Owner의 RLS로 제한합니다.
    const membership = await client
      .from("admin_roles")
      .insert({ user_id: invite.data.user.id, email, role, active: true });
    if (membership.error)
      return reply(
        {
          error:
            "招待は送信されましたが権限登録に失敗しました。運営責任者にご確認ください。",
        },
        500,
      );
    return reply({ success: true });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "";
    return reply(
      {
        error:
          reason === "unauthorized"
            ? "ログインが必要です。"
            : reason === "forbidden"
              ? "Ownerの権限が必要です。"
              : "招待を処理できませんでした。",
      },
      reason === "unauthorized" ? 401 : reason === "forbidden" ? 403 : 500,
    );
  }
});
