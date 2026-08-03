/* =====================================================================
   06-profile.js — プロフィール（部屋）: SPEC §5.9
   2人で同じアプリを使う。台本は共有、進捗は完全に分ける。
   ここは「今どちらの部屋か」を持つだけの小さなモジュールにする。
   キーの組み立ては 00-store.js 側で行う。
   ===================================================================== */
;(function (EST) {
  'use strict';

  var LS_KEY = 'est-profile';

  // 権限は §5.9 の表のとおり。mari は練習専用で、編集系の導線は出さない。
  var PROFILES = [
    { id: 'tamo', label: 'タモやん', sub: '台本を作る人', canEdit: true },
    { id: 'mari', label: 'まり',     sub: '練習する人',   canEdit: false }
  ];

  var current = null;   // 未選択のあいだは null

  function all() { return PROFILES.slice(); }

  function find(id) {
    var hit = null;
    PROFILES.forEach(function (p) { if (p.id === id) hit = p; });
    return hit;
  }

  // 起動時に localStorage から復元する。IndexedDB に置かないのは、
  // 「どの部屋か」がDBを開くより前に決まっていないとキーを作れないため。
  function restore() {
    try {
      var id = localStorage.getItem(LS_KEY);
      if (find(id)) { current = id; return id; }
    } catch (e) { /* プライベートモード等 */ }
    return null;
  }

  function set(id) {
    if (!find(id)) throw new Error('不明なプロフィールです: ' + id);
    current = id;
    try { localStorage.setItem(LS_KEY, id); } catch (e) {}
    return id;
  }

  function get() { return current; }
  function isChosen() { return !!current; }

  function info() { return find(current) || PROFILES[0]; }
  function label() { return info().label; }

  // 編集系（台本の作成・編集・削除・配信用書き出し）を出してよいか
  function canEdit() { return !!(find(current) && find(current).canEdit); }

  function clear() {
    current = null;
    try { localStorage.removeItem(LS_KEY); } catch (e) {}
  }

  EST.profile = {
    LS_KEY: LS_KEY,
    all: all,
    restore: restore,
    set: set,
    get: get,
    isChosen: isChosen,
    info: info,
    label: label,
    canEdit: canEdit,
    clear: clear
  };
})(window.EST = window.EST || {});
