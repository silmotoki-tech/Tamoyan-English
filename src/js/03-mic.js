/* =====================================================================
   03-mic.js — 音量検知エンジン（SPEC §2.1〜§2.8 / §1.8 / §10.3）

   §2.8 UIから完全に独立させる。イベントを発火するだけのモジュールにし、
   UIはそれを購読する。コンソールから単体で動かせる形にする。

     EST.mic.start() / stop()
     EST.mic.calibrate()          // → Promise<{noiseFloor, onsetThreshold}>
     EST.mic.gate(open)           // TTS再生中は閉じる（§2.6）
     EST.mic.markCue()            // レイテンシの t0 を打つ（§2.4）
     EST.mic.cancelLast()         // 「今のはナシ」（§2.4）
     EST.mic.on(event, cb)        // onset / offset / level / rep / stall / timeout

   §2.8 カウント成否の判定（§2.3）はここでは行わない。何回と数えるかは
   ステージ側（F5）の仕事で、EST.mic は起きた事実だけを報告する。
   expectedMs を知っているのはステージ層なので、この線引きを崩すと
   マイクモジュールが台本を知らないと試験できなくなる。
   ===================================================================== */
;(function (EST) {
  'use strict';

  /* ---- 調整用の定数（実機で必ず調整する。SPEC §12） ------------------ */
  var FFT_SIZE            = 2048;   // §2.1
  var SMOOTHING           = 0.3;    // §2.1
  var CALIBRATE_MS        = 1500;   // §2.1 較正にかける時間
  var ONSET_MULTIPLIER    = 3.5;    // §2.1 onsetThreshold = noiseFloor * これ
  var ONSET_FLOOR         = 0.008;  // §2.1 onsetThresholdの下限
  var OFFSET_RATIO        = 0.7;    // §2.1 offsetThreshold = onsetThreshold * これ
  var NOISE_FLOOR_MAX     = 0.05;   // §2.1 これを超えたら較正値として採用しない
  var LOOP_MS             = 20;     // §2.2 解析間隔
  var ONSET_FRAMES        = 3;      // §2.2 onset確定に必要な連続フレーム数
  var OFFSET_FRAMES       = 15;     // §2.2 offset確定に必要な連続フレーム数（=300ms）
  var STALL_MS            = 1500;   // §2.5 詰まりとみなす無音の長さ
  // §2.2 offset から この時間 新しい onset が来なければ「1回」を確定する。
  // STALL_MS と近すぎると詰まった瞬間に回が切れ、離れすぎると次の回の
  // 先頭を前の回に飲み込む。実機で必ず調整する。
  var REP_GAP_MS          = 2500;
  // §2.4 キュー表示から この時間 一度も発話が無ければ「発話なし」で閉じる。
  // 無限に待つと画面が固まったように見える。
  var NO_ONSET_TIMEOUT_MS = 10000;
  var LEVEL_EMIT_MS       = 66;     // §10.3 音量バーの描画間引き（解析20ms・描画66ms）
  // 未較正のまま start() された場合の保守的な既定値。すぐ試せることを優先し、
  // 較正を必須にはしない（コンソールから即試せるようにするため）。
  var UNCALIBRATED_ONSET  = 0.025;

  /* ---- 状態 -------------------------------------------------------------- */
  var audioCtx = null, stream = null, source = null, analyser = null, buf = null;
  var listening = false;     // start()〜stop() の間か
  var gateOpen = true;       // §2.6 TTS再生中などにカウント窓を閉じる
  var loopTimer = null;
  var visHandlerInstalled = false;

  var onsetThreshold = UNCALIBRATED_ONSET;
  var offsetThreshold = UNCALIBRATED_ONSET * OFFSET_RATIO;
  var calibrated = false;

  // §2.6 2500msの自動確定を使うか。TTS駆動のステージ（S1・S2・S4）では
  // 行の開始で false にし、回を閉じるのは closeRep() だけにする。
  // 止めないと rep を出す経路が2つになり、お手本がまだ鳴っている最中に
  // マイク側が勝手に回を閉じて、次の行へ進んでしまう。
  var autoClose = true;

  var voiced = false;        // 現在「発話中」state か（§2.2）
  var onsetStreak = 0, offsetStreak = 0;
  var segmentOnsetAt = 0;
  var lastAboveOffsetAt = 0; // 直近で声が確認できていた時刻（offset確定待ち300msを含めないため）

  var lastLevelEmit = 0;

  /* 進行中の「1回」（§2.2）。markCue() が無くても onset で自動的に開くので、
     コンソールから start() して喋るだけで rep が出る（§2.8）。 */
  var rep = null;            // { cueAt, firstOnsetAt, spokenMs, segments, stalls, lastOffsetAt, stallPending }
  var lastRep = null;        // §2.4 cancelLast() 用

  var listeners = { onset: [], offset: [], level: [], rep: [], stall: [], timeout: [] };

  function on(ev, fn) { if (listeners[ev]) listeners[ev].push(fn); return fn; }
  function off(ev, fn) {
    if (!listeners[ev]) return;
    var i = listeners[ev].indexOf(fn);
    if (i >= 0) listeners[ev].splice(i, 1);
  }
  function emit(ev, payload) {
    (listeners[ev] || []).slice().forEach(function (fn) {
      try { fn(payload); } catch (e) { console.error('[mic] リスナーでエラー', e); }
    });
  }

  /* ---- サポート判定・エラー分類（§2.7） ---------------------------------- */
  function isSupported() {
    return !!(self.navigator && navigator.mediaDevices && navigator.mediaDevices.getUserMedia
              && (self.AudioContext || self.webkitAudioContext));
  }

  function classifyError(e) {
    var name = e && e.name;
    if (!isSupported()) return 'unsupported';
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') return 'denied';
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return 'no-device';
    return 'error';
  }

  /* ---- ストリーム確立（§2.1） --------------------------------------------- */
  function ensureStream() {
    if (stream && audioCtx) return Promise.resolve();
    if (!isSupported()) return Promise.reject({ reason: 'unsupported', message: 'この環境ではマイクが使えません' });

    return navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,   // TTSの回り込みを抑える
        noiseSuppression: true,
        autoGainControl: false    // 自動ゲインだと閾値が動いてしまうので必ずfalse
      }
    }).then(function (s) {
      stream = s;
      audioCtx = new (self.AudioContext || self.webkitAudioContext)();
      source = audioCtx.createMediaStreamSource(stream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = FFT_SIZE;
      analyser.smoothingTimeConstant = SMOOTHING;
      source.connect(analyser);
      buf = new Uint8Array(analyser.fftSize);
    }).catch(function (e) {
      return Promise.reject({ reason: classifyError(e), message: String(e && e.message || e) });
    });
  }

  function computeRms() {
    analyser.getByteTimeDomainData(buf);
    var sum = 0;
    for (var i = 0; i < buf.length; i++) {
      var v = (buf[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / buf.length);
  }

  /* ---- 較正（§2.1） ------------------------------------------------------- */
  function measureNoiseFloor() {
    return new Promise(function (resolve) {
      var samples = [];
      var startedAt = Date.now();
      var timer = setInterval(function () {
        samples.push(computeRms());
        if (Date.now() - startedAt >= CALIBRATE_MS) {
          clearInterval(timer);
          resolve(samples.length
            ? samples.reduce(function (a, b) { return a + b; }, 0) / samples.length
            : 0);
        }
      }, LOOP_MS);
    });
  }

  function applyNoiseFloor(noiseFloor) {
    var ot = Math.max(noiseFloor * ONSET_MULTIPLIER, ONSET_FLOOR);
    onsetThreshold = ot;
    offsetThreshold = ot * OFFSET_RATIO;
    calibrated = true;
    return ot;
  }

  // §2.1 測った値が異常なら採用しない。noiseFloor が閾値を超えたら
  // うるさい場所にいるか較正中に声が入っている。そのまま採用すると
  // 閾値が上がりすぎて「何を喋っても検知されない」状態になり原因も分からない。
  // 1回だけ自動でやり直し、それでも高ければ既定値を使って警告を返す。
  function calibrate() {
    return ensureStream().then(function () {
      return measureNoiseFloor().then(function (nf1) {
        if (nf1 <= NOISE_FLOOR_MAX) {
          return { noiseFloor: nf1, onsetThreshold: applyNoiseFloor(nf1), retried: false, tooNoisy: false };
        }
        // 1回だけ自動でやり直す
        return measureNoiseFloor().then(function (nf2) {
          if (nf2 <= NOISE_FLOOR_MAX) {
            return { noiseFloor: nf2, onsetThreshold: applyNoiseFloor(nf2), retried: true, tooNoisy: false };
          }
          onsetThreshold = UNCALIBRATED_ONSET;
          offsetThreshold = UNCALIBRATED_ONSET * OFFSET_RATIO;
          calibrated = false;
          return {
            noiseFloor: nf2,
            onsetThreshold: UNCALIBRATED_ONSET,
            retried: true,
            tooNoisy: true,
            message: '静かな場所で較正し直してください'
          };
        });
      });
    }).then(function (result) {
      // うるさすぎて採用しなかった値は保存しない（次回も既定値から始める）
      if (result.tooNoisy) return result;
      return EST.store.loadSettings().then(function (s) {
        s.mic = { noiseFloor: result.noiseFloor, onsetThreshold: result.onsetThreshold, calibratedAt: Date.now() };
        return EST.store.saveSettings(s);
      }).then(function () { return result; });
    });
  }

  // 保存済みの較正値があれば読み込む。無ければ保守的な既定値のまま。
  function loadCalibration() {
    return EST.store.loadSettings().then(function (s) {
      applySettings(s);
      if (!calibrated) {
        console.warn('[mic] 較正されていません。既定値で動作します。EST.mic.calibrate() を推奨します。');
      }
    });
  }

  /* =====================================================================
     「1回」の管理（§2.2 / §2.4 / §2.5）
     ===================================================================== */
  function openRep(cueAt) {
    rep = {
      cueAt: cueAt || null,      // markCue()が無ければnull → latencyMsもnull（§2.8）
      firstOnsetAt: null,
      spokenMs: 0,
      segments: [],
      stalls: [],
      lastOffsetAt: null,
      stallPending: null,
      timedOut: false
    };
  }

  // source: §2.8 rep の出どころ。'auto'（2500msの自動確定）/
  // 'closeRep'（ステージ側から明示的に）/ 'tap'（タップモード）。
  // ステージ側が期待しない経路の rep を無視できるようにするため。
  function closeRep(source) {
    if (!rep) return;
    // 発話中に閉じられたら、その区間をここまでの分だけ算入して閉じる。
    // TTS駆動のステージ（§2.6）は再生終了から短い猶予で閉じるので、
    // 語尾を追いかけている途中で呼ばれることがある。
    if (voiced) {
      var now = Date.now();
      var seg = Math.max(0, now - segmentOnsetAt);
      rep.spokenMs += seg;
      rep.segments.push({ startedAt: segmentOnsetAt, durationMs: seg });
      voiced = false; onsetStreak = 0; offsetStreak = 0;
    }
    var payload = {
      spokenMs: rep.spokenMs,
      latencyMs: (rep.cueAt != null && rep.firstOnsetAt != null) ? (rep.firstOnsetAt - rep.cueAt) : null,
      stalls: rep.stalls.slice(),
      segments: rep.segments.slice(),
      source: source || 'auto'
    };
    lastRep = payload;
    rep = null;
    emit('rep', payload);
  }

  // §2.6 TTSが鳴るステージでは、回の区切りをTTSの終わりが決める。
  // §2.2 の2500msを当てると1行ごとに2.5秒待たされ、シャドーイングが成立しない。
  // ステージ側から明示的に閉じるための入口。進行中の回が無ければ
  // 「発話が無かった1回」として空のrepを出す（S1のように声を出さない
  // ステージでも、回の区切りだけは通知したいため）。
  function closeRepNow(source) {
    if (!rep) openRep(null);
    closeRep(source || 'closeRep');
  }

  // §2.6 2500msの自動確定を止める／再開する。
  // TTS駆動のステージ（S1・S2・S4）は行の開始で false にする。
  function setAutoClose(on) { autoClose = (on !== false); }
  function isAutoClose() { return autoClose; }

  // §2.2/§2.4 無音の経過を見て、詰まり・回の確定・発話なしの打ち切りを判断する。
  // 解析ループから毎フレーム呼ばれる。
  function tickRepTimers(now) {
    if (!rep || voiced) return;

    // §2.4 キューを打ったのに一度も発話が無いまま10秒
    if (rep.firstOnsetAt == null) {
      if (rep.cueAt != null && (now - rep.cueAt) >= NO_ONSET_TIMEOUT_MS) {
        rep.timedOut = true;
        rep = null;
        emit('timeout', { t: now });
      }
      return;
    }

    var since = now - rep.lastOffsetAt;
    // §2.2 2500ms 新しいonsetが来なければ「1回」を確定する。
    // §2.6 TTS駆動のステージでは autoClose が false になっていて、
    // ここを通らない。回を閉じるのは closeRep() だけになる。
    if (autoClose && since >= REP_GAP_MS) { closeRep('auto'); return; }

    // §2.5 発話開始後の1.5秒以上の無音は「詰まり」。回は継続する。
    // ただし詰まりは回の内側で起きる出来事なので、無音が続いたまま
    // REP_GAP_MS に達した場合（＝その回が終わっただけ）は詰まりにしない。
    // ここで先に emit すると、単発の発話でも必ず詰まり1件が付いてしまう。
    // よって確定は「無音が STALL_MS を超えたあと、再び発話が始まったとき」に行う。
    if (!rep.stallPending && since >= STALL_MS) {
      rep.stallPending = { t: now, elapsedMs: now - rep.firstOnsetAt };
    }
  }

  /* ---- 発話検知ループ（§2.2） ---------------------------------------------- */
  function loopTick() {
    if (!listening || !gateOpen) return;
    var rms = computeRms();
    var now = Date.now();

    if (now - lastLevelEmit >= LEVEL_EMIT_MS) {
      lastLevelEmit = now;
      emit('level', { rms: rms });
    }

    if (!voiced) {
      onsetStreak = rms > onsetThreshold ? onsetStreak + 1 : 0;
      if (onsetStreak >= ONSET_FRAMES) {
        voiced = true;
        onsetStreak = 0; offsetStreak = 0;
        segmentOnsetAt = now;
        lastAboveOffsetAt = now;
        // §2.8 markCue()が呼ばれていなくても回を開く。latencyMsはnullになる。
        if (!rep) openRep(null);
        if (rep.firstOnsetAt == null) rep.firstOnsetAt = now;
        // 直前の無音が STALL_MS を超えていて、かつ再び喋り始めた。
        // ここで初めて「回の内側の詰まり」として確定する（§2.5）。
        if (rep.stallPending) {
          rep.stalls.push(rep.stallPending);
          emit('stall', rep.stallPending);
          rep.stallPending = null;
        }
        emit('onset', { t: now });
      }
    } else {
      if (rms < offsetThreshold) {
        offsetStreak++;
      } else {
        offsetStreak = 0;
        lastAboveOffsetAt = now;   // まだ声が続いている
      }
      if (offsetStreak >= OFFSET_FRAMES) {
        voiced = false;
        onsetStreak = 0; offsetStreak = 0;
        // durationMsは実際に声があった長さにする。offset確定に使った
        // 300ms（OFFSET_FRAMES分の無音）を含めると実長より長く出てしまうため、
        // 最後に声が確認できた時刻までで区切る。
        var durationMs = lastAboveOffsetAt - segmentOnsetAt;
        if (rep) {
          rep.spokenMs += durationMs;
          rep.segments.push({ startedAt: segmentOnsetAt, durationMs: durationMs });
          rep.lastOffsetAt = lastAboveOffsetAt;
        }
        emit('offset', { t: now, durationMs: durationMs });
      }
    }

    tickRepTimers(now);
  }

  /* ---- バックグラウンドで解析を止める（§10.3） ----------------------------- */
  function installVisibilityHandling() {
    if (visHandlerInstalled) return;
    visHandlerInstalled = true;
    document.addEventListener('visibilitychange', function () {
      if (!listening) return;
      if (document.hidden) {
        if (loopTimer) { clearInterval(loopTimer); loopTimer = null; }
      } else if (!loopTimer) {
        loopTimer = setInterval(loopTick, LOOP_MS);
      }
    });
  }

  /* ---- start/stop --------------------------------------------------------- */
  function start() {
    if (listening) return Promise.resolve(true);
    return ensureStream()
      .then(loadCalibration)
      .then(function () {
        listening = true;
        gateOpen = true;
        autoClose = true;   // 既定は2500msの自動確定。止めるのはステージ側の判断
        voiced = false; onsetStreak = 0; offsetStreak = 0;
        rep = null; lastRep = null;
        installVisibilityHandling();
        if (!document.hidden) loopTimer = setInterval(loopTick, LOOP_MS);
        return true;
      });
  }

  // stop() は「聞き終わった」の意味にする。リスナーも解除する。
  // 画面をまたいで購読が残ると、次の画面には存在しないDOM要素を
  // 触ろうとするコールバックが残り続けるため。
  // 引き続き聞きたい呼び出し側は、次に start() したあと改めて on() する。
  function stop() {
    listening = false;
    autoClose = true;   // 次に start() したとき前のステージの設定を持ち越さない
    voiced = false; onsetStreak = 0; offsetStreak = 0;
    rep = null;
    if (loopTimer) { clearInterval(loopTimer); loopTimer = null; }
    Object.keys(listeners).forEach(function (k) { listeners[k] = []; });
  }

  function isListening() { return listening; }

  /* ---- 公開API（§2.8） ----------------------------------------------------- */
  // §2.6 TTS再生中はカウント窓を閉じる。gate(false)で閉、gate(true)で開。
  function gate(open) {
    gateOpen = (open !== false);
    if (!gateOpen) {
      // 閉じている間の音は無かったことにする。開いた瞬間に
      // 直前のTTSの残響でonsetが立たないよう、検知state もリセットする。
      voiced = false; onsetStreak = 0; offsetStreak = 0;
    }
  }
  function isGateOpen() { return gateOpen; }

  // §2.4 レイテンシの t0 を打つ。進行中の回があれば先に確定させる。
  function markCue() {
    if (rep) closeRep('markCue');
    openRep(Date.now());
    return rep.cueAt;
  }

  // §2.4「今のはナシ」。直前に確定した1回の記録を取り消す。
  // 進行中の回があるならそちらを破棄する。
  function cancelLast() {
    if (rep) { rep = null; return true; }
    if (lastRep) { lastRep = null; return true; }
    return false;
  }
  function getLastRep() { return lastRep; }

  function applySettings(s) {
    if (!s) return;
    var m = s.mic || {};
    if (m.onsetThreshold) {
      onsetThreshold = m.onsetThreshold;
      offsetThreshold = onsetThreshold * OFFSET_RATIO;
      calibrated = true;
    }
  }

  function isCalibrated() { return calibrated; }
  function getThresholds() { return { onsetThreshold: onsetThreshold, offsetThreshold: offsetThreshold }; }

  /* ---- 計測値の加工（判定ではない。§2.4 / §1.8） --------------------------- */
  // §2.4 直近5回の中央値。平均だと咳や物音の外れ値に引っ張られるため。
  function medianOfLastN(history, n) {
    n = n || 5;
    var arr = (history || []).slice(-n).slice().sort(function (a, b) { return a - b; });
    if (!arr.length) return null;
    var mid = Math.floor(arr.length / 2);
    return (arr.length % 2) ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
  }

  // §1.8 詰まりが文のどのあたりで起きたかを、経過時間とチャンクの累積想定時間
  // （語数比で按分）から推定する共通処理。戻り値はチャンクの添字（厳密ではない）。
  function stallChunkIndex(chunks, elapsedMs, expectedMs) {
    chunks = (chunks || []).map(String).filter(function (c) { return c.trim(); });
    if (!chunks.length || !expectedMs || expectedMs <= 0 || elapsedMs == null) return -1;

    var wordCounts = chunks.map(function (c) { return Math.max(1, c.trim().split(/\s+/).length); });
    var totalWords = wordCounts.reduce(function (a, b) { return a + b; }, 0);

    var acc = 0, idx = chunks.length - 1;
    for (var i = 0; i < chunks.length; i++) {
      acc += (wordCounts[i] / totalWords) * expectedMs;
      if (elapsedMs <= acc) { idx = i; break; }
    }
    return idx;
  }

  // 前半/中盤/後半程度の粒度。積み上げドリルの開始位置に使う（§1.8）。
  function estimateStallPosition(chunks, elapsedMs, expectedMs) {
    var idx = stallChunkIndex(chunks, elapsedMs, expectedMs);
    if (idx < 0) return null;
    var n = (chunks || []).filter(function (c) { return String(c).trim(); }).length;
    var frac = (idx + 0.5) / n;
    if (frac < 1 / 3) return 'front';
    if (frac < 2 / 3) return 'mid';
    return 'back';
  }

  // §1.8「よく詰まるチャンクの集計」用。実際のチャンク文字列を返す（F8）。
  function estimateStallChunk(chunks, elapsedMs, expectedMs) {
    var idx = stallChunkIndex(chunks, elapsedMs, expectedMs);
    var list = (chunks || []).map(String).filter(function (c) { return c.trim(); });
    return idx >= 0 ? list[idx] : null;
  }

  EST.mic = {
    // §2.8 のインターフェース
    start: start,
    stop: stop,
    calibrate: calibrate,
    gate: gate,
    markCue: markCue,
    closeRep: closeRepNow,
    setAutoClose: setAutoClose,
    isAutoClose: isAutoClose,
    cancelLast: cancelLast,
    on: on,
    off: off,
    // 状態の参照
    isListening: isListening,
    isSupported: isSupported,
    isCalibrated: isCalibrated,
    isGateOpen: isGateOpen,
    getThresholds: getThresholds,
    getLastRep: getLastRep,
    applySettings: applySettings,
    // 計測値の加工（カウント成否の判定はF5。§2.8）
    medianOfLastN: medianOfLastN,
    estimateStallPosition: estimateStallPosition,
    estimateStallChunk: estimateStallChunk,
    // 定数（実機調整で参照する）
    STALL_MS: STALL_MS,
    REP_GAP_MS: REP_GAP_MS,
    NO_ONSET_TIMEOUT_MS: NO_ONSET_TIMEOUT_MS,
    NOISE_FLOOR_MAX: NOISE_FLOOR_MAX
  };
})(window.EST = window.EST || {});
