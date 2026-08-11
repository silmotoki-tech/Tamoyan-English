/* =====================================================================
   11-ui-practice.js — 練習画面（SPEC §3 / §1.1 / §1.2 / §2.6 / §2.7）

   音読中の画面は極限まで削る。情報が多いと画面を見てしまい、
   音読がおろそかになる。進行は自動で、押すボタンは中断するときだけ。
   ===================================================================== */
;(function (EST) {
  'use strict';

  var h = null;
  function ui() { h = EST.ui.h; return EST.ui; }

  /* ---- 調整用の定数 ------------------------------------------------------- */
  var NEXT_LINE_DELAY_MS = 400;    // 1行終わってから次の行を出すまでの間

  var S = null;        // 進行中のセッション
  var wakeLock = null;

  /* =====================================================================
     セッション
     ===================================================================== */
  function renderPractice(view, topicId) {
    var U = ui();
    stopSession();

    EST.store.get('topics', topicId).then(function (topic) {
      if (!topic) {
        EST.app.setBar('練習', []);
        U.mount(view, h('div', { class: 'empty', text: 'このトピックは見つかりませんでした。' }));
        return;
      }
      // §5.9 自分の部屋の台本でなければ練習させない
      if (!EST.profile.canSee(topic)) {
        location.hash = EST.profile.canEdit() ? ('#/edit/' + encodeURIComponent(topic.id)) : '#/';
        return;
      }
      return EST.stage.loadTopicProgress(topic.id).then(function (tp) {
        return EST.store.loadSettings().then(function (settings) {
          startSession(view, topic, tp, settings);
        });
      });
    });
  }

  function startSession(view, topic, tp, settings) {
    var U = ui();

    // F7 未実装のステージに来ていたら、その旨だけ出して止める
    if (!EST.stage.IMPLEMENTED[tp.stage]) {
      EST.app.setBar(topic.title || '(無題)', []);
      U.mount(view, h('div', { class: 'card' }, [
        h('h2', { class: 'card__title', text: EST.stage.stageLabel(tp.stage) + ' はまだ使えません' }),
        h('div', { class: 'small muted', text: 'S5・S6 と積み上げドリルは F7 で追加します。' }),
        h('button', {
          class: 'btn', style: { marginTop: '.6rem' }, text: 'トピックへ戻る',
          onClick: function () { location.hash = '#/topic/' + encodeURIComponent(topic.id); }
        })
      ]));
      return;
    }

    S = {
      view: view,
      topic: topic,
      tp: tp,
      settings: settings,
      countRatio: (typeof settings.countRatio === 'number' && settings.countRatio > 0)
        ? settings.countRatio : EST.stage.COUNT_RATIO_DEFAULT,
      lines: EST.stage.linesOfBlock(topic, tp.blockIndex || 0),
      idx: 0,
      lastResult: null,     // 「今のはナシ」用
      lastLineId: null,
      micOn: false,
      tapMode: false,
      tapReason: '',
      closing: false,
      timers: [],
      barTimer: null,
      expectedMs: 0,
      cueAt: 0,
      finished: false
    };
    if (!S.lines.length) {
      U.mount(view, h('div', { class: 'empty', text: '練習できる行がありません。' }));
      return;
    }

    buildScreen();
    requestWakeLock();
    prepareMic().then(function () { runLine(); });
  }

  function stopSession() {
    if (!S) return;
    S.closing = true;
    clearTimers();
    try { EST.speech.cancel(); } catch (e) {}
    try { EST.mic.stop(); } catch (e) {}
    releaseWakeLock();
    S = null;
  }

  function clearTimers() {
    if (!S) return;
    S.timers.forEach(function (t) { clearTimeout(t); });
    S.timers = [];
    if (S.barTimer) { clearInterval(S.barTimer); S.barTimer = null; }
  }

  function later(fn, ms) {
    if (!S) return null;
    var t = setTimeout(function () {
      if (!S || S.closing) return;
      fn();
    }, ms);
    S.timers.push(t);
    return t;
  }

  /* ---- マイク（§2.7 使えなければ黙ってタップモード） ---------------------- */
  function prepareMic() {
    var mode = EST.stage.stageMode(S.tp.stage);
    // §1.2 S1は聞くだけ。マイクを使わないので権限も要求しない。
    if (!mode.mic) return Promise.resolve();

    return EST.mic.start().then(function () {
      if (!S) return;
      S.micOn = true;
      EST.mic.on('level', onLevel);
      EST.mic.on('rep', onRep);
      EST.mic.on('timeout', onTimeout);
    }).catch(function (err) {
      if (!S) return;
      // §2.7 エラーを出さず黙ってタップモードに切り替え、理由を1行添える
      S.tapMode = true;
      S.tapReason = err && err.reason === 'denied' ? 'マイクが使えないのでタップモードです'
        : err && err.reason === 'no-device' ? 'マイクが見つからないのでタップモードです'
        : 'マイクが使えないのでタップモードです';
      showTapReason();
    });
  }

  /* =====================================================================
     画面（§3）
     ===================================================================== */
  var el = {};

  function buildScreen() {
    var U = ui();
    var topic = S.topic;

    // §3 押すべきボタンは原則ゼロ。中断だけをアプリバーに置く。
    EST.app.setBar(topic.title || '(無題)', [
      h('button', {
        class: 'btn btn--sm', text: '中断',
        onClick: quitToHome
      })
    ]);

    el.stageName = h('span', { class: 'pr-head__stage', text: EST.stage.stageLabel(S.tp.stage) });
    el.stageCount = h('span', { class: 'pr-head__count' });
    el.main = h('div', { class: 'pr-main' });
    el.timeBar = h('div', { class: 'pr-bar__fill' });
    el.timeBarWrap = h('div', { class: 'pr-bar hidden' }, [el.timeBar]);
    el.levelBar = h('div', { class: 'pr-level__fill' });
    el.meter = h('div', { class: 'pr-meter' });
    el.notice = h('div', { class: 'pr-notice' });

    var undoBtn = h('button', {
      class: 'btn btn--sm', text: '今のはナシ',
      onClick: undoLast
    });
    var recalBtn = h('button', {
      class: 'btn btn--sm', text: '再較正',
      onClick: recalibrate
    });

    var body = h('div', { class: 'practice' }, [
      h('div', { class: 'pr-head' }, [el.stageName, el.stageCount]),
      el.main,
      el.timeBarWrap,
      h('div', { class: 'pr-level' }, [el.levelBar]),
      el.notice,
      el.meter,
      h('div', { class: 'row row--tight', style: { justifyContent: 'center' } }, [undoBtn, recalBtn])
    ]);

    // タップモードでは画面中央のタップで1回とする（§2.7）
    body.addEventListener('click', function (e) {
      if (!S || !S.tapMode) return;
      if (e.target.closest('button')) return;
      onTapRep();
    });

    U.mount(S.view, body);
    refreshMeter();
  }

  // §2.7 タップモードに切り替えた理由を1行添える。行が進むと notice は
  // 消されるので、タップモードの間は毎行出し直す。
  function tapHintText() {
    return S ? (S.tapReason + '（画面をタップで1回）') : '';
  }
  function showTapReason() {
    if (!S || !el.notice) return;
    el.notice.textContent = tapHintText();
  }

  // lineId を渡すとその行の回数を出す。省略時は現在の行。
  function refreshMeter(lineId) {
    if (!S) return;
    var reps = (S.tp.stageReps && S.tp.stageReps[S.tp.stage]) || 0;
    el.stageCount.textContent = reps + '回';

    var id = lineId || (S.lines[S.idx] && S.lines[S.idx].id);
    var key = id ? EST.store.progressKey(S.topic.id, id) : null;
    if (!key) return;
    EST.store.get('progress', key).then(function (p) {
      if (!S || !el.meter) return;
      var lineCount = (p && p.counts && p.counts.total) || 0;
      var laps = (S.tp.laps && S.tp.laps.total) || 0;
      var parts = ['この文 ' + lineCount + '回', 'この会話 ' + laps + '周'];
      if (EST.stage.usesBlocks(S.topic)) {
        parts.push('ブロック' + ((S.tp.blockIndex || 0) + 1) + '/' + (S.topic.blocks || []).length);
      }
      el.meter.textContent = parts.join(' / ');
    });
  }

  /* =====================================================================
     1行の進行
     ===================================================================== */
  function runLine() {
    if (!S || S.closing) return;
    var line = S.lines[S.idx];
    if (!line) return;

    var mode = EST.stage.stageMode(S.tp.stage);
    S.lastLineId = line.id;
    S.repDone = false;      // この行の確定はまだ
    S.timeLimitMs = 0;
    el.notice.textContent = S.tapMode ? tapHintText() : '';

    // 画面表示（§1.1 ステージに応じて手がかりを減らす）
    var U = ui();
    var parts = [];
    if (mode.showEn) parts.push(h('div', { class: 'pr-en en', text: line.en }));
    if (mode.showJa && line.ja) parts.push(h('div', { class: 'pr-ja', text: line.ja }));
    if (!mode.showEn) parts.push(h('div', { class: 'pr-hint', text: '音だけを追いかけてください' }));
    U.mount(el.main, parts);

    refreshMeter();

    // expectedMs は §2.3。実測があればそれ、無ければ語数から。
    EST.speech.expectedMsFor(S.topic.id, line.id, line.en, S.settings.ttsRate)
      .then(function (ms) {
        if (!S || S.closing) return;
        S.expectedMs = ms;
        if (mode.timeBar) startTimeBar(ms);
        beginLine(line, mode);
      });
  }

  function beginLine(line, mode) {
    if (!S || S.closing) return;
    S.cueAt = Date.now();
    if (S.micOn) EST.mic.markCue();

    if (mode.tts) {
      // §2.6 TTSが鳴るステージ。窓は開けたまま（S2・S4）。
      // S1はマイクを使わないのでそもそも開いていない。
      var gender = genderOf(line.speakerId);
      EST.speech.speak(line.en, {
        gender: gender, topicId: S.topic.id, lineId: line.id
      }).then(function () {
        if (!S || S.closing) return;
        // §2.6 再生が終わったら短い猶予だけ置いて回を閉じる。
        // 2500msの自動確定に任せると1行ごとに待たされ、S4が成立しない。
        later(function () {
          if (!S || S.closing) return;
          if (S.micOn) EST.mic.closeRep();
          else onListenOnlyDone();   // S1は発話しないのでrepが来ない
        }, EST.stage.TTS_CLOSE_DELAY_MS);
      });
    }
    // TTSが鳴らないステージ（S3）は §2.2 の2500ms自動確定に任せる
  }

  function genderOf(speakerId) {
    var g = '';
    (S.topic.speakers || []).forEach(function (s) { if (s.id === speakerId) g = s.gender || ''; });
    return g;
  }

  /* ---- S3 の目標時間バー（§1.2） ------------------------------------------ */
  function startTimeBar(expectedMs) {
    if (!S) return;
    var factor = EST.stage.currentS3Factor(S.tp);
    var limit = expectedMs * factor;
    S.timeLimitMs = limit;
    S.timeStartedAt = Date.now();
    el.timeBarWrap.classList.remove('hidden');
    el.timeBar.style.width = '100%';
    if (S.barTimer) clearInterval(S.barTimer);
    S.barTimer = setInterval(function () {
      if (!S || S.closing) return;
      var left = Math.max(0, 1 - (Date.now() - S.timeStartedAt) / limit);
      el.timeBar.style.width = (left * 100) + '%';
      el.timeBar.classList.toggle('is-over', left <= 0);
    }, 50);
  }

  function stopTimeBar() {
    if (!S) return;
    if (S.barTimer) { clearInterval(S.barTimer); S.barTimer = null; }
    el.timeBarWrap.classList.add('hidden');
  }

  /* =====================================================================
     EST.mic からのイベント
     ===================================================================== */
  function onLevel(e) {
    if (!S || !el.levelBar) return;
    el.levelBar.style.width = Math.min(100, Math.round(e.rms * 300)) + '%';
  }

  function onRep(e) {
    if (!S || S.closing) return;
    // §2.3 カウント判定はここ（ステージ層）で行う
    var withinTime = true;
    if (S.timeLimitMs) withinTime = (Date.now() - S.timeStartedAt) <= S.timeLimitMs;

    var ok = EST.stage.judgeCount(e.spokenMs, S.expectedMs, S.countRatio);
    finishRep({
      ok: ok,
      spokenMs: e.spokenMs,
      latencyMs: e.latencyMs,
      stalls: e.stalls || [],
      withinTime: withinTime
    });
  }

  // §2.4 10秒待って発話が無かった。責める文言にしない。
  function onTimeout() {
    if (!S || S.closing) return;
    el.notice.textContent = 'もう一度どうぞ';
    finishRep({ ok: false, spokenMs: 0, latencyMs: null, stalls: [], withinTime: false, noSpeech: true });
  }

  // S1（聞くだけ）は発話しないので、再生完了をもって1回とする
  function onListenOnlyDone() {
    finishRep({ ok: true, spokenMs: 0, latencyMs: null, stalls: [], withinTime: true, listenOnly: true });
  }

  // §2.7 タップモード。spokenMsが取れないのでタップ＝成立として扱う。
  function onTapRep() {
    if (!S || S.closing) return;
    finishRep({ ok: true, spokenMs: 0, latencyMs: null, stalls: [], withinTime: true, tapped: true });
  }

  function finishRep(result) {
    if (!S || S.closing) return;
    // 1行につき1回だけ確定させる。TTS終了の closeRep と 2500ms の自動確定、
    // タップの連打などが重なると、同じ行が何度も数えられてしまう。
    if (S.repDone) return;
    S.repDone = true;
    stopTimeBar();

    var lineId = S.lastLineId;
    var stage = S.tp.stage;
    S.lastResult = { result: result, lineId: lineId, stage: stage };

    EST.stage.recordRep(S.tp, lineId, S.topic.id, result);
    EST.stage.saveTopicProgress(S.tp);
    // 保存が終わってからメーターを描き直す。先に描くと、いま数えた1回が
    // 反映される前の値（この文 0回）が出てしまう。
    EST.stage.recordLineProgress(S.topic.id, lineId, stage, result)
      .then(function () { refreshMeter(lineId); });
    if (result.ok && !result.listenOnly) flash();

    later(nextLine, NEXT_LINE_DELAY_MS);
  }

  function flash() {
    if (!el.main) return;
    el.main.classList.add('is-ok');
    later(function () { if (el.main) el.main.classList.remove('is-ok'); }, 260);
  }

  /* ---- 次の行・次の周（§3 進行は自動） ------------------------------------- */
  function nextLine() {
    if (!S || S.closing) return;
    S.idx++;
    if (S.idx < S.lines.length) { runLine(); return; }

    // 最終行まで行った → 1周
    S.idx = 0;
    S.tp.laps = S.tp.laps || { total: 0, byStage: {} };
    S.tp.laps.total = (S.tp.laps.total || 0) + 1;
    S.tp.laps.byStage[S.tp.stage] = (S.tp.laps.byStage[S.tp.stage] || 0) + 1;
    EST.stage.saveTopicProgress(S.tp);

    // §1.2 条件を満たしたら控えめに知らせる。進級は強制しない。
    if (EST.stage.canAdvance(S.tp)) showAdvanceOffer();
    else runLine();
  }

  function showAdvanceOffer() {
    var U = ui();
    var nx = EST.stage.nextStage(S.tp.stage);
    if (!nx) { runLine(); return; }
    el.notice.textContent = '';

    U.dialog({
      title: EST.stage.stageLabel(nx) + ' に進めます',
      body: h('div', { class: 'small' }, [
        h('div', { text: '押さなければ ' + EST.stage.stageLabel(S.tp.stage) + ' を続けられます。回数は積み上がります。' })
      ]),
      buttons: [
        { label: '続ける', value: 'stay' },
        { label: '進む', value: 'go', kind: 'primary' }
      ]
    }).then(function (v) {
      if (!S || S.closing) return;
      if (v === 'go') {
        EST.stage.advance(S.tp);
        EST.stage.saveTopicProgress(S.tp);
        // ステージが変わるとTTS・マイクの扱いも変わるので入り直す
        var topicId = S.topic.id;
        stopSession();
        renderPractice(document.getElementById('view'), topicId);
        return;
      }
      runLine();
    });
  }

  /* ---- 「今のはナシ」（§2.4） --------------------------------------------- */
  function undoLast() {
    if (!S || !S.lastResult) { ui().toast('取り消せる記録がありません'); return; }
    var last = S.lastResult;
    S.lastResult = null;

    try { EST.mic.cancelLast(); } catch (e) {}
    // ステージ側の連続カウントも巻き戻す
    if (last.stage === 'S2' || last.stage === 'S4') S.tp.streak = 0;
    if (last.stage === 'S3') S.tp.s3Streak = 0;
    S.tp.stageReps[last.stage] = Math.max(0, (S.tp.stageReps[last.stage] || 0) - 1);

    EST.stage.undoLineProgress(S.topic.id, last.lineId, last.stage, last.result)
      .then(function () {
        EST.stage.saveTopicProgress(S.tp);
        refreshMeter();
        ui().toast('直前の1回を取り消しました');
      });
  }

  function recalibrate() {
    var U = ui();
    U.toast('1.5秒間、静かにしてください…');
    EST.mic.calibrate().then(function (r) {
      U.toast(r.tooNoisy ? '静かな場所で較正し直してください' : '較正しました');
    }).catch(function () {
      U.toast('マイクを使えませんでした');
    });
  }

  function quitToHome() {
    var topicId = S ? S.topic.id : null;
    stopSession();
    location.hash = topicId ? ('#/topic/' + encodeURIComponent(topicId)) : '#/';
  }

  /* ---- Screen Wake Lock（§3。非対応環境は諦める） -------------------------- */
  function requestWakeLock() {
    if (!navigator.wakeLock || !navigator.wakeLock.request) return;
    navigator.wakeLock.request('screen').then(function (w) {
      wakeLock = w;
    }).catch(function () { /* 非対応・拒否は諦める */ });
  }

  function releaseWakeLock() {
    if (wakeLock) { try { wakeLock.release(); } catch (e) {} wakeLock = null; }
  }

  EST.uiPractice = {
    renderPractice: renderPractice,
    stopSession: stopSession
  };
})(window.EST = window.EST || {});
