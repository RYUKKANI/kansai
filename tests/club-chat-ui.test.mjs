import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

// 실제 채팅 화면을 실행합니다. RPC·Realtime 전송만 대체하여 공개 데이터나 운영 계정을 사용하지 않습니다.
const compiled = (await build({
  entryPoints: ["src/scripts/club-chat.ts"], bundle: true, write: false,
  format: "iife", globalName: "ClubChat", platform: "browser",
  define: { "import.meta.env.BASE_URL": '"/"' }, loader: { ".css": "empty" },
})).outputFiles[0].text;
const userId = "00000000-0000-4000-8000-000000000001";
const otherId = "00000000-0000-4000-8000-000000000002";
const stamp = "2026-10-17T10:00:00Z";
const message = (body = "Practice starts at 18:00", values = {}) => ({
  id: "1", sender_id: otherId, sender_name: "韓 山田 Ana-María", sender_role: "player",
  body, created_at: stamp, is_removed: false, ...values,
});
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function until(check) {
  for (let index = 0; index < 120; index++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.ok(check(), "Chat did not reach the expected state");
}
function app(options = {}) {
  const dom = new JSDOM("<main></main>", {
    url: "https://kansaiunited.com/admin/", runScripts: "outside-only", pretendToBeVisual: true,
  });
  const { window } = dom;
  if (options.mobile !== undefined) window.matchMedia = () => ({ matches: options.mobile });
  const viewport = options.viewportHeight ? Object.assign(new window.EventTarget(), { height: options.viewportHeight }) : null;
  if (viewport) Object.defineProperty(window, "visualViewport", { value: viewport });
  let nonce = 0;
  Object.defineProperty(window, "crypto", { value: { randomUUID: () =>
    `10000000-0000-4000-8000-${String(++nonce).padStart(12, "0")}` } });
  window.eval(compiled + "\nwindow.ClubChat = ClubChat;");
  let active = true;
  let authListener;
  let unsubscribed = 0;
  const calls = [], channels = [], removed = [];
  const role = options.role ?? "owner";
  const allowed = role === "owner" ? ["players", "office"] : role === "staff" ? ["office"] : ["players"];
  const defaults = {
    office_chat_rooms: () => ({ user_id: userId, role, rooms: allowed.map(id => ({ id })), server_time: stamp }),
    office_chat_messages: args => ({ user_id: userId, room: args.p_room,
      messages: [message(args.p_room === "office" ? "Office private discussion" : "Player private discussion")], has_more: false }),
    office_chat_send: args => ({ user_id: userId, room: args.p_room,
      message: message(args.p_body, { id: "2", sender_id: userId, sender_role: role }) }),
  };
  const client = {
    async rpc(name, args) {
      calls.push({ name, args: args && structuredClone(args) });
      const handler = options.responses?.[name] ?? defaults[name];
      assert.ok(handler !== undefined, `Unexpected RPC ${name}`);
      const result = typeof handler === "function" ? await handler(args) : handler;
      return result && (Object.hasOwn(result, "data") || Object.hasOwn(result, "error"))
        ? result : { data: result, error: null };
    },
    channel(name) {
      const channel = { name, listeners: [],
        on(event, config, callback) { this.listeners.push({ event, config, callback }); return this; },
        subscribe(callback) { this.status = callback; callback?.("SUBSCRIBED"); return this; },
      };
      channels.push(channel); return channel;
    },
    async removeChannel(channel) { removed.push(channel); return "ok"; },
    auth: { onAuthStateChange(listener) {
      authListener = listener;
      return { data: { subscription: { unsubscribe() { unsubscribed++; } } } };
    } },
  };
  const controller = window.ClubChat.createClubChat({ client, userId, isCurrent: () => active });
  window.document.querySelector("main").append(controller.element);
  const roomButtons = () => [...controller.element.querySelectorAll(".club-chat-room-button")];
  const selectedRoom = () => controller.element.querySelector('.club-chat-room-button[aria-current="true"]')?.dataset.room;
  const composer = () => controller.element.querySelector("textarea");
  const submit = () => composer()?.form?.querySelector('[type="submit"]');
  return { dom, window, controller, calls, channels, removed, roomButtons, selectedRoom, composer, submit, viewport,
    unsubscribed: () => unsubscribed,
    choose(room) { controller.element.querySelector(`.club-chat-room-button[data-room="${room}"]`)?.click(); },
    write(body) { composer().value = body; composer().dispatchEvent(new window.Event("input", { bubbles: true })); },
    send() { composer().form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); },
    emit(event, session) { authListener?.(event, session); },
    invalidate() { active = false; },
    close() { controller.dispose(); window.close(); },
  };
}

