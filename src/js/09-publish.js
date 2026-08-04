/* =====================================================================
   09-publish.js — 台本の配信と同期（SPEC §6.5）
   タモやんが作った台本を data/scripts.json に置き、
   2人の端末が起動時に取りに行って自動で反映する。

   取れなかったときは何もしない。前回取り込んだ台本が IndexedDB に残って
   いるので練習は続けられる（オフラインでも file:// でも止まらない）。
   ===================================================================== */
;(function (EST) {
  'use strict';

  /* ---- 調整用の定数 ---------------------------------------------------- */
  var FEED_PATH   = 'data/scripts.json';
  var FETCH_MS    = 8000;   // これを超えたら諦める（起動を待たせない）

  // 直近の同期結果。ホームが一度だけ知らせに使う。
  var lastResult = null;

  /* ---- 取得 ------------------------------------------------------------ */
  function fetchFeed() {
    if (typeof fetch !== 'function') return Promise.resolve(null);

    // ?t= を付けるのは GitHub Pages のキャッシュを避けるため（§6.5）
    var url = FEED_PATH + '?t=' + Date.now();
    var opts = { cache: 'no-store' };
    var timer = null;

    if (typeof AbortController === 'function') {
      var ctrl = new AbortController();
      opts.signal = ctrl.signal;
      timer = setTimeout(function () { ctrl.abort(); }, FETCH_MS);
    }

    return fetch(url, opts)
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (json) { return json; })
      .catch(function (e) {
        // 失敗はユーザーに見せない。file:// や圏外では当たり前に起きるため。
        console.info('[publish] 配信を取得できませんでした（前回の台本のまま動きます）:',
                     (e && e.message) || e);
        return null;
      })
      .then(function (v) { if (timer) clearTimeout(timer); return v; });
  }

  /* ---- 同期 ------------------------------------------------------------
     戻り値: null（更新なし）または {added, updated, removed, publishedAt}
  --------------------------------------------------------------------- */
  function sync() {
    return fetchFeed().then(function (feed) {
      if (!feed || !Array.isArray(feed.topics)) return null;
      var publishedAt = Number(feed.publishedAt) || 0;

      return EST.store.loadShared().then(function (shared) {
        // publishedAt が進んでいなければ何もしない
        if (publishedAt && publishedAt <= (Number(shared.publishedAt) || 0)) return null;
        return apply(feed, shared, publishedAt);
      });
    }).then(function (r) {
      lastResult = r;
      return r;
    }).catch(function (e) {
      console.warn('[publish] 同期に失敗しました', e);
      return null;
    });
  }

  function apply(feed, shared, publishedAt) {
    // §6.3: 配信JSONは外部データなので、audience 未指定は "both" で救済する。
    // ここで止めてしまうと、値の抜けた1件のせいで配信全体が反映されなくなる。
    var incoming = feed.topics
      .map(function (t) { return EST.schema.normalizeTopic(t, { rescueAudience: true }); })
      .filter(function (t) { return t.lines.length > 0; });

    return EST.store.getAll('topics').then(function (cur) {
      var curIds = {};
      cur.forEach(function (t) { curIds[t.id] = true; });

      var incomingIds = {};
      incoming.forEach(function (t) { incomingIds[t.id] = true; });

      // 件数は自分の部屋に見えるものだけ数える。相手用の台本が増えたことを
      // 知らされても、こちらの行動は何も変わらないため（§5.9）。
      var added = 0, updated = 0;
      incoming.forEach(function (t) {
        if (!EST.profile.canSee(t)) return;
        if (curIds[t.id]) updated++; else added++;
      });

      // 配信から消えたトピックは一覧からも消す（§6.5）。ただし
      // 手元で作っただけでまだ配信していない台本を巻き込まないよう、
      // 前回の配信に入っていたものだけを対象にする。
      var wasFed = Array.isArray(shared.feedTopicIds) ? shared.feedTopicIds : [];
      var removeIds = wasFed.filter(function (id) { return !incomingIds[id] && curIds[id]; });

      // 削除の件数も、自分の部屋に見えていたものだけを数える
      var curById = {};
      cur.forEach(function (t) { curById[t.id] = t; });
      var removedVisible = removeIds.filter(function (id) { return EST.profile.canSee(curById[id]); }).length;

      var chain = EST.store.bulkPut('topics', incoming);
      removeIds.forEach(function (id) {
        // 進捗レコードは消さない。再配信で復活したときに引き継げるようにする（§6.5）
        chain = chain.then(function () { return EST.store.del('topics', id); });
      });

      return chain.then(function () {
        shared.publishedAt = publishedAt || Date.now();
        shared.feedTopicIds = Object.keys(incomingIds);
        return EST.store.saveShared(shared);
      }).then(function () {
        return { added: added, updated: updated, removed: removedVisible, publishedAt: publishedAt };
      });
    });
  }

  /* ---- 書き出し（タモやんのみ。§6.5 の更新手順2） ----------------------- */
  function buildFeed() {
    return EST.store.getAll('topics').then(function (topics) {
      topics.sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
      return { publishedAt: Date.now(), topics: topics };
    });
  }

  function exportFeedFile() {
    return buildFeed().then(function (feed) {
      EST.ui.download('scripts.json', JSON.stringify(feed, null, 2));
      return feed;
    });
  }

  /* ---- ホームへの通知 ---------------------------------------------------- */
  function takeResult() {
    var r = lastResult;
    lastResult = null;     // 一度だけ出す（毎回出ると邪魔になる）
    return r;
  }

  EST.publish = {
    FEED_PATH: FEED_PATH,
    fetchFeed: fetchFeed,
    sync: sync,
    buildFeed: buildFeed,
    exportFeedFile: exportFeedFile,
    takeResult: takeResult
  };
})(window.EST = window.EST || {});
