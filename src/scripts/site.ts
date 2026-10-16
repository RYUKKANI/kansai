import { publicText as t, publicFormat as format } from "../lib/public-i18n";
import { initLanguageSwitcher } from "./languages";
// [편집 안내] 메뉴 → 뉴스 필터 → 탭 → 검색 → 사진 확대 → 대화상자 순서입니다.
// 화면 문구는 Astro 파일에서, 버튼·패널을 연결하는 동작은 이 파일에서 편집합니다.

function initMobileMenu() {
  const button = document.querySelector<HTMLButtonElement>(
    ".mobile-menu-toggle",
  );
  const navigation = document.querySelector<HTMLElement>("#mobile-navigation");

  function setMenuOpen(open: boolean) {
    button?.setAttribute("aria-expanded", String(open));
    button?.setAttribute(
      "aria-label",
      open ? t("メニューを閉じる") : t("メニューを開く"),
    );
    if (navigation) navigation.hidden = !open;
  }

  const closeMenu = () => setMenuOpen(false);
  button?.addEventListener("click", () => {
    setMenuOpen(button.getAttribute("aria-expanded") !== "true");
  });
  navigation
    ?.querySelectorAll("a")
    .forEach((link) => link.addEventListener("click", closeMenu));
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    // Escape로 숨길 메뉴 안에 포커스가 있을 때만 여는 버튼으로 돌려보냅니다.
    // 링크 이동·검색·다른 대화상자의 포커스는 각 동작이 관리하도록 유지합니다.
    const restoreFocus = button?.getAttribute("aria-expanded") === "true" &&
      navigation?.contains(document.activeElement);
    closeMenu();
    if (restoreFocus) button?.focus();
  });

  // CSS의 1024px 모바일 구간을 벗어나면 열린 메뉴를 닫습니다.
  window
    .matchMedia("(min-width: 1025px)")
    .addEventListener("change", (event) => {
      if (event.matches) closeMenu();
    });
  return closeMenu;
}

function initNewsFilters() {
  document
    .querySelectorAll<HTMLElement>("[data-filter-group]")
    .forEach((group) => {
      const buttons =
        group.querySelectorAll<HTMLButtonElement>("[data-filter]");
      const cards = group.querySelectorAll<HTMLElement>("[data-category]");
      // 버튼을 누를 때마다 찾지 않도록 카운터도 처음에 한 번만 조회합니다.
      const counter = group.querySelector<HTMLElement>("[data-news-count]");

      buttons.forEach((button) =>
        button.addEventListener("click", () => {
          const category = button.dataset.filter;
          let count = 0;
          cards.forEach((card) => {
            card.hidden =
              category !== "all" && card.dataset.category !== category;
            if (!card.hidden) count++;
          });
          buttons.forEach((item) =>
            item.setAttribute("aria-pressed", String(item === button)),
          );
          if (counter)
            counter.textContent = format(
              count === 1 ? "{0} STORY" : "{0} STORIES",
              count,
            );
        }),
      );
    });
}

function initTabs() {
  document.querySelectorAll<HTMLElement>("[data-tabs]").forEach((group) => {
    // 패널은 현재 탭 그룹 안에서만 연결합니다. 경기·미디어 탭이 서로 영향을 주지 않습니다.
    const tabs = Array.from(
      group.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    );
    const groupPanels = Array.from(
      group.querySelectorAll<HTMLElement>('[role="tabpanel"]'),
    );
    const panels = tabs.map((tab) => {
      const id = tab.getAttribute("aria-controls");
      return groupPanels.find((panel) => panel.id === id);
    });

    function selectTab(selected: HTMLButtonElement) {
      tabs.forEach((tab, index) => {
        const active = tab === selected;
        tab.setAttribute("aria-selected", String(active));
        tab.tabIndex = active ? 0 : -1;
        const panel = panels[index];
        if (panel) panel.hidden = !active;
      });
    }

    // 홈의 경기 카드에서 결과·리포트로 이동하면 해당 탭과 접힌 리포트를 바로 엽니다.
    function selectLinkedPanel() {
      const target = document.getElementById(window.location.hash.slice(1));
      if (!target) return;
      const index = panels.findIndex((panel) => panel?.contains(target));
      if (index < 0 || !tabs[index]) return;
      selectTab(tabs[index]);
      const report = target.closest<HTMLDetailsElement>("details");
      if (report) report.open = true;
      requestAnimationFrame(() => target.scrollIntoView?.({ block: "start" }));
    }
    selectLinkedPanel();
    window.addEventListener("hashchange", selectLinkedPanel);

    tabs.forEach((tab, index) => {
      tab.addEventListener("click", () => selectTab(tab));
      // 마우스 없이도 좌우 방향키·Home·End로 이동할 수 있게 유지합니다.
      tab.addEventListener("keydown", (event) => {
        let nextIndex: number | undefined;
        if (event.key === "ArrowRight") nextIndex = (index + 1) % tabs.length;
        if (event.key === "ArrowLeft")
          nextIndex = (index - 1 + tabs.length) % tabs.length;
        if (event.key === "Home") nextIndex = 0;
        if (event.key === "End") nextIndex = tabs.length - 1;
        if (nextIndex === undefined) return;

        event.preventDefault();
        const next = tabs[nextIndex];
        if (next) {
          selectTab(next);
          next.focus();
        }
      });
    });
  });
}

