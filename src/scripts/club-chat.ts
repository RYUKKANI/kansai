import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import { currentLocale, intlLocales, text as t } from "../lib/i18n";
import { node, roleLabels } from "../lib/admin-ui";
import type { ListController } from "./admin-list";
import "../styles/club-chat.css";

type Room = "players" | "office";
type Message = {
  id: string;
  sender_id: string;
  sender_name: string | null;
  sender_role: string;
  body: string;
  is_removed: boolean;
  created_at: string;
};
type Envelope = { user_id: string; room: Room };
const roomName = (room: Room) => t(room === "players" ? "選手チャット" : "統括・スタッフチャット");
const isRoom = (value: unknown): value is Room => value === "players" || value === "office";
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

// 실시간 이벤트에는 본문·작성자가 없습니다. 권한을 매번 확인하는 RPC만 실제 메시지를 읽습니다.
export function createClubChat(options: {
  client: SupabaseClient;
  userId: string;
  isCurrent: () => boolean;
}): ListController {
  const element = node("section", "", "club-chat");
  element.dataset.clubChat = "true";
  const toolbar = node("div", "", "club-chat-toolbar");
  const roomLabel = node("label", t("ルームを選択"), "club-chat-room-label");
  const roomSelect = node("select", "", "club-chat-room-select");
  roomSelect.setAttribute("aria-label", t("ルームを選択"));
  roomLabel.append(roomSelect);
  const reload = button(t("更新"), "club-chat-refresh");
  const connection = node("p", t("接続中…"), "club-chat-connection");
  connection.setAttribute("role", "status");
  toolbar.append(roomLabel, reload, connection);
  const roomTitle = node("h2", "", "club-chat-title");
  const help = node("p", t("個人の連絡先や健康情報、認証情報は投稿しないでください。"), "club-chat-help");
  const error = node("p", "", "club-chat-error");
  error.setAttribute("role", "alert");
  error.hidden = true;
  const older = button(t("過去のメッセージを表示"), "club-chat-older");
  older.hidden = true;
  const messages = node("ol", "", "club-chat-messages");
  messages.setAttribute("aria-label", t("メッセージ一覧"));
  messages.tabIndex = 0;
  const announcement = node("p", "", "club-chat-announcement");
  announcement.setAttribute("role", "status");
  const form = node("form", "", "club-chat-composer");
  const inputLabel = node("label", t("メッセージ"), "club-chat-input-label");
  const input = node("textarea", "", "club-chat-input");
  input.setAttribute("aria-label", t("メッセージ"));
  input.required = true;
  input.maxLength = 2000;
  input.rows = 3;
  input.autocomplete = "off";
  inputLabel.append(input);
  const send = button(t("送信"), "club-chat-send");
  send.type = "submit";
  const limit = node("span", "0 / 2,000", "club-chat-counter");
  const footer = node("div", "", "club-chat-composer-footer");
  footer.append(limit, send);
  form.append(inputLabel, footer);
  element.append(toolbar, roomTitle, help, error, older, messages, announcement, form, node("p", t("時刻は日本時間です。"), "club-chat-help"));

  let disposed = false;
  let blocked = false;
  let room: Room | null = null;
  let role = "";
  let rooms: Room[] = [];
  let epoch = 0;
  let refreshSequence = 0;
  let readSequence = 0;
  let sending = false;
  let loading = false;
  let readAgain = false;
  let hasMore = false;
  let confirmed = false;
  let entries: Message[] = [];
  let rendered = new Map<string, { entry: Message; element: HTMLLIElement }>();
  let pending: { room: Room; body: string; nonce: string } | null = null;
  let channel: RealtimeChannel | null = null;
  let invalidation: ReturnType<typeof setTimeout> | null = null;
  let authTimer: ReturnType<typeof setTimeout> | null = null;
  const current = () => !disposed && !blocked && options.isCurrent();
  const same = (version: number, target: Room) => current() && version === epoch && target === room;

  function button(label: string, className: string) {
    const result = node("button", label, className);
    result.type = "button";
    return result;
  }
  function showError(text: string) {
    error.textContent = text;
    error.hidden = !text;
  }
  function controls() {
    input.disabled = !confirmed || blocked;
    send.disabled = !confirmed || sending || blocked;
    send.textContent = t(sending ? "送信中…" : "送信");
    roomSelect.disabled = !rooms.length || sending || blocked;
    older.disabled = loading || sending || blocked;
    older.hidden = !hasMore;
    reload.disabled = blocked;
  }
  function leaveChannel() {
    const previous = channel;
    channel = null;
    if (invalidation !== null) clearTimeout(invalidation);
    invalidation = null;
    if (previous) void options.client.removeChannel(previous).catch(() => undefined);
  }
  function clearPrivate(keepDraft = false) {
    epoch++;
    readSequence++;
    confirmed = false;
    entries = [];
    rendered.clear();
    hasMore = false;
    loading = false;
    readAgain = false;
    sending = false;
    if (!keepDraft) {
      pending = null;
      input.value = "";
    }
    limit.textContent = `${input.value.length.toLocaleString("en-US")} / 2,000`;
    messages.replaceChildren();
    messages.removeAttribute("aria-busy");
    announcement.textContent = "";
    leaveChannel();
    controls();
  }
  function deny() {
    blocked = true;
    clearPrivate();
    room = null;
    rooms = [];
    role = "";
    roomSelect.replaceChildren();
    roomTitle.textContent = "";
    connection.textContent = "";
    showError(t("このチャットを利用する権限がありません。ページを再読み込みしてください。"));
    controls();
  }
  function forbidden(value: unknown) {
    const issue = record(value);
    return issue?.code === "42501" || issue?.code === "PGRST301" || issue?.code === "PGRST302" || issue?.status === 401 || issue?.status === 403;
  }
  function envelope(value: unknown, target: Room): Record<string, unknown> & Envelope {
    const data = record(value);
    if (!data || data.user_id !== options.userId || data.room !== target) throw new Error("invalid_response");
    return data as Record<string, unknown> & Envelope;
  }
  function parseMessage(value: unknown): Message {
    const data = record(value);
    if (!data || typeof data.id !== "string" || !/^\d+$/.test(data.id) || typeof data.sender_id !== "string"
      || (data.sender_name !== null && typeof data.sender_name !== "string") || typeof data.sender_role !== "string"
      || typeof data.body !== "string" || typeof data.is_removed !== "boolean" || typeof data.created_at !== "string"
      || !Number.isFinite(Date.parse(data.created_at))) throw new Error("invalid_response");
    return data as unknown as Message;
  }
  function timeLabel(value: string) {
    return new Intl.DateTimeFormat(intlLocales[currentLocale()], {
      timeZone: "Asia/Tokyo", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).format(new Date(value));
  }
  function renderMessages(scrollToEnd = false) {
    const scrollTop = messages.scrollTop;
    const scrollHeight = messages.scrollHeight;
    const atEnd = scrollHeight - scrollTop - messages.clientHeight < 80;
    const focused = messages.contains(document.activeElement) ? document.activeElement as HTMLElement | null : null;
    const next = new Map<string, { entry: Message; element: HTMLLIElement }>();
    const nodes = entries.map((entry) => {
      const previous = rendered.get(entry.id);
      // 일반 갱신은 같은 메시지의 폼·포커스를 유지합니다. 삭제 tombstone이나 내용 변경은
      // 새 노드로 교체하므로 확정 삭제된 본문과 작성 중인 삭제 사유가 화면에 남지 않습니다.
      if (previous && (Object.keys(entry) as (keyof Message)[]).every((key) => previous.entry[key] === entry[key])) {
        next.set(entry.id, previous);
        return previous.element;
      }
      const item = node("li", "", "club-chat-message");
      item.dataset.messageId = entry.id;
      item.dataset.own = String(entry.sender_id === options.userId);
      const meta = node("div", "", "club-chat-message-meta");
      meta.append(node("strong", entry.sender_name?.trim() || t("実名未確認の関係者")), node("span", roleLabels[entry.sender_role] ?? t("関係者")));
      const time = node("time", timeLabel(entry.created_at));
      time.dateTime = entry.created_at;
      meta.append(time);
      const body = node("p", entry.is_removed ? t("このメッセージは統括により削除されました。") : entry.body, "club-chat-message-body");
      if (entry.is_removed) item.dataset.removed = "true";
      item.append(meta, body);
      if (role === "owner" && !entry.is_removed) {
        const remove = button(t("メッセージを削除"), "club-chat-remove");
        remove.addEventListener("click", () => openRemoval(item, entry, remove));
        item.append(remove);
      }
      next.set(entry.id, { entry, element: item });
      return item;
    });
    rendered = next;
    messages.replaceChildren(...nodes);
    if (!entries.length) messages.append(node("li", t("まだメッセージはありません。"), "club-chat-empty"));
    if (focused?.isConnected) focused.focus({ preventScroll: true });
    if (scrollToEnd || atEnd) messages.scrollTop = messages.scrollHeight;
    else messages.scrollTop = scrollTop;
  }
  function openRemoval(item: HTMLLIElement, entry: Message, trigger: HTMLButtonElement) {
    if (!current() || role !== "owner" || !room || item.querySelector("form")) return;
    const target = room;
    const version = epoch;
    const removeForm = node("form", "", "club-chat-removal");
    const label = node("label", t("削除理由"));
    const reason = node("input");
    reason.required = true;
    reason.minLength = 5;
    reason.maxLength = 500;
    reason.setAttribute("aria-label", t("削除理由"));
    label.append(reason);
    const save = button(t("削除する"), "club-chat-remove-confirm");
    save.type = "submit";
    const cancel = button(t("キャンセル"), "club-chat-remove-cancel");
    cancel.addEventListener("click", () => { removeForm.remove(); trigger.hidden = false; trigger.focus(); });
    const status = node("p", "", "club-chat-error");
    status.setAttribute("role", "alert");
    removeForm.append(label, node("p", t("削除理由に個人の連絡先や認証情報を入力しないでください。"), "club-chat-help"), save, cancel, status);
    let busy = false;
    removeForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (busy || !same(version, target) || !removeForm.reportValidity() || reason.value.trim().length < 5) return;
      busy = true;
      save.disabled = true;
      cancel.disabled = true;
      try {
        const response = await options.client.rpc("office_chat_remove", { p_message_id: entry.id, p_reason: reason.value.trim() });
        if (!same(version, target)) return;
        if (response.error) throw response.error;
        const result = envelope(response.data, target);
        const removed = parseMessage(result.message);
        if (removed.id !== entry.id || !removed.is_removed) throw new Error("invalid_response");
        entries = entries.map((message) => message.id === removed.id ? removed : message);
        renderMessages();
      } catch (issue) {
        if (!same(version, target)) return;
        if (forbidden(issue)) { deny(); return; }
        status.textContent = t("削除できませんでした。再試行してください。");
      } finally {
        if (same(version, target)) { busy = false; save.disabled = false; cancel.disabled = false; }
      }
    });
    trigger.hidden = true;
    item.append(removeForm);
    reason.focus();
  }
  async function readMessages(appendOlder = false) {
    if (!current() || !room || (appendOlder && !hasMore)) return;
    // 바쁜 방에서도 진행 중인 여러 페이지 조회를 매 이벤트마다 취소하지 않습니다.
    // 조회 중 도착한 알림은 한 번 더 읽도록 합쳐 완성된 창을 차례로 표시합니다.
    if (loading) { if (!appendOlder) readAgain = true; return; }
    const target = room;
    const version = epoch;
    const sequence = ++readSequence;
    const before = appendOlder ? entries[0]?.id ?? null : null;
    const retainedPages = appendOlder ? 1 : Math.min(5, Math.max(1, Math.ceil(entries.length / 50)));
    loading = true;
    messages.setAttribute("aria-busy", "true");
    controls();
    try {
      let cursor = before;
      let page: Message[] = [];
      let more = false;
      // 펼쳐 놓은 과거 기록도 최대 5페이지까지 다시 읽습니다. 캐시를 단순 병합하지 않아
      // 오래된 페이지의 삭제를 반영하면서 정기 갱신 때 읽던 기록이 50개로 줄지 않습니다.
      for (let index = 0; index < retainedPages; index++) {
        const response = await options.client.rpc("office_chat_messages", { p_room: target, p_before: cursor });
        if (!same(version, target) || sequence !== readSequence) return;
        if (response.error) throw response.error;
        const data = envelope(response.data, target);
        if (!Array.isArray(data.messages) || data.messages.length > 50 || typeof data.has_more !== "boolean") throw new Error("invalid_response");
        const batch = data.messages.map(parseMessage);
        page = [...batch, ...page];
        more = data.has_more;
        if (!more || !batch.length) break;
        cursor = batch[0]!.id;
      }
      const previousLast = entries.at(-1)?.id;
      const previousHeight = messages.scrollHeight;
      const previousTop = messages.scrollTop;
      entries = appendOlder ? [...page, ...entries].filter((entry, index, all) => all.findIndex((candidate) => candidate.id === entry.id) === index).slice(-250) : page;
      hasMore = more && entries.length < 250;
      confirmed = true;
      renderMessages(!appendOlder && !previousLast);
      if (appendOlder) messages.scrollTop = previousTop + messages.scrollHeight - previousHeight;
      else if (previousLast && previousLast !== entries.at(-1)?.id) announcement.textContent = t("新しいメッセージがあります");
      showError("");
    } catch (issue) {
      if (!same(version, target) || sequence !== readSequence) return;
      if (forbidden(issue) || (issue instanceof Error && issue.message === "invalid_response")) { deny(); return; }
      confirmed = false;
      entries = [];
      rendered.clear();
      messages.replaceChildren();
      hasMore = false;
      showError(t("メッセージを取得できませんでした。再試行してください。"));
    } finally {
      if (same(version, target) && sequence === readSequence) {
        loading = false;
        messages.removeAttribute("aria-busy");
        controls();
        if (readAgain) { readAgain = false; void readMessages(); }
      }
    }
  }
  function subscribe(target: Room, version: number) {
    leaveChannel();
    connection.textContent = t("接続中…");
    try {
      channel = options.client.channel(`office-chat-${target}-${crypto.randomUUID()}`)
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "office_chat_events", filter: `room=eq.${target}` }, () => {
          if (!same(version, target) || invalidation !== null) return;
          invalidation = setTimeout(() => { invalidation = null; if (same(version, target)) void readMessages(); }, 120);
        })
        .subscribe((status) => {
          if (!same(version, target)) return;
          connection.textContent = t(status === "SUBSCRIBED" ? "リアルタイム接続中" : "再接続を待っています。定期的に更新します。");
          if (status === "SUBSCRIBED") void readMessages();
        });
    } catch {
      connection.textContent = t("再接続を待っています。定期的に更新します。");
    }
  }
  async function selectRoom(target: Room) {
    if (!current() || !rooms.includes(target)) return;
    clearPrivate();
    room = target;
    roomSelect.value = target;
    roomTitle.textContent = roomName(target);
    showError("");
    const version = epoch;
    await readMessages();
    if (same(version, target) && confirmed) subscribe(target, version);
  }
  async function refresh() {
    if (!current()) return;
    const version = ++refreshSequence;
    const previousEpoch = epoch;
    if (!room) messages.replaceChildren(node("li", t("チャットを読み込み中…"), "club-chat-empty"));
    try {
      const response = await options.client.rpc("office_chat_rooms");
      if (!current() || version !== refreshSequence || previousEpoch !== epoch) return;
      if (response.error) throw response.error;
      const data = record(response.data);
      if (!data || data.user_id !== options.userId || !["owner", "staff", "player"].includes(String(data.role)) || !Array.isArray(data.rooms)) throw new Error("invalid_response");
      const allowed = data.rooms.map((value) => record(value)?.id);
      if (allowed.some((value) => !isRoom(value)) || allowed.length > 2 || new Set(allowed).size !== allowed.length) throw new Error("invalid_response");
      if (allowed.some((value) => data.role !== "owner" && value !== (data.role === "player" ? "players" : "office"))) throw new Error("invalid_response");
      if (role && role !== data.role) clearPrivate();
      role = String(data.role);
      rooms = allowed as Room[];
      roomSelect.replaceChildren(...rooms.map((value) => {
        const option = node("option", roomName(value));
        option.value = value;
        return option;
      }));
      if (!rooms.length) { deny(); return; }
      if (!room || !rooms.includes(room)) await selectRoom(rooms[0]!);
      else {
        const target = room;
        roomSelect.value = target;
        await readMessages();
        if (current() && room === target && confirmed && !channel) subscribe(target, epoch);
      }
    } catch (issue) {
      if (!current() || version !== refreshSequence || previousEpoch !== epoch) return;
      if (forbidden(issue) || (issue instanceof Error && issue.message === "invalid_response")) { deny(); return; }
      clearPrivate(true);
      showError(t("チャットの利用状況を確認できませんでした。再試行してください。"));
      controls();
    }
  }
  roomSelect.addEventListener("change", () => { if (isRoom(roomSelect.value) && !sending) void selectRoom(roomSelect.value); });
  reload.addEventListener("click", () => { void refresh(); });
  older.addEventListener("click", () => { void readMessages(true); });
  input.addEventListener("input", () => { limit.textContent = `${input.value.length.toLocaleString("en-US")} / 2,000`; });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!current() || !room || sending || !confirmed || !form.reportValidity()) return;
    const body = input.value.trim();
    if (!body || Array.from(body).length > 2000) { showError(t("メッセージは2,000文字以内で入力してください。")); return; }
    const target = room;
    const version = epoch;
    // 응답이 유실되어도 같은 내용의 재전송은 같은 nonce를 사용해 서버에서 중복 저장을 막습니다.
    if (!pending || pending.room !== target || pending.body !== body) pending = { room: target, body, nonce: crypto.randomUUID() };
    const attempt = pending;
    sending = true;
    showError("");
    controls();
    try {
      const response = await options.client.rpc("office_chat_send", { p_room: target, p_body: body, p_nonce: attempt.nonce });
      if (!same(version, target)) return;
      if (response.error) throw response.error;
      const result = envelope(response.data, target);
      const sent = parseMessage(result.message);
      if (sent.sender_id !== options.userId) throw new Error("invalid_response");
      pending = null;
      if (input.value.trim() === body) { input.value = ""; limit.textContent = "0 / 2,000"; }
      entries = [...entries.filter((entry) => entry.id !== sent.id), sent]
        .sort((left, right) => BigInt(left.id) < BigInt(right.id) ? -1 : BigInt(left.id) > BigInt(right.id) ? 1 : 0)
        .slice(-250);
      renderMessages(true);
      input.focus();
    } catch (issue) {
      if (!same(version, target)) return;
      if (forbidden(issue)) { deny(); return; }
      if (issue instanceof Error && issue.message === "invalid_response") { deny(); return; }
      showError(t("送信できませんでした。入力内容を残しています。再試行してください。"));
    } finally {
      if (same(version, target)) { sending = false; controls(); }
    }
  });
  // 연결이 끊겨도 상태를 재검사합니다. 브라우저 복귀 시 기존 역할을 신뢰하지 않습니다.
  const timer = setInterval(() => { if (current() && document.visibilityState !== "hidden" && !sending && !loading) void refresh(); }, 20_000);
  const visible = () => { if (document.visibilityState !== "hidden" && current()) void refresh(); };
  document.addEventListener("visibilitychange", visible);
  const auth = options.client.auth?.onAuthStateChange((event, session) => {
    if (disposed) return;
    if (event === "SIGNED_OUT" || (session && session.user.id !== options.userId)) { deny(); return; }
    if (event === "TOKEN_REFRESHED" && current()) {
      if (authTimer !== null) clearTimeout(authTimer);
      authTimer = setTimeout(() => { authTimer = null; if (current()) void refresh(); }, 0);
    }
  });
  controls();
  return {
    element, refresh,
    dispose() {
      disposed = true;
      refreshSequence++;
      clearInterval(timer);
      if (authTimer !== null) clearTimeout(authTimer);
      document.removeEventListener("visibilitychange", visible);
      auth?.data.subscription.unsubscribe();
      clearPrivate();
      rooms = [];
      room = null;
      role = "";
      element.replaceChildren();
    },
  };
}
