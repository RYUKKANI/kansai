// Astro의 배포 경로를 자동으로 붙입니다. 자체 도메인의 루트 경로는 astro.config.mjs에서 관리합니다.
// 페이지와 이미지가 동일한 규칙을 사용하므로 경로 결합은 한 번만 정의합니다.
const baseUrl = import.meta.env.BASE_URL.replace(/\/?$/, "/");

function withBase(path = ""): string {
  if (path.startsWith("https://")) return path;
  return `${baseUrl}${path.replace(/^\//, "")}`;
}

// 호출 위치에서 링크의 용도를 구분할 수 있도록 두 이름은 유지합니다.
export const asset = withBase;
export const page = withBase;
