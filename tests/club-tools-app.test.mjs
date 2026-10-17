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
        assert.equal(document.querySelector(".club-chat-launcher"), null);
        await login(context.window);
        await eventually(() => Boolean(document.querySelector(".club-chat-launcher")));
        const chat = document.querySelector('[data-resource="club_chat"]');
        const attendance = document.querySelector('[data-resource="training_attendance"]');
        assert.ok(chat && attendance);
        assert.equal(document.querySelector(".club-chat"), null);
        assert.equal(context.requests.some(request => /\/rpc\/office_chat_(rooms|messages)$/.test(new URL(request.url).pathname)), false);
        const previousContent = document.querySelector("#admin-content").firstElementChild;
        const previousTitle = document.querySelector("#resource-title").textContent;
        const previousNewButtonHidden = document.querySelector("#new-button").hidden;
        const previousPublicationHidden = document.querySelector("#publication-status").hidden;
        chat.click();
        await eventually(() => Boolean(document.querySelector(".club-chat-room-button")));
        const chatView = document.querySelector(".club-chat");
        const widget = document.querySelector(".club-chat-widget");
        assert.equal(widget.dataset.open, "true");
        assert.equal(document.querySelector("#admin-content").firstElementChild, previousContent);
        assert.equal(document.querySelector("#resource-title").textContent, previousTitle);
        assert.equal(document.querySelector("#new-button").hidden, previousNewButtonHidden);
        assert.equal(document.querySelector("#publication-status").hidden, previousPublicationHidden);
        assert.deepEqual([...document.querySelectorAll(".club-chat-room-button")].map(button => button.dataset.room),
          role === "owner" ? ["players", "office"] : [room]);
        assert.equal(document.querySelector(".club-chat select"), null);
        assert.equal(document.querySelector(".club-chat").dataset.view, "rooms");
        document.querySelector(".club-chat-room-button").click();
        assert.equal(document.querySelector(".club-chat").dataset.view, "conversation");
        const composer = document.querySelector(".club-chat textarea");
        composer.value = "PRIVATE DRAFT ACROSS WORKSPACE NAVIGATION";
        composer.dispatchEvent(new context.window.Event("input", { bubbles: true }));
        document.querySelector(".club-chat-widget-close").click();
        assert.equal(widget.dataset.open, "false");
        attendance.click();
        await eventually(() => Boolean(document.querySelector('.training-attendance-day[datetime="2026-10-18"]')));
        assert.equal(document.querySelector(".club-chat"), chatView);
        assert.equal(composer.value, "PRIVATE DRAFT ACROSS WORKSPACE NAVIGATION");
        const attendanceView = document.querySelector(".training-attendance");
        chat.click();
        assert.equal(document.querySelector(".training-attendance"), attendanceView);
        assert.equal(widget.dataset.open, "true");
        assert.equal(composer.value, "PRIVATE DRAFT ACROSS WORKSPACE NAVIGATION");
        const empty = document.querySelector(".training-attendance-empty").textContent;
        assert.equal(empty, { ja: "今日の練習はありません。", ko: "오늘은 훈련이 없습니다.", en: "There is no training today." }[lang]);
        document.querySelector("#logout-button").click();
        await eventually(() => document.querySelector("#workspace").hidden);
        assert.equal(document.querySelector(".training-attendance"), null);
        assert.equal(document.querySelector(".club-chat-widget,.club-chat"), null);
        assert.equal(widget.textContent, "");
        assert.equal(document.querySelector("#admin-navigation").childElementCount, 0);
      } finally { context.dom.window.close(); }
    });
  }
}

test("the chat launcher is absent when the server capability is disabled", async () => {
  const context = await app("owner", "https://kansaiunited.com/admin/", {
    staffIdentity: identityEnabled, accountState: identityEnabled ? account("owner") : undefined,
    clubChat: false,
  });
  try {
    await login(context.window);
    assert.equal(context.window.document.querySelector('.club-chat-widget,[data-resource="club_chat"]'), null);
    assert.equal(context.requests.some(request => /\/rpc\/office_chat_/.test(new URL(request.url).pathname)), false);
  } finally { context.dom.window.close(); }
});

test("a role change destroys the old floating chat before a delayed private response returns", async () => {
  let role = "owner", hold = false, held = false, release;
  const late = new Promise(resolve => { release = resolve; });
  const context = await app("owner", "https://kansaiunited.com/admin/", {
    staffIdentity: identityEnabled, accountState: identityEnabled ? () => account(role) : undefined,
    clubChat: true,
    async rpc(name, args) {
      if (name === "office_chat_rooms") return { user_id: uid, role, rooms: (role === "owner" ? ["players", "office"] : ["office"]).map(id => ({ id })) };
      if (name === "office_chat_messages") {
        if (hold && args.p_room === "players") { held = true; return late; }
        return { user_id: uid, room: args.p_room, messages: [], has_more: false };
      }
      return [];
    },
  });
  const document = context.window.document;
  try {
    await login(context.window);
    document.querySelector(".club-chat-launcher").click();
    await eventually(() => Boolean(document.querySelector(".club-chat textarea:not(:disabled)")));
    const oldWidget = document.querySelector(".club-chat-widget");
    document.querySelector(".club-chat textarea").value = "OLD OWNER PRIVATE DRAFT";
    hold = true;
    document.querySelector(".club-chat-refresh").click();
    await eventually(() => held);
    role = "staff";
    context.tables.admin_roles[0].role = role;
    context.window.dispatchEvent(new context.window.Event("focus"));
    await eventually(() => Boolean(document.querySelector(".club-chat-widget")) && document.querySelector(".club-chat-widget") !== oldWidget);
    release({ user_id: uid, room: "players", messages: [{ id: "1", sender_id: uid, sender_name: "Owner", sender_role: "owner", body: "OLD ROLE PRIVATE RESPONSE", is_removed: false, created_at: "2026-10-17T10:00:00Z" }], has_more: false });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(oldWidget.isConnected, false);
    assert.equal(oldWidget.textContent, "");
    assert.equal(document.querySelector(".club-chat-widget").dataset.open, "false");
    document.querySelector(".club-chat-launcher").click();
    await eventually(() => Boolean(document.querySelector('.club-chat-room-button[data-room="office"]')));
    assert.equal(document.querySelector('.club-chat-room-button[data-room="players"]'), null);
    assert.equal(document.body.textContent.includes("OLD ROLE PRIVATE RESPONSE"), false);
  } finally { release({ user_id: uid, room: "players", messages: [], has_more: false }); context.dom.window.close(); }
});
