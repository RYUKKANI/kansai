import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
// [편집 안내] 이전 빌드에서 복사한 CMS 사진을 지웁니다. 비공개로 전환한 사진이 새 배포에 남지 않습니다.
// 이 디렉터리는 전부 자동 생성됩니다. 수동 사진은 public/assets/에 보관하세요.
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const generated = path.resolve(project, "public", "cms-assets");
if (generated !== path.join(project, "public", "cms-assets"))
  throw new Error("생성 디렉터리 경로 오류");
await rm(generated, { recursive: true, force: true });
