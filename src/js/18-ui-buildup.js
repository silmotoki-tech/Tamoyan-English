/* =====================================================================
   18-ui-buildup.js — 積み上げドリル（SPEC §1.8。F7の積み残し）

   詰まりが続く文を、文末から少しずつ足しながら練習する。
     1回目   for me
     2回目   on the scale for me
     3回目   place it on the scale for me
     4回目   Could you place it on the scale for me?
   後ろから積むのは、文末の抑揚とリズムが最後まで壊れないため。

   §1.8「チャンクは独立した復習単位にはしない」。ここでの1回ぶんは
   Progress には書き込まない（累計回数・レイテンシ・定着のどれにも影響しない）。
   あくまで「詰まった文を分解して口を慣らすための道具」であって、
   本番の判定はもとのステージ（S3/S5）に戻ってから行う。

   入口は2つ（§1.8）:
     ・S3/S5で同じ行に3回連続で詰まったときの自動オファー（11-ui-practice.js）
       このとき直近の詰まりの経過時間から前半/中盤/後半を推定し、後半なら
       文末2チャンクから始める（明らかに無駄な最初の1歩を省く程度の調整）。
     ・トピック詳細から手動で任意の行を分解する（10-ui-home.js。推定なし＝常に1チャンク目から）

   チャンク境界の編集（§1.8）は投入プレビュー画面（12-ui-import.js）側にのみ
   ある。このドリル内では編集できない。直したい場合はプレビューから直して
   から入り直す想定。
   ===================================================================== */
