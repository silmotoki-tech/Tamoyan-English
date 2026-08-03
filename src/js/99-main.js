/* =====================================================================
   99-main.js — 起動とハッシュルーティング
   ルートは location.hash だけで表す。サーバ設定が要らず、
   単一HTMLをどこに置いても壊れないため。
   ===================================================================== */
;(function (EST) {
  'use strict';

  var viewEl = null, barEl = null;

  /* ---- テーマと文字サイズ ------------------------------------------------ */
  function applyTheme(s) {
    var root = document.documentElement;
    root.setAttribute('data-theme', s && s.theme ? s.theme : 'auto');
    root.style.setProperty('--fs', String((s && Number(s.fontScale)) || 1));
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
    return { name: 'home' };
  }

  function route() {
    var r = currentRoute();
    window.scrollTo(0, 0);
    try {
      if (r.name === 'home') EST.uiHome.renderHome(viewEl);
      else if (r.name === 'import') EST.uiImport.renderImport(viewEl);
      else if (r.name === 'edit') EST.uiImport.renderEditor(viewEl, r.id);
      else if (r.name === 'topic') EST.uiHome.renderTopic(viewEl, r.id);
      else if (r.name === 'settings') EST.uiSettings.render(viewEl);
    } catch (e) {
      console.error('[route]', e);
      EST.ui.mount(viewEl, EST.ui.h('div', { class: 'note-box note-box--err',
        text: '画面の表示に失敗しました: ' + (e && e.message || e) }));
    }
  }

  /* ---- サンプル台本の投入（付録B） --------------------------------------- */
  // 短い台本（12行）と長い台本（22行・4ブロック）の両方で確認できるようにする。
  function seedSamples(force) {
    var list = EST.SAMPLES || [];
    if (!list.length) return Promise.resolve(0);
    return EST.store.loadSettings().then(function (s) {
      if (s.samplesSeeded && !force) return 0;
      var topics = list.map(function (raw) { return EST.schema.normalizeTopic(raw); });
      return EST.store.bulkPut('topics', topics).then(function () {
        s.samplesSeeded = true;
        return EST.store.saveSettings(s);
      }).then(function () { return topics.length; });
    });
  }

  /* ---- 起動 --------------------------------------------------------------- */
  function boot() {
    viewEl = document.getElementById('view');
    barEl = document.getElementById('appbar');
    applyThemeEarly();

    EST.store.loadSettings()
      .then(function (s) {
        applyTheme(s);
        return seedSamples(false);
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
    currentRoute: currentRoute
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window.EST = window.EST || {});