// 전각·반각 차이와 영문 대소문자를 통일해 일본어 검색 결과가 흔들리지 않게 합니다.
function normalizeSearchText(value: string): string {
  return value.toLocaleLowerCase("ja").normalize("NFKC");
}

function initSearch(closeMenu: () => void) {
  const dialog = document.querySelector<HTMLDialogElement>(".search-dialog");
  const input = dialog?.querySelector<HTMLInputElement>("#news-search");
  const empty = dialog?.querySelector<HTMLElement>(".search-empty");
  if (!dialog || !input) return;

  // 기사 본문 검색어는 입력 때마다 변환하지 않고 한 번만 정규화해 보관합니다.
  const results = Array.from(
    dialog.querySelectorAll<HTMLAnchorElement>("[data-search-text]"),
  ).map((element) => ({
    element,
    text: normalizeSearchText(element.dataset.searchText ?? ""),
  }));

  document
    .querySelectorAll<HTMLButtonElement>(".search-open")
    .forEach((button) => {
      button.addEventListener("click", () => {
        closeMenu();
        if (!dialog.open) dialog.showModal();
        input.focus();
      });
    });

  input.addEventListener("input", () => {
    const query = normalizeSearchText(input.value.trim());
    let count = 0;
    results.forEach(({ element, text }) => {
      element.hidden = !text.includes(query);
      if (!element.hidden) count++;
    });
    if (empty) empty.hidden = count > 0;
  });
}

function initLightbox() {
  const dialog = document.querySelector<HTMLDialogElement>(".photo-dialog");
  const image = dialog?.querySelector<HTMLImageElement>("#lightbox-image");
  const caption = dialog?.querySelector<HTMLElement>("#lightbox-caption");
  const source = dialog?.querySelector<HTMLAnchorElement>("#lightbox-source");
  if (!dialog || !image) return;

  document
    .querySelectorAll<HTMLButtonElement>("[data-lightbox]")
    .forEach((button) => {
      button.addEventListener("click", () => {
        if (!button.dataset.image) return;
        // 원본 사진은 확대 버튼을 누르는 시점에만 읽습니다.
        image.src = button.dataset.image;
        image.parentElement?.classList.toggle(
          "photo-natural",
          button.dataset.natural === "true",
        );
        image.alt = button.dataset.alt ?? t("関西ユナイテッドFCの活動写真");
        if (caption) caption.textContent = button.dataset.caption ?? "";
        if (source) {
          source.hidden = !button.dataset.source;
          source.href = button.dataset.source ?? "#";
        }
        if (!dialog.open) dialog.showModal();
      });
    });
}

function initDialogs() {
  document.querySelectorAll<HTMLDialogElement>("dialog").forEach((dialog) => {
    dialog
      .querySelectorAll<HTMLButtonElement>("[data-close-dialog]")
      .forEach((button) => {
        button.addEventListener("click", () => dialog.close());
      });
    // 사진·내용을 눌렀을 때는 유지하고, 대화상자 바깥 배경을 눌렀을 때만 닫습니다.
    dialog.addEventListener("click", (event) => {
      if (event.target !== dialog) return;
      const bounds = dialog.getBoundingClientRect();
      const outside =
        event.clientX < bounds.left ||
        event.clientX > bounds.right ||
        event.clientY < bounds.top ||
        event.clientY > bounds.bottom;
      if (outside) dialog.close();
    });
  });
}

// 저장된 URL 전체를 삽입하지 않고 검증한 YouTube ID로만 플레이어를 만듭니다.
function initVideos() {
  document
    .querySelectorAll<HTMLButtonElement>("[data-video-open]")
    .forEach((button) => {
      button.addEventListener("click", () => {
        const id = button.dataset.videoOpen ?? "";
        const container =
          button.parentElement?.querySelector<HTMLElement>(".video-embed");
        if (!container || !/^[A-Za-z0-9_-]{11}$/.test(id)) return;
        const frame = document.createElement("iframe");
        frame.src = "https://www.youtube-nocookie.com/embed/" + id;
        frame.title = button.dataset.videoTitle ?? t("公式動画");
        frame.allowFullscreen = true;
        frame.allow = "encrypted-media; picture-in-picture";
        frame.referrerPolicy = "strict-origin-when-cross-origin";
        container.replaceChildren(frame);
        container.hidden = false;
        button.hidden = true;
      });
    });
}

// 정적 페이지마다 한 번 실행합니다. 기능별 초기화가 있어 필요한 부분만 찾아 수정할 수 있습니다.
initLanguageSwitcher();
const closeMenu = initMobileMenu();
initNewsFilters();
initTabs();
initSearch(closeMenu);
initLightbox();
initDialogs();
initVideos();
