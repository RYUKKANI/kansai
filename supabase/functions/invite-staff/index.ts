import { requireOwner } from "../_shared/auth.ts";
import { createLegacyInviteHandler } from "./handler.ts";
// [편집 안내] 기존 초대의 호환 경로입니다. 실명 계정 DB가 적용되면 메일 전송 전에 차단합니다.
Deno.serve(createLegacyInviteHandler(requireOwner));
