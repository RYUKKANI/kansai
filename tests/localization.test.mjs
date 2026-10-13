import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { JSDOM } from "jsdom";
import { build } from "esbuild";
import { app, login, eventually } from "./helpers/admin-app.mjs";
import { browserScript } from "./helpers/browser-script.mjs";

// 실제 정적 번역 페이지·SDK를 검사합니다. 운영 DB에 번역·테스트 콘텐츠를 쓰지 않습니다.
const pages = [
  "",
  "news",
  "team",
  "matches",
  "media",
  "club",
  "join",
  "news/attacking-training",
  "news/defending-training",
  "news/join-united",
];
const read = (relative) =>
  readFile(path.join("dist", relative, "index.html"), "utf8");
test("three languages retain all published pages, internal links and equivalent SEO URLs", async () => {
  for (const locale of ["ja", "ko", "en"]) {
    for (const page of pages) {
      const relative = (locale === "ja" ? "" : locale + "/") + page;
      const dom = new JSDOM(await read(relative), {
        url: "https://ryukkani.github.io/kansai/" + relative + "/",
      });
      const doc = dom.window.document;
      assert.equal(doc.documentElement.lang, locale);
      assert.equal(doc.querySelectorAll("h1").length, 1);
      assert.ok(
        doc
          .querySelector("link[rel=canonical]")
          .href.includes("/kansai/" + relative),
      );
      for (const target of ["ja", "ko", "en"]) {
        const expected =
          "https://ryukkani.github.io/kansai/" +
          (target === "ja" ? "" : target + "/") +
          (page ? page + "/" : "");
        assert.equal(
          doc.querySelector('link[hreflang="' + target + '"]').href,
          expected,
        );
        assert.equal(
          doc.querySelector(
            '.language-options [data-language="' + target + '"]',
          ).href,
          expected,
        );
      }
      for (const link of doc.querySelectorAll('a[href^="/kansai/"]')) {
        const url = new URL(link.href);
        const destination = url.pathname.replace("/kansai/", "");
        await readFile(path.join("dist", destination, "index.html"));
        if (
          !link.closest(".language-switcher") &&
          !destination.startsWith("admin/")
        )
          assert.equal(destination.startsWith(locale + "/"), locale !== "ja");
      }
      if (locale !== "ja") {
        doc
          .querySelectorAll(".language-switcher,script,style")
          .forEach((element) => element.remove());
        assert.ok(
          !/[\u3040-\u30ff\u3400-\u9fff]/.test(doc.body.textContent),
          relative + " contains untranslated Japanese",
        );
        for (const element of doc.querySelectorAll(
          "[alt],[aria-label],[placeholder]",
        ))
          for (const attribute of ["alt", "aria-label", "placeholder"])
            assert.ok(
              !/[\u3040-\u30ff\u3400-\u9fff]/.test(
                element.getAttribute(attribute) ?? "",
              ),
              relative + " " + attribute,
            );
        assert.equal(doc.querySelector(".translation-notice"), null);
      }
      dom.window.close();
    }
  }
});
test("translations preserve article facts, photos and the unknown match state", async () => {
  for (const locale of ["ko", "en"]) {
    const article = new JSDOM(await read(locale + "/news/attacking-training"));
    assert.match(
      article.window.document.querySelector(".article-body").textContent,
      /14|Fourteen/,
    );
    assert.equal(
      article.window.document.querySelectorAll("[data-lightbox]").length,
      2,
    );
    const home = new JSDOM(await read(locale));
    assert.equal(
      home.window.document.querySelectorAll("[data-match-slot]").length,
      3,
    );
    assert.ok(
      home.window.document.body.textContent.includes(
        locale === "ko" ? "아직 경기 미정" : "The match is yet to be confirmed",
      ),
    );
    article.window.close();
    home.window.close();
  }
});

