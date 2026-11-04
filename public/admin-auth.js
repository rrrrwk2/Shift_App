// =========================================================
// 作成担当用の画面（希望の一覧・シフト作成）で共通のログイン
//
// ・LINEでログインして、その人が「管理者」として登録されているかをサーバーで確かめる
// ・管理者でなければ、招待コードの入力（最初の1人だけは合言葉）を出す
// ・パソコンのブラウザでも、LINEのログイン画面を通して使える
// =========================================================

let adminToken = ""; // LINEが発行した本人の証明書。サーバーへのリクエストに付ける

// 画面に必要な部品（各画面のHTMLに同じidで置いてある）
const authEls = {
  section: document.getElementById("auth-section"),
  content: document.getElementById("content"),
  userBar: document.getElementById("user-bar"),
};

// ログインして、管理者だと確認できたら onReady() を呼ぶ
async function adminLogin(onReady) {
  try {
    showAuth("<p style='margin:0'>LINEで本人確認をしています…</p>");
    const { liff_id } = await api("/api/config");
    if (!liff_id) {
      showAuth("<p style='margin:0'>LINE連携の設定がまだ終わっていません。</p>");
      return;
    }
    if (typeof liff === "undefined") {
      showAuth("<p style='margin:0'>LINEの部品を読み込めませんでした。通信状態を確認してください。</p>");
      return;
    }
    await liff.init({ liffId: liff_id });

    // まだログインしていなければ、ログインボタンを出す（LINEアプリの中なら最初からログイン済み）
    if (!liff.isLoggedIn()) {
      showAuth(`
        <h2>ログイン</h2>
        <p class="hint">この画面は、登録された管理者だけが使えます。LINEでログインしてください。</p>
        <button id="login-button" type="button" class="primary">LINEでログイン</button>`);
      document.getElementById("login-button").addEventListener("click", () =>
        liff.login({ redirectUri: location.href })
      );
      return;
    }

    adminToken = liff.getIDToken();
    const me = await api("/api/admin/me", { token: adminToken });
    if (me.admin) {
      authEls.section.hidden = true;
      authEls.content.hidden = false;
      renderUserBar(me.line_name);
      await onReady();
      return;
    }
    showRegister(me, onReady);
  } catch (err) {
    handleAuthError(err);
  }
}

// 管理者として登録されていない人向け：招待コード（最初の1人だけは合言葉）の入力
function showRegister(me, onReady) {
  const first = me.can_bootstrap;
  showAuth(`
    <h2>${first ? "最初の管理者の登録" : "管理者の登録"}</h2>
    <p class="hint">
      LINE「${escapeHtml(me.line_name || "")}」でログインしています。この画面は登録された管理者だけが使えます。
      ${
        first
          ? "まだ管理者が1人もいないので、Cloudflareに設定した管理用の合言葉を入れると、あなたが最初の管理者になります。"
          : "管理者から受け取った「管理者の招待コード」を入れてください。"
      }
    </p>
    <div class="row">
      <input id="register-input" type="${first ? "password" : "text"}" autocomplete="off"
             placeholder="${first ? "管理用の合言葉" : "例：K7P2-QX9M"}" />
      <button id="register-button" type="button" style="flex: 0 0 auto">登録</button>
    </div>
    <div id="register-message" class="message error"></div>
    <button id="logout-inline" type="button" class="secondary">別のLINEアカウントでログインし直す</button>`);

  const input = document.getElementById("register-input");
  const message = document.getElementById("register-message");
  const submit = async () => {
    const value = input.value.trim();
    if (!value) return;
    try {
      await api(first ? "/api/admin/bootstrap" : "/api/admin/join", {
        method: "POST",
        body: first ? { key: value } : { code: value },
        token: adminToken,
      });
      await adminLogin(onReady); // 登録できたら最初からやり直す（今度は管理者として入れる）
    } catch (err) {
      if (err instanceof AuthError) handleAuthError(err);
      else message.textContent = err.message;
    }
  };
  document.getElementById("register-button").addEventListener("click", submit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
  });
  document.getElementById("logout-inline").addEventListener("click", adminLogout);
}

// 右上の「ログイン中の人」と「ログアウト」
function renderUserBar(name) {
  if (!authEls.userBar) return;
  authEls.userBar.innerHTML = `<span>${escapeHtml(name || "")} さんでログイン中</span>
    <button id="logout-button" type="button">ログアウト</button>`;
  document.getElementById("logout-button").addEventListener("click", adminLogout);
}

function adminLogout() {
  try {
    liff.logout(); // この端末でのLINEログインを終える（共用のパソコンでは必ず押す）
  } catch {
    // LINEアプリの中ではログアウトできないので何もしない
  }
  adminToken = "";
  if (authEls.userBar) authEls.userBar.innerHTML = "";
  authEls.content.hidden = true;
  showAuth(`
    <h2>ログアウトしました</h2>
    <button id="relogin-button" type="button" class="primary">もう一度ログイン</button>`);
  document.getElementById("relogin-button").addEventListener("click", () => location.reload());
}

function showAuth(html) {
  authEls.content.hidden = true;
  authEls.section.hidden = false;
  authEls.section.innerHTML = html;
}

// 本人確認が切れた・管理者でなくなった、などのとき
function handleAuthError(err) {
  if (err instanceof AuthError) {
    // LINEの証明書の期限が切れたときは、ログインし直してもらう
    showAuth(`
      <p style="margin:0">${escapeHtml(err.message)}</p>
      <button id="relogin-button" type="button" class="secondary">ログインし直す</button>`);
    document.getElementById("relogin-button").addEventListener("click", () => {
      try {
        if (!liff.isInClient()) {
          liff.logout();
          liff.login({ redirectUri: location.href });
          return;
        }
      } catch {
        // 何もしない
      }
      location.reload();
    });
  } else if (err.status === 403) {
    // 管理者から外された場合など
    showAuth(`<p style="margin:0">${escapeHtml(err.message)}</p>`);
  } else {
    showAuth(`<p style="margin:0">読み込みに失敗しました：${escapeHtml(err.message)}</p>`);
  }
}

// 管理者として、サーバーにリクエストを送る
function adminApi(path, options = {}) {
  return api(path, { ...options, token: adminToken });
}
