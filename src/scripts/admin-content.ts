import { text as t } from "../lib/i18n";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resources, type Resource } from "../lib/admin-config";
import { action, dateLabel, node, roleLabels, type Row } from "../lib/admin-ui";
import { translatedFields, translationName } from "../lib/content-translations";
import {
  draftKey,
  readDraft,
  writeDraft,
  contentResources,
} from "../lib/content-drafts";
export { contentResources };
export type ContentEditor = {
  dispose: () => void;
  clear: () => void;
  flush: () => void;
};
// 기존 편집 양식을 사용하면서 브라우저 임시 저장과 서버 이력 UI만 덧붙입니다.
export function attachContentEditor(options: {
  client: SupabaseClient;
  userId: string;
  resource: Resource;
  row: Row | null;
  form: HTMLFormElement;
  container: HTMLElement;
  publisher: boolean;
  changed: () => void;
  isCurrent: () => boolean;
  restore: (row: Row) => Promise<void>;
  error: (error: unknown) => void;
}): ContentEditor {
  const { client, resource, row, form, container } = options;
  const key = draftKey(
    options.userId,
    resource,
    row ? String(row[resources[resource].key]) : null,
  );
  const expected = row?.updated_at ? String(row.updated_at) : null;
  let disposed = false;
  const active = () => !disposed && options.isCurrent();
  const reportError = (error: unknown) => { if (active()) options.error(error); };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let dirty = false;
  let refreshId = 0;
  const status = node(
    "p",
    t("このブラウザ内の一時保存：変更待ち"),
    "admin-help",
  );
  status.setAttribute("role", "status");
  const section = node("section", "", "office-content-tools");
  section.append(node("h3", t("保存と履歴")), status);
  container.append(section);
  let stored: ReturnType<typeof readDraft> = null;
  try {
    stored = readDraft(localStorage, key);
  } catch {
    status.textContent = t(
      "このブラウザでは一時保存を利用できません。下書き保存をご利用ください。",
    );
  }
  if (stored) {
    const prompt = node("div", "", "office-draft-prompt");
    prompt.append(
      node(
        "p",
        t("前回の一時保存：") +
          dateLabel(new Date(stored.savedAt), true) +
          (stored.expected !== expected
            ? t(
                "。サーバーの内容が変更されています。復元後に内容を照合してください。",
              )
            : ""),
        "admin-help",
      ),
    );
    const draft = stored;
    prompt.append(
      action(t("一時保存を編集画面に戻す"), "admin-secondary", () => {
        const names = [
          ...resources[resource].fields.map((field) => field.name),
          ...["ko", "en"].flatMap((locale) =>
            translatedFields(resource).map((field) =>
              translationName(locale as "ko" | "en", field),
            ),
          ),
        ];
        for (const name of names) {
          const controls = form.querySelectorAll<
            HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
          >('[name="' + name + '"]');
          const values = draft.values
            .filter(([fieldName]) => fieldName === name)
            .map(([, value]) => value);
          controls.forEach((control) => {
            if (
              control.disabled ||
              (control instanceof HTMLInputElement && control.type === "file")
            )
              return;
            if (
              control instanceof HTMLInputElement &&
              control.type === "checkbox"
            )
              control.checked = values.includes(control.value);
            else control.value = values[0] ?? "";
          });
        }
        form
          .querySelector(".office-translations input")
          ?.dispatchEvent(new Event("input", { bubbles: true }));
        options.changed();
        dirty = true;
        flush();
        prompt.remove();
      }),
      action(t("一時保存を破棄"), "admin-secondary", () => {
        try {
          localStorage.removeItem(key);
        } catch {}
        prompt.remove();
      }),
    );
    section.append(prompt);
  }
  section.append(
    node(
      "p",
      t(
        "自動保存はこのブラウザ内だけです。サーバーへの下書き保存・発行は上のボタンで行います。7日間有効で、期限切れは次回表示時、ログアウト時はその場で削除されます。",
      ),
      "admin-help",
    ),
  );
  if (options.publisher) {
    const label = node("label", t("予約発行（日本時間）"));
    const input = node("input");
    input.type = "datetime-local";
    input.name = "_publish_at";
    input.id = "scheduled-publish-at";
    label.append(input);
    const button = action(t("承認して予約する"), "admin-secondary");
    button.type = "submit";
    button.dataset.saveStatus = "scheduled";
    section.append(
      label,
      button,
      node(
        "p",
        t(
          "予約日時以降に内容を確認して発行します。公式サイトへの反映は次の再構築後です。公開中の記事を予約すると一旦非公開になります。",
        ),
        "admin-help",
      ),
    );
  } else
    section.append(
      node(
        "p",
        t("予約発行は運営責任者による公開処理の有効化後に利用できます。"),
        "admin-help",
      ),
    );
  const history = node("div", "", "office-content-history");
  section.append(history);
  async function refreshHistory() {
    if (!active()) return;
    if (!row) {
      history.replaceChildren(
        node(
          "p",
          t("下書きを保存すると修正履歴を確認できます。"),
          "admin-help",
        ),
      );
      return;
    }
    const version = ++refreshId;
    history.replaceChildren(
      node("p", t("修正履歴を読み込み中…"), "admin-help"),
    );
    const response = await client.rpc("office_content_state", {
      p_entity: resource,
      p_id: String(row.id),
    });
    if (!active() || version !== refreshId) return;
    if (response.error) {
      history.replaceChildren(
        node("p", t("修正履歴を取得できませんでした。"), "admin-help"),
        action(t("再試行"), "admin-secondary", () => void refreshHistory()),
      );
      return;
    }
    history.replaceChildren(node("h4", t("最近の修正履歴")));
    const data = response.data as { release?: Row; revisions?: Row[] } | null;
    if (data?.release) {
      const release = data.release;
      const labels: Record<string, string> = {
        queued: t("予約済み"),
        published: t("発行済み"),
        cancelled: t("予約取消"),
        failed: t("発行できませんでした"),
      };
      history.append(
        node(
          "p",
          (labels[String(release.state)] ?? "") +
            "：" +
            dateLabel(release.scheduled_at, true),
          "admin-help",
        ),
      );
      if (release.state === "queued") {
        if (
          new Date(String(release.scheduled_at)).getTime() <
          Date.now() - 600000
        )
          history.append(
            node(
              "p",
              t(
                "予約時刻を過ぎています。運営責任者に処理状況をご確認ください。",
              ),
              "admin-help",
            ),
          );
        history.append(
          action(t("予約を取り消す"), "admin-secondary", () => {
            if (!active()) return;
            void (async () => {
              const response = await client.rpc("cancel_content_release", {
                p_entity: resource,
                p_id: String(row.id),
              });
              if (!active()) return;
              if (response.error) throw response.error;
              await refreshHistory();
            })().catch(reportError);
          }),
        );
      }
      if (release.state === "failed")
        history.append(
          node(
            "p",
            t(
              "掲載確認・写真・承認者の権限を確認し、内容を保存して予約し直してください。",
            ),
            "admin-help",
          ),
        );
    }
    if (!data?.revisions?.length)
      history.append(
        node(
          "p",
          t("この機能の導入後に保存した履歴はまだありません。"),
          "admin-help",
        ),
      );
    for (const revision of data?.revisions ?? []) {
      const item = node("div", "", "office-revision");
      const actor =
        revision.reason === "baseline"
          ? t("修正前の内容")
          : (roleLabels[String(revision.actor_role)] ?? t("システム"));
      item.append(
        node("strong", String(revision.title ?? t("名称未設定"))),
        node(
          "p",
          dateLabel(revision.captured_at, true) + " · " + actor,
          "admin-help",
        ),
      );
      const ask = action(t("この版を下書きに復元"), "admin-secondary", () => {
        if (!active()) return;
        const confirmation = node("div", "", "office-restore-confirm");
        confirmation.append(
          node(
            "p",
            t(
              "現在の編集を置き換え、この版を非公開の下書きとして保存します。発行には再確認が必要です。",
            ),
            "admin-help",
          ),
        );
        const confirm = action(t("復元を確定"), "admin-danger", () => {
          if (!active()) return;
          confirm.disabled = true;
          void (async () => {
            const response = await client.rpc("restore_content_revision", {
              p_revision: revision.id,
              p_expected: expected,
            });
            // 이미 폐기된 화면의 응답은 같은 키로 새로 쓴 초안·새 계정 화면을 건드리지 않습니다.
            if (!active()) return;
            if (response.error) throw response.error;
            clear();
            await options.restore(response.data as Row);
          })().catch((error) => {
            if (!active()) return;
            confirm.disabled = false;
            reportError(error);
          });
        });
        confirmation.append(
          confirm,
          action(t("戻る"), "admin-secondary", () => confirmation.remove()),
        );
        item.append(confirmation);
        confirm.focus();
      });
      item.append(ask);
      history.append(item);
    }
  }
  function flush() {
    if (disposed || !dirty) return;
    try {
      const values = [...new FormData(form).entries()].filter(
        (pair): pair is [string, string] =>
          typeof pair[1] === "string" && !pair[0].startsWith("_"),
      );
      writeDraft(localStorage, key, { savedAt: Date.now(), expected, values });
      status.textContent =
        t("このブラウザ内に一時保存済み：") +
        dateLabel(new Date(), true) +
        t("（サーバー未送信）");
      dirty = false;
    } catch (error) {
      status.textContent =
        error instanceof Error
          ? error.message
          : t("一時保存できません。下書き保存をご利用ください。");
    }
  }
  function changed() {
    dirty = true;
    status.textContent = t("このブラウザ内に一時保存中…");
    clearTimeout(timer);
    timer = setTimeout(flush, 700);
  }
  function clear() {
    clearTimeout(timer);
    dirty = false;
    try {
      localStorage.removeItem(key);
    } catch {}
  }
  form.addEventListener("input", changed);
  form.addEventListener("change", changed);
  window.addEventListener("beforeunload", flush);
  void refreshHistory().catch(reportError);
  return {
    clear,
    flush,
    dispose() {
      flush();
      disposed = true;
      refreshId++;
      clearTimeout(timer);
      form.removeEventListener("input", changed);
      form.removeEventListener("change", changed);
      window.removeEventListener("beforeunload", flush);
      section.remove();
    },
  };
}
