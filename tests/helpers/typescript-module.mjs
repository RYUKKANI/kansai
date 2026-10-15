import { build } from "esbuild";
// JSON 번역 사전과 TypeScript 의존성을 Node 검사에서도 앱과 같은 방식으로 해석합니다.
export async function typescriptModule(file) {
  const result = await build({
    entryPoints: [file],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    define: { "import.meta.env.BASE_URL": JSON.stringify("/") },
  });
  return import(
    "data:text/javascript;base64," +
      Buffer.from(result.outputFiles[0].text).toString("base64")
  );
}
