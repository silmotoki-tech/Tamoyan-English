/* =====================================================================
   15-ui-search.js — 横断検索（SPEC §4.2）
   全トピックを対象に日本語でも英語でも部分一致で引ける。検索は「これから
   見に行く」操作であって、思い出せなかった記録（§4.1）の対象ではない。
   練習画面（F5）がまだ無いので、ヒットからの遷移先はトピック詳細にする。
   ===================================================================== */
;(function (EST) {
  'use strict';

  var h = null;
  function ui() { h = EST.ui.h; return EST.ui; }

  var resultsBox = null;
  var allTopics = [];

  function renderSearch(root) {
    var U = ui();
    EST.app.setBar('検索', []);

    var input = h('input', {
      type: 'text', placeholder: '日本語でも英語でも入力してください',
      onInput: function (e) { runSearch(e.target.value); }
    });

    resultsBox = h('div', { style: { marginTop: '.7rem' } });

    U.mount(root, [
      h('div', { class: 'card' }, [input]),
      resultsBox
    ]);

    EST.store.getAll('topics').then(function (topics) {
      // §5.9 検索対象は自分の部屋に属するトピックだけ
      allTopics = EST.profile.visible(topics);
      drawHint();
      try { input.focus(); } catch (e) {}
    });
  }

  function drawHint() {
    ui().mount(resultsBox, h('div', { class: 'empty', text: 'キーワードを入力してください。' }));
  }

  function runSearch(raw) {
    var U = ui();
    var q = String(raw || '').trim();
    if (!q) { drawHint(); return; }
    var nq = EST.schema.normalizeForSearch(q);

    var groups = [];
    allTopics.forEach(function (t) {
      var hits = (t.lines || []).filter(function (l) { return !l.skip; }).filter(function (l) {
        return EST.schema.normalizeForSearch(l.en).indexOf(nq) >= 0
            || EST.schema.normalizeForSearch(l.ja).indexOf(nq) >= 0;
      });
      if (hits.length) groups.push({ topic: t, hits: hits });
    });

    if (!groups.length) {
      U.mount(resultsBox, h('div', { class: 'empty', text: '見つかりませんでした。' }));
      return;
    }
    U.mount(resultsBox, groups.map(groupBox));
  }

  function groupBox(g) {
    var U = ui();
    return h('div', { class: 'card' }, [
      h('button', {
        class: 'card__title', style: { background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--ink)', textAlign: 'left' },
        onClick: function () { location.hash = '#/topic/' + encodeURIComponent(g.topic.id); }
      }, g.topic.title || '(無題)'),
      h('div', {}, g.hits.map(function (l) {
        return h('div', { class: 'line-view' }, [
          h('div', { class: 'grow' }, [
            h('div', { class: 'line-view__ja', text: l.ja || '(和訳なし)' }),
            h('div', { class: 'line-view__en en', text: l.en })
          ])
        ]);
      }))
    ]);
  }

  EST.uiSearch = { renderSearch: renderSearch };
})(window.EST = window.EST || {});
