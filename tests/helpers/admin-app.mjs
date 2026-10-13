import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { JSDOM } from "jsdom";
// UI는 빌드한 실제 SDK로 검사하고 서버 응답만 대체합니다. 실제 DB 권한은 supabase/tests에서 따로 검증합니다.
const html = await readFile("dist/admin/index.html", "utf8");
export const uid = "00000000-0000-4000-8000-000000000001";
const token =
  Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString(
    "base64url",
  ) +
  "." +
  Buffer.from(
    JSON.stringify({
      sub: uid,
      exp: Math.floor(Date.now() / 1000) + 3600,
      aud: "authenticated",
    }),
  ).toString("base64url") +
  ".TEST";
export async function eventually(condition) {
  for (let n = 0; n < 100; n++) {
    if (condition()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(condition(), "UI did not reach expected state");
}
export async function app(
  staffRole = "owner",
  appUrl = "https://ryukkani.github.io/kansai/admin/",
  authResponses = {},
  tableOverrides = {},
) {
  const dom = new JSDOM(html, {
    url: appUrl,
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  window.matchMedia = () => ({
    matches: Boolean(authResponses.mobile),
    addEventListener() {},
    removeEventListener() {},
  });
  window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  Object.assign(window, {
    TextEncoder,
    TextDecoder,
    Headers,
    Request,
    Response,
    AbortController,
    AbortSignal,
    fetch,
  });
  const user = {
    id: uid,
    email: "test@example.invalid",
    aud: "authenticated",
    role: "authenticated",
    user_metadata: { role: "owner" },
    app_metadata: {},
    created_at: new Date().toISOString(),
  };
  const tables = {
    admin_roles: [
      { user_id: uid, email: user.email, role: staffRole, active: true },
    ],
    articles: [
      {
        id: "article-1",
        slug: "existing-url",
        title: "Existing title",
        summary: "summary",
        body: "body",
        category: "club",
        cover_alt: "alt",
        gallery_paths: [],
        status: "published",
        published_at: "2026-10-01T00:00:00Z",
        updated_at: new Date().toISOString(),
      },
    ],
    players: [],
    fixtures: [],
    training_sessions: [],
    public_player_profiles: [],
    media_assets: [],
    media_albums: [],
    site_pages: [],
    audit_logs: [],
    publication_state: [{ id: 1, version: 1 }],
  };
  Object.assign(tables, structuredClone(tableOverrides));
  const requests = [];
  window.fetch = async (input, options = {}) => {
    const url = new URL(
      typeof input === "string" ? input : input.url,
      window.location.href,
    );
    const headers = new Headers(options.headers ?? {});
    const method = options.method ?? "GET";
    requests.push({ url: url.href, method, body: options.body });
    if (url.pathname.endsWith("/build.json"))
      return Response.json({
        version: 1,
        fromCms: true,
        builtAt: new Date().toISOString(),
      });
    if (url.pathname.endsWith("/auth/v1/token"))
      return Response.json({
        access_token: token,
        refresh_token: "TEST-REFRESH",
        token_type: "bearer",
        expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        user,
      });
    if (url.pathname.endsWith("/auth/v1/user")) return Response.json(user);
    if (url.pathname.endsWith("/auth/v1/logout"))
      return new Response(null, { status: 204 });
    // 실제 SDK의 회원가입 차단, 확인 메일 재전송, 발송 제한 처리를 검사합니다.
    if (
      url.pathname.endsWith("/auth/v1/otp") ||
      url.pathname.endsWith("/auth/v1/resend")
    ) {
      const code = url.pathname.endsWith("/otp")
        ? authResponses.otpError
        : authResponses.resendError;
      return code
        ? Response.json(
            { code, msg: "Auth request rejected" },
            {
              status: code.includes("rate_limit") ? 429 : 422,
              headers: { "x-supabase-api-version": "2024-01-01" },
            },
          )
        : Response.json({});
    }
    const name = url.pathname.split("/").pop();
    if (name === "office_release_states")
      return Response.json(authResponses.releaseStates ?? []);
    if (name === "office_release_attention")
      return Response.json(authResponses.releaseAttention ?? []);
    if (name === "office_capabilities")
      return Response.json({
        schedule: Boolean(authResponses.schedule),
        content: Boolean(authResponses.content),
        publisher: Boolean(authResponses.publisher),
      });
    if (url.pathname.includes("/rpc/") && authResponses.rpc)
      return Response.json(
        await authResponses.rpc(name, JSON.parse(options.body || "{}")),
      );
    if (authResponses.beforeRead) await authResponses.beforeRead(name, url);
    const matches = (row, field, expression) => {
      const [operator, ...pieces] = expression.split(".");
      const value = pieces.join(".");
      const actual = row[field];
      if (operator === "eq") return String(actual) === value;
      if (operator === "is")
        return value === "null" ? actual == null : String(actual) === value;
      if (operator === "in")
        return value.slice(1, -1).split(",").includes(String(actual));
      if (operator === "gte") return actual != null && String(actual) >= value;
      if (operator === "lt") return actual != null && String(actual) < value;
      if (operator === "ilike")
        return String(actual ?? "")
          .normalize("NFKC")
          .toLowerCase()
          .includes(
            value
              .replace(/^%|%$/g, "")
              .replace(/\\([\\%_])/g, "$1")
              .toLowerCase(),
          );
      return true;
    };
    let data = [...(tables[name] ?? [])];
    for (const [field, expression] of url.searchParams) {
      if (["select", "order", "limit", "offset"].includes(field)) continue;
      if (field === "or")
        data = data.filter((row) =>
          expression
            .slice(1, -1)
            .split(",")
            .some((part) => {
              const [key, ...rule] = part.split(".");
              return matches(row, key, rule.join("."));
            }),
        );
      else data = data.filter((row) => matches(row, field, expression));
    }
    const total = data.length;
    const order = url.searchParams.get("order")?.split(",") ?? [];
    data.sort((a, b) => {
      for (const clause of order) {
        const [key, direction] = clause.split(".");
        const compared = String(a[key] ?? "").localeCompare(
          String(b[key] ?? ""),
        );
        if (compared) return direction === "desc" ? -compared : compared;
      }
      return 0;
    });
    if (method === "HEAD")
      return new Response(null, {
        status: 200,
        headers: { "Content-Range": "0-0/" + total },
      });
    if (method === "POST") {
      const payload = JSON.parse(options.body);
      const row = {
        ...payload,
        id: "new-row",
        updated_at: new Date().toISOString(),
      };
      tables[name].push(row);
      return Response.json(row);
    }
    if (method === "PATCH") {
      const row = data[0];
      Object.assign(row, JSON.parse(options.body));
      return Response.json(row);
    }
    if (method === "DELETE") {
      const removed = new Set(data);
      tables[name] = tables[name].filter((row) => !removed.has(row));
      return Response.json(data.length === 1 ? data[0] : data);
    }
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? data.length);
    data = data.slice(offset, offset + limit);
    if (headers.get("Accept")?.includes("object")) data = data[0] ?? null;
    return Response.json(data, {
      headers: { "Content-Range": "0-0/" + total },
    });
  };
  for (const script of window.document.querySelectorAll("script[src]")) {
    const relative = new URL(script.src).pathname.replace("/kansai/", "");
    window.eval(await readFile(path.join("dist", relative), "utf8"));
  }
  await eventually(() => !window.document.querySelector("#login-panel").hidden);
  return { dom, window, tables, requests };
}
export async function login(window) {
  const document = window.document;
  document.querySelector('#login-form input[name="email"]').value =
    "test@example.invalid";
  document.querySelector('#login-form input[name="password"]').value =
    "TEST ONLY";
  document
    .querySelector("#login-form")
    .dispatchEvent(
      new window.Event("submit", { bubbles: true, cancelable: true }),
    );
  await eventually(
    () =>
      !document.querySelector("#workspace").hidden &&
      document.querySelectorAll(".admin-stat").length > 0,
  );
}
