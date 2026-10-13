import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  // [편집 안내] 도메인과 배포 하위 경로는 여기서 관리합니다. 링크는 BASE_URL을 통해 따라갑니다.
  site: "https://ryukkani.github.io",
  base: "/kansai/",
  trailingSlash: "always",
  // 각 페이지를 정적 HTML로 생성해 GitHub Pages에서 별도 서버 없이 제공합니다.
  output: "static",
  // 기본 일본어 URL과 검색 순위를 유지하고 한국어·영어는 별도 정적 주소를 제공합니다.
  i18n: {
    defaultLocale: "ja",
    locales: ["ja", "ko", "en"],
    routing: { prefixDefaultLocale: false },
  },
  vite: { plugins: [tailwindcss()] },
});
