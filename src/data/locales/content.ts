import type { PublicContent } from "../cms";
import { translate, localizedDate, type Locale } from "../../lib/i18n";
import { club } from "../club";
import { translationComplete } from "../../lib/content-translations";
export function clubForLocale(locale: Locale) {
  return {
    ...club,
    name: translate(club.name, locale),
    description: translate(club.description, locale),
  };
}
// 새로 게시된 일본어 원문의 번역이 아직 없으면 이를 숨기거나 번역됐다고 표시하지 않습니다.
export function hasOriginalText(content: PublicContent): boolean {
  const values = [
    ...content.stories.flatMap((item) => [
      item.title,
      item.summary,
      item.alt,
      ...item.paragraphs,
    ]),
    ...content.pages.flatMap((item) => [
      item.title,
      item.introduction,
      ...item.paragraphs,
    ]),
    ...content.players.flatMap((item) => [item.name, item.bio]),
    ...content.fixtures.flatMap((item) => [
      item.opponent,
      item.competition,
      item.venue,
      ...item.report,
    ]),
    ...content.media.flatMap((item) => [
      item.title,
      item.alt,
      item.description,
    ]),
    ...content.albums.flatMap((item) => [item.title, item.description]),
    ...content.schedules.flatMap((item) => [
      item.title,
      item.venue,
      item.description,
    ]),
  ];
  return values.some(
    (value) =>
      typeof value === "string" && /[\u3040-\u30ff\u3400-\u9fff]/.test(value),
  );
}
// 공개 승인된 문자열만 번역합니다. UUID·슬러그·사진·링크·상태·수치와 내부 데이터는 변경하지 않습니다.
export function localizeContent(
  content: PublicContent,
  locale: Locale,
): PublicContent {
  if (locale === "ja") return content;
  const t = (value: string) => translate(value, locale);
  return {
    ...content,
    stories: content.stories.map((story) => {
      const translation = story.translations?.[locale];
      const explicit = translationComplete(translation, "articles")
        ? translation
        : undefined;
      return {
        ...story,
        label: t(story.label),
        title: explicit?.title ?? t(story.title),
        summary: explicit?.summary ?? t(story.summary),
        alt: explicit?.cover_alt ?? t(story.alt),
        paragraphs: explicit?.body
          ? explicit.body
              .split(/\n\s*\n/)
              .map((value) => value.trim())
              .filter(Boolean)
          : story.paragraphs.map(t),
        activityDate: story.activityDate
          ? /^\d{4}-\d{2}-\d{2}$/.test(story.activityDate)
            ? localizedDate(story.activityDate + "T12:00:00+09:00", locale)
            : t(story.activityDate)
          : undefined,
      };
    }),
    pages: content.pages.map((page) => {
      const translation = page.translations?.[locale];
      const explicit = translationComplete(translation, "site_pages")
        ? translation
        : undefined;
      return {
        ...page,
        title: explicit?.title ?? t(page.title),
        introduction: explicit?.introduction ?? t(page.introduction),
        paragraphs: explicit?.body
          ? explicit.body
              .split(/\n\s*\n/)
              .map((value) => value.trim())
              .filter(Boolean)
          : page.paragraphs.map(t),
      };
    }),
    players: content.players.map((player) => ({
      ...player,
      name: t(player.name),
      bio: player.bio
        .split(/\n\s*\n/)
        .map(t)
        .join("\n\n"),
    })),
    fixtures: content.fixtures.map((fixture) => ({
      ...fixture,
      opponent: t(fixture.opponent),
      competition: t(fixture.competition),
      venue: t(fixture.venue),
      report: fixture.report.map(t),
    })),
    media: content.media.map((item) => ({
      ...item,
      title: t(item.title),
      alt: t(item.alt),
      description: t(item.description),
    })),
    albums: content.albums.map((album) => ({
      ...album,
      title: t(album.title),
      description: t(album.description),
    })),
    schedules: content.schedules.map((item) => ({
      ...item,
      title: t(item.title),
      venue: t(item.venue ?? ""),
      description: t(item.description ?? ""),
    })),
  };
}
