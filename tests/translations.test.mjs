import test from "node:test";
import assert from "node:assert/strict";
import { app, login, eventually, uid } from "./helpers/admin-app.mjs";
import { typescriptModule } from "./helpers/typescript-module.mjs";
const { localizeContent, hasOriginalText } = await typescriptModule(
  "src/data/locales/content.ts",
);
const { draftKey, writeDraft } = await typescriptModule(
  "src/lib/content-drafts.ts",
);
const button = (d, label) =>
  [...d.querySelectorAll("button")].find((b) => b.textContent.trim() === label);
const set = (w, name, value) => {
  const input = w.document.querySelector(`[name="${name}"]`);
  assert.ok(input, name);
  input.value = value;
  input.dispatchEvent(new w.Event("input", { bubbles: true }));
};
async function create(context, resource) {
  const d = context.window.document;
  d.querySelector(`[data-resource="${resource}"]`).click();
  await eventually(() => d.querySelector(".admin-list"));
  d.querySelector("#new-button").click();
  await eventually(() => d.querySelector("#editor-dialog").open);
  return d;
}
const ja = {
  title: "日本語の新記事",
  summary: "概要",
  body: "本文",
  cover_alt: "写真説明",
};
const ko = {
  title: "새 한국어 기사",
  summary: "한국어 요약",
  body: "한국어 본문\n\n둘째 문단",
  cover_alt: "한국어 사진 설명",
};
const en = {
  title: "New English story",
  summary: "Summary",
  body: "First paragraph\n\nSecond paragraph",
  cover_alt: "English image description",
};

test("CMS translations take priority over dictionaries without changing IDs, images or source", () => {
  const content = {
    stories: [
      {
        id: "same-url",
        title: "日本語",
        summary: "概要",
        alt: "説明",
        paragraphs: ["本文"],
        label: "CLUB",
        image: "assets/photo.jpg",
        translations: { ko, en },
      },
    ],
    pages: [
      {
        id: "club",
        title: "クラブ",
        introduction: "概要",
        paragraphs: ["本文"],
        translations: {
          en: { title: "Our club", introduction: "Intro", body: "Details" },
        },
      },
    ],
    players: [],
    fixtures: [],
    media: [],
    albums: [],
    schedules: [],
    fromCms: true,
    version: 3,
  };
  const korean = localizeContent(content, "ko");
  assert.equal(korean.stories[0].title, ko.title);
  assert.deepEqual(korean.stories[0].paragraphs, ["한국어 본문", "둘째 문단"]);
  assert.equal(korean.stories[0].id, "same-url");
  assert.equal(korean.stories[0].image, "assets/photo.jpg");
  assert.equal(content.stories[0].title, "日本語");
  assert.equal(localizeContent(content, "en").pages[0].title, "Our club");
  assert.equal(localizeContent(content, "ja"), content);
});

// 공개되지 않은 메모리 시험 자료입니다. 사전 키와 겹치는 이름도 써서 실제 번역 충돌을 재현합니다.
test("public player names stay exact in every language while biography and message translations remain available", () => {
  const names = ["月", "山田 太郎", "김 민수", "Ana-María O'Neil", "Jose\u0301-Anne"];
  const bio = "ピッチでつながる。チームの今を、ここから。\n\nプレーする、教える、運営を支える。";
  const content = {
    stories: [], pages: [], fixtures: [], media: [], albums: [], fromCms: true, version: 7,
    players: names.map((name, index) => ({
      playerId: "00000000-0000-4000-8000-" + String(index + 1).padStart(12, "0"), slug: "test-only-player-" + index,
      name, romanizedName: "Test only original spelling", number: index + 1, position: "MF", photo: "assets/test-only-photo.jpg",
      bio, activityStatus: "active", displayOrder: index,
    })),
    schedules: [{ id: "test-only-schedule", title: "月", venue: "", description: "" }],
  };
  const before = structuredClone(content);
  const biographies = {
    ja: bio,
    ko: "그라운드에서 연결되다. 팀의 오늘을 여기에서.\n\n뛰고, 가르치고, 운영을 지원하다.",
    en: "Connected on the pitch. The team today, right here.\n\nPlay. Coach. Support the club.",
  };
  for (const locale of ["ja", "ko", "en"]) {
    const localized = localizeContent(content, locale);
    assert.deepEqual(localized.players.map(player => player.name), names);
    assert.deepEqual(localized.players, before.players.map(player => ({ ...player, bio: biographies[locale] })));
    assert.equal(localized.schedules[0].title, { ja: "月", ko: "월", en: "Month" }[locale]);
    if (locale !== "ja") assert.equal(hasOriginalText(localized), false);
  }
  assert.deepEqual(content, before);
});

