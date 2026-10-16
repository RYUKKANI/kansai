import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

// 실제 대화상자 모듈을 실행하고 권한 있는 RPC·Edge 경계만 대체합니다. 운영 계정은 변경하지 않습니다.
const bundle = await build({
  entryPoints: ["src/scripts/owner-account-management.ts"],
  bundle: true,
  write: false,
  format: "iife",
  globalName: "OwnerManagement",
  platform: "browser",
  define: { "import.meta.env.BASE_URL": '"/"' },
});
const ownerId = "00000000-0000-4000-8000-000000000001";
const targetId = "00000000-0000-4000-8000-000000000002";
const operationId = "00000000-0000-4000-8000-000000000003";
const account = {
  user_id: targetId,
  username: "staff.name",
  real_name: "韓 山田 Ana-María",
  password_is_set: true,
  name_verified_at: null,
  can_edit_real_name: true,
};
async function until(check) {
  for (let index = 0; index < 150; index++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(check(), "Owner dialog did not reach its expected state");
}
function app(options = {}) {
  const dom = new JSDOM("<main></main><button id='outside'>Outside</button>", {
    url: "https://kansaiunited.com/admin/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  Object.assign(window, { Request, Response, Headers });
  Object.defineProperty(window, "crypto", {
    value: { randomUUID: () => operationId },
  });
  window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
    this.dispatchEvent(new window.Event("close"));
  };
  window.eval(
    bundle.outputFiles[0].text + "\nwindow.OwnerManagement = OwnerManagement;",
  );
  let current = true;
  let listener;
  let unsubscribeCount = 0;
  let changedCount = 0;
  let ownIdentityChangedCount = 0;
  let signOutCount = 0;
  const calls = [];
  const notices = [];
  const client = {
    async rpc(name, args) {
      calls.push({ kind: "rpc", name, args: structuredClone(args) });
      if (name === "office_owner_account")
        return options.read
          ? options.read(args)
          : { data: { ...account, ...options.account }, error: null };
      return options.update
        ? options.update(args)
        : {
            data: {
              ...account,
              ...options.account,
              user_id: args.p_user_id,
              username: args.p_username,
              real_name: args.p_real_name,
            },
            error: null,
          };
    },
    functions: {
      async invoke(name, request) {
        calls.push({ kind: "edge", name, request: structuredClone(request) });
        return options.reset
          ? options.reset(request)
          : {
              data: {
                success: true,
                code: "owner_password_reset_succeeded",
                operation_id: operationId,
              },
              error: null,
            };
      },
    },
    auth: {
      async getSession() {
        calls.push({ kind: "session" });
        return options.session
          ? options.session()
          : {
              data: {
                session: {
                  access_token: "current-verified-token",
                  user: { id: ownerId },
                },
              },
              error: null,
            };
      },
      async signOut(request) {
        signOutCount++;
        calls.push({ kind: "signout", request });
        listener?.("SIGNED_OUT", null);
        return { error: null };
      },
      onAuthStateChange(callback) {
        listener = callback;
        return {
          data: {
            subscription: {
              unsubscribe() {
                unsubscribeCount++;
              },
            },
          },
        };
      },
    },
  };
  const controller = window.OwnerManagement.renderOwnerAccountManagement({
    client,
    userId: ownerId,
    targetUserId: options.targetUserId ?? targetId,
    onChanged() {
      changedCount++;
      return options.onChanged?.();
    },
    onOwnIdentityChanged() {
      ownIdentityChangedCount++;
      return options.onOwnIdentityChanged?.();
    },
    isCurrent: () => current,
    notice: (...args) => notices.push(args),
  });
  window.document.querySelector("main").append(controller.element);
  const dialog = controller.element.querySelector("dialog");
  const trigger = controller.element.querySelector(".owner-account-trigger");
  const passwordForm = () =>
    controller.element.querySelector('[data-owner-form="password"]');
  return {
    dom,
    window,
    calls,
    notices,
    controller,
    dialog,
    trigger,
    passwordForm,
    counts: () => ({
      changed: changedCount,
      ownIdentityChanged: ownIdentityChangedCount,
      signOut: signOutCount,
      unsubscribed: unsubscribeCount,
    }),
    async open() {
      trigger.click();
      await until(
        () =>
          dialog.querySelector("form") ||
          dialog.querySelector('[role="alert"]')?.textContent,
      );
    },
    resetForm(password = "new-test-password") {
      const form = passwordForm();
      form.elements.namedItem("password").value = password;
      form.elements.namedItem("password_confirmation").value = password;
      form.elements.namedItem("reason").value = "本人の依頼を確認";
      form.elements.namedItem("reset_acknowledged").checked = true;
      return form;
    },
    submit(form) {
      form.dispatchEvent(
        new window.Event("submit", { bubbles: true, cancelable: true }),
      );
    },
    emit(event, session) {
      listener?.(event, session);
    },
    invalidate() {
      current = false;
    },
    close() {
      controller.dispose();
      dom.window.close();
    },
  };
}
test("Owner details load only when opened and display safe names and an explicit password status", async () => {
  for (const password_is_set of [true, false, null]) {
    const context = app({
      account: {
        password_is_set,
        real_name: '<img src=x onerror="alert(1)"> 金',
        encrypted_password: "must-never-render",
        email: "private-contact@example.invalid",
      },
    });
    try {
      assert.equal(context.calls.length, 0);
      await context.open();
      assert.deepEqual(
        context.calls.map((call) => call.name),
        ["office_owner_account"],
      );
      assert.deepEqual(context.calls[0].args, { p_user_id: targetId });
      assert.equal(context.dialog.querySelector("img"), null);
      assert.equal(
        context.dialog.textContent.includes("must-never-render"),
        false,
      );
      assert.equal(
        context.dialog.textContent.includes("private-contact"),
        false,
      );
      assert.equal(
        context.dialog.querySelector("[data-owner-password-state]").textContent,
        password_is_set === true
          ? "設定済み"
          : password_is_set === false
            ? "未設定"
            : "確認不可",
      );
      assert.equal(
        context.dialog.getAttribute("aria-labelledby"),
        context.dialog.querySelector("h2").id,
      );
      assert.equal(
        context.dialog.querySelector('[autocomplete="current-password"]'),
        null,
      );
    } finally {
      context.close();
    }
  }
});
test("server denial displays no editable account fields", async () => {
  const context = app({
    read: () => ({
      data: null,
      error: { code: "42501", message: "private server detail" },
    }),
  });
  try {
    await context.open();
    assert.equal(context.dialog.querySelector("form"), null);
    assert.equal(
      context.dialog.textContent.includes("private server detail"),
      false,
    );
    assert.match(
      context.dialog.querySelector('[role="alert"]').textContent,
      /最高管理者/,
    );
  } finally {
    context.close();
  }
});
test("identity edits normalize only the login ID, preserve UUID and Unicode names and refresh after confirmed save", async () => {
  const context = app();
  try {
    await context.open();
    const form = context.dialog.querySelector('[data-owner-form="identity"]');
    form.elements.namedItem("username").value = "New.Owner-1";
    form.elements.namedItem("real_name").value = "李 Jean-Luc サトウ";
    form.elements.namedItem("reason").value = "登録表記の訂正";
    context.submit(form);
    assert.equal(
      context.calls.some(
        (call) => call.name === "office_owner_update_identity",
      ),
      false,
    );
    form.elements.namedItem("name_change_acknowledged").checked = true;
    context.submit(form);
    await until(() => context.counts().changed === 1);
    const update = context.calls.find(
      (call) => call.name === "office_owner_update_identity",
    );
    assert.deepEqual(update.args, {
      p_user_id: targetId,
      p_username: "new.owner-1",
      p_real_name: "李 Jean-Luc サトウ",
      p_reason: "登録表記の訂正",
    });
    assert.equal(
      context.calls.filter((call) => call.name === "office_owner_account")
        .length,
      1,
    );
    assert.equal(context.counts().ownIdentityChanged, 0);
    assert.equal(
      context.dialog.querySelector('[name="real_name"]').value,
      "李 Jean-Luc サトウ",
    );
    assert.equal(
      context.calls.some((call) => call.kind === "edge"),
      false,
    );
    assert.equal(
      context.notices.some(([, error]) => error),
      false,
    );
  } finally {
    context.close();
  }
});
test("an unverified legacy Owner can update their saved Unicode name and refresh the current header independently of the directory", async () => {
  const context = app({
    targetUserId: ownerId,
    account: {
      user_id: ownerId,
      real_name: "カンギ",
      profile_enrollment_pending: true,
      name_verified_at: null,
      can_edit_real_name: true,
    },
    onChanged: () => {
      throw new Error("directory refresh failed");
    },
  });
  try {
    await context.open();
    const form = context.dialog.querySelector('[data-owner-form="identity"]');
    assert.equal(form.elements.namedItem("real_name").readOnly, false);
    form.elements.namedItem("real_name").value = "カン・ギ Ana-María";
    form.elements.namedItem("reason").value = "本人が未確認の登録表記を訂正";
    context.submit(form);
    await until(() => context.counts().changed === 1);
    assert.equal(context.counts().ownIdentityChanged, 1);
    assert.equal(
      context.dialog.querySelector('[name="real_name"]').value,
      "カン・ギ Ana-María",
    );
    assert.equal(context.notices[0][0], "アカウント情報を保存しました。");
    assert.match(context.notices.at(-1)[0], /変更は保存されましたが/);
    assert.equal(
      context.notices.some(([message]) => /保存できませんでした/.test(message)),
      false,
    );
  } finally {
    context.close();
  }
});
test("a failed header refresh does not reverse a confirmed save or prevent the directory refresh", async () => {
  const context = app({
    targetUserId: ownerId,
    account: { user_id: ownerId },
    onOwnIdentityChanged: () => {
      throw new Error("header refresh failed");
    },
  });
  try {
    await context.open();
    const form = context.dialog.querySelector('[data-owner-form="identity"]');
    form.elements.namedItem("real_name").value = "金 Ana";
    form.elements.namedItem("reason").value = "登録表記の訂正";
    context.submit(form);
    await until(() => context.counts().changed === 1);
    assert.equal(context.counts().ownIdentityChanged, 1);
    assert.equal(context.notices[0][1], undefined);
    assert.match(context.notices.at(-1)[0], /変更は保存されましたが/);
    assert.equal(context.notices.at(-1)[1], true);
  } finally {
    context.close();
  }
});
test("identity mutation accepts only the exact saved account response and never reports malformed results as success", async () => {
  for (const result of [
    { data: null, error: null },
    { data: false, error: null },
    { data: { success: false }, error: null },
    {
      data: { user_id: targetId, username: "staff.name", real_name: "wrong name" },
      error: null,
    },
    {
      data: { user_id: ownerId, username: "staff.name", real_name: "新しい名前" },
      error: null,
    },
  ]) {
    const context = app({ update: () => result });
    try {
      await context.open();
      const form = context.dialog.querySelector('[data-owner-form="identity"]');
      form.elements.namedItem("real_name").value = "新しい名前";
      form.elements.namedItem("reason").value = "登録表記の訂正";
      form.elements.namedItem("name_change_acknowledged").checked = true;
      context.submit(form);
      await until(() => context.dialog.querySelector('[role="alert"]')?.textContent);
      assert.match(context.dialog.textContent, /保存結果を確認できませんでした/);
      assert.equal(context.counts().changed, 0);
      assert.equal(context.counts().ownIdentityChanged, 0);
      assert.equal(context.notices.length, 0);
    } finally {
      context.close();
    }
  }
});
test("verified self name remains unchanged for a login ID edit, while a missing legacy name may remain null", async () => {
  for (const verified of [true, false]) {
    const context = app({
      targetUserId: ownerId,
      account: {
        user_id: ownerId,
        real_name: verified ? "確認された名前" : null,
        profile_enrollment_pending: !verified,
        name_verified_at: verified ? "2026-10-15T05:00:00Z" : null,
        can_edit_real_name: !verified,
      },
    });
    try {
      await context.open();
      const form = context.dialog.querySelector('[data-owner-form="identity"]');
      form.elements.namedItem("username").value = "NEW.Owner";
      form.elements.namedItem("reason").value = "ログインIDの訂正";
      context.submit(form);
      await until(() => context.counts().changed === 1);
      assert.equal(
        context.calls.find((call) => call.name === "office_owner_update_identity")
          .args.p_real_name,
        verified ? "確認された名前" : null,
      );
      assert.equal(context.counts().ownIdentityChanged, 1);
    } finally {
      context.close();
    }
  }
});
test("identity errors distinguish an MFA challenge and verified self correction without exposing server details", async () => {
  for (const [message, expected] of [
    ["owner_mfa_required", /多要素認証.*その認証も完了/],
    ["self_verified_name_requires_review", /別の最高管理者/],
  ]) {
    const context = app({
      update: () => ({
        data: null,
        error: { code: "42501", message, details: "private server detail" },
      }),
    });
    try {
      await context.open();
      const form = context.dialog.querySelector('[data-owner-form="identity"]');
      form.elements.namedItem("username").value = "new.owner";
      form.elements.namedItem("reason").value = "ログインIDの訂正";
      context.submit(form);
      await until(() => context.dialog.querySelector('[role="alert"]')?.textContent);
      assert.match(context.dialog.querySelector('[role="alert"]').textContent, expected);
      assert.equal(context.dialog.textContent.includes("private server detail"), false);
      assert.equal(context.counts().changed, 0);
    } finally {
      context.close();
    }
  }
});
test("pending identity saves prevent duplicate submissions and refresh a confirmed self change even after closing the dialog", async () => {
  let complete;
  let submitted;
  const context = app({
    targetUserId: ownerId,
    account: { user_id: ownerId },
    update: (args) => {
      submitted = args;
      return new Promise((resolve) => {
        complete = resolve;
      });
    },
  });
  try {
    await context.open();
    const form = context.dialog.querySelector('[data-owner-form="identity"]');
    form.elements.namedItem("real_name").value = "新しい名前";
    form.elements.namedItem("reason").value = "登録表記の訂正";
    context.submit(form);
    context.submit(form);
    await until(() => Boolean(complete));
    assert.equal(
      context.calls.filter((call) => call.name === "office_owner_update_identity").length,
      1,
    );
    context.dialog.querySelector(".owner-account-close").click();
    complete({
      data: {
        ...account,
        user_id: submitted.p_user_id,
        username: submitted.p_username,
        real_name: submitted.p_real_name,
      },
      error: null,
    });
    await until(() => context.counts().changed === 1);
    assert.equal(context.dialog.open, false);
    assert.equal(context.counts().ownIdentityChanged, 1);
    assert.equal(context.notices[0][1], undefined);
  } finally {
    context.close();
  }
});
test("a saved result from a signed-out identity cannot update the next account's header or directory", async () => {
  let complete;
  const context = app({
    targetUserId: ownerId,
    account: { user_id: ownerId },
    update: () => new Promise((resolve) => { complete = resolve; }),
  });
  try {
    await context.open();
    const form = context.dialog.querySelector('[data-owner-form="identity"]');
    form.elements.namedItem("real_name").value = "新しい名前";
    form.elements.namedItem("reason").value = "登録表記の訂正";
    context.submit(form);
    await until(() => Boolean(complete));
    context.emit("SIGNED_OUT", null);
    complete({
      data: {
        ...account,
        user_id: ownerId,
        username: account.username,
        real_name: "新しい名前",
      },
      error: null,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(context.counts().ownIdentityChanged, 0);
    assert.equal(context.counts().changed, 0);
    assert.equal(context.notices.length, 0);
    assert.equal(context.dialog.open, false);
  } finally {
    context.close();
  }
});
test("verified self real name is read-only while an unverified self name remains editable", async () => {
  for (const verified of [true, false]) {
    const context = app({
      targetUserId: ownerId,
      account: {
        user_id: ownerId,
        name_verified_at: verified ? "2026-10-15T05:00:00Z" : null,
        can_edit_real_name: !verified,
      },
    });
    try {
      await context.open();
      const form = context.dialog.querySelector('[data-owner-form="identity"]');
      assert.equal(form.elements.namedItem("real_name").readOnly, verified);
      assert.equal(form.elements.namedItem("username").readOnly, false);
      if (verified) assert.match(form.textContent, /別の最高管理者/);
    } finally {
      context.close();
    }
  }
});
test("reset requires explicit acknowledgment, matching inputs and the native Unicode byte bound", async () => {
  const context = app();
  try {
    await context.open();
    const form = context.resetForm();
    form.elements.namedItem("reset_acknowledged").checked = false;
    context.submit(form);
    assert.equal(
      context.calls.some((call) => call.kind === "edge"),
      false,
    );
    form.elements.namedItem("reset_acknowledged").checked = true;
    form.elements.namedItem("password_confirmation").value =
      "different-password";
    context.submit(form);
    assert.equal(
      form.elements
        .namedItem("password_confirmation")
        .getAttribute("aria-invalid"),
      "true",
    );
    const oversized = "가".repeat(24) + "a";
    form.elements.namedItem("password").value = oversized;
    form.elements.namedItem("password_confirmation").value = oversized;
    context.submit(form);
    assert.equal(
      form.elements.namedItem("password").getAttribute("aria-invalid"),
      "true",
    );
    assert.equal(
      context.calls.some((call) => call.kind === "edge"),
      false,
    );
    const boundary = "가".repeat(24);
    context.resetForm(boundary);
    const toggle = form.querySelector(
      '[data-owner-password-toggle="password"]',
    );
    toggle.click();
    assert.equal(form.elements.namedItem("password").type, "text");
    assert.equal(toggle.getAttribute("aria-pressed"), "true");
    context.submit(form);
    await until(() => context.counts().changed === 1);
    const request = context.calls.find((call) => call.kind === "edge").request;
    assert.deepEqual(request.body, {
      action: "owner_reset_password",
      operation_id: operationId,
      user_id: targetId,
      password: boundary,
      password_confirmation: boundary,
      reason: "本人の依頼を確認",
    });
    assert.equal(
      request.headers.Authorization,
      "Bearer current-verified-token",
    );
    assert.equal(context.window.localStorage.length, 0);
    assert.equal(context.dialog.textContent.includes(boundary), false);
    assert.equal(context.dialog.querySelector('[name="password"]').value, "");
  } finally {
    context.close();
  }
});
test("duplicate submit is prevented and passwords clear while the result is still pending", async () => {
  let resolve;
  const context = app({
    reset: () =>
      new Promise((done) => {
        resolve = done;
      }),
  });
  try {
    await context.open();
    const form = context.resetForm();
    context.submit(form);
    context.submit(form);
    await until(() => context.calls.some((call) => call.kind === "edge"));
    assert.equal(
      context.calls.filter((call) => call.kind === "edge").length,
      1,
    );
    assert.equal(form.elements.namedItem("password").value, "");
    assert.equal(form.elements.namedItem("password_confirmation").value, "");
    assert.equal(form.querySelector('button[type="submit"]').disabled, true);
    assert.equal(context.counts().changed, 0);
    resolve({
      data: {
        success: true,
        code: "owner_password_reset_succeeded",
        operation_id: operationId,
      },
      error: null,
    });
    await until(() => context.counts().changed === 1);
  } finally {
    context.close();
  }
});
test("uncertain and audit-partial outcomes block repeated resets without refreshing or announcing success", async () => {
  const context = app({
    reset: () => ({
      data: null,
      error: {
        context: Response.json(
          { error: "owner_password_reset_uncertain" },
          { status: 409 },
        ),
      },
    }),
  });
  try {
    await context.open();
    context.submit(context.resetForm());
    await until(() => context.notices.length > 0);
    assert.equal(context.notices.at(-1)[1], true);
    assert.match(context.dialog.textContent, /再設定を繰り返さず/);
    assert.equal(
      context.dialog.querySelector("[data-owner-password-state]").textContent,
      "確認不可",
    );
    assert.equal(
      context.calls.filter((call) => call.name === "office_owner_account")
        .length,
      1,
    );
    assert.equal(context.counts().changed, 0);
    const form = context.resetForm();
    context.submit(form);
    assert.equal(
      context.calls.filter((call) => call.kind === "edge").length,
      1,
    );
    context.dialog.querySelector(".owner-account-close").click();
    await context.open();
    assert.equal(
      context.passwordForm().querySelector('button[type="submit"]').disabled,
      true,
    );
    assert.match(context.passwordForm().textContent, new RegExp(operationId));
  } finally {
    context.close();
  }
});
test("already-succeeded replay is distinguished from applying the newly typed password", async () => {
  const context = app({
    reset: () => ({
      data: {
        success: true,
        code: "owner_password_reset_already_succeeded",
        operation_id: operationId,
      },
      error: null,
    }),
  });
  try {
    await context.open();
    context.submit(context.resetForm());
    await until(() => context.counts().changed === 1);
    assert.match(
      context.notices[0][0],
      /今回入力したパスワードで再変更していません/,
    );
    assert.equal(context.notices[0][1], undefined);
  } finally {
    context.close();
  }
});
test("reauthentication errors request a fresh login and never claim a password change", async () => {
  const context = app({
    reset: () => ({
      data: null,
      error: {
        context: Response.json(
          { error: "reauthentication_required" },
          { status: 409 },
        ),
      },
    }),
  });
  try {
    await context.open();
    context.submit(context.resetForm());
    await until(() => context.notices.length > 0);
    assert.match(context.notices.at(-1)[0], /ログインし直して/);
    assert.match(context.notices.at(-1)[0], /多要素認証/);
    assert.equal(context.notices.at(-1)[1], true);
    assert.equal(context.counts().changed, 0);
    assert.equal(context.dialog.querySelector('[name="password"]').value, "");
    assert.equal(
      context.passwordForm().querySelector('button[type="submit"]').disabled,
      false,
    );
  } finally {
    context.close();
  }
});
test("self reset clears the dialog and closes the cached session without reading the now-revoked account", async () => {
  const context = app({ targetUserId: ownerId, account: { user_id: ownerId } });
  try {
    await context.open();
    context.submit(context.resetForm());
    await until(() => context.counts().signOut === 1);
    assert.equal(context.dialog.open, false);
    assert.equal(context.dialog.querySelector('[name="password"]').value, "");
    assert.equal(
      context.calls.filter((call) => call.name === "office_owner_account")
        .length,
      1,
    );
    assert.equal(context.counts().changed, 0);
    assert.match(context.notices.at(-1)[0], /ログインし直して/);
  } finally {
    context.close();
  }
});
test("close, Escape and disposal clear passwords, restore keyboard focus and unsubscribe", async () => {
  const context = app();
  try {
    await context.open();
    context.resetForm();
    const close = context.dialog.querySelector(".owner-account-close");
    close.focus();
    close.dispatchEvent(
      new context.window.KeyboardEvent("keydown", {
        key: "Tab",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    assert.equal(
      context.window.document.activeElement,
      context.dialog.querySelector(
        'button[data-owner-action="reset-password"]',
      ),
    );
    context.dialog.dispatchEvent(
      new context.window.Event("cancel", { cancelable: true }),
    );
    assert.equal(context.dialog.open, false);
    assert.equal(context.dialog.querySelector('[name="password"]').value, "");
    assert.equal(context.window.document.activeElement, context.trigger);
    await context.open();
    context.resetForm();
    context.controller.dispose();
    assert.equal(context.dialog.querySelector('[name="password"]'), null);
    assert.equal(context.counts().unsubscribed, 1);
  } finally {
    context.dom.window.close();
  }
});
test("logout while the current session is checked prevents dispatch and any stale callback", async () => {
  let resolve;
  const context = app({
    session: () =>
      new Promise((done) => {
        resolve = done;
      }),
  });
  try {
    await context.open();
    context.submit(context.resetForm());
    await until(() => Boolean(resolve));
    context.emit("SIGNED_OUT", null);
    resolve({
      data: { session: { access_token: "old-token", user: { id: ownerId } } },
      error: null,
    });
    await new Promise((done) => setTimeout(done, 10));
    assert.equal(
      context.calls.some((call) => call.kind === "edge"),
      false,
    );
    assert.equal(context.dialog.open, false);
    assert.equal(context.dialog.querySelector('[name="password"]').value, "");
    assert.equal(context.notices.length, 0);
  } finally {
    context.close();
  }
});
test("late account reads cannot refill a closed or invalidated dialog", async () => {
  let resolve;
  const context = app({
    read: () =>
      new Promise((done) => {
        resolve = done;
      }),
  });
  try {
    context.trigger.click();
    context.dialog.querySelector(".owner-account-close").click();
    context.invalidate();
    resolve({ data: account, error: null });
    await new Promise((done) => setTimeout(done, 10));
    assert.equal(context.dialog.querySelector("form"), null);
    assert.equal(context.dialog.open, false);
  } finally {
    context.close();
  }
});
