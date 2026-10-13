import { createClient } from "npm:@supabase/supabase-js@2.117.3";
// [편집 안내] 사용자 JWT는 Auth 서버에서 확인하고, 역할은 매 요청마다 DB에서 조회합니다.
// 사용자가 변경 가능한 user_metadata나 오래된 JWT의 역할 정보를 신뢰하지 않습니다.
function environmentKey(name: string, legacy: string): string {
  const values = JSON.parse(Deno.env.get(name) ?? "{}");
  const key =
    values.default ?? Object.values(values)[0] ?? Deno.env.get(legacy);
  if (!key || typeof key !== "string")
    throw new Error("Server credentials unavailable");
  return key;
}
export async function requireOwner(request: Request) {
  const authorization = request.headers.get("Authorization") ?? "";
  if (!/^Bearer [A-Za-z0-9._-]+$/.test(authorization))
    throw new Error("unauthorized");
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const client = createClient(
    url,
    environmentKey("SUPABASE_PUBLISHABLE_KEYS", "SUPABASE_ANON_KEY"),
    {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    },
  );
  const {
    data: { user },
    error,
  } = await client.auth.getUser(authorization.slice(7));
  if (error || !user) throw new Error("unauthorized");
  const membership = await client
    .from("admin_roles")
    .select("role,active")
    .eq("user_id", user.id)
    .maybeSingle();
  if (
    membership.error ||
    membership.data?.role !== "owner" ||
    !membership.data.active
  )
    throw new Error("forbidden");
  const service = createClient(
    url,
    environmentKey("SUPABASE_SECRET_KEYS", "SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  return { client, service, user };
}
