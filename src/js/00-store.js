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

  var SETTINGS_KEY = 'app';
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
    // F1 で足す運用フラグ
    samplesSeeded: false,
    autoBackups: []            // §6.4 直近3世代
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

  // ---- 設定 -----------------------------------------------------------
  // settings ストアは {k:'app', v:{...}} の1件だけを持つ。
  function deepDefault(v) {
    var out = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    if (v && typeof v === 'object') {
      Object.keys(v).forEach(function (k) {
        if (v[k] !== undefined) out[k] = v[k];
      });
    }
    return out;
  }

  function loadSettings() {
    return get('settings', SETTINGS_KEY).then(function (rec) {
      var s = deepDefault(rec && rec.v);
      mirror(s);
      return s;
    });
  }

  function saveSettings(s) {
    var v = deepDefault(s);
    mirror(v);
    return put('settings', { k: SETTINGS_KEY, v: v }).then(function () { return v; });
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