;(function (EST) {
  'use strict';

  var h = null;
  function ui() { h = EST.ui.h; return EST.ui; }

  /* ---- 調整用の定数 ------------------------------------------------------- */
  var NEXT_STEP_DELAY_MS = 400;
  var MIN_STEP_INTERVAL_MS = 900;     // §7.2 と同じ考え方。壊れても流れ去らない下限
  var TTS_CLOSE_DELAY_MS_FALLBACK = 800;
  var FINISH_PAUSE_MS = 1400;         // 最終ステップの後、練習画面に戻るまでの間

  var BS = null;   // 進行中の積み上げドリル
  var el = {};

  function renderBuildup(view, topicId, lineId, startHint) {
    stopSession();
    var U = ui();

    EST.store.get('topics', topicId).then(function (topic) {
      if (!topic) {
        EST.app.setBar('分解して練習', []);
        U.mount(view, h('div', { class: 'empty', text: 'このトピックは見つかりませんでした。' }));
        return;
      }
      if (!EST.profile.canSee(topic)) {
        location.hash = EST.profile.canEdit() ? ('#/edit/' + encodeURIComponent(topic.id)) : '#/';
        return;
      }
      var line = null;
      (topic.lines || []).forEach(function (l) { if (l.id === lineId) line = l; });
      var chunks = line ? ((line.chunks && line.chunks.length) ? line.chunks : EST.schema.splitChunks(line.en)) : [];
      if (!line || chunks.length < 2) {
        EST.app.setBar('分解して練習', []);
        U.mount(view, h('div', { class: 'empty', text: 'この行は分解できません（チャンクが1個しかありません）。' }));
        return;
      }

      // §1.8 文末から積む。steps[0] が最初の1回（最短）、最後が全文。
      var steps = [];
      for (var i = 1; i <= chunks.length; i++) {
        steps.push(chunks.slice(chunks.length - i).join(' '));
      }

      // §1.8 詰まり位置の推定（前半/中盤/後半）を開始位置のヒントに使う。
      // 「後半で詰まっているなら文末2チャンクから始める」の一例のみ明記されて
      // いるので、それ以外（前半・中盤・推定なし）は従来どおり最短の1チャンク
      // から始める。厳密な最適化ではなく、明らかに無駄な最初の1歩を省く程度。
      var startIdx = (startHint === 'back') ? Math.min(1, steps.length - 1) : 0;

      return EST.store.loadSettings().then(function (settings) {
        BS = {
          view: view, topic: topic, line: line, steps: steps, idx: startIdx,
          settings: settings,
          countRatio: (typeof settings.countRatio === 'number' && settings.countRatio > 0)
            ? settings.countRatio : EST.stage.COUNT_RATIO_DEFAULT,
          micOn: false, tapMode: false, tapReason: '',
          closing: false, timers: [], expectedMs: 0, cueAt: 0,
          expectRepSource: null, repDone: false, runningLine: false,
          stepStartedAt: 0
        };
        buildScreen();
        prepareMic().then(function () { runStep(); });
      });
    });
  }

  function stopSession() {
    if (!BS) return;
    BS.closing = true;
    clearTimers();
    try { EST.speech.cancel(); } catch (e) {}
    try { EST.mic.stop(); } catch (e) {}
    BS = null;
  }

  function clearTimers() {
    if (!BS) return;
    BS.timers.forEach(function (t) { clearTimeout(t); });
    BS.timers = [];
  }

  function later(fn, ms) {
    if (!BS) return null;
    var t = setTimeout(function () {
      if (!BS || BS.closing) return;
      var i = BS.timers.indexOf(t);
      if (i >= 0) BS.timers.splice(i, 1);
      fn();
    }, ms);
    BS.timers.push(t);
    return t;
  }

  function prepareMic() {
    return EST.mic.start().then(function () {
      if (!BS) return;
      BS.micOn = true;
      EST.mic.on('level', onLevel);
      EST.mic.on('rep', onRep);
      EST.mic.on('timeout', onTimeout);
    }).catch(function (err) {
      if (!BS) return;
      // §2.7 エラーを出さず黙ってタップモードに切り替える
      BS.tapMode = true;
      BS.tapReason = err && err.reason === 'denied' ? 'マイクが使えないのでタップモードです'
        : err && err.reason === 'no-device' ? 'マイクが見つからないのでタップモードです'
        : 'マイクが使えないのでタップモードです';
      showTapReason();
    });
  }

  /* ---- 画面 ---------------------------------------------------------------- */
  function buildScreen() {
    var U = ui();
    EST.app.setBar('分解して練習', [
      h('button', { class: 'btn btn--sm', text: 'やめる',
        onClick: function () { location.hash = '#/topic/' + encodeURIComponent(BS.topic.id); } })
    ]);

    el.stepCount = h('span', { class: 'pr-head__count' });
    el.main = h('div', { class: 'pr-main' });
    el.levelBar = h('div', { class: 'pr-level__fill' });
    el.notice = h('div', { class: 'pr-notice' });

    var body = h('div', { class: 'practice' }, [
      h('div', { class: 'pr-head' }, [h('span', { class: 'pr-head__stage', text: '分解して練習' }), el.stepCount]),
      el.main,
      h('div', { class: 'pr-level' }, [el.levelBar]),
      el.notice
    ]);

    body.addEventListener('click', function (e) {
      if (!BS || !BS.tapMode) return;
      if (e.target.closest('button')) return;
      onTapRep();
    });

    U.mount(BS.view, body);
  }

  function tapHintText() { return BS ? (BS.tapReason + '（画面をタップで1回）') : ''; }
  function showTapReason() { if (BS && el.notice) el.notice.textContent = tapHintText(); }

  /* ---- 1ステップの進行 ------------------------------------------------------ */
  function runStep() {
    if (!BS || BS.closing) return;
    if (BS.runningLine) return;
    BS.runningLine = true;
    BS.repDone = false;
    BS.stepStartedAt = Date.now();

    var U = ui();
    var text = BS.steps[BS.idx];
    el.stepCount.textContent = (BS.idx + 1) + ' / ' + BS.steps.length;
    el.notice.textContent = BS.tapMode ? tapHintText() : '';
    U.mount(el.main, h('div', { class: 'en', text: text }));

    // 実測キャッシュは行本体のIDを汚さないよう、ステップごとの合成IDを使う。
    // （expectedMsFor はキャッシュがあれば text を無視して行本体の長さを返すため）
    var stepKey = BS.line.id + '__bu' + BS.idx;
    EST.speech.expectedMsFor(BS.topic.id, stepKey, text, BS.settings.ttsRate).then(function (ms) {
      if (!BS || BS.closing) return;
      BS.expectedMs = ms;
      BS.cueAt = Date.now();

      if (BS.micOn) {
        EST.mic.setAutoClose(false);   // TTSが鳴るので2500msの自動確定は止める（§2.6と同じ理由）
        BS.expectRepSource = 'closeRep';
        EST.mic.markCue();
      } else {
        BS.expectRepSource = null;
      }

      EST.speech.speak(text, { gender: genderOf(), topicId: BS.topic.id, lineId: stepKey }).then(function (r) {
        if (!BS || BS.closing) return;
        // §7.2 鳴らなかったのに進むと、聞こえていないのに回数だけ積み上がるのと
        // 同じ事故になる。ここは判定を書き込まないが、体験として同じなので揃える。
        if (r && r.spoken === false) { haltForSilentTts(); return; }
        var delay = EST.stage.TTS_CLOSE_DELAY_MS || TTS_CLOSE_DELAY_MS_FALLBACK;
        later(function () {
          if (!BS || BS.closing) return;
          if (BS.micOn) EST.mic.closeRep();
          else finishStep({ ok: true, spokenMs: 0, latencyMs: null, stalls: [], listenOnly: true });
        }, delay);
      });
    });
  }

  function haltForSilentTts() {
    if (!BS || BS.closing) return;
    BS.runningLine = false;
    clearTimers();
    el.notice.textContent = '音声が鳴りませんでした。';
    ui().dialog({
      title: '音声が鳴りませんでした',
      body: h('div', { class: 'small', text: '端末の音量とマナーモードを確認してください。' }),
      buttons: [
        { label: 'やめる', value: 'quit' },
        { label: 'このステップからやり直す', value: 'retry', kind: 'primary' }
      ]
    }).then(function (v) {
      if (!BS || BS.closing) return;
      if (v === 'quit') { location.hash = '#/topic/' + encodeURIComponent(BS.topic.id); return; }
      runStep();
    });
  }

  function genderOf() {
    var sp = (BS.topic.speakers || []).filter(function (s) { return s.id === BS.line.speakerId; })[0];
    return sp ? sp.gender : '';
  }

  function onLevel(e) {
    if (!BS || !el.levelBar) return;
    el.levelBar.style.width = Math.min(100, Math.round(e.rms * 300)) + '%';
  }

  function onRep(e) {
    if (!BS || BS.closing) return;
    if (BS.expectRepSource && e.source && e.source !== BS.expectRepSource) return;
    var ok = EST.stage.judgeCount(e.spokenMs, BS.expectedMs, BS.countRatio);
    finishStep({ ok: ok, spokenMs: e.spokenMs, latencyMs: e.latencyMs, stalls: e.stalls || [] });
  }

  function onTimeout() {
    if (!BS || BS.closing) return;
    finishStep({ ok: false, spokenMs: 0, latencyMs: null, stalls: [], noSpeech: true });
  }

  function onTapRep() {
    if (!BS || BS.closing) return;
    finishStep({ ok: true, spokenMs: 0, latencyMs: null, stalls: [], tapped: true });
  }

  // §1.8 このドリルの1回はProgressに書き込まない（意図的。ファイル冒頭のコメント参照）。
  // ここでの役目は口を慣らすことだけで、判定はもとのステージに戻ってから行う。
  function finishStep(result) {
    if (!BS || BS.closing || BS.repDone) return;
    BS.repDone = true;
    BS.runningLine = false;
    if (result.ok && !result.listenOnly) flash();

    var elapsed = Date.now() - (BS.stepStartedAt || 0);
    var wait = Math.max(NEXT_STEP_DELAY_MS, MIN_STEP_INTERVAL_MS - elapsed);
    later(nextStep, wait);
  }

  function flash() {
    if (!el.main) return;
    el.main.classList.add('is-ok');
    later(function () { if (el.main) el.main.classList.remove('is-ok'); }, 260);
  }

  function nextStep() {
    if (!BS || BS.closing) return;
    BS.idx++;
    if (BS.idx < BS.steps.length) { runStep(); return; }
    finishDrill();
  }

  function finishDrill() {
    if (!BS || BS.closing) return;
    var U = ui();
    var topicId = BS.topic.id;
    el.notice.textContent = 'できました。練習にもどります…';
    U.mount(el.main, h('div', { class: 'en', text: BS.line.en }));
    later(function () {
      if (BS && BS.topic.id === topicId) { location.hash = '#/practice/' + encodeURIComponent(topicId); }
    }, FINISH_PAUSE_MS);
  }

  EST.uiBuildup = { renderBuildup: renderBuildup, stopSession: stopSession };
})(window.EST = window.EST || {});
