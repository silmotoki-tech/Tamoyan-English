/* =====================================================================
   07-backup.js — 全体バックアップと復元（SPEC §6.4 / §5.9）
   個人アプリはデータが飛ぶと二度と使われなくなるので、ここは必ず作る。
   audio ストアはバックアップに含めない（§5.8）。外部TTSの音声キャッシュも、
   お手本音声の実測長（dur|...）も、端末とボイスに依存し、消えても
   再生し直せば作り直せるため。

   §5.9 の権限:
     タモやん … 全体（台本＋全員の進捗＋設定）
     まり     … 自分の進捗のみ（台本は含めない）
   ===================================================================== */
;(function (EST) {
  'use strict';

  var BACKUP_KIND = 'est-backup';
  var AUTO_KEEP = 3;   // §6.4 直近3世代

  // プロフィールごとに分かれるストア。topics は共有、audio は対象外（§5.8）。
  var PROGRESS_STORES = ['progress', 'wordProgress', 'topicProgress'];

  function keyPathOf(name) { return name === 'topicProgress' ? 'topicId' : 'key'; }

  function isFull() { return EST.profile.canEdit(); }

  /* ---- 書き出し -------------------------------------------------------- */
  function exportAll() {
    var full = isFull();
    var me = EST.profile.get();

    var jobs = PROGRESS_STORES.map(function (n) { return EST.store.getAll(n); });
    jobs.push(full ? EST.store.getAll('topics') : Promise.resolve(null));
    jobs.push(EST.store.loadSettings());
    jobs.push(full ? EST.store.loadShared() : Promise.resolve(null));

    return Promise.all(jobs).then(function (res) {
      var data = {
        kind: BACKUP_KIND,
        schemaVersion: EST.schema.SCHEMA_VERSION,
        exportedAt: Date.now(),
        profileId: me,
        scope: full ? 'full' : 'progress'   // 復元側が中身を判断できるように
      };

      PROGRESS_STORES.forEach(function (name, i) {
        var rows = res[i] || [];
        // まりのバックアップには自分の行だけ入れる（相手の進捗は持ち出さない）
        data[name] = full ? rows : rows.filter(function (r) {
          return EST.store.belongsToProfile(r[keyPathOf(name)], me);
        });
      });

      if (full) data.topics = res[PROGRESS_STORES.length] || [];

      var s = JSON.parse(JSON.stringify(res[PROGRESS_STORES.length + 1]));
      delete s.autoBackups;   // 自動バックアップを入れ子にすると際限なく膨らむ
      data.settings = s;

      if (full) data.shared = res[PROGRESS_STORES.length + 2];
      return data;
    });
  }

  function exportAllText() {
    return exportAll().then(function (d) { return JSON.stringify(d, null, 2); });
  }

  /* ---- 復元 ------------------------------------------------------------
     mode: 'overwrite'（消してから入れる） / 'merge'（同キーは updatedAt が新しい方）
  --------------------------------------------------------------------- */
  function importAll(data, mode) {
    if (!data || typeof data !== 'object') return Promise.reject(new Error('バックアップとして読めません'));

    var full = isFull();
    var me = EST.profile.get();
    var chain = Promise.resolve();

    // 台本を書き戻せるのは編集できる部屋だけ（§5.9）
    if (full && Array.isArray(data.topics)) {
      chain = chain.then(function () { return writeStore('topics', data.topics, mode); });
    }

    PROGRESS_STORES.forEach(function (name) {
      var rows = Array.isArray(data[name]) ? data[name] : [];
      if (!full) {
        // 自分の部屋の行だけを書き戻す。相手の進捗には触らない。
        rows = rows.filter(function (r) { return EST.store.belongsToProfile(r[keyPathOf(name)], me); });
      }
      chain = chain.then(function () { return writeStore(name, rows, mode, full ? null : me); });
    });

    if (data.settings) {
      chain = chain.then(function () {
        return EST.store.loadSettings().then(function (cur) {
          var next = JSON.parse(JSON.stringify(data.settings));
          next.autoBackups = cur.autoBackups || [];   // 自動バックアップは今の端末のものを残す
          return EST.store.saveSettings(next);
        });
      });
    }
    if (full && data.shared) {
      chain = chain.then(function () { return EST.store.saveShared(data.shared); });
    }
    return chain;
  }

  // onlyProfile を渡すと、上書きでもその部屋の行だけを消す
  function writeStore(name, rows, mode, onlyProfile) {
    var kp = name === 'topics' ? 'id' : keyPathOf(name);

    if (mode === 'overwrite') {
      if (!onlyProfile) {
        return EST.store.clear(name).then(function () { return EST.store.bulkPut(name, rows); });
      }
      return EST.store.getAll(name).then(function (cur) {
        var chain = Promise.resolve();
        cur.filter(function (r) { return EST.store.belongsToProfile(r[kp], onlyProfile); })
           .forEach(function (r) { chain = chain.then(function () { return EST.store.del(name, r[kp]); }); });
        return chain.then(function () { return EST.store.bulkPut(name, rows); });
      });
    }

    // マージ: 同じキーが両方にあるときは updatedAt が新しい方を採用する
    return EST.store.getAll(name).then(function (cur) {
      var byKey = {};
      cur.forEach(function (r) { byKey[r[kp]] = r; });
      var merged = rows.filter(function (r) {
        var old = byKey[r[kp]];
        return !old || (Number(r.updatedAt) || 0) >= (Number(old.updatedAt) || 0);
      });
      return EST.store.bulkPut(name, merged);
    });
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

  // 自分の部屋の記録だけを消す。台本（共有）には触らない。
  function wipeProfile() {
    var me = EST.profile.get();
    var chain = Promise.resolve();
    PROGRESS_STORES.forEach(function (name) {
      chain = chain.then(function () {
        return EST.store.getAll(name).then(function (rows) {
          var sub = Promise.resolve();
          rows.filter(function (r) { return EST.store.belongsToProfile(r[keyPathOf(name)], me); })
              .forEach(function (r) {
                sub = sub.then(function () { return EST.store.del(name, r[keyPathOf(name)]); });
              });
          return sub;
        });
      });
    });
    return chain.then(function () { return EST.store.del('settings', EST.store.settingsKey(me)); });
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
    wipeAll: wipeAll,
    wipeProfile: wipeProfile
  };
})(window.EST = window.EST || {});
