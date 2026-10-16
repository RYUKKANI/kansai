import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  // [편집 안내] 자체 도메인은 루트에 배포합니다. /kansai/를 다시 붙이면 메뉴·사진·관리자 주소가 끊깁니다.
  site: "https://kansaiunited.com",
  base: "/",
  trailingSlash: "always",
  // 각 페이지를 정적 HTML로 생성해 GitHub Pages에서 별도 서버 없이 제공합니다.
  output: "static",
  // GitHub Pages에서 적용할 수 있는 CSP는 빌드된 HTML에 담습니다. Astro가 실제 번들의
  // 해시를 계산하므로 새 인라인 스크립트나 이벤트 속성을 허용할 필요가 없습니다.
  // frame-ancestors 같은 응답 헤더 전용 보호는 이 meta 정책으로 대체되지 않습니다.
  security: {
    csp: {
      directives: [
        "default-src 'self'",
        "base-uri 'none'",
        "object-src 'none'",
        "form-action 'self'",
        "font-src 'self' data:",
        "media-src 'none'",
        "worker-src 'none'",
        "manifest-src 'none'",
      ],
      scriptDirective: {
        resources: ["'self'"],
      },
      styleDirective: {
        resources: ["'self'"],
      },
    },
  },
  // 게시물은 일반 텍스트로 렌더링합니다. 사용하지 않는 Shiki의 인라인 스타일은 켜지 않습니다.
  markdown: { syntaxHighlight: false },
  // 기본 일본어 URL과 검색 순위를 유지하고 한국어·영어는 별도 정적 주소를 제공합니다.
  i18n: {
    defaultLocale: "ja",
    locales: ["ja", "ko", "en"],
    routing: { prefixDefaultLocale: false },
  },
  vite: { plugins: [tailwindcss()] },
});
