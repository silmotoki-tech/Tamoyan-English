/* =====================================================================
   99-main.js — 起動とハッシュルーティング
   ルートは location.hash だけで表す。サーバ設定が要らず、
   単一HTMLをどこに置いても壊れないため。
   ===================================================================== */
;(function (EST) {
  'use strict';

  var viewEl = null, barEl = null;

  /* ---- テーマと文字サイズ ------------------------------------------------ */
  // styles.css の --bg（ライト/ダーク）と同じ値。iOSのステータスバー／
  // 起動画面の色に使う <meta name="theme-color"> をここから合わせる。
  var THEME_BG_LIGHT = '#faf9f7';
  var THEME_BG_DARK = '#17181a';

  function applyTheme(s) {
    var root = document.documentElement;
    var theme = s && s.theme ? s.theme : 'auto';
    root.setAttribute('data-theme', theme);
    root.style.setProperty('--fs', String((s && Number(s.fontScale)) || 1));
    syncThemeColor(theme);
  }

  // <meta name="theme-color"> は本来 prefers-color-scheme で自動追従するが、
  // 設定で明示的に light/dark を選んだときは両方のタグを同じ値に揃えて上書きする。
  // auto に戻したら、それぞれ本来のライト/ダーク値に戻す。
  function syncThemeColor(theme) {
    var light = document.querySelector('meta[name="theme-color"][media*="light"]');
    var dark = document.querySelector('meta[name="theme-color"][media*="dark"]');
    if (!light || !dark) return;
    if (theme === 'light') { light.setAttribute('content', THEME_BG_LIGHT); dark.setAttribute('content', THEME_BG_LIGHT); }
    else if (theme === 'dark') { light.setAttribute('content', THEME_BG_DARK); dark.setAttribute('content', THEME_BG_DARK); }
    else { light.setAttribute('content', THEME_BG_LIGHT); dark.setAttribute('content', THEME_BG_DARK); }
  }

  // DBを開く前に localStorage のミラーから当てる（起動時に一瞬白くならないように）
  function applyThemeEarly() {
    var m = EST.store.readMirror();
    applyTheme(m || { theme: 'auto', fontScale: 1 });
  }

  /* ---- アプリバー -------------------------------------------------------- */
  function setBar(title, actions) {
    var h = EST.ui.h;
    var isHome = (currentRoute().name === 'home');
    EST.ui.mount(barEl, [
      isHome ? null : h('button', {
        class: 'btn btn--ghost btn--sm', text: '←', title: '戻る',
        onClick: function () { history.length > 1 ? history.back() : (location.hash = '#/'); }
      }),
      h('div', { class: 'appbar__title', text: title || '' }),
      h('div', { class: 'appbar__actions' }, actions || [])
    ]);
  }

  /* ---- ルーティング ------------------------------------------------------ */
  function currentRoute() {
    var raw = String(location.hash || '').replace(/^#/, '');
    var parts = raw.split('/').filter(Boolean);
    if (!parts.length) return { name: 'home' };
    if (parts[0] === 'import') return { name: 'import' };
    if (parts[0] === 'settings') return { name: 'settings' };
    if (parts[0] === 'topic') return { name: 'topic', id: decodeURIComponent(parts[1] || '') };
    if (parts[0] === 'edit') return { name: 'edit', id: decodeURIComponent(parts[1] || '') };
    if (parts[0] === 'practice') return { name: 'practice', id: decodeURIComponent(parts[1] || '') };
    if (parts[0] === 'list') return { name: 'list', id: decodeURIComponent(parts[1] || '') };
    if (parts[0] === 'search') return { name: 'search' };
    if (parts[0] === 'vocab-prep') return { name: 'vocab-prep', id: decodeURIComponent(parts[1] || '') };
    if (parts[0] === 'vocab-review') return { name: 'vocab-review' };
    if (parts[0] === 'review') return { name: 'review' };
    return { name: 'home' };
  }

  function route() {
    var r = currentRoute();
    window.scrollTo(0, 0);
    // §7.2 画面遷移時に必ず止める。忘れると別画面で喋り続ける。
    // 通して再生はループなので、発話を止めるだけでは次の行へ進んでしまう。
    // ループごと止めてから cancel する。
    try { EST.uiHome.stopPlayback(); } catch (e) {}
    // 練習セッションはタイマーで自走するので、画面を離れるときに必ず止める。
    // 止めないと次の画面で行が進み続け、TTSもマイクも動いたままになる。
    try { EST.uiPractice.stopSession(); } catch (e) {}
    // F6のS0・語彙復習・再確認も同じくタイマーで自走する（16-ui-vocab.js）。
    try { EST.uiVocab.stopSession(); } catch (e) {}
    try { EST.speech.cancel(); } catch (e) {}
    // マイクも画面をまたいで開いたままにしない。stop()は聞いていなければ何もしない。
    try { EST.mic.stop(); } catch (e) {}
    try {
      if (r.name === 'home') EST.uiHome.renderHome(viewEl);
      else if (r.name === 'import') EST.uiImport.renderImport(viewEl);
      else if (r.name === 'edit') EST.uiImport.renderEditor(viewEl, r.id);
      else if (r.name === 'topic') EST.uiHome.renderTopic(viewEl, r.id);
      else if (r.name === 'practice') EST.uiPractice.renderPractice(viewEl, r.id);
      else if (r.name === 'list') EST.uiList.renderList(viewEl, r.id);
      else if (r.name === 'search') EST.uiSearch.renderSearch(viewEl);
      else if (r.name === 'settings') EST.uiSettings.render(viewEl);
      else if (r.name === 'vocab-prep') EST.uiVocab.renderVocabPrep(viewEl, r.id);
      else if (r.name === 'vocab-review') EST.uiVocab.renderVocabReview(viewEl);
      else if (r.name === 'review') EST.uiVocab.renderReview(viewEl);
    } catch (e) {
      console.error('[route]', e);
      EST.ui.mount(viewEl, EST.ui.h('div', { class: 'note-box note-box--err',
        text: '画面の表示に失敗しました: ' + (e && e.message || e) }));
    }
  }

  /* ---- サンプル台本の投入（付録B） --------------------------------------- */
  // 短い台本（12行）と長い台本（22行・4ブロック）の両方で確認できるようにする。
  // 台本は2人で共有するので、投入済みフラグも共有側（settings の "shared"）に置く。
  // §6.5 由来を後から入れたので、既にある古いレコードには origin が無い。
  // 同梱サンプルのIDと一致するものを seed、それ以外を local として補う。
  // これをやらないと、由来なしのサンプルが配信の削除対象から外れない。
  function backfillOrigins() {
    var sampleIds = {};
    (EST.SAMPLES || []).forEach(function (s) { if (s && s.id) sampleIds[s.id] = true; });
    return EST.store.getAll('topics').then(function (all) {
      var need = all.filter(function (t) { return EST.schema.ORIGINS.indexOf(t.origin) < 0; });
      if (!need.length) return 0;
      need.forEach(function (t) { t.origin = sampleIds[t.id] ? 'seed' : 'local'; });
      return EST.store.bulkPut('topics', need).then(function () { return need.length; });
    });
  }

  function seedSamples(force) {
    var list = EST.SAMPLES || [];
    if (!list.length) return Promise.resolve(0);
    return EST.store.loadShared().then(function (sh) {
      if (sh.samplesSeeded && !force) return 0;
      // 同梱サンプルは audience を持たない場合があるので §6.3 の救済を適用する。
      // §6.5 由来を seed として記録し、配信の削除判定から外す。
      var topics = list.map(function (raw) {
        return EST.schema.normalizeTopic(raw, { rescueAudience: true, origin: 'seed' });
      });
      return EST.store.bulkPut('topics', topics).then(function () {
        sh.samplesSeeded = true;
        return EST.store.saveShared(sh);
      }).then(function () { return topics.length; });
    });
  }

  /* ---- プロフィール選択（§5.9） ------------------------------------------
     起動時に一度だけ聞く。どちらの部屋かが決まらないと進捗のキーが作れないので、
     この画面を通すまで他の画面は出さない。
  --------------------------------------------------------------------- */
  function renderProfilePicker(onPick) {
    var h = EST.ui.h;
    EST.ui.mount(barEl, [h('div', { class: 'appbar__title', text: '英会話台本トレーナー' })]);
    EST.ui.mount(viewEl, h('div', { class: 'card' }, [
      h('h2', { class: 'card__title', text: 'どちらの部屋で使いますか' }),
      h('div', { class: 'small muted', style: { marginBottom: '.6rem' },
        text: '台本も練習の記録も部屋ごとに分かれます。2人とも学習者で、課題は別です。あとから設定で変えられます。' }),
      h('div', {}, EST.profile.all().map(function (p) {
        return h('button', {
          class: 'home-item',
          onClick: function () { EST.profile.set(p.id); onPick(p.id); }
        }, [
          h('span', { class: 'home-item__icon', text: p.canEdit ? '🛠' : '🎧' }),
          h('span', { class: 'home-item__body' }, [
            h('div', { text: p.label }),
            h('div', { class: 'home-item__sub', text: p.sub })
          ])
        ]);
      }))
    ]));
  }

  /* ---- 起動 --------------------------------------------------------------- */
  function boot() {
    viewEl = document.getElementById('view');
    barEl = document.getElementById('appbar');
    applyThemeEarly();
    installSpeechUnlock();

    if (!EST.profile.restore()) {
      renderProfilePicker(function () { start(); });
      return;
    }
    start();
  }

  // §7.2 iOS Safari は最初の発話をユーザージェスチャの同期処理内で行う必要がある。
  // 起動後の最初のタップで解錠する。once なので以降は何もしない。
  function installSpeechUnlock() {
    function once() {
      document.removeEventListener('pointerdown', once, true);
      document.removeEventListener('touchend', once, true);
      try { EST.speech.unlock(); } catch (e) {}
    }
    document.addEventListener('pointerdown', once, true);
    document.addEventListener('touchend', once, true);
  }

  // §6.4 / F7 TopicProgress を §5.6 の形へ移すのは EST.stage.loadTopicProgress()
  // が読むたびにメモリ上で行う（migrateTopicProgress）。実際にIndexedDBへ
  // 書き込まれるのは次の saveTopicProgress() が呼ばれた時点で、そこで
  // 旧形式は上書きされて消える。書き込みが起きる前に一度だけ自動バックアップを
  // 取っておけば、想定外のレコードに当たっても旧形式へ戻せる地点ができる。
  var MIGRATION_BACKUP_FLAG = 'backupBeforeStageMigrationV315';
  function backupBeforeMigrationIfNeeded() {
    return EST.store.loadSettings().then(function (s) {
      if (s[MIGRATION_BACKUP_FLAG]) return;   // 既に取った
      return EST.store.getAll('topicProgress').then(function (rows) {
        var hasOld = rows.some(function (tp) {
          return tp && tp.stage && (!tp.blocks || !Object.keys(tp.blocks).length);
        });
        var mark = function () {
          return EST.store.loadSettings().then(function (s2) {
            s2[MIGRATION_BACKUP_FLAG] = true;
            return EST.store.saveSettings(s2);
          });
        };
        if (!hasOld) return mark();   // 移行対象が無ければ以降は毎回スキップしてよい
        return EST.backup.snapshot('v3.14 TopicProgress 移行前の自動保存').then(mark);
      });
    }).catch(function (e) {
      // バックアップの失敗で起動そのものを止めない
      console.warn('[boot] 移行前バックアップに失敗しました', e);
    });
  }

  function start() {
    EST.store.loadSettings()
      .then(function (s) {
        applyTheme(s);
        EST.speech.applySettings(s);   // §7.5 速度と§7.2 ボイス指定を反映する
        EST.mic.applySettings(s);      // §2.1 較正値を反映する（countRatioはF5が使う）
        return seedSamples(false);
      })
      .then(function () {
        return backupBeforeMigrationIfNeeded();
      })
      .then(function () {
        // 配信を取りに行く前に、由来の無い既存レコードを埋めておく
        return backfillOrigins();
      })
      .then(function () {
        // §6.5 配信の取得。失敗しても何もしないので待っても害はないが、
        // 起動を止めないよう画面を出してから結果を反映する。
        return EST.publish.sync().catch(function () { return null; });
      })
      .then(function () {
        window.addEventListener('hashchange', route);
        route();
      })
      .catch(function (e) {
        console.error('[boot]', e);
        EST.ui.mount(viewEl, EST.ui.h('div', { class: 'note-box note-box--err' }, [
          '起動に失敗しました: ' + (e && e.message || e),
          EST.ui.h('div', { class: 'tiny', style: { marginTop: '.3rem' },
            text: 'プライベートブラウジングだとIndexedDBが使えないことがあります。' })
        ]));
      });
  }

  EST.app = {
    setBar: setBar,
    applyTheme: applyTheme,
    seedSamples: seedSamples,
    route: route,
    currentRoute: currentRoute,
    renderProfilePicker: renderProfilePicker
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window.EST = window.EST || {});
