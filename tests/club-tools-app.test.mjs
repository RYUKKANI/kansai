import test from "node:test";
import assert from "node:assert/strict";
import { app, login, eventually, uid } from "./helpers/admin-app.mjs";

// 실제 관리자 번들에서 메뉴→업무 진입과 계정 정리를 확인합니다. DB 권한은 별도 SQL 파트가 검사합니다.
const identityEnabled = Boolean(process.env.STAFF_IDENTITY_TEST_DIST);
const account = role => ({ user_id: uid, username: "club.member", real_name: "李 Ana-María",
  approved_real_name: "李 Ana-María", role, active: true, approval_status: "approved",
  identity_enrolled: true, legacy_account: false, email_confirmation_required: false,
  name_verified_at: "2026-10-01T00:00:00Z" });
for (const lang of ["ja", "ko", "en"]) {
  for (const role of ["owner", "staff", "player"]) {
    test(`${role} can open club tools in ${lang} and logout removes private views`, async () => {
      const room = role === "staff" ? "office" : "players";
      const context = await app(role, `https://kansaiunited.com/admin/?lang=${lang}`, {
        staffIdentity: identityEnabled, accountState: identityEnabled ? account(role) : undefined,
        clubChat: true, trainingAttendance: true,
        rpc(name) {
          if (name === "office_player_portal") return { user_id: uid, linked: false, player_id: null };
          if (name === "office_chat_rooms") return { user_id: uid, role,
            rooms: (role === "owner" ? ["players", "office"] : [room]).map(id => ({ id })) };
          if (name === "office_chat_messages") return { user_id: uid, room, messages: [], has_more: false };
          if (name === "office_training_attendance_today") return { user_id: uid, role, today: "2026-10-18",
            player_id: null, linked: false, trainings: [] };
          return [];
        },
      });
      const document = context.window.document;
      try {
        await login(context.window);
        const chat = document.querySelector('[data-resource="club_chat"]');
        const attendance = document.querySelector('[data-resource="training_attendance"]');
        assert.ok(chat && attendance);
        chat.click();
        await eventually(() => Boolean(document.querySelector(".club-chat-room-button")));
        assert.equal(document.querySelector("#new-button").hidden, true);
        assert.equal(document.querySelector("#publication-status").hidden, true);
        assert.deepEqual([...document.querySelectorAll(".club-chat-room-button")].map(button => button.dataset.room),
          role === "owner" ? ["players", "office"] : [room]);
        assert.equal(document.querySelector(".club-chat select"), null);
        assert.equal(document.querySelector(".club-chat").dataset.view, "rooms");
        document.querySelector(".club-chat-room-button").click();
        assert.equal(document.querySelector(".club-chat").dataset.view, "conversation");
        attendance.click();
        await eventually(() => Boolean(document.querySelector('.training-attendance-day[datetime="2026-10-18"]')));
        assert.equal(document.querySelector(".club-chat"), null);
        const empty = document.querySelector(".training-attendance-empty").textContent;
        assert.equal(empty, { ja: "今日の練習はありません。", ko: "오늘은 훈련이 없습니다.", en: "There is no training today." }[lang]);
        document.querySelector("#logout-button").click();
        await eventually(() => document.querySelector("#workspace").hidden);
        assert.equal(document.querySelector(".training-attendance"), null);
        assert.equal(document.querySelector("#admin-navigation").childElementCount, 0);
      } finally { context.dom.window.close(); }
    });
  }
}
