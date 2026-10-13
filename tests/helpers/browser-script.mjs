import { build } from "esbuild";
import path from "node:path";
// Vite가 공통 모듈을 분리해도 실제 빌드 스크립트 전체를 메모리 DOM에서 실행합니다.
const cache = new Map();
export function browserScript(file) {
  const absolute = path.resolve(file);
  if (!cache.has(absolute))
    cache.set(
      absolute,
      build({
        entryPoints: [absolute],
        bundle: true,
        write: false,
        format: "iife",
        platform: "browser",
      }).then((result) => result.outputFiles[0].text),
    );
  return cache.get(absolute);
}
