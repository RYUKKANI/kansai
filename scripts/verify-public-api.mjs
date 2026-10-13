import assert from "node:assert/strict";
// [검증 안내] 공개 키로만 실제 Data API와 서버 함수의 익명 접근 권한을 검사합니다.
const url = process.env.PUBLIC_SUPABASE_URL;
const key = process.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY;
if (!url || !key) throw new Error("공개 연결 환경 변수를 설정하세요.");
async function api(path, options = {}) {
  return fetch(url + path, {
    ...options,
    headers: { apikey: key, ...options.headers },
  });
}
const articles = await api(
  "/rest/v1/articles?select=slug,title,status,published_at",
);
assert.equal(articles.status, 200);
const news = await articles.json();
for (const slug of ["attacking-training", "defending-training", "join-united"])
  assert.ok(news.some((a) => a.slug === slug));
assert.ok(news.every((a) => a.status === "published"));
for (const path of [
  "/rest/v1/players?select=id,internal_name",
  "/rest/v1/admin_roles?select=user_id,role",
  "/rest/v1/training_sessions?select=id,notes",
  "/rest/v1/audit_logs?select=*",
  "/rest/v1/public_player_profiles?select=approved_by",
])
  assert.ok(
    [401, 403].includes((await api(path)).status),
    "Internal endpoint exposed: " + path,
  );
const privateSchema = await api("/rest/v1/player_contacts?select=*", {
  headers: { "Accept-Profile": "private" },
});
assert.equal(privateSchema.status, 406);
const write = await api("/rest/v1/articles", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    slug: "unauthorized-write",
    title: "UNAUTHORIZED TEST",
  }),
});
assert.ok([401, 403].includes(write.status));
const invite = await api("/functions/v1/invite-staff", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: "{}",
});
assert.equal(invite.status, 401);
console.log(
  "Live API: public articles readable; 8 unauthorized access paths blocked.",
);