test("translated search, category filters, photo descriptions and language menu keyboard controls work", async () => {
  for (const locale of ["ko", "en"]) {
    const dom = new JSDOM(await read(locale), {
      url: "https://ryukkani.github.io/kansai/" + locale + "/",
      runScripts: "outside-only",
      pretendToBeVisual: true,
    });
    const { window } = dom;
    window.matchMedia = () => ({ matches: false, addEventListener() {} });
    window.HTMLDialogElement.prototype.showModal = function () {
      this.open = true;
    };
    window.HTMLDialogElement.prototype.close = function () {
      this.open = false;
    };
    for (const script of window.document.querySelectorAll("script[src]"))
      window.eval(
        await browserScript(
          path.join(
            "dist",
            new URL(script.src).pathname.replace("/kansai/", ""),
          ),
        ),
      );
    const doc = window.document;
    doc.querySelector(".search-open").click();
    const input = doc.querySelector("#news-search");
    input.value = locale === "ko" ? "훈련" : "defence";
    input.dispatchEvent(new window.Event("input"));
    assert.equal(
      [...doc.querySelectorAll("[data-search-text]")].filter(
        (item) => !item.hidden,
      ).length,
      locale === "ko" ? 2 : 1,
    );
    doc.querySelector(".search-dialog [data-close-dialog]").click();
    doc.querySelector("[data-filter-group] [data-filter=club]").click();
    assert.equal(
      [...doc.querySelectorAll("[data-filter-group] [data-category]")].filter(
        (item) => !item.hidden,
      ).length,
      1,
    );
    doc.querySelector("[data-lightbox]").click();
    assert.equal(doc.querySelector(".photo-dialog").open, true);
    assert.ok(
      !/[\u3040-\u30ff\u3400-\u9fff]/.test(
        doc.querySelector(".photo-dialog img").alt,
      ),
    );
    const menu = doc.querySelector(".language-switcher");
    menu.open = true;
    menu.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    assert.equal(menu.open, false);
    dom.window.close();
  }
});
test("locale routing and date formatting keep Japanese time and exclude auth tokens", async () => {
  const bundled = await build({
    entryPoints: ["src/lib/i18n.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    define: { "import.meta.env.BASE_URL": JSON.stringify("/kansai/") },
  });
  const api = await import(
    "data:text/javascript;base64," +
      Buffer.from(bundled.outputFiles[0].text).toString("base64")
  );
  const url = new URL(
    "https://ryukkani.github.io/kansai/admin/?lang=ko&access_token=TEST#access_token=TEST",
  );
  assert.equal(api.localeFromUrl(url), "ko");
  assert.equal(api.languageUrl(url, "en"), "/kansai/admin/?lang=en");
  assert.equal(
    api.languageUrl(
      new URL("https://ryukkani.github.io/kansai/en/news/attacking-training/"),
      "ko",
    ),
    "/kansai/ko/news/attacking-training/",
  );
  assert.equal(
    api.localeFromUrl(
      new URL("https://ryukkani.github.io/kansai/admin/?lang=invalid"),
    ),
    "ja",
  );
  assert.match(api.localizedDate("2026-10-13T15:05:00Z", "ko", true), /14/);
  assert.match(api.localizedDate("2026-10-13T15:05:00Z", "en", true), /14/);
  assert.deepEqual(api.weekdayNames("en"), [
    "Sun",
    "Mon",
    "Tue",
    "Wed",
    "Thu",
    "Fri",
    "Sat",
  ]);
  assert.equal(api.formatForLocale("en")("{0}を編集", "News"), "Edit News");
  assert.equal(api.translate("未翻訳の新しい本文", "en"), "未翻訳の新しい本文");
});
test("Korean staff UI preserves original content, server field names and draft state", async () => {
  const row = {
    id: "00000000-0000-4000-8000-000000000009",
    slug: "language-test",
    title: "日本語の編集対象",
    summary: "原文の概要",
    body: "原文を保持",
    category: "club",
    cover_alt: "説明",
    status: "draft",
    gallery_paths: [],
    updated_at: new Date().toISOString(),
  };
  const { dom, window, requests } = await app(
    "owner",
    "https://ryukkani.github.io/kansai/admin/?lang=ko",
    {},
    { articles: [row] },
  );
  try {
    const doc = window.document;
    assert.equal(doc.documentElement.lang, "ko");
    assert.equal(
      doc.querySelector("#login-panel h1").textContent,
      "운영 멤버 로그인",
    );
    assert.equal(
      doc.querySelector(".office-public-link").getAttribute("href"),
      "/kansai/ko/",
    );
    await login(window);
    assert.equal(doc.querySelector("#resource-title").textContent, "대시보드");
    doc.querySelector("[data-resource=articles]").click();
    await eventually(() => doc.querySelector(".admin-list-row button"));
    doc.querySelector(".admin-list-row button").click();
    await eventually(
      () =>
        doc.querySelector("#editor-dialog").open &&
        doc.querySelector("#field-title"),
    );
    assert.equal(doc.querySelector("#field-title").value, row.title);
    doc.querySelector("#field-title").value = "日本語の修正";
    doc
      .querySelector("#field-title")
      .dispatchEvent(new window.Event("input", { bubbles: true }));
    const button = doc.querySelector("[data-save-status=draft]");
    button.click();
    await eventually(() =>
      doc.querySelector("#admin-notice").textContent.includes("저장했습니다."),
    );
    const request = requests.find(
      (item) =>
        item.method === "PATCH" &&
        new URL(item.url).pathname.endsWith("/articles"),
    );
    assert.ok(request);
    const saved = JSON.parse(request.body);
    assert.equal(saved.title, "日本語の修正");
    assert.equal(saved.status, "draft");
    assert.equal(saved.category, "club");
    assert.equal("제목" in saved, false);
  } finally {
    dom.window.close();
  }
});
test("English login notices remain invitation-only and return to the selected language", async () => {
  const { dom, window, requests } = await app(
    "owner",
    "https://ryukkani.github.io/kansai/admin/?lang=en",
  );
  try {
    const doc = window.document;
    assert.equal(doc.documentElement.lang, "en");
    assert.equal(
      doc.querySelector("#login-panel h1").textContent,
      "Club staff login",
    );
    doc.querySelector("#login-form input[name=email]").value =
      "test@example.invalid";
    doc.querySelector("#magic-link-button").click();
    await eventually(() =>
      doc
        .querySelector("#admin-notice")
        .textContent.includes("Login link sent."),
    );
    const request = requests.find((item) =>
      new URL(item.url).pathname.endsWith("/auth/v1/otp"),
    );
    assert.equal(JSON.parse(request.body).create_user, false);
    assert.equal(
      new URL(request.url).searchParams.get("redirect_to"),
      "https://ryukkani.github.io/kansai/admin/",
    );
    assert.equal(window.localStorage.getItem("kansai-language"), "en");
  } finally {
    dom.window.close();
  }
});

test("Korean email rate-limit errors are readable and English coach access stays restricted", async () => {
  const limited = await app(
    "owner",
    "https://ryukkani.github.io/kansai/admin/?lang=ko",
    { otpError: "over_email_send_rate_limit" },
  );
  try {
    const doc = limited.window.document;
    doc.querySelector("#login-form input[name=email]").value =
      "test@example.invalid";
    doc.querySelector("#magic-link-button").click();
    await eventually(() =>
      doc
        .querySelector("#admin-notice")
        .textContent.includes("메일 전송 횟수 제한"),
    );
    assert.equal(doc.querySelector("#magic-link-button").disabled, false);
    assert.equal(
      limited.requests.filter((item) =>
        new URL(item.url).pathname.includes("/auth/v1/otp"),
      ).length,
      1,
    );
  } finally {
    limited.dom.window.close();
  }
  const coach = await app(
    "coach",
    "https://ryukkani.github.io/kansai/admin/?lang=en",
  );
  try {
    await login(coach.window);
    const doc = coach.window.document;
    assert.equal(doc.querySelector("[data-resource=articles]"), null);
    assert.equal(doc.querySelector("[data-resource=admin_roles]"), null);
    assert.ok(doc.querySelector("[data-resource=players]"));
    assert.equal(doc.querySelector("#resource-title").textContent, "Dashboard");
  } finally {
    coach.dom.window.close();
  }
});