test("original-script player names do not trigger translation notices but untranslated biographies and stories do", () => {
  const content = {
    stories: [], pages: [], fixtures: [], media: [], albums: [], schedules: [], fromCms: true, version: 1,
    players: [{ name: "山田 タロウ", bio: "" }],
  };
  for (const locale of ["ko", "en"]) {
    assert.equal(hasOriginalText(localizeContent(content, locale)), false);
    const untranslatedBio = { ...content, players: [{ ...content.players[0], bio: "まだ翻訳のない選手紹介" }] };
    assert.equal(hasOriginalText(localizeContent(untranslatedBio, locale)), true);
    const untranslatedStory = { ...content, stories: [{ title: "まだ翻訳のない新着記事", summary: "", alt: "", paragraphs: [], label: "CLUB" }] };
    assert.equal(hasOriginalText(localizeContent(untranslatedStory, locale)), true);
  }
});

test("one editor retains three language values, previews chosen language and saves one record", async () => {
  let saved;
  const context = await app(
    "owner",
    "https://kansaiunited.com/admin/?lang=ko",
    {
      content: true,
      rpc: (name, values) => {
        if (name === "save_office_content") saved = values;
        return name === "office_content_state" ? { revisions: [] } : {};
      },
    },
  );
  try {
    await login(context.window);
    const d = await create(context, "articles");
    for (const [name, value] of Object.entries(ja))
      set(context.window, name, value);
    set(context.window, "slug", "test-only-three-languages");
    d.querySelector("#content-tab-ko").click();
    for (const [name, value] of Object.entries(ko))
      set(context.window, "translation_ko_" + name, value);
    d.querySelector("#content-tab-en").click();
    for (const [name, value] of Object.entries(en))
      set(context.window, "translation_en_" + name, value);
    d.querySelector("#content-tab-ja").click();
    assert.equal(d.querySelector('[name="title"]').value, ja.title);
    d.querySelector("#content-tab-ko").click();
    assert.equal(
      d.querySelector("#content-tab-ko").dataset.translationState,
      "complete",
    );
    button(d, "게시 전 미리보기").click();
    await eventually(() => d.querySelector(".office-news-preview"));
    assert.equal(
      d.querySelector(".office-news-preview h1").textContent,
      ko.title,
    );
    assert.equal(d.querySelector(".office-news-preview").lang, "ko");
    const previewLanguage = d.querySelector(".office-preview-language select");
    previewLanguage.value = "en";
    previewLanguage.dispatchEvent(
      new context.window.Event("change", { bubbles: true }),
    );
    await eventually(
      () => d.querySelector(".office-news-preview h1").textContent === en.title,
    );
    d.querySelector("#preview-close").click();
    button(d, "초안 저장").click();
    await eventually(() => saved);
    assert.equal(saved.p_entity, "articles");
    assert.deepEqual(saved.p_values.translations, { ko, en });
    assert.equal(saved.p_values.title, ja.title);
    assert.equal(saved.p_values.slug, "test-only-three-languages");
  } finally {
    context.dom.window.close();
  }
});

test("partial translations can be drafted but publication is blocked with an actionable message", async () => {
  let calls = 0;
  const context = await app(
    "owner",
    "https://kansaiunited.com/admin/?lang=en",
    {
      content: true,
      rpc: (name) => {
        if (name === "save_office_content") calls++;
        return {};
      },
    },
  );
  try {
    await login(context.window);
    const d = await create(context, "articles");
    for (const [name, value] of Object.entries(ja))
      set(context.window, name, value);
    set(context.window, "slug", "test-only-partial");
    set(context.window, "translation_en_title", "In progress");
    button(d, "Publish").click();
    await eventually(
      () => d.querySelector("#editor-notice").dataset.error === "true",
    );
    assert.equal(calls, 0);
    assert.match(
      d.querySelector("#editor-notice").textContent,
      /translation is incomplete/,
    );
    button(d, "Save draft").click();
    await eventually(() => calls === 1);
  } finally {
    context.dom.window.close();
  }
});

