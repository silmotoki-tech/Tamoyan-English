/* =====================================================================
   17-ui-progress.js — 進捗画面（SPEC §1.9。F8）

   トピックごとに「定着した行 X/Y」「レイテンシ推移グラフ」「継続日数」
   「直近の日次ログ」を出す。グラフはこれ1つだけにする（§1.9）。統計を
   増やすとアプリを見る時間が増えて音読する時間が減る、という方針どおり。
   外部のグラフライブラリは使わず、SVGを直接組み立てる。
   ===================================================================== */
;(function (EST) {
  'use strict';

  var h = null;
  function ui() { h = EST.ui.h; return EST.ui; }

  // 調整用の定数
  var GRAPH_W = 320, GRAPH_H = 120, GRAPH_PAD = 8;
  var SESSION_LOG_SHOW_DAYS = 14;   // 日次ログに出す直近日数

  function renderProgress(view, topicId) {
    var U = ui();
    EST.store.get('topics', topicId).then(function (topic) {
      if (!topic) {
        EST.app.setBar('進捗', []);
        U.mount(view, h('div', { class: 'empty', text: 'このトピックは見つかりませんでした。' }));
        return;
      }
      if (!EST.profile.canSee(topic)) {
        location.hash = EST.profile.canEdit() ? ('#/edit/' + encodeURIComponent(topic.id)) : '#/';
        return;
      }
      EST.app.setBar((topic.title || '(無題)') + ' の進捗', [
        h('button', { class: 'btn btn--sm', text: 'トピックへ',
          onClick: function () { location.hash = '#/topic/' + encodeURIComponent(topic.id); } })
      ]);

      Promise.all([
        EST.stage.loadTopicProgress(topic.id, topic),
        EST.mastery.topicMasterySummary(topic)
      ]).then(function (r) {
        var tp = r[0], summary = r[1];
        U.mount(view, [
          masteryCard(summary),
          latencyCard(tp),
          streakCard(tp),
          sessionLogCard(tp)
        ]);
      });
    });
  }

  /* ---- 定着した行 X/Y ------------------------------------------------- */
  function masteryCard(summary) {
    var pct = summary.total ? Math.round((summary.mastered / summary.total) * 100) : 0;
    return h('div', { class: 'card' }, [
      h('h2', { class: 'card__title', text: '定着した行' }),
      h('div', { class: 'stat-bar', style: { position: 'static', marginTop: '.3rem' } }, [
        h('span', {}, [h('b', { text: String(summary.mastered) }), ' / ' + summary.total + ' 行']),
        h('span', {}, [h('b', { text: pct + '%' })])
      ])
    ]);
  }

  /* ---- レイテンシ推移グラフ -------------------------------------------
     横軸=累計回数、縦軸=平均レイテンシ。点が少ない（3点未満）うちは
     グラフの形に意味が無いので、素直に「まだデータが足りません」を出す。 */
  function latencyCard(tp) {
    var trend = tp.latencyTrend || [];
    var body;
    if (trend.length < 3) {
      body = h('div', { class: 'small muted', text: 'まだデータが足りません（あと' + Math.max(0, 3 - trend.length) + '回）。' });
    } else {
      body = latencySvg(trend);
    }
    return h('div', { class: 'card' }, [
      h('h2', { class: 'card__title', text: 'レイテンシの推移' }),
      h('div', { class: 'tiny muted', style: { marginBottom: '.3rem' }, text: '横軸: 累計回数　縦軸: レイテンシ（秒）' }),
      body
    ]);
  }

  function latencySvg(trend) {
    var xs = trend.map(function (p) { return p.totalCount; });
    var ys = trend.map(function (p) { return p.avgMs; });
    var minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs);
    var minY = 0, maxY = Math.max.apply(null, ys) * 1.1 || 1;
    var w = GRAPH_W - GRAPH_PAD * 2, hh = GRAPH_H - GRAPH_PAD * 2;

    function px(x) { return GRAPH_PAD + (maxX === minX ? w / 2 : ((x - minX) / (maxX - minX)) * w); }
    function py(y) { return GRAPH_PAD + hh - (maxY === minY ? 0 : ((y - minY) / (maxY - minY)) * hh); }

    var pts = trend.map(function (p) { return px(p.totalCount).toFixed(1) + ',' + py(p.avgMs).toFixed(1); }).join(' ');
    var last = trend[trend.length - 1];

    // 数値だけを埋め込むテンプレート（ユーザー由来の文字列は入れない）ので innerHTML でよい。
    var svg = ''
      + '<svg viewBox="0 0 ' + GRAPH_W + ' ' + GRAPH_H + '" width="100%" height="' + GRAPH_H + '" class="latency-svg">'
      + '<polyline points="' + pts + '" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />'
      + '<circle cx="' + px(last.totalCount).toFixed(1) + '" cy="' + py(last.avgMs).toFixed(1) + '" r="3" fill="currentColor" />'
      + '</svg>';

    var box = h('div', { class: 'latency-graph' });
    box.innerHTML = svg;
    var caption = h('div', { class: 'tiny muted', style: { marginTop: '.2rem' } }, [
      '直近: ' + (last.avgMs / 1000).toFixed(1) + '秒（' + last.totalCount + '回目）　最速: '
      + (Math.min.apply(null, ys) / 1000).toFixed(1) + '秒'
    ]);
    return h('div', {}, [box, caption]);
  }

  /* ---- 継続日数 --------------------------------------------------------- */
  function streakCard(tp) {
    var n = EST.stage.currentStreak(tp);
    return h('div', { class: 'card' }, [
      h('h2', { class: 'card__title', text: '継続日数' }),
      h('div', { class: 'stat-bar', style: { position: 'static', marginTop: '.3rem' } }, [
        h('span', {}, [h('b', { text: String(n) }), ' 日連続'])
      ])
    ]);
  }

  /* ---- 直近の日次ログ ----------------------------------------------------- */
  function sessionLogCard(tp) {
    var list = (tp.sessions || []).slice(-SESSION_LOG_SHOW_DAYS).reverse();
    if (!list.length) {
      return h('div', { class: 'card' }, [
        h('h2', { class: 'card__title', text: '日次ログ' }),
        h('div', { class: 'small muted', text: 'まだ記録がありません。' })
      ]);
    }
    return h('div', { class: 'card' }, [
      h('h2', { class: 'card__title', text: '日次ログ（直近' + list.length + '日）' }),
      h('div', {}, list.map(function (s) {
        return h('div', { class: 'row row--tight', style: { justifyContent: 'space-between', padding: '.2rem 0' } }, [
          h('span', { class: 'tiny muted', text: s.date }),
          h('span', { class: 'tiny', text: (s.laps || 0) + '周 / ' + (s.minutes || 0) + '分' })
        ]);
      }))
    ]);
  }

  EST.uiProgress = { renderProgress: renderProgress };
})(window.EST = window.EST || {});
