import {
  currentLocale,
  text,
  languageCodes,
  languageUrl,
  isLocale,
  localizedPage,
} from "../lib/i18n";
// 언어 선택은 실제 링크로 동작합니다. JavaScript가 없어도 공개 번역 페이지로 이동할 수 있습니다.
export function initLanguageSwitcher(admin = false) {
  const locale = currentLocale();
  try {
    localStorage.setItem("kansai-language", locale);
  } catch {}
  if (admin) {
    document.documentElement.lang = locale;
    document.querySelectorAll<HTMLElement>("[data-i18n]").forEach((element) => {
      element.textContent = text(element.dataset.i18n ?? "");
    });
    for (const attribute of ["aria-label", "placeholder", "title"]) {
      document
        .querySelectorAll<HTMLElement>("[data-i18n-" + attribute + "]")
        .forEach((element) => {
          element.setAttribute(
            attribute,
            text(element.getAttribute("data-i18n-" + attribute) ?? ""),
          );
        });
    }
    const publicLink = document.querySelector<HTMLAnchorElement>(
      ".office-public-link",
    );
    if (publicLink) publicLink.href = localizedPage("", locale);
  }
  const selectors =
    document.querySelectorAll<HTMLDetailsElement>(".language-switcher");
  selectors.forEach((selector) => {
    const summary = selector.querySelector<HTMLElement>(
      "[data-language-summary]",
    );
    summary?.setAttribute("aria-label", text("表示言語を選択"));
    selector
      .querySelector("[data-language-menu]")
      ?.setAttribute("aria-label", text("表示言語"));
    const code = selector.querySelector("[data-language-current]");
    if (code) code.textContent = languageCodes[locale];
    selector
      .querySelectorAll<HTMLAnchorElement>("[data-language]")
      .forEach((link) => {
        const target = link.dataset.language;
        if (!isLocale(target)) return;
        link.href = languageUrl(new URL(window.location.href), target);
        if (target === locale) link.setAttribute("aria-current", "true");
        else link.removeAttribute("aria-current");
        link.addEventListener("click", () => {
          try {
            localStorage.setItem("kansai-language", target);
          } catch {}
          // 인증 콜백의 토큰은 다른 링크로 복사하지 않습니다. 공개 페이지의 섹션 위치만 유지합니다.
          if (!admin) link.hash = window.location.hash;
        });
      });
    selector.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        selector.open = false;
        summary?.focus();
      }
    });
    document.addEventListener("click", (event) => {
      if (event.target instanceof Node && !selector.contains(event.target))
        selector.open = false;
    });
  });
}