test("local draft restore includes both translations, tab status and keyboard navigation", async () => {
  const context = await app("owner", undefined, {
    content: true,
    rpc: () => ({ revisions: [] }),
  });
  try {
    await login(context.window);
    writeDraft(context.window.localStorage, draftKey(uid, "articles", null), {
      savedAt: Date.now(),
      expected: null,
      values: [
        ["title", ja.title],
        ...Object.entries(ko).map(([k, v]) => ["translation_ko_" + k, v]),
      ],
    });
    const d = await create(context, "articles");
    button(d, "一時保存を編集画面に戻す").click();
    assert.equal(
      d.querySelector('[name="translation_ko_body"]').value,
      ko.body,
    );
    assert.equal(
      d.querySelector("#content-tab-ko").dataset.translationState,
      "complete",
    );
    d.querySelector("#content-tab-ja").dispatchEvent(
      new context.window.KeyboardEvent("keydown", {
        key: "ArrowRight",
        bubbles: true,
      }),
    );
    assert.equal(
      d.querySelector("#content-tab-ko").getAttribute("aria-selected"),
      "true",
    );
    assert.equal(d.querySelector("#content-panel-ko").hidden, false);
  } finally {
    context.dom.window.close();
  }
});

test("player registration offers only approved player photos and public profile receives the chosen photo", async () => {
  const photo = (id, category, status = "published", approved = true) => ({
    id,
    title: id,
    kind: "photo",
    media_category: category,
    status,
    public_approved: approved,
    published_at: "2026-10-01T00:00:00Z",
    legacy_path: "assets/club-profile.jpg",
    album_id: null,
  });
  const context = await app(
    "coach",
    undefined,
    {},
    {
      media_assets: [
        photo("selected-player", "player"),
        {
          ...photo("second-player", "player"),
          legacy_path: "assets/second-player.jpg",
        },
        photo("training", "training"),
        photo("draft-player", "player", "draft"),
        photo("unapproved", "player", "published", false),
      ],
      players: [
        {
          id: uid,
          internal_name: "Test only player",
          profile_consent: false,
          photo_consent: false,
          photo_asset_id: "selected-player",
          activity_status: "active",
        },
        {
          id: "00000000-0000-4000-8000-000000000002",
          internal_name: "Test player two",
          photo_asset_id: "second-player",
          profile_consent: false,
          photo_consent: false,
          activity_status: "active",
        },
      ],
    },
  );
  try {
    await login(context.window);
    let d = await create(context, "players");
    const photos = d.querySelector('[name="photo_asset_id"]');
    assert.deepEqual(
      [...photos.options].map((o) => o.value).sort(),
      ["", "selected-player", "second-player"].sort(),
    );
    d.querySelector("#editor-close").click();
    await eventually(() => d.querySelector('[data-player-action="edit"]'));
    d.querySelector('[data-player-action="edit"]').click();
    await eventually(() => d.querySelector("#editor-dialog").open);
    assert.equal(
      d.querySelector('[name="photo_asset_id"]').value,
      "selected-player",
    );
    assert.ok(d.querySelector(".office-player-photo-preview img"));
    assert.ok(d.querySelector('[name="internal_name"]'));
    assert.ok(d.querySelector('[name="display_name"]'));
    assert.equal(d.querySelector('[name="player_id"]'), null);
    const photoSelect = d.querySelector('[name="photo_asset_id"]');
    photoSelect.value = "second-player";
    photoSelect.dispatchEvent(
      new context.window.Event("change", { bubbles: true }),
    );
    assert.equal(
      photoSelect.value,
      "second-player",
      "manual choice is preserved",
    );
    assert.equal(d.querySelector('[data-save-status="published"]'), null);
    assert.equal(context.tables.public_player_profiles.length, 0);
  } finally {
    context.dom.window.close();
  }
});

test("media category filter is sent to the server and new category field retains its value", async () => {
  const context = await app(
    "editor",
    "https://kansaiunited.com/admin/?lang=ko",
    {},
    {
      media_assets: [
        {
          id: "one",
          title: "Player picture",
          kind: "photo",
          media_category: "player",
          status: "draft",
        },
        {
          id: "two",
          title: "Training picture",
          kind: "photo",
          media_category: "training",
          status: "draft",
        },
      ],
    },
  );
  try {
    await login(context.window);
    const d = context.window.document;
    d.querySelector('[data-resource="media_assets"]').click();
    await eventually(() => d.querySelector('[name="category"]'));
    const filter = d.querySelector('[name="category"]');
    filter.value = "player";
    filter.dispatchEvent(new context.window.Event("change", { bubbles: true }));
    await eventually(() => d.querySelectorAll(".admin-list-row").length === 1);
    assert.match(d.querySelector(".admin-list").textContent, /Player picture/);
    assert.ok(
      context.requests.some((r) => r.url.includes("media_category=eq.player")),
    );
    d.querySelector(".admin-list-row button").click();
    await eventually(() => d.querySelector("#editor-dialog").open);
    assert.equal(d.querySelector('[name="media_category"]').value, "player");
  } finally {
    context.dom.window.close();
  }
});
