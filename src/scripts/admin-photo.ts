import type { SupabaseClient } from "@supabase/supabase-js";
import { text as t } from "../lib/i18n";

// [편집 안내] 미디어 양식과 선수 양식이 같은 압축·비공개 업로드 규칙을 사용합니다.
// 반환 경로는 아직 게시된 사진이 아닙니다. 각 양식의 저장·승인 처리가 별도로 필요합니다.
export async function uploadOfficePhoto(
  client: SupabaseClient,
  userId: string,
  file: File,
): Promise<string> {
  if (
    !["image/jpeg", "image/png", "image/webp"].includes(file.type) ||
    file.size > 10485760
  )
    throw new Error(t("JPEG・PNG・WebPの10MB以下の写真を選択してください。"));
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 2400 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  try {
    const context = canvas.getContext("2d");
    if (!context) throw new Error(t("写真を処理できません。"));
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  } finally {
    bitmap.close();
  }
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (value) =>
        value ? resolve(value) : reject(new Error(t("写真を処理できません。"))),
      "image/jpeg",
      0.88,
    ),
  );
  const path = userId + "/" + crypto.randomUUID() + ".jpg";
  const { error } = await client.storage
    .from("kansai-media")
    .upload(path, blob, { contentType: "image/jpeg", upsert: false });
  if (error) throw error;
  return path;
}
