/* =====================================================================
   03-mic.js — 音量検知エンジン（SPEC §2.1〜§2.7 / §1.8 / §10.3）

   UIから完全に独立させる。イベントを発火するだけのモジュールにし、
   UIはそれを購読する（SPEC §12）。コンソールから単体で確認できる。

     EST.mic.on('onset',  ({t}) => ...)
     EST.mic.on('offset', ({t, durationMs}) => ...)
     EST.mic.on('level',  ({rms}) => ...)      // 音量バー用（15fpsに間引く）
     EST.mic.calibrate()   // Promise<{noiseFloor, onsetThreshold}>

   「1回分の計測」（beginAttempt）と「判定」（judgeCount等）は生の検知の
   上に乗る薄い層。どちらもUIから独立しており、どのタイミングで
   attemptを開始・終了するか（ステージ進行）はF5が決める。
   ===================================================================== */
;(function (EST) {
  'use strict';

  /* ---- 調整用の定数（実機で必ず調整する。SPEC §12） ------------------ */
  var FFT_SIZE           = 2048;   // §2.1
  var SMOOTHING          = 0.3;    // §2.1
  var CALIBRATE_MS       = 1500;   // §2.1 較正にかける時間
  var ONSET_MULTIPLIER   = 3.5;    // §2.1 onsetThreshold = noiseFloor * これ
  var ONSET_FLOOR        = 0.008;  // §2.1 onsetThresholdの下限
  var OFFSET_RATIO       = 0.7;    // §2.1 offsetThreshold = onsetThreshold * これ
  var LOOP_MS            = 20;     // §2.2 解析間隔
  var ONSET_FRAMES       = 3;      // §2.2 onset確定に必要な連続フレーム数
  var OFFSET_FRAMES      = 15;     // §2.2 offset確定に必要な連続フレーム数（=300ms）
  var STALL_MS           = 1500;   // §2.5 詰まりとみなす無音の長さ
  var LEVEL_EMIT_MS      = 66;     // §10.3 音量バーの描画間引き（解析20ms・描画66ms）
  var COUNT_RATIO_DEFAULT = 0.55;  // §2.3 settings.countRatio が無いときの既定
  // 未較正のまま start() された場合の保守的な既定値。すぐ試せることを優先し、
  // 較正を必須にはしない（コンソールから即試せるようにするため）。
  var UNCALIBRATED_ONSET = 0.025;

  /* ---- 状態 -------------------------------------------------------------- */
  var audioCtx = null, stream = null, source = null, analyser = null, buf = null;
  var listening = false;     // start()〜stop() の間か
  var muted = false;         // §2.6 TTS再生中などにカウント窓を閉じる
  var loopTimer = null;
  var visHandlerInstalled = false;

  var onsetThreshold = UNCALIBRATED_ONSET;
  var offsetThreshold = UNCALIBRATED_ONSET * OFFSET_RATIO;
  var calibrated = false;

  var voiced = false;        // 現在「発話中」state か（§2.2）
  var onsetStreak = 0, offsetStreak = 0;
  var segmentOnsetAt = 0;
  var lastAboveOffsetAt = 0; // 直近で声が確認できていた時刻（offsetの確定待ち300msを含めないため）

  var lastLevelEmit = 0;

  var countRatio = COUNT_RATIO_DEFAULT;

  var listeners = { onset: [], offset: [], level: [] };

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
    return !!(self.navigator && navigator.mediaDevices && navigator.mediaDevices.getUserMedia && self.AudioContext);
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
      var reason = classifyError(e);
      return Promise.reject({ reason: reason, message: String(e && e.message || e) });
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
  function calibrate() {
    return ensureStream().then(function () {
      return new Promise(function (resolve) {
        var samples = [];
        var startedAt = Date.now();
        var timer = setInterval(function () {
          samples.push(computeRms());
          if (Date.now() - startedAt >= CALIBRATE_MS) {
            clearInterval(timer);
            var noiseFloor = samples.length
              ? samples.reduce(function (a, b) { return a + b; }, 0) / samples.length
              : 0;
            var ot = Math.max(noiseFloor * ONSET_MULTIPLIER, ONSET_FLOOR);
            onsetThreshold = ot;
            offsetThreshold = ot * OFFSET_RATIO;
            calibrated = true;
            resolve({ noiseFloor: noiseFloor, onsetThreshold: ot });
          }
        }, LOOP_MS);
      });
    }).then(function (result) {
      return EST.store.loadSettings().then(function (s) {
        s.mic = { noiseFloor: result.noiseFloor, onsetThreshold: result.onsetThreshold, calibratedAt: Date.now() };
        return EST.store.saveSettings(s);
      }).then(function () { return result; });
    });
  }

  // 保存済みの較正値があれば読み込む。無ければ保守的な既定値のまま。
  function loadCalibration() {
    return EST.store.loadSettings().then(function (s) {
      var m = s.mic || {};
      if (m.onsetThreshold) {
        onsetThreshold = m.onsetThreshold;
        offsetThreshold = onsetThreshold * OFFSET_RATIO;
        calibrated = true;
      } else {
        console.warn('[mic] 較正されていません。既定値で動作します。EST.mic.calibrate() を推奨します。');
      }
      countRatio = (typeof s.countRatio === 'number' && s.countRatio > 0) ? s.countRatio : COUNT_RATIO_DEFAULT;
    });
  }

  /* ---- 発話検知ループ（§2.2） ---------------------------------------------- */
  function loopTick() {
    if (!listening || muted) return;
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
        emit('offset', { t: now, durationMs: lastAboveOffsetAt - segmentOnsetAt });
      }
    }
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
        voiced = false; onsetStreak = 0; offsetStreak = 0;
        installVisibilityHandling();
        if (!document.hidden) loopTimer = setInterval(loopTick, LOOP_MS);
        return true;
      });
  }

  // stop() は「聞き終わった」の意味にする。リスナーも解除する。
  // 画面をまたいで購読が残ると、次の画面には存在しないDOM要素を
  // 触ろうとするコールバックが残り続けるため（設定画面のテスト表示など）。
  // 引き続き聞きたい呼び出し側は、次に start() したあと改めて on() する。
  function stop() {
    listening = false;
    voiced = false; onsetStreak = 0; offsetStreak = 0;
    if (loopTimer) { clearInterval(loopTimer); loopTimer = null; }
    listeners.onset = []; listeners.offset = []; listeners.level = [];
  }

  function isListening() { return listening; }

  function setMuted(v) { muted = !!v; }
  function isMuted() { return muted; }

  function applySettings(s) {
    if (!s) return;
    if (typeof s.countRatio === 'number' && s.countRatio > 0) countRatio = s.countRatio;
    var m = s.mic || {};
    if (m.onsetThreshold) {
      onsetThreshold = m.onsetThreshold;
      offsetThreshold = onsetThreshold * OFFSET_RATIO;
      calibrated = true;
    }
  }

  function isCalibrated() { return calibrated; }
  function getThresholds() { return { onsetThreshold: onsetThreshold, offsetThreshold: offsetThreshold }; }

  /* =====================================================================
     1回分の計測（beginAttempt）— 生イベントの上の薄い層
     いつ始めていつ終えるかはF5が決める。ここでは「発話区間の合計」
     「最初のonsetまでの時間」「1.5秒以上の無音（詰まり）」だけを集計する。
     ===================================================================== */
  function beginAttempt() {
    var t0 = Date.now();
    var firstOnsetAt = null;
    var spokenMs = 0;
    var segStart = null;
    var lastBoundaryAt = t0;
    var stalls = [];
    var stallOpen = false;
    var ended = false;

    function handleOnset(e) {
      if (ended) return;
      if (firstOnsetAt == null) firstOnsetAt = e.t;
      segStart = e.t;
      lastBoundaryAt = e.t;
      stallOpen = false;
    }
    function handleOffset(e) {
      if (ended) return;
      // e.durationMsは既にoffset確定待ちの無音を除いた実長（03-mic.jsのloopTick側で補正済み）
      if (segStart != null) { spokenMs += e.durationMs; segStart = null; }
      lastBoundaryAt = e.t;
    }
    // §2.5 発話開始後、1.5秒以上の無音が入ったら詰まりとして記録する。
    // levelイベント（約66ms間隔）を内部の時計代わりに使う。
    function handleLevelTick() {
      if (ended || firstOnsetAt == null || stallOpen || segStart != null) return;
      var gap = Date.now() - lastBoundaryAt;
      if (gap >= STALL_MS) {
        stallOpen = true;
        stalls.push({ t: Date.now(), elapsedMs: Date.now() - t0 });
      }
    }

    on('onset', handleOnset);
    on('offset', handleOffset);
    on('level', handleLevelTick);

    function detach() {
      off('onset', handleOnset);
      off('offset', handleOffset);
      off('level', handleLevelTick);
    }

    function snapshot() {
      var extra = segStart != null ? (Date.now() - segStart) : 0;
      return {
        t0: t0,
        firstOnsetAt: firstOnsetAt,
        latencyMs: firstOnsetAt != null ? (firstOnsetAt - t0) : null,
        spokenMs: spokenMs + extra,
        stalls: stalls.slice()
      };
    }

    return {
      t0: t0,
      get spokenMs() { return snapshot().spokenMs; },
      get stalls() { return stalls.slice(); },
      end: function () {
        if (ended) return snapshot();
        if (segStart != null) { spokenMs += (Date.now() - segStart); segStart = null; }
        ended = true;
        detach();
        return snapshot();
      },
      cancel: function () {
        if (ended) return;
        ended = true;
        detach();
      }
    };
  }

  /* ---- 判定（純粋関数。SPEC §2.3・§2.4・§1.8） ---------------------------- */
  // §2.3 spokenMs / expectedMs >= ratio なら1回としてカウント成立
  function judgeCount(spokenMs, expectedMs, ratio) {
    if (!expectedMs || expectedMs <= 0) return false;
    var r = (ratio == null) ? countRatio : ratio;
    return (spokenMs / expectedMs) >= r;
  }

  // §2.4 直近5回の中央値。平均だと外れ値に引っ張られるため。
  function medianOfLastN(history, n) {
    n = n || 5;
    var arr = (history || []).slice(-n).slice().sort(function (a, b) { return a - b; });
    if (!arr.length) return null;
    var mid = Math.floor(arr.length / 2);
    return (arr.length % 2) ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
  }

  // §1.8 詰まりが文のどのあたりで起きたかを、経過時間とチャンクの累積想定時間
  // （語数比で按分）から推定する。厳密ではなく前半/中盤/後半程度の粒度。
  function estimateStallPosition(chunks, elapsedMs, expectedMs) {
    chunks = (chunks || []).map(String).filter(function (c) { return c.trim(); });
    if (!chunks.length || !expectedMs || expectedMs <= 0 || elapsedMs == null) return null;

    var wordCounts = chunks.map(function (c) { return Math.max(1, c.trim().split(/\s+/).length); });
    var totalWords = wordCounts.reduce(function (a, b) { return a + b; }, 0);

    var acc = 0, idx = chunks.length - 1;
    for (var i = 0; i < chunks.length; i++) {
      acc += (wordCounts[i] / totalWords) * expectedMs;
      if (elapsedMs <= acc) { idx = i; break; }
    }
    var frac = (idx + 0.5) / chunks.length;
    if (frac < 1 / 3) return 'front';
    if (frac < 2 / 3) return 'mid';
    return 'back';
  }

  EST.mic = {
    // 生の検知（§12）
    on: on,
    off: off,
    calibrate: calibrate,
    start: start,
    stop: stop,
    isListening: isListening,
    isSupported: isSupported,
    isCalibrated: isCalibrated,
    getThresholds: getThresholds,
    setMuted: setMuted,
    isMuted: isMuted,
    applySettings: applySettings,
    // 1回分の計測
    beginAttempt: beginAttempt,
    // 判定
    judgeCount: judgeCount,
    medianOfLastN: medianOfLastN,
    estimateStallPosition: estimateStallPosition,
    // 定数（設定画面等から参照する）
    STALL_MS: STALL_MS,
    COUNT_RATIO_DEFAULT: COUNT_RATIO_DEFAULT
  };
})(window.EST = window.EST || {});