test("room list navigation preserves the current conversation without fetching other-room previews", async () => {
  const ctx = app();
  try {
    await ctx.controller.refresh();
    await until(() => !ctx.controller.element.querySelector('[aria-busy="true"]'));
    assert.equal(ctx.controller.element.dataset.view, "rooms");
    assert.equal(ctx.controller.element.querySelector("select"), null);
    assert.equal(ctx.calls.some(call => call.name === "office_chat_messages" && call.args.p_room === "office"), false);
    const office = ctx.roomButtons().find(button => button.dataset.room === "office");
    assert.equal(office.querySelector(".club-chat-room-preview").textContent, "統括 · スタッフ");
    assert.equal(office.querySelector("time").hidden, true);
    ctx.choose("players");
    assert.equal(ctx.controller.element.dataset.view, "conversation");
    assert.equal(ctx.window.document.activeElement, ctx.controller.element.querySelector(".club-chat-title"));
    ctx.write("Keep this draft when going back");
    const history = ctx.controller.element.querySelector(".club-chat-history");
    Object.defineProperty(history, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(history, "clientHeight", { configurable: true, value: 300 });
    history.scrollTop = 42;
    const channel = ctx.channels.at(-1);
    const reads = ctx.calls.filter(call => call.name === "office_chat_messages").length;
    ctx.controller.element.querySelector(".club-chat-back").click();
    assert.equal(ctx.controller.element.dataset.view, "rooms");
    assert.equal(ctx.window.document.activeElement.dataset.room, "players");
    // 실제 모바일의 display:none처럼 치수가 0이 되어도 배경 갱신이 복귀 위치를 지우지 않습니다.
    Object.defineProperty(history, "scrollHeight", { configurable: true, value: 0 });
    Object.defineProperty(history, "clientHeight", { configurable: true, value: 0 });
    history.scrollTop = 0;
    await ctx.controller.refresh();
    Object.defineProperty(history, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(history, "clientHeight", { configurable: true, value: 300 });
    ctx.choose("players");
    assert.equal(ctx.composer().value, "Keep this draft when going back");
    assert.equal(history.scrollTop, 42);
    assert.equal(ctx.channels.at(-1), channel);
    assert.equal(ctx.removed.includes(channel), false);
    assert.equal(ctx.calls.filter(call => call.name === "office_chat_messages").length, reads + 1);
    ctx.choose("office");
    await until(() => ctx.controller.element.textContent.includes("Office private discussion"));
    const oldRoom = ctx.roomButtons().find(button => button.dataset.room === "players");
    assert.equal(oldRoom.querySelector(".club-chat-room-preview").textContent, "選手 · 統括");
    assert.equal(oldRoom.querySelector("time").hidden, true);
    assert.equal(ctx.composer().value, "");
  } finally { ctx.close(); }
});

test("an initial room-list failure shows an actionable retry before opening a conversation", async () => {
  let offline = true;
  const ctx = app({ responses: { office_chat_rooms: () => offline
    ? { data: null, error: { code: "FETCH_ERROR" } }
    : { user_id: userId, role: "owner", rooms: [{ id: "players" }, { id: "office" }] },
  } });
  try {
    await ctx.controller.refresh();
    assert.equal(ctx.controller.element.dataset.view, "rooms");
    const status = ctx.controller.element.querySelector(".club-chat-sidebar-status");
    assert.equal(status.hidden, false);
    assert.ok(status.querySelector("p").textContent);
    assert.equal(ctx.roomButtons().length, 0);
    offline = false;
    status.querySelector("button").click();
    await until(() => ctx.selectedRoom() === "players" && !ctx.composer().disabled);
    assert.equal(status.hidden, true);
    assert.equal(ctx.controller.element.dataset.view, "rooms");
  } finally { ctx.close(); }
});

test("chat dates follow Japan midnight and multiline input waits for explicit send", async () => {
  const ctx = app({ responses: { office_chat_messages: args => ({ user_id: userId, room: args.p_room, has_more: false,
    messages: [
      message("Before midnight", { id: "1", created_at: "2026-10-17T14:59:00Z" }),
      message("After midnight", { id: "2", sender_id: userId, created_at: "2026-10-17T15:00:00Z" }),
    ],
  }) } });
  try {
    await ctx.controller.refresh(); ctx.choose("players");
    assert.deepEqual([...ctx.controller.element.querySelectorAll(".club-chat-day time")].map(time => time.dateTime), ["2026-10-17", "2026-10-18"]);
    assert.deepEqual([...ctx.controller.element.querySelectorAll(".club-chat-message-time")].map(time => time.textContent), ["23:59", "00:00"]);
    const own = ctx.controller.element.querySelector('[data-own="true"]');
    assert.ok(own.querySelector(".club-chat-bubble-row .club-chat-message-body"));
    assert.ok(own.querySelector(".club-chat-bubble-row .club-chat-message-time"));
    assert.equal(ctx.controller.element.querySelector('input[type="file"],.club-chat-unread,.club-chat-read-receipt'), null);
    ctx.write("Line one\nLine two");
    const enter = new ctx.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    ctx.composer().dispatchEvent(enter);
    assert.equal(enter.defaultPrevented, false);
    assert.equal(ctx.calls.some(call => call.name === "office_chat_send"), false);
    ctx.send(); await until(() => ctx.composer().value === "");
    assert.equal(ctx.calls.find(call => call.name === "office_chat_send").args.p_body, "Line one\nLine two");
  } finally { ctx.close(); }
});

test("visible viewport sizing follows keyboard resize and stops after disposal", async () => {
  const ctx = app({ viewportHeight: 640 });
  try {
    assert.equal(ctx.controller.element.style.getPropertyValue("--club-chat-viewport-height"), "640px");
    ctx.viewport.height = 400;
    ctx.viewport.dispatchEvent(new ctx.window.Event("resize"));
    assert.equal(ctx.controller.element.style.getPropertyValue("--club-chat-viewport-height"), "400px");
    ctx.controller.dispose();
    ctx.viewport.height = 320;
    ctx.viewport.dispatchEvent(new ctx.window.Event("resize"));
    assert.equal(ctx.controller.element.style.getPropertyValue("--club-chat-viewport-height"), "400px");
  } finally { ctx.close(); }
});

for (const mobile of [false, true]) {
  test(`${mobile ? "hidden mobile" : "visible desktop"} conversation receives focus appropriately after sending`, async () => {
    const receipt = deferred();
    const ctx = app({ mobile, responses: { office_chat_send: () => receipt.promise } });
    try {
      await ctx.controller.refresh();
      if (mobile) ctx.choose("players");
      ctx.write("A delivered message"); ctx.send();
      if (mobile) ctx.controller.element.querySelector(".club-chat-back").click();
      else ctx.submit().focus();
      receipt.resolve({ user_id: userId, room: "players", message: message("A delivered message", { id: "2", sender_id: userId }) });
      await until(() => !ctx.submit().disabled);
      assert.equal(ctx.window.document.activeElement, mobile
        ? ctx.controller.element.querySelector('.club-chat-room-button[data-room="players"]')
        : ctx.composer());
    } finally { ctx.close(); }
  });
}

for (const [role, rooms] of [["owner", ["players", "office"]], ["staff", ["office"]], ["player", ["players"]]]) {
  test(`${role} sees only their permitted chat rooms and does not issue hidden-room queries`, async () => {
    const ctx = app({ role });
    try {
      await ctx.controller.refresh();
      assert.deepEqual(ctx.roomButtons().map(button => button.dataset.room), rooms);
      assert.equal(ctx.calls.filter(call => call.name === "office_chat_messages").every(call => rooms.includes(call.args.p_room)), true);
      if (role !== "owner") {
        const forbidden = role === "staff" ? "players" : "office";
        const forged = ctx.roomButtons()[0]; forged.dataset.room = forbidden;
        forged.click();
        await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(ctx.calls.some(call => call.name === "office_chat_messages" && call.args.p_room === forbidden), false);
      }
    } finally { ctx.close(); }
  });
}

test("messages and approved real names render as text rather than executable markup", async () => {
  const attack = '<img src=x onerror="window.chatLeak=true"><script>window.chatLeak=true</script>';
  const ctx = app({ responses: { office_chat_messages: args => ({ user_id: userId, room: args.p_room,
    messages: [message(attack, { sender_name: attack })], has_more: false }) } });
  try {
    await ctx.controller.refresh();
    assert.ok(ctx.controller.element.textContent.includes(attack));
    assert.equal(ctx.controller.element.querySelector("img,script"), null);
    assert.equal(ctx.window.chatLeak, undefined);
  } finally { ctx.close(); }
});

test("a pending send blocks duplicate submission and an uncertain retry reuses its nonce", async () => {
  const first = deferred(); let attempts = 0;
  const ctx = app({ responses: { office_chat_send: args => ++attempts === 1 ? first.promise : {
    user_id: userId, room: args.p_room, message: message(args.p_body, { id: "9", sender_id: userId }),
  } } });
  try {
    await ctx.controller.refresh(); ctx.write("Keep this draft for retry"); ctx.send(); ctx.send();
    assert.equal(ctx.calls.filter(call => call.name === "office_chat_send").length, 1);
    assert.equal(ctx.submit().disabled, true);
    assert.equal(ctx.roomButtons().find(button => button.dataset.room === "office").disabled, true);
    assert.equal(ctx.roomButtons().find(button => button.dataset.room === "players").disabled, false);
    first.resolve({ data: null, error: { code: "FETCH_ERROR", message: "Network interrupted" } });
    await until(() => !ctx.submit().disabled);
    assert.equal(ctx.composer().value, "Keep this draft for retry");
    ctx.send(); await until(() => ctx.composer().value === "");
    const writes = ctx.calls.filter(call => call.name === "office_chat_send");
    assert.equal(writes.length, 2);
    assert.match(writes[0].args.p_nonce, /^[a-f0-9-]{36}$/i);
    assert.equal(writes[0].args.p_nonce, writes[1].args.p_nonce);
    assert.deepEqual(Object.keys(writes[0].args).sort(), ["p_body", "p_nonce", "p_room"]);
  } finally { ctx.close(); }
});

test("an older room response cannot appear after changing to another room", async () => {
  const old = deferred(); let hold = false, held = false;
  const ctx = app({ responses: { office_chat_messages: args => hold && args.p_room === "players" ? (held = true, old.promise) : {
    user_id: userId, room: args.p_room, messages: [message(`${args.p_room} fresh only`)], has_more: false,
  } } });
  try {
    await ctx.controller.refresh(); hold = true;
    const staleRefresh = ctx.controller.refresh();
    await until(() => held);
    ctx.choose("office"); await until(() => ctx.controller.element.textContent.includes("office fresh only"));
    old.resolve({ data: { user_id: userId, room: "players", messages: [message("OLD SECRET")], has_more: false }, error: null });
    await staleRefresh;
    assert.equal(ctx.controller.element.textContent.includes("OLD SECRET"), false);
    assert.ok(ctx.controller.element.textContent.includes("office fresh only"));
  } finally { ctx.close(); }
});

test("Realtime invalidation reads the protected RPC and releases subscriptions on room change and dispose", async () => {
  const ctx = app();
  try {
    await ctx.controller.refresh();
    const playerChannel = ctx.channels.at(-1);
    assert.ok(playerChannel);
    const change = playerChannel.listeners.find(listener => listener.event === "postgres_changes");
    assert.equal(change.config.table, "office_chat_events");
    assert.equal(change.config.filter, "room=eq.players");
    const before = ctx.calls.filter(call => call.name === "office_chat_messages").length;
    change.callback({ new: { room: "players", body: "UNTRUSTED EVENT BODY" } });
    await until(() => ctx.calls.filter(call => call.name === "office_chat_messages").length > before);
    assert.equal(ctx.controller.element.textContent.includes("UNTRUSTED EVENT BODY"), false);
    ctx.choose("office"); await until(() => ctx.channels.length > 1);
    assert.ok(ctx.removed.includes(playerChannel));
    const officeChannel = ctx.channels.at(-1);
    ctx.controller.dispose();
    assert.ok(ctx.removed.includes(officeChannel));
    assert.equal(ctx.unsubscribed(), 1);
    assert.equal(ctx.controller.element.textContent.includes("Office private discussion"), false);
  } finally { ctx.close(); }
});

test("permission denial clears previously displayed private messages and disables the composer", async () => {
  let denied = false;
  const ctx = app({ responses: { office_chat_messages: args => denied
    ? { data: null, error: { code: "42501", message: "not permitted" } }
    : { user_id: userId, room: args.p_room, messages: [message("PRIVATE BEFORE REVOCATION")], has_more: false } } });
  try {
    await ctx.controller.refresh(); assert.ok(ctx.controller.element.textContent.includes("PRIVATE BEFORE REVOCATION"));
    denied = true; await ctx.controller.refresh();
    assert.equal(ctx.controller.element.textContent.includes("PRIVATE BEFORE REVOCATION"), false);
    assert.ok(ctx.controller.element.querySelector('[role="alert"]'));
    assert.ok(!ctx.composer() || ctx.composer().disabled);
  } finally { ctx.close(); }
});

for (const event of ["SIGNED_OUT", "different user"]) {
  test(`${event} clears chat drafts and messages and ignores delayed responses`, async () => {
    const late = deferred(); let hold = false;
    const ctx = app({ responses: { office_chat_messages: args => hold ? late.promise : {
      user_id: userId, room: args.p_room, messages: [message("PRIVATE ACTIVE ACCOUNT")], has_more: false,
    } } });
    try {
      await ctx.controller.refresh(); ctx.write("PRIVATE UNSENT DRAFT");
      ctx.controller.element.querySelector(".club-chat-remove").click();
      ctx.controller.element.querySelector(".club-chat-removal input").value = "PRIVATE REMOVAL REASON";
      hold = true;
      const pending = ctx.controller.refresh();
      await until(() => ctx.calls.filter(call => call.name === "office_chat_messages").length === 2);
      ctx.emit(event === "SIGNED_OUT" ? "SIGNED_OUT" : "SIGNED_IN", event === "SIGNED_OUT" ? null : { user: { id: otherId } });
      late.resolve({ data: { user_id: userId, room: "players", messages: [message("LATE PRIVATE ACCOUNT")], has_more: false }, error: null });
      await pending;
      for (const secret of ["PRIVATE ACTIVE ACCOUNT", "PRIVATE UNSENT DRAFT", "LATE PRIVATE ACCOUNT", "PRIVATE REMOVAL REASON"])
        assert.equal(ctx.controller.element.textContent.includes(secret), false);
      assert.ok(!ctx.composer() || ctx.composer().value === "");
      assert.equal(ctx.controller.element.querySelector(".club-chat-removal"), null);
    } finally { ctx.close(); }
  });
}

test("a response for another account is never rendered", async () => {
  const ctx = app({ responses: { office_chat_messages: args => ({ user_id: otherId, room: args.p_room,
    messages: [message("OTHER ACCOUNT SECRET")], has_more: false }) } });
  try {
    await ctx.controller.refresh();
    assert.equal(ctx.controller.element.textContent.includes("OTHER ACCOUNT SECRET"), false);
    assert.ok(ctx.controller.element.querySelector('[role="alert"]'));
    assert.ok(!ctx.composer() || ctx.composer().disabled);
  } finally { ctx.close(); }
});

test("an overbroad room list is rejected before querying a room outside the server role", async () => {
  const ctx = app({ role: "player", responses: { office_chat_rooms: {
    user_id: userId, role: "player", rooms: [{ id: "players" }, { id: "office" }], server_time: stamp,
  } } });
  try {
    await ctx.controller.refresh();
    assert.equal(ctx.calls.some(call => call.name === "office_chat_messages"), false);
    assert.ok(ctx.controller.element.querySelector('[role="alert"]')?.textContent);
    assert.equal(ctx.composer().disabled, true);
  } finally { ctx.close(); }
});

test("successful delivery does not erase a different draft typed while the send was pending", async () => {
  const pending = deferred();
  const ctx = app({ responses: { office_chat_send: () => pending.promise } });
  try {
    await ctx.controller.refresh(); ctx.write("First message"); ctx.send();
    ctx.write("Next unsent message");
    pending.resolve({ data: { user_id: userId, room: "players",
      message: message("First message", { id: "8", sender_id: userId }) }, error: null });
    await until(() => !ctx.submit().disabled);
    assert.equal(ctx.composer().value, "Next unsent message");
    assert.ok(ctx.controller.element.querySelector('[data-message-id="8"]')?.textContent.includes("First message"));
  } finally { ctx.close(); }
});

test("Staff has no message moderation controls", async () => {
  const ctx = app({ role: "staff" });
  try {
    await ctx.controller.refresh();
    assert.equal(ctx.controller.element.querySelector(".club-chat-remove,.club-chat-removal"), null);
  } finally { ctx.close(); }
});

test("Owner moderation keeps the original message until a confirmed tombstone and preserves failed reasons", async () => {
  const first = deferred(); let attempts = 0;
  const ctx = app({ responses: { office_chat_remove: args => ++attempts === 1 ? first.promise : {
    user_id: userId, room: "players", message: message("SERVER RETAINED BODY", { id: args.p_message_id, is_removed: true }),
  } } });
  try {
    await ctx.controller.refresh();
    const trigger = ctx.controller.element.querySelector(".club-chat-remove");
    assert.equal(trigger.textContent, "⋯");
    assert.equal(trigger.getAttribute("aria-label"), "メッセージを削除");
    assert.equal(trigger.title, "メッセージを削除");
    assert.ok(trigger.closest(".club-chat-bubble-row"));
    trigger.click();
    const form = ctx.controller.element.querySelector(".club-chat-removal");
    assert.ok(form.parentElement.classList.contains("club-chat-message-content"));
    form.querySelector("input").value = "Club moderation policy";
    const submit = () => form.dispatchEvent(new ctx.window.Event("submit", { bubbles: true, cancelable: true }));
    submit(); submit();
    assert.equal(ctx.calls.filter(call => call.name === "office_chat_remove").length, 1);
    assert.ok(ctx.controller.element.textContent.includes("Player private discussion"));
    await ctx.controller.refresh();
    assert.equal(ctx.controller.element.querySelector(".club-chat-removal"), form);
    assert.equal(form.querySelector('[type="submit"]').disabled, true);
    first.resolve({ data: null, error: { code: "40001" } });
    await until(() => !form.querySelector('[type="submit"]').disabled);
    assert.equal(form.querySelector("input").value, "Club moderation policy");
    assert.ok(ctx.controller.element.textContent.includes("Player private discussion"));
    submit(); await until(() => ctx.controller.element.querySelector('[data-message-id="1"][data-removed="true"]'));
    assert.equal(ctx.controller.element.textContent.includes("Player private discussion"), false);
    assert.equal(ctx.controller.element.textContent.includes("SERVER RETAINED BODY"), false);
    const writes = ctx.calls.filter(call => call.name === "office_chat_remove");
    assert.deepEqual(writes[0].args, { p_message_id: "1", p_reason: "Club moderation policy" });
  } finally { ctx.close(); }
});

test("ordinary refreshes and incoming messages preserve the Owner's removal draft and focus", async () => {
  let incoming = false;
  const ctx = app({ responses: { office_chat_messages: args => ({ user_id: userId, room: args.p_room,
    messages: [message(), ...(incoming ? [message("New incoming message", { id: "2" })] : [])], has_more: false,
  }) } });
  try {
    await ctx.controller.refresh();
    await until(() => !ctx.controller.element.querySelector('[aria-busy="true"]'));
    const trigger = ctx.controller.element.querySelector(".club-chat-remove");
    trigger.click();
    const form = ctx.controller.element.querySelector(".club-chat-removal");
    const input = form.querySelector("input");
    input.value = "Owner reason still being written";
    input.setSelectionRange(5, 12);
    await ctx.controller.refresh();
    assert.equal(ctx.controller.element.querySelector(".club-chat-removal"), form);
    assert.equal(input.value, "Owner reason still being written");
    assert.equal(ctx.window.document.activeElement, input);
    assert.equal(input.selectionStart, 5);
    assert.equal(input.selectionEnd, 12);
    incoming = true;
    ctx.channels.at(-1).listeners[0].callback({ new: { room: "players" } });
    await until(() => ctx.controller.element.querySelector('[data-message-id="2"]'));
    assert.equal(ctx.controller.element.querySelector(".club-chat-removal"), form);
    assert.equal(input.value, "Owner reason still being written");
    assert.equal(ctx.window.document.activeElement, input);
    form.querySelector(".club-chat-remove-cancel").click();
    assert.equal(ctx.controller.element.querySelector(".club-chat-removal"), null);
    assert.equal(trigger.hidden, false);
    assert.equal(ctx.window.document.activeElement, trigger);
  } finally { ctx.close(); }
});

test("room and role changes clear Owner removal drafts", async () => {
  let role = "owner";
  const ctx = app({ responses: { office_chat_rooms: () => ({ user_id: userId, role,
    rooms: (role === "owner" ? ["players", "office"] : ["office"]).map(id => ({ id })), server_time: stamp,
  }) } });
  try {
    await ctx.controller.refresh();
    ctx.controller.element.querySelector(".club-chat-remove").click();
    ctx.controller.element.querySelector(".club-chat-removal input").value = "Player room private reason";
    ctx.choose("office"); await until(() => ctx.controller.element.textContent.includes("Office private discussion"));
    assert.equal(ctx.controller.element.querySelector(".club-chat-removal"), null);
    ctx.choose("players"); await until(() => ctx.controller.element.textContent.includes("Player private discussion"));
    assert.equal(ctx.controller.element.querySelector(".club-chat-removal"), null);
    ctx.controller.element.querySelector(".club-chat-remove").click();
    ctx.controller.element.querySelector(".club-chat-removal input").value = "Reason before role change";
    role = "staff"; await ctx.controller.refresh();
    assert.equal(ctx.selectedRoom(), "office");
    assert.equal(ctx.controller.element.querySelector(".club-chat-removal,.club-chat-remove"), null);
  } finally { ctx.close(); }
});

test("loaded history refreshes as a bounded complete window and replaces old deleted bodies", async () => {
  const releasePage = deferred();
  const releaseQueued = deferred();
  let changed = false, held = false, refreshes = 0;
  const stored = Array.from({ length: 300 }, (_, index) => message(`History ${index + 1}`, { id: String(index + 1) }));
  const ctx = app({ responses: { office_chat_messages: async args => {
    if (changed && args.p_before === null && ++refreshes === 2) await releaseQueued.promise;
    const matching = stored.filter(item => args.p_before === null || BigInt(item.id) < BigInt(args.p_before));
    const page = matching.slice(-50).map(item => ({ ...item }));
    if (changed && args.p_before === "252" && !held) { held = true; await releasePage.promise; }
    return { user_id: userId, room: args.p_room, messages: page, has_more: matching.length > 50 };
  } } });
  try {
    await ctx.controller.refresh();
    await until(() => !ctx.controller.element.querySelector('[aria-busy="true"]'));
    for (let count = 100; count <= 250; count += 50) {
      ctx.controller.element.querySelector(".club-chat-older").click();
      await until(() => ctx.controller.element.querySelectorAll('[data-message-id]').length === count);
    }
    assert.equal(ctx.controller.element.querySelector(".club-chat-older").hidden, true);
    ctx.controller.element.querySelector('[data-message-id="60"] .club-chat-remove').click();
    ctx.controller.element.querySelector(".club-chat-removal input").value = "Reason before another Owner removes it";
    stored[59] = message("", { id: "60", is_removed: true });
    stored.push(message("Newest message", { id: "301" }));
    changed = true;
    const before = ctx.calls.filter(call => call.name === "office_chat_messages").length;
    const refresh = ctx.controller.refresh();
    await until(() => held);
    assert.ok(ctx.controller.element.querySelector('[data-message-id="60"]').textContent.includes("History 60"));
    assert.equal(ctx.controller.element.querySelector('[data-message-id="301"]'), null);
    // 조회 중 들어온 갱신은 진행 중인 5페이지를 취소하지 않고 다음 한 번으로 합칩니다.
    await ctx.controller.refresh();
    assert.equal(ctx.calls.filter(call => call.name === "office_chat_messages").length, before + 2);
    releasePage.resolve();
    await refresh;
    await until(() => refreshes === 2);
    assert.equal(ctx.controller.element.querySelectorAll('[data-message-id]').length, 250);
    assert.ok(ctx.controller.element.querySelector('[data-message-id="60"][data-removed="true"]'));
    assert.equal(ctx.controller.element.querySelector(".club-chat-removal"), null);
    assert.equal(ctx.controller.element.textContent.includes("History 60"), false);
    assert.ok(ctx.controller.element.querySelector('[data-message-id="301"]'));
    const window = ctx.calls.filter(call => call.name === "office_chat_messages").slice(before, before + 5);
    assert.deepEqual(window.map(call => call.args.p_before), [null, "252", "202", "152", "102"]);
    releaseQueued.resolve();
    await until(() => !ctx.controller.element.querySelector('[aria-busy="true"]'));
    assert.equal(ctx.controller.element.querySelectorAll('[data-message-id]').length, 250);
  } finally { releasePage.resolve(); releaseQueued.resolve(); ctx.close(); }
});

test("a transient room-list failure preserves the current-room draft and its uncertain-send nonce", async () => {
  let offline = false, attempts = 0;
  const ctx = app({ responses: {
    office_chat_rooms: () => offline
      ? { data: null, error: { code: "FETCH_ERROR", message: "Temporarily offline" } }
      : { user_id: userId, role: "owner", rooms: [{ id: "players" }, { id: "office" }], server_time: stamp },
    office_chat_send: args => ++attempts === 1
      ? { data: null, error: { code: "FETCH_ERROR", message: "Receipt lost" } }
      : { user_id: userId, room: args.p_room, message: message(args.p_body, { id: "15", sender_id: userId }) },
  } });
  try {
    await ctx.controller.refresh(); ctx.choose("office");
    await until(() => ctx.channels.some(channel => channel.name.startsWith("office-chat-office-")));
    ctx.write("Office draft whose delivery is uncertain"); ctx.send();
    await until(() => !ctx.submit().disabled);
    offline = true; await ctx.controller.refresh();
    assert.equal(ctx.composer().value, "Office draft whose delivery is uncertain");
    assert.equal(ctx.submit().disabled, true);
    offline = false; await ctx.controller.refresh();
    assert.equal(ctx.selectedRoom(), "office");
    assert.equal(ctx.composer().value, "Office draft whose delivery is uncertain");
    ctx.send(); await until(() => ctx.composer().value === "");
    const writes = ctx.calls.filter(call => call.name === "office_chat_send");
    assert.equal(writes.length, 2);
    assert.equal(writes[0].args.p_nonce, writes[1].args.p_nonce);
    assert.equal(writes.every(call => call.args.p_room === "office"), true);
  } finally { ctx.close(); }
});
