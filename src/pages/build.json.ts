import type { APIRoute } from "astro";
import { loadPublicContent } from "../data/cms";
// 공개 데이터의 반영 상태만 제공합니다. 로그인 정보와 내부 선수 기록은 포함하지 않습니다.
export const GET: APIRoute = async () => {
  const content = await loadPublicContent();
  return Response.json({
    version: content.version,
    fromCms: content.fromCms,
    schedulesEnabled: import.meta.env.PUBLIC_SCHEDULE_ENABLED === "true",
    builtAt: new Date().toISOString(),
  });
};
