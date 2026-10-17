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
  const select = () => controller.element.querySelector("select");
  const composer = () => controller.element.querySelector("textarea");
  const submit = () => composer()?.form?.querySelector('[type="submit"]');
  return { dom, window, controller, calls, channels, removed, select, composer, submit,
    unsubscribed: () => unsubscribed,
    choose(room) { select().value = room; select().dispatchEvent(new window.Event("change", { bubbles: true })); },
    write(body) { composer().value = body; composer().dispatchEvent(new window.Event("input", { bubbles: true })); },
    send() { composer().form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); },
    emit(event, session) { authListener?.(event, session); },
    invalidate() { active = false; },
    close() { controller.dispose(); window.close(); },
  };
}

for (const [role, rooms] of [["owner", ["players", "office"]], ["staff", ["office"]], ["player", ["players"]]]) {
  test(`${role} sees only their permitted chat rooms and does not issue hidden-room queries`, async () => {
    const ctx = app({ role });
    try {
      await ctx.controller.refresh();
      assert.deepEqual([...ctx.select().options].map(option => option.value).filter(Boolean), rooms);
      assert.equal(ctx.calls.filter(call => call.name === "office_chat_messages").every(call => rooms.includes(call.args.p_room)), true);
      if (role !== "owner") {
        const forbidden = role === "staff" ? "players" : "office";
        const forged = ctx.window.document.createElement("option"); forged.value = forbidden;
        ctx.select().append(forged); ctx.choose(forbidden);
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
      await ctx.controller.refresh(); ctx.write("PRIVATE UNSENT DRAFT"); hold = true;
      const pending = ctx.controller.refresh();
      await until(() => ctx.calls.filter(call => call.name === "office_chat_messages").length === 2);
      ctx.emit(event === "SIGNED_OUT" ? "SIGNED_OUT" : "SIGNED_IN", event === "SIGNED_OUT" ? null : { user: { id: otherId } });
      late.resolve({ data: { user_id: userId, room: "players", messages: [message("LATE PRIVATE ACCOUNT")], has_more: false }, error: null });
      await pending;
      for (const secret of ["PRIVATE ACTIVE ACCOUNT", "PRIVATE UNSENT DRAFT", "LATE PRIVATE ACCOUNT"])
        assert.equal(ctx.controller.element.textContent.includes(secret), false);
      assert.ok(!ctx.composer() || ctx.composer().value === "");
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
    ctx.controller.element.querySelector(".club-chat-remove").click();
    const form = ctx.controller.element.querySelector(".club-chat-removal");
    form.querySelector("input").value = "Club moderation policy";
    const submit = () => form.dispatchEvent(new ctx.window.Event("submit", { bubbles: true, cancelable: true }));
    submit(); submit();
    assert.equal(ctx.calls.filter(call => call.name === "office_chat_remove").length, 1);
    assert.ok(ctx.controller.element.textContent.includes("Player private discussion"));
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
    assert.equal(ctx.select().value, "office");
    assert.equal(ctx.composer().value, "Office draft whose delivery is uncertain");
    ctx.send(); await until(() => ctx.composer().value === "");
    const writes = ctx.calls.filter(call => call.name === "office_chat_send");
    assert.equal(writes.length, 2);
    assert.equal(writes[0].args.p_nonce, writes[1].args.p_nonce);
    assert.equal(writes.every(call => call.args.p_room === "office"), true);
  } finally { ctx.close(); }
});
