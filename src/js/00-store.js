/* =====================================================================
   00-store.js — IndexedDB の薄いラッパ（SPEC §5.8）
   IndexedDB = ブラウザに内蔵されたデータベース。localStorage と違って
   大きなデータや Blob（音声）を入れられるので、保存先はこちらに統一する。
   ===================================================================== */
;(function (EST) {
  'use strict';

  var DB_NAME = 'est-db';
  var DB_VERSION = 3;

  // F1 で実際に使うのは topics / topicProgress / settings の3つだけ。
  // ただし後から version を上げると移行処理を書く羽目になるので、
  // §5.8 の6ストアを最初から全部作っておく。
  var STORES = [
    { name: 'topics',        keyPath: 'id' },
    { name: 'progress',      keyPath: 'key' },
    { name: 'wordProgress',  keyPath: 'key' },
    { name: 'topicProgress', keyPath: 'topicId' },
    { name: 'audio',         keyPath: 'key' },
    { name: 'settings',      keyPath: 'k' }
  ];

  // §5.9 設定はプロフィールごと（"app|tamo"）。台本に属する共有情報は
  // どちらの部屋のものでもないので、"shared" の1件に分けて置く。
  var SETTINGS_PREFIX = 'app';
  var SETTINGS_SHARED_KEY = 'shared';
  var LS_MIRROR_KEY = 'est.settings.mirror'; // 起動直後にテーマを当てるためのミラー

  // §5.7 の既定値
  var DEFAULT_SETTINGS = {
    engine: 'local',
    cloud: { endpoint: '', token: '', voiceMap: {}, model: 'tts-1-hd' },
    ttsRate: 0.95,
    localVoiceEn: null,
    mic: { noiseFloor: null, onsetThreshold: null, calibratedAt: null },
    countRatio: 0.55,
    masteryBase: 1200,
    masteryPerWord: 60,
    inputMode: 'voice',
    dailyGoalLaps: 10,
    theme: 'auto',
    fontScale: 1.0,
    autoBackups: []            // §6.4 直近3世代（部屋ごとに持つ）
  };

  // 台本に属する共有情報（どちらの部屋からでも同じものを見る）
  var DEFAULT_SHARED = {
    samplesSeeded: false,      // サンプル台本を入れたか
    publishedAt: 0,            // §6.5 最後に取り込んだ配信の publishedAt
    feedTopicIds: []           // 配信由来のトピックid。手元で作った台本と区別するため
  };

  var dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      if (!self.indexedDB) { reject(new Error('この環境では IndexedDB が使えません')); return; }
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        var db = req.result;
        STORES.forEach(function (s) {
          if (!db.objectStoreNames.contains(s.name)) {
            db.createObjectStore(s.name, { keyPath: s.keyPath });
          }
        });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
      req.onblocked = function () { reject(new Error('別のタブが古いデータベースを開いています')); };
    });
    return dbPromise;
  }

  function run(storeName, mode, fn) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(storeName, mode);
        var store = tx.objectStore(storeName);
        var out;
        try { out = fn(store); } catch (e) { reject(e); return; }
        tx.oncomplete = function () { resolve(out && out.__req ? out.__req.result : out); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error || new Error('保存が中断されました')); };
      });
    });
  }

  function wrap(req) { return { __req: req }; }

  function get(storeName, key) {
    return run(storeName, 'readonly', function (s) { return wrap(s.get(key)); });
  }
  function getAll(storeName) {
    return run(storeName, 'readonly', function (s) { return wrap(s.getAll()); })
      .then(function (r) { return r || []; });
  }
  function put(storeName, value) {
    return run(storeName, 'readwrite', function (s) { s.put(value); return value; });
  }
  function bulkPut(storeName, values) {
    return run(storeName, 'readwrite', function (s) {
      (values || []).forEach(function (v) { s.put(v); });
      return (values || []).length;
    });
  }
  function del(storeName, key) {
    return run(storeName, 'readwrite', function (s) { s.delete(key); return true; });
  }
  function clear(storeName) {
    return run(storeName, 'readwrite', function (s) { s.clear(); return true; });
  }

  /* ---- プロフィールつきキー（§5.9） -----------------------------------
     既存のキーの先頭に profileId を足すだけにする。
       progress       "tamo|tpc_xxx|ln_001"
       wordProgress   "mari|tpc_xxx|w_003"
       topicProgress  "tamo|tpc_xxx"
       settings       "app|tamo"
     topics と audio は2人で共有するのでプレフィックスを付けない。
  --------------------------------------------------------------------- */
  function pid() {
    // プロフィール未選択のまま呼ばれたら既定の部屋にしておく。
    // （起動直後に読む設定のためで、選択画面はこの後すぐ出る）
    return (EST.profile && EST.profile.get()) || 'tamo';
  }

  function progressKey(topicId, lineId) { return pid() + '|' + topicId + '|' + lineId; }
  function wordProgressKey(topicId, wordId) { return pid() + '|' + topicId + '|' + wordId; }
  function topicProgressKey(topicId) { return pid() + '|' + topicId; }
  function settingsKey(profileId) { return SETTINGS_PREFIX + '|' + (profileId || pid()); }

  // その行が今の部屋のものか（バックアップの絞り込みに使う）
  function belongsToProfile(key, profileId) {
    return String(key || '').indexOf((profileId || pid()) + '|') === 0;
  }

  // ---- 設定 -----------------------------------------------------------
  function withDefaults(defaults, v) {
    var out = JSON.parse(JSON.stringify(defaults));
    if (v && typeof v === 'object') {
      Object.keys(v).forEach(function (k) {
        if (v[k] !== undefined) out[k] = v[k];
      });
    }
    return out;
  }

  function deepDefault(v) { return withDefaults(DEFAULT_SETTINGS, v); }

  function loadSettings(profileId) {
    return get('settings', settingsKey(profileId)).then(function (rec) {
      var s = deepDefault(rec && rec.v);
      mirror(s);
      return s;
    });
  }

  function saveSettings(s, profileId) {
    var v = deepDefault(s);
    mirror(v);
    return put('settings', { k: settingsKey(profileId), v: v }).then(function () { return v; });
  }

  // 共有情報（サンプル投入済みか、配信の publishedAt）
  function loadShared() {
    return get('settings', SETTINGS_SHARED_KEY).then(function (rec) {
      return withDefaults(DEFAULT_SHARED, rec && rec.v);
    });
  }

  function saveShared(v) {
    var out = withDefaults(DEFAULT_SHARED, v);
    return put('settings', { k: SETTINGS_SHARED_KEY, v: out }).then(function () { return out; });
  }

  // テーマと文字サイズだけは起動直後（DBを開く前）に当てたいので
  // localStorage にミラーする。SPEC 上も「設定のミラーのみ可」。
  function mirror(s) {
    try {
      localStorage.setItem(LS_MIRROR_KEY, JSON.stringify({
        theme: s.theme, fontScale: s.fontScale
      }));
    } catch (e) { /* プライベートモード等。失敗しても致命的ではない */ }
  }

  function readMirror() {
    try {
      var raw = localStorage.getItem(LS_MIRROR_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  EST.store = {
    DB_NAME: DB_NAME,
    DB_VERSION: DB_VERSION,
    STORES: STORES.map(function (s) { return s.name; }),
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    DEFAULT_SHARED: DEFAULT_SHARED,
    SETTINGS_SHARED_KEY: SETTINGS_SHARED_KEY,
    progressKey: progressKey,
    wordProgressKey: wordProgressKey,
    topicProgressKey: topicProgressKey,
    settingsKey: settingsKey,
    belongsToProfile: belongsToProfile,
    loadShared: loadShared,
    saveShared: saveShared,
    open: open,
    get: get,
    getAll: getAll,
    put: put,
    bulkPut: bulkPut,
    del: del,
    clear: clear,
    loadSettings: loadSettings,
    saveSettings: saveSettings,
    readMirror: readMirror
  };
})(window.EST = window.EST || {});
