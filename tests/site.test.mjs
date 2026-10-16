import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { JSDOM } from "jsdom";
import { browserScript } from "./helpers/browser-script.mjs";
// 빌드된 실제 HTML·스크립트를 검사합니다. 화면 배치는 별도의 브라우저 검증 대상입니다.
const root = process.cwd();
const file = async (name) => readFile(path.join(root, "dist", name), "utf8");
function dialogSupport(window) {
  window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  window.matchMedia = () => ({ matches: false, addEventListener() {} });
}
async function interactive(name, url = "https://kansaiunited.com/") {
  const html = await file(name);
  const dom = new JSDOM(html, {
    url,
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  dialogSupport(dom.window);
  for (const script of dom.window.document.querySelectorAll("script")) {
    const code = script.src
      ? await browserScript(
          path.join(
            root,
            "dist",
            new URL(script.src).pathname.replace(/^\//, ""),
          ),
        )
      : script.textContent;
    if (code) dom.window.eval(code);
  }
  return dom;
}
test("existing articles and independent page links stay valid", async () => {
  const pages = [
    "index.html",
    "news/index.html",
    "news/attacking-training/index.html",
    "news/defending-training/index.html",
    "news/join-united/index.html",
    "team/index.html",
    "matches/index.html",
    "media/index.html",
    "club/index.html",
    "join/index.html",
    "admin/index.html",
  ];
  for (const page of pages) {
    const dom = new JSDOM(await file(page), {
      url: new URL(page.replace(/index\.html$/, ""), "https://kansaiunited.com/"),
    });
    const { document } = dom.window;
    assert.equal(document.documentElement.lang, "ja");
    assert.equal(
      document.querySelectorAll("h1").length,
      page === "admin/index.html" ? 2 : 1,
    );
    if (page !== "admin/index.html")
      assert.ok(!/design preview/i.test(document.body.textContent));
    // 독립 도메인의 루트 경로에서 메뉴와 로컬 자산이 실제 배포 파일로 연결되는지 확인합니다.
    for (const link of document.querySelectorAll('a[href^="/"]')) {
      const url = new URL(link.href);
      if (url.origin !== "https://kansaiunited.com") continue;
      assert.ok(!url.pathname.startsWith("/kansai/"), link.href);
      const destination = path.join(
        root,
        "dist",
        url.pathname.replace(/^\//, ""),
        "index.html",
      );
      await readFile(destination);
    }
    for (const asset of document.querySelectorAll(
      'img[src],script[src],link[rel="stylesheet"][href]',
    )) {
      const url = new URL(asset.src ?? asset.href);
      if (url.origin !== "https://kansaiunited.com") continue;
      assert.ok(!url.pathname.startsWith("/kansai/"), url.href);
      await readFile(path.join(root, "dist", url.pathname.replace(/^\//, "")));
    }
    dom.window.close();
  }
  assert.equal(
    new JSDOM(await file("team/index.html")).window.document.querySelectorAll(
      ".squad-card",
    ).length,
    0,
  );
  assert.equal(
    new JSDOM(
      await file("matches/index.html"),
    ).window.document.querySelectorAll(".fixture-teams").length,
    0,
  );
});
test("menu, normalized search, filters, keyboard tabs and photo expansion work together", async () => {
  const dom = await interactive("index.html");
  const { document, KeyboardEvent, Event } = dom.window;
  document.querySelector(".mobile-menu-toggle").click();
  assert.equal(document.querySelector("#mobile-navigation").hidden, false);
  document.querySelector(".search-open").click();
  assert.equal(document.querySelector("#mobile-navigation").hidden, true);
  assert.equal(document.querySelector(".search-dialog").open, true);
  const search = document.querySelector("#news-search");
  search.value = "ＴＲＡＩＮＩＮＧ";
  search.dispatchEvent(new Event("input"));
  assert.equal(
    [...document.querySelectorAll("[data-search-text]")].filter(
      (e) => !e.hidden,
    ).length,
    2,
  );
  search.value = "no-such-story";
  search.dispatchEvent(new Event("input"));
  assert.equal(document.querySelector(".search-empty").hidden, false);
  const news = document.querySelector("[data-filter-group]");
  news.querySelector('[data-filter="club"]').click();
  assert.equal(
    [...news.querySelectorAll("[data-category]")].filter((e) => !e.hidden)
      .length,
    1,
  );
  document
    .querySelector("#photo-tab")
    .dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
  assert.equal(document.querySelector("#photo-panel").hidden, true);
  assert.equal(document.querySelector("#video-panel").hidden, false);
  document.querySelector("#photo-tab").click();
  const photo = document.querySelector("[data-lightbox]");
  photo.click();
  assert.equal(document.querySelector(".photo-dialog").open, true);
  assert.equal(
    document.querySelector("#lightbox-image").src,
    new URL(photo.dataset.image, dom.window.location.href).href,
  );
  assert.equal(
    document.querySelector("#lightbox-image").alt,
    photo.dataset.alt,
  );
  document.querySelector(".photo-dialog [data-close-dialog]").click();
  assert.equal(document.querySelector(".photo-dialog").open, false);
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  assert.equal(document.querySelector("#mobile-navigation").hidden, true);
  dom.window.close();
});

test("Escape from an open mobile navigation restores focus to its toggle in all three languages", async () => {
  for (const locale of ["ja", "ko", "en"]) {
    const prefix = locale === "ja" ? "" : locale + "/";
    const dom = await interactive(prefix + "index.html", "https://kansaiunited.com/" + prefix);
    try {
      const { document, KeyboardEvent } = dom.window;
      const toggle = document.querySelector(".mobile-menu-toggle");
      const navigation = document.querySelector("#mobile-navigation");
      const link = navigation.querySelector("a");
      toggle.focus();
      toggle.click();
      link.focus();
      assert.equal(document.activeElement, link);
      link.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      assert.equal(navigation.hidden, true);
      assert.equal(toggle.getAttribute("aria-expanded"), "false");
      assert.equal(document.activeElement, toggle);
    } finally { dom.window.close(); }
  }
});

test("closing mobile navigation for a link or search preserves the destination focus", async () => {
  const dom = await interactive("index.html");
  try {
    const { document } = dom.window;
    const toggle = document.querySelector(".mobile-menu-toggle");
    const navigation = document.querySelector("#mobile-navigation");
    const link = navigation.querySelector("a");
    toggle.click();
    link.focus();
    // 문서 이동만 막아 메뉴 닫기 자체가 포커스를 가로채는지 검사합니다.
    link.addEventListener("click", event => event.preventDefault(), { once: true });
    link.click();
    assert.equal(navigation.hidden, true);
    assert.equal(document.activeElement, link);
    toggle.click();
    link.focus();
    document.querySelector(".search-open").click();
    assert.equal(navigation.hidden, true);
    assert.equal(document.querySelector(".search-dialog").open, true);
    assert.equal(document.activeElement, document.querySelector("#news-search"));
  } finally { dom.window.close(); }
});

test("Escape in another dialog or with the mobile menu already closed does not redirect focus", async () => {
  const dom = await interactive("index.html");
  try {
    const { document, KeyboardEvent } = dom.window;
    const toggle = document.querySelector(".mobile-menu-toggle");
    const navigation = document.querySelector("#mobile-navigation");
    toggle.click();
    document.querySelector("[data-lightbox]").click();
    const dialogButton = document.querySelector(".photo-dialog [data-close-dialog]");
    dialogButton.focus();
    assert.equal(document.querySelector(".photo-dialog").open, true);
    dialogButton.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.equal(navigation.hidden, true);
    assert.equal(document.activeElement, dialogButton);
    dialogButton.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    assert.equal(document.activeElement, dialogButton);
  } finally { dom.window.close(); }
});

test("home keeps all three match cards visible and announces undetermined fixtures", async () => {
  const dom = new JSDOM(await file("index.html"));
  try {
    const section = dom.window.document.querySelector("#matches");
    assert.equal(section.querySelectorAll(".match-summary").length, 3);
    assert.equal(section.querySelectorAll('[role="tabpanel"]').length, 0);
    for (const kind of ["next", "upcoming"]) {
      const card = section.querySelector('[data-match-slot="' + kind + '"]');
      assert.ok(card.textContent.includes("現在、公開中の試合日程はありません。"));
      assert.equal(card.querySelector("time"), null);
      assert.ok(
        card.querySelector('a[href="/matches/#schedule-panel"]'),
      );
    }
    assert.ok(
      section
        .querySelector('[data-match-slot="last"]')
        .textContent.includes("現在、公開中の試合結果はありません。"),
    );
  } finally {
    dom.window.close();
  }
});

test("result links open the results tab without changing unrelated tabs", async () => {
  const dom = await interactive(
    "matches/index.html",
    "https://kansaiunited.com/matches/#results-panel",
  );
  try {
    const document = dom.window.document;
    assert.equal(
      document.querySelector("#results-tab").getAttribute("aria-selected"),
      "true",
    );
    assert.equal(document.querySelector("#results-panel").hidden, false);
    assert.equal(document.querySelector("#schedule-panel").hidden, true);
    document.querySelector("#schedule-tab").click();
    assert.equal(document.querySelector("#schedule-panel").hidden, false);
  } finally {
    dom.window.close();
  }
});
test("offline export contains local images, styles and independent page links", async () => {
  const html = await readFile(path.join(root, "preview", "index.html"), "utf8");
  const dom = new JSDOM(html);
  const document = dom.window.document;
  assert.equal(document.querySelectorAll('link[rel="stylesheet"]').length, 0);
  assert.ok(
    [...document.querySelectorAll("img[src]")].every((image) =>
      image.src.startsWith("data:"),
    ),
  );
  assert.ok(document.querySelector('a[href="team/index.html"]'));
  assert.ok(document.querySelector('a[href="join/index.html"]'));
  const admin = await readFile(
    path.join(root, "preview", "admin", "index.html"),
    "utf8",
  );
  assert.ok(!/<script[^>]+src=/.test(admin));
  assert.ok(!/sb_secret_[A-Za-z0-9_-]{20,}/.test(admin));
  assert.ok(!/\/github-auth\//.test(admin));
  dom.window.close();
});
