import { createHash } from "node:crypto";

// [편집 안내] 파일 미리보기에서 다시 묶은 JS/CSS만 새 해시로 승인합니다.
// 원래 정책이 승인하지 않은 인라인 코드를 함께 해시하면 공격 코드까지 허용하므로 먼저 검증합니다.
function digest(code) {
  // HTML 파서는 CRLF/CR을 LF로 바꾼 뒤 인라인 코드의 CSP 해시를 검사합니다.
  return `'sha256-${createHash("sha256").update(code.replace(/\r\n?/g, "\n")).digest("base64")}'`;
}

function inlineBlocks(html, type) {
  const pattern = type === "script"
    ? /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi
    : /<style\b([^>]*)>([\s\S]*?)<\/style\s*>/gi;
  return [...html.matchAll(pattern)]
    .filter(match => type !== "script" || !/\bsrc\s*=/i.test(match[1]))
    .map(match => match[2]);
}

export function preparePreviewCsp(html) {
  const metas = [...html.matchAll(/<meta\b[^>]*>/gi)]
    .map(match => match[0])
    .filter(tag => /\bhttp-equiv\s*=\s*(["'])content-security-policy\1/i.test(tag));
  // CSP가 없는 이전/격리 빌드에도 내보내기를 제공하지만, 있는 정책은 절대로 제거하지 않습니다.
  if (metas.length === 0) return undefined;
  if (metas.length !== 1) throw new Error("미리보기에서 여러 CSP 정책을 안전하게 변환할 수 없습니다.");
  const meta = metas[0];
  const content = meta.match(/\bcontent\s*=\s*"([^"]*)"/i)?.[1];
  if (content === undefined || content.includes("&"))
    throw new Error("지원하지 않는 CSP 속성 형식입니다.");

  const directives = new Map();
  for (const segment of content.split(";")) {
    const [name, ...sources] = segment.trim().split(/\s+/);
    if (!name) continue;
    if (directives.has(name)) throw new Error(`중복 CSP 지시어: ${name}`);
    directives.set(name, sources);
  }
  if (directives.has("script-src-elem") || directives.has("style-src-elem"))
    throw new Error("별도 요소 지시어가 있는 CSP는 미리보기에서 변환하지 않습니다.");

  const approved = { script: new Set(), style: new Set() };
  for (const type of ["script", "style"]) {
    const sources = directives.get(`${type}-src`);
    if (!sources?.includes("'self'") || sources.some(source => source !== "'self'" && !/^'sha256-[A-Za-z0-9+/]{43}='$/.test(source)))
      throw new Error(`지원하지 않는 ${type}-src CSP 정책입니다.`);
    for (const code of inlineBlocks(html, type)) {
      const hash = digest(code);
      if (!sources.includes(hash)) throw new Error(`기존 CSP가 승인하지 않은 인라인 ${type}입니다.`);
      approved[type].add(hash);
    }
  }

  return {
    // 호출자는 빌드 폴더 안의 self 리소스를 읽고 변환한 결과만 이 경로에 전달합니다.
    approveEmbedded(type, code) {
      approved[type].add(digest(code));
    },
    finalize(finalHtml) {
      if (!finalHtml.includes(meta)) throw new Error("미리보기 생성 중 CSP 정책이 예상과 다르게 변경되었습니다.");
      const finalSources = {};
      for (const type of ["script", "style"]) {
        const hashes = new Set(inlineBlocks(finalHtml, type).map(digest));
        for (const hash of hashes) {
          if (!approved[type].has(hash)) throw new Error(`미리보기 변환 중 승인되지 않은 인라인 ${type}이 생성되었습니다.`);
        }
        finalSources[`${type}-src`] = ["'self'", ...hashes].join(" ");
      }
      const updatedContent = content.replace(
        /(^|;)\s*(script-src|style-src)\s+[^;]*/g,
        (_match, separator, name) => `${separator}${name} ${finalSources[name]}`,
      );
      const updatedMeta = meta.replace(/(\bcontent\s*=\s*")[^"]*(")/i, (_match, start, end) => start + updatedContent + end);
      return finalHtml.replace(meta, () => updatedMeta);
    },
  };
}
