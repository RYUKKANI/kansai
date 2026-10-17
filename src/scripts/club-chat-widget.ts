import type { SupabaseClient } from "@supabase/supabase-js";
import { text as t } from "../lib/i18n";
import { icon, node } from "../lib/admin-ui";
import { createClubChat, type ClubChatController } from "./club-chat";
import "../styles/club-chat-widget.css";

// 업무 페이지 수명주기와 분리된 작은 채팅 창입니다. 최소화·메뉴 이동은 입력을 보존하고,
// 계정·역할을 바꾸는 호출자는 반드시 dispose하여 이전 계정의 DOM·구독을 폐기합니다.
export function createClubChatWidget(options: {
  client: SupabaseClient;
  userId: string;
  isCurrent: () => boolean;
}) {
  const element = node("aside", "", "club-chat-widget");
  element.dataset.open = "false";
  const launcher = node("button", "", "club-chat-launcher");
  launcher.type = "button";
  launcher.setAttribute("aria-label", t("チームチャット"));
  launcher.title = t("チームチャット");
  launcher.setAttribute("aria-controls", "club-chat-widget-panel");
  launcher.setAttribute("aria-haspopup", "dialog");
  launcher.setAttribute("aria-expanded", "false");
  const bubble = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [key, value] of Object.entries({ viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.8", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false" })) bubble.setAttribute(key, value);
  const path = document.createElementNS(bubble.namespaceURI, "path");
  path.setAttribute("d", "M21 11.5a8.5 8.5 0 0 1-8.5 8.5H5l-4 3 1.8-6A8.5 8.5 0 1 1 21 11.5Z");
  path.setAttribute("fill", "currentColor");
  path.setAttribute("stroke", "none");
  bubble.append(path);
  for (const x of [7, 12, 17]) {
    const dot = document.createElementNS(bubble.namespaceURI, "circle");
    dot.setAttribute("cx", String(x));
    dot.setAttribute("cy", "11");
    dot.setAttribute("r", "1.15");
    dot.setAttribute("fill", "#93bde2");
    dot.setAttribute("stroke", "none");
    bubble.append(dot);
  }
  launcher.append(bubble);
  const panel = node("section", "", "club-chat-widget-panel");
  panel.id = "club-chat-widget-panel";
  panel.hidden = true;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "false");
  panel.setAttribute("aria-labelledby", "club-chat-widget-title");
  const toolbar = node("header", "", "club-chat-widget-toolbar");
  const title = node("h2", t("チームチャット"));
  title.id = "club-chat-widget-title";
  const closeButton = node("button", "", "club-chat-widget-close");
  closeButton.type = "button";
  closeButton.setAttribute("aria-label", t("閉じる"));
  closeButton.title = t("閉じる");
  closeButton.append(icon("close"));
  toolbar.append(title, closeButton);
  const body = node("div", "", "club-chat-widget-body");
  panel.append(toolbar, body);
  element.append(panel, launcher);
  let disposed = false;
  let controller: ClubChatController | null = null;
  const current = () => !disposed && options.isCurrent();
  function open() {
    if (!current()) return;
    panel.hidden = false;
    element.dataset.open = "true";
    launcher.setAttribute("aria-expanded", "true");
    // 첫 클릭 전에는 방·메시지 RPC, Realtime 구독, 채팅 타이머를 만들지 않습니다.
    if (!controller) {
      controller = createClubChat({ ...options, isCurrent: current, widget: true });
      body.append(controller.element);
    }
    controller.setVisible(true);
    void controller.refresh();
    closeButton.focus({ preventScroll: true });
  }
  function close() {
    if (disposed) return;
    controller?.setVisible(false);
    panel.hidden = true;
    element.dataset.open = "false";
    launcher.setAttribute("aria-expanded", "false");
    launcher.focus({ preventScroll: true });
  }
  launcher.addEventListener("click", () => { if (element.dataset.open === "true") close(); else open(); });
  closeButton.addEventListener("click", close);
  panel.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    close();
  });
  const viewport = window.visualViewport;
  const fitViewport = () => {
    const height = viewport?.height ?? window.innerHeight;
    element.style.setProperty("--club-chat-widget-viewport-height", `${height}px`);
    element.style.setProperty("--club-chat-widget-viewport-width", `${viewport?.width ?? window.innerWidth}px`);
    element.style.setProperty("--club-chat-widget-viewport-top", `${viewport?.offsetTop ?? 0}px`);
    element.style.setProperty("--club-chat-widget-top-safe", `${Math.max(0, document.querySelector(".admin-header")?.getBoundingClientRect().bottom ?? 0)}px`);
    element.dataset.compact = String(height < 520);
  };
  fitViewport();
  viewport?.addEventListener("resize", fitViewport);
  viewport?.addEventListener("scroll", fitViewport);
  window.addEventListener("resize", fitViewport);
  return {
    element, open, close,
    dispose() {
      if (disposed) return;
      disposed = true;
      controller?.dispose();
      controller = null;
      viewport?.removeEventListener("resize", fitViewport);
      viewport?.removeEventListener("scroll", fitViewport);
      window.removeEventListener("resize", fitViewport);
      element.replaceChildren();
      element.remove();
    },
  };
}
