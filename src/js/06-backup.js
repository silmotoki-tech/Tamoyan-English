/* =====================================================================
   06-backup.js — 全体バックアップと復元（SPEC §6.4）
   個人アプリはデータが飛ぶと二度と使われなくなるので、ここは必ず作る。
   音声キャッシュ（audio）は再生成できるのでバックアップに含めない。
   ===================================================================== */
;(function (EST) {
  'use strict';

  var BACKUP_KIND = 'est-backup';
  var AUTO_KEEP = 3;   // §6.4 直近3世代

  // audio 以外のストアを丸ごと入れる
  var STORES = ['topics', 'progress', 'wordProgress', 'topicProgress'];

  function exportAll() {
    var jobs = STORES.map(function (name) { return EST.store.getAll(name); });
    jobs.push(EST.store.loadSettings());
    return Promise.all(jobs).then(function (res) {
      var data = {
        kind: BACKUP_KIND,
        schemaVersion: EST.schema.SCHEMA_VERSION,
        exportedAt: Date.now()
      };
      STORES.forEach(function (name, i) { data[name] = res[i] || []; });
      var s = res[STORES.length];
      // 自動バックアップ自身を入れ子にすると際限なく膨らむので落とす
      var copy = JSON.parse(JSON.stringify(s));
      delete copy.autoBackups;
      data.settings = copy;
      return data;
    });
  }

  function exportAllText() {
    return exportAll().then(function (d) { return JSON.stringify(d, null, 2); });
  }

  // mode: 'overwrite'（消してから入れる） / 'merge'（同idは updatedAt が新しい方）
  function importAll(data, mode) {
    if (!data || typeof data !== 'object') return Promise.reject(new Error('バックアップとして読めません'));
    if (!Array.isArray(data.topics)) return Promise.reject(new Error('topics が入っていません'));

    var chain = Promise.resolve();

    if (mode === 'overwrite') {
      STORES.forEach(function (name) {
        chain = chain.then(function () { return EST.store.clear(name); });
      });
      STORES.forEach(function (name) {
        chain = chain.then(function () { return EST.store.bulkPut(name, data[name] || []); });
      });
    } else {
      STORES.forEach(function (name) {
        chain = chain.then(function () {
          return EST.store.getAll(name).then(function (cur) {
            var keyOf = (name === 'topicProgress') ? 'topicId' : (name === 'topics' ? 'id' : 'key');
            var byKey = {};
            cur.forEach(function (r) { byKey[r[keyOf]] = r; });
            var merged = [];
            (data[name] || []).forEach(function (r) {
              var old = byKey[r[keyOf]];
              // 同じidが両方にあるときは新しい方を採用する
              if (!old || (Number(r.updatedAt) || 0) >= (Number(old.updatedAt) || 0)) merged.push(r);
            });
            return EST.store.bulkPut(name, merged);
          });
        });
      });
    }

    if (data.settings) {
      chain = chain.then(function () {
        return EST.store.loadSettings().then(function (cur) {
          var next = JSON.parse(JSON.stringify(data.settings));
          next.autoBackups = cur.autoBackups || [];   // 自動バックアップは今の端末のものを残す
          return EST.store.saveSettings(next);
        });
      });
    }
    return chain;
  }

  /* ---- 自動バックアップ（トピック保存のたびに1世代） ------------------- */
  function snapshot(label) {
    return exportAllText().then(function (text) {
      return EST.store.loadSettings().then(function (s) {
        var list = Array.isArray(s.autoBackups) ? s.autoBackups.slice() : [];
        list.unshift({ at: Date.now(), label: label || '', size: text.length, json: text });
        s.autoBackups = list.slice(0, AUTO_KEEP);
        return EST.store.saveSettings(s);
      });
    }).catch(function (e) {
      // バックアップの失敗で保存そのものを止めない
      console.warn('[backup] 自動バックアップに失敗しました', e);
    });
  }

  function listAuto() {
    return EST.store.loadSettings().then(function (s) {
      return (s.autoBackups || []).map(function (b, i) {
        return { index: i, at: b.at, label: b.label, size: b.size };
      });
    });
  }

  function restoreAuto(index, mode) {
    return EST.store.loadSettings().then(function (s) {
      var b = (s.autoBackups || [])[index];
      if (!b) throw new Error('その世代のバックアップがありません');
      return importAll(JSON.parse(b.json), mode || 'overwrite');
    });
  }

  function wipeAll() {
    var chain = Promise.resolve();
    EST.store.STORES.forEach(function (name) {
      chain = chain.then(function () { return EST.store.clear(name); });
    });
    return chain;
  }

  EST.backup = {
    BACKUP_KIND: BACKUP_KIND,
    AUTO_KEEP: AUTO_KEEP,
    exportAll: exportAll,
    exportAllText: exportAllText,
    importAll: importAll,
    snapshot: snapshot,
    listAuto: listAuto,
    restoreAuto: restoreAuto,
    wipeAll: wipeAll
  };
})(window.EST = window.EST || {});
