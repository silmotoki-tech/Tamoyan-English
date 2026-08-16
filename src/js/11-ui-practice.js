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
  // §7.2 行が進む最短間隔の下限。何が壊れても画面が流れ去らないようにする。
  // TTSが握り潰されて即endが返るような事態でも、これ以上速くは進まない。
  var MIN_LINE_INTERVAL_MS = 1200;

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
      return EST.stage.loadTopicProgress(topic.id, topic).then(function (tp) {
        // §8「そのトピックでS0が未完了なら、最初に語彙の下ごしらえへ回す」（F6）
        if (EST.stage.s0Needed(tp, topic)) {
          location.hash = '#/vocab-prep/' + encodeURIComponent(topic.id);
          return;
        }
        return EST.store.loadSettings().then(function (settings) {
          startSession(view, topic, tp, settings);
        });
      });
    });
  }

  function startSession(view, topic, tp, settings) {
    var U = ui();

    var stage = EST.stage.currentStage(tp, topic);
    var role = EST.stage.activeRole(tp, topic);
    var mode = EST.stage.stageMode(stage);
    var blockLines = linesOfCurrentBlock(topic, tp);

    S = {
      view: view,
      topic: topic,
      tp: tp,
      stage: stage,
      role: role,
      settings: settings,
      countRatio: (typeof settings.countRatio === 'number' && settings.countRatio > 0)
        ? settings.countRatio : EST.stage.COUNT_RATIO_DEFAULT,
      blockLines: blockLines,
      // §1.3 S5・S6 はシャッフルした出題（S6は組）、S1〜S4は台本の順
      queue: mode.shuffled
        ? EST.stage.buildQueue(stage, topic, blockLines, role, null)
        : blockLines.map(function (l) { return { kind: 'line', line: l }; }),
      lines: blockLines,
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
    if (!S.queue.length) {
      U.mount(view, h('div', { class: 'empty', text: mode.myRoleOnly
        ? 'このブロックに自分の役の行がありません。'
        : '練習できる行がありません。' }));
      return;
    }

    buildScreen();
    requestWakeLock();
    prepareMic().then(function () { runLine(); });
  }

  // §1.5 現在ブロックの行。ブロックを使わない台本なら全行。
  function linesOfCurrentBlock(topic, tp) {
    var blocks = EST.stage.blocksOf(topic);
    var idx = 0;
    blocks.forEach(function (b, i) { if (b.id === tp.currentBlockId) idx = i; });
    return EST.stage.linesOfBlock(topic, idx);
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

  // 発火し終えたタイマーは配列から外す。放っておくと1周ごとに積み上がり、
  // 長い練習で clearTimers() の走査対象が際限なく増える。
  function later(fn, ms) {
    if (!S) return null;
    var t = setTimeout(function () {
      if (!S || S.closing) return;
      var i = S.timers.indexOf(t);
      if (i >= 0) S.timers.splice(i, 1);
      fn();
    }, ms);
    S.timers.push(t);
    return t;
  }

  /* ---- マイク（§2.7 使えなければ黙ってタップモード） ---------------------- */
  function prepareMic() {
    var mode = EST.stage.stageMode(S.stage);
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

    el.stageName = h('span', { class: 'pr-head__stage', text: EST.stage.stageLabel(S.stage) });
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
    var reps = (S.tp.stageReps && S.tp.stageReps[S.stage]) || 0;
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
    if (!S || S.closing || S.halted) return;
    // 再入防止。行送りのタイマーと、TTS完了やrepからの経路が重なると
    // 同じ行で二重に走り、片方が他方をcancelして音が切れる。
    if (S.runningLine) return;
    S.runningLine = true;

    var item = S.queue[S.idx];
    if (!item) { S.runningLine = false; return; }
    var line = item.line;

    var mode = EST.stage.stageMode(S.stage);
    S.item = item;
    S.lastLineId = line.id;
    S.repDone = false;      // この行の確定はまだ
    S.timeLimitMs = 0;
    S.lineStartedAt = Date.now();   // §7.2 行送りの下限を測るため
    el.notice.textContent = S.tapMode ? tapHintText() : '';

    // 画面表示（§1.1 ステージに応じて手がかりを減らす）
    var U = ui();
    var parts = [];
    // §5.3 英文が出ているステージ（S1〜S3）だけ、語を長押しで拾えるようにする。
    if (mode.showEn) parts.push(buildEnLine(line));

    if (S.stage === 'S5') {
      // §1.1 S5 は和訳のみ。ここから英語を言う。
      parts.push(h('div', { class: 'pr-ja pr-ja--cue', text: line.ja || '（和訳がありません）' }));
    } else if (S.stage === 'S6') {
      // §1.3 S6 のキューは相手の台詞。組が作れなかった行は和訳を出す。
      if (item.kind === 'pair') {
        parts.push(h('div', { class: 'pr-hint', text: '相手の台詞に返してください' }));
      } else {
        parts.push(h('div', { class: 'pr-ja pr-ja--cue', text: line.ja || '（和訳がありません）' }));
      }
    } else {
      if (mode.showJa && line.ja) parts.push(h('div', { class: 'pr-ja', text: line.ja }));
      if (!mode.showEn) parts.push(h('div', { class: 'pr-hint', text: '音だけを追いかけてください' }));
    }
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

    // §2.6 S6 は相手の台詞だけを鳴らし、それが終わってから測定を開始する。
    // 自分が喋るのは相手の後なので、ここでは自分の台詞を鳴らさない。
    if (S.stage === 'S6') {
      beginS6(line, mode);
      return;
    }

    if (S.micOn) {
      // §2.6 TTSが鳴るステージでは2500msの自動確定を止める。
      // 止めないと、言い終わって黙った時点からマイク側の2500msが走り、
      // お手本がまだ鳴っている最中に回が閉じて次の行へ進んでしまう。
      // そこで speak() が cancel され、音が途中で切れる。
      EST.mic.setAutoClose(!mode.tts);
      // この行で受け付ける rep の経路を決めておく（§2.8）
      S.expectRepSource = mode.tts ? 'closeRep' : 'auto';
      EST.mic.markCue();
    } else {
      S.expectRepSource = null;   // マイクを使わないステージ
    }

    if (mode.tts) {
      // §2.6 TTSが鳴るステージ。窓は開けたまま（S2・S4）。
      // S1はマイクを使わないのでそもそも開いていない。
      var gender = genderOf(line.speakerId);
      EST.speech.speak(line.en, {
        gender: gender, topicId: S.topic.id, lineId: line.id
      }).then(function (r) {
        if (!S || S.closing) return;

        // §7.2 鳴らなかった（想定より極端に短いendを鳴らし直しても駄目だった）
        // 場合は、行を進めずに止める。音が出ていないのに回数だけ積み上がると
        // 学習の記録そのものが信用できなくなる。
        if (r && r.spoken === false) {
          haltForSilentTts();
          return;
        }

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

  /* §7.2 音が鳴らなかったときに行送りを止める。黙って進むと、聞こえて
     いないのに回数だけが積み上がる。自動で再試行し続けると同じことなので、
     ここで止めて本人に判断してもらう。 */
  function haltForSilentTts() {
    if (!S || S.closing) return;
    S.halted = true;
    S.runningLine = false;   // 再開できるように解除しておく
    clearTimers();
    el.notice.textContent = '音声が鳴りませんでした。';
    ui().dialog({
      title: '音声が鳴りませんでした',
      body: h('div', { class: 'small' }, [
        h('div', { text: '端末の音量とマナーモードを確認してください。' }),
        h('div', { style: { marginTop: '.4rem' },
          text: '記録が狂わないよう、ここで止めています。この行から再開できます。' })
      ]),
      buttons: [
        { label: '中断する', value: 'quit' },
        { label: 'この行からやり直す', value: 'retry', kind: 'primary' }
      ]
    }).then(function (v) {
      if (!S || S.closing) return;
      if (v === 'quit') { quitToHome(); return; }
      S.halted = false;
      runLine();
    });
  }

  /* §2.6 S6「相手に返す」。相手の台詞を鳴らし終えてから測定を開始する。
     相手の台詞が無い組（台本の頭が自分の台詞）は和訳をキューにするので、
     TTSを鳴らさず S5 と同じ扱いにする（§1.3）。 */
  function beginS6(line, mode) {
    var item = S.item;
    var cue = (item && item.kind === 'pair') ? item.cueLine : null;

    function startListening() {
      if (!S || S.closing) return;
      if (S.micOn) {
        // 自分が喋るのを待つので、確定は2500msの自動確定に任せる
        EST.mic.setAutoClose(true);
        S.expectRepSource = 'auto';
        EST.mic.markCue();   // 相手の台詞が終わった時点が t0
      } else {
        S.expectRepSource = null;
      }
    }

    if (!cue) { startListening(); return; }

    // 相手の台詞を鳴らしているあいだは窓を閉じる（自分はまだ喋らない）
    if (S.micOn) EST.mic.gate(false);
    EST.speech.speak(cue.en, {
      gender: genderOf(cue.speakerId), topicId: S.topic.id, lineId: cue.id
    }).then(function (r) {
      if (!S || S.closing) return;
      if (S.micOn) EST.mic.gate(true);
      if (r && r.spoken === false) { haltForSilentTts(); return; }
      startListening();
    });
  }

  /* ---- 英文の長押しで語彙に追加（SPEC §5.3。F6） -------------------------
     「音読していて引っかかった語をその場で拾えないと、結局あとで
     拾い直さなくなる」ので、行の英文を語ごとに span へ分けて長押しを
     受け付ける。和訳は付けずに登録し、あとで編集画面から埋める前提にする
     （その場で聞くと入力のために止まってしまい、音読の流れが切れるため）。 */
  function buildEnLine(line) {
    var container = h('div', { class: 'pr-en en' });
    var text = String(line.en || '');
    text.split(/(\s+)/).forEach(function (tok) {
      if (!tok) return;
      if (/^\s+$/.test(tok)) { container.appendChild(document.createTextNode(tok)); return; }
      var span = h('span', { class: 'pr-word', text: tok });
      attachLongPress(span, tok, line.id);
      container.appendChild(span);
    });
    return container;
  }

  // 引数名を el にすると練習画面全体で使っている DOM キャッシュ（モジュール
  // 先頭の el.main 等）を覆い隠して紛らわしいので、ここだけ span と呼ぶ。
  function attachLongPress(span, rawToken, lineId) {
    var timer = null;
    function begin() {
      if (timer) return;
      timer = setTimeout(function () {
        timer = null;
        onWordLongPress(rawToken, lineId);
      }, (EST.uiVocab && EST.uiVocab.LONG_PRESS_MS) || 550);
    }
    function cancelPress() { if (timer) { clearTimeout(timer); timer = null; } }
    span.addEventListener('pointerdown', begin);
    span.addEventListener('pointerup', cancelPress);
    span.addEventListener('pointerleave', cancelPress);
    span.addEventListener('pointercancel', cancelPress);
    // iOSのコールアウト（コピー/検索）が長押しと競合するので出さない
    span.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  }

  function onWordLongPress(rawToken, lineId) {
    if (!S) return;
    var clean = String(rawToken).replace(/^[^A-Za-z']+|[^A-Za-z']+$/g, '');
    if (!clean) return;
    var topic = S.topic;
    var exists = (topic.words || []).some(function (w) {
      return String(w.en || '').toLowerCase() === clean.toLowerCase();
    });
    if (exists) { ui().toast('すでに語彙にあります: ' + clean); return; }

    ui().confirm('語彙に追加', '「' + clean + '」を語彙に追加しますか？和訳はあとで編集できます。', '追加する')
      .then(function (ok) {
        if (!ok || !S) return;
        addWordToTopic(topic.id, clean, lineId);
      });
  }

  function addWordToTopic(topicId, en, lineId) {
    return EST.store.get('topics', topicId).then(function (topic) {
      if (!topic) return;
      // 長押しのあいだに他の変更が入っていた場合に備え、直前の値を読み直す
      if ((topic.words || []).some(function (w) { return String(w.en || '').toLowerCase() === en.toLowerCase(); })) {
        ui().toast('すでに語彙にあります: ' + en);
        return;
      }
      var words = (topic.words || []).slice();
      var n = words.length + 1;
      var id = 'w_' + EST.schema.pad3(n);
      while (words.some(function (w) { return w.id === id; })) { n++; id = 'w_' + EST.schema.pad3(n); }
      words.push({
        id: id, en: en, ja: '',
        type: EST.schema.countWords(en) > 1 ? 'phrase' : 'word',
        lineIds: lineId ? [lineId] : [], note: ''
      });
      topic.words = words;
      topic.updatedAt = Date.now();
      return EST.store.put('topics', topic).then(function () {
        if (S && S.topic && S.topic.id === topicId) S.topic = topic;
        ui().toast('語彙に追加しました');
      });
    });
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
    if (!S || S.closing || S.halted) return;
    // §2.8 期待しない経路から来た rep は無視する。経路が増えたときに
    // 同じ事故（お手本の再生中にマイク側が回を閉じる）を繰り返さないための保険。
    if (S.expectRepSource && e.source && e.source !== S.expectRepSource) {
      console.warn('[practice] 想定外の経路の rep を無視しました: ' + e.source +
                   '（期待は ' + S.expectRepSource + '）');
      return;
    }
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
    S.runningLine = false;   // この行は終わった。次の runLine() を通す
    stopTimeBar();

    var lineId = S.lastLineId;
    var stage = S.stage;
    S.lastResult = { result: result, lineId: lineId, stage: stage };

    EST.stage.recordRep(S.tp, lineId, S.topic.id, result);
    EST.stage.saveTopicProgress(S.tp);
    // 保存が終わってからメーターを描き直す。先に描くと、いま数えた1回が
    // 反映される前の値（この文 0回）が出てしまう。
    // §1.4 定着判定はシャッフル状態（S5以降）での測定でのみ行う
    var mode = EST.stage.stageMode(stage);
    var line = S.item && S.item.line;
    EST.stage.recordLineProgress(S.topic.id, lineId, stage, result, line, { shuffled: !!mode.shuffled })
      .then(function (p) {
        refreshMeter(lineId);
        if (p && p.mastered && !S.masteredShown) {
          // 定着した瞬間だけ控えめに出す
          el.notice.textContent = '定着しました';
        }
      });
    if (result.ok && !result.listenOnly) flash();

    // §7.2 行が進む最短間隔に下限を置く。何かが壊れて即座に確定が返っても、
    // これ以上速くは流れない（画面が流れ去るのを防ぐ最後の砦）。
    var elapsed = Date.now() - (S.lineStartedAt || 0);
    later(nextLine, Math.max(NEXT_LINE_DELAY_MS, MIN_LINE_INTERVAL_MS - elapsed));
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
    if (S.idx < S.queue.length) { runLine(); return; }

    // 最後まで行った → 1周
    S.idx = 0;
    S.tp.laps = S.tp.laps || { total: 0, byStage: {} };
    S.tp.laps.total = (S.tp.laps.total || 0) + 1;
    S.tp.laps.byStage[S.stage] = (S.tp.laps.byStage[S.stage] || 0) + 1;
    EST.stage.saveTopicProgress(S.tp);

    var mode = EST.stage.stageMode(S.stage);
    // §1.3 S5・S6 は周ごとに並べ替え直す。直前に出た行が続かないようにする。
    if (mode.shuffled) {
      var lastKey = S.queue.length ? S.queue[S.queue.length - 1].line.id : null;
      S.queue = EST.stage.buildQueue(S.stage, S.topic, S.blockLines, S.role, lastKey);
    }

    // §1.2 S5・S6 の進級は「全行が定着基準を満たす」ので非同期に判定する
    if (S.stage === 'S5' || S.stage === 'S6') {
      EST.stage.canAdvanceMastery(S.tp, S.topic, S.blockLines, S.role).then(function (ok) {
        if (!S || S.closing) return;
        if (ok) onStageCleared();
        else runLine();
      });
      return;
    }

    // §1.2 条件を満たしたら控えめに知らせる。進級は強制しない。
    if (EST.stage.canAdvance(S.tp)) showAdvanceOffer();
    else runLine();
  }

  /* S5・S6 をクリアしたとき。S6 の後は役交代を提案する（§1.1）。 */
  function onStageCleared() {
    if (S.stage === 'S6') { offerRoleSwapOrAdvance(); return; }
    showAdvanceOffer();
  }

  /* §1.1 役交代。S6を終えたら「相手の役でもやりますか」を出す。
     §5.6 Topic.myRole は書き換えず TopicProgress.activeRole に持つ。
     Topic は配信で配られる共有データなので、書き戻すと次の配信で
     元に戻され、audience:"both" の台本では相手の役まで変わる。 */
  function offerRoleSwapOrAdvance() {
    var U = ui();
    var other = EST.stage.otherRole(S.topic, S.role);
    // 相手役が無い（1人しか話者がいない）場合は交代の余地がない
    if (!other || S.tp.roleSwapOffered) { markBlockDone(); return; }

    S.tp.roleSwapOffered = true;
    EST.stage.saveTopicProgress(S.tp);

    var otherLabel = other;
    (S.topic.speakers || []).forEach(function (s) { if (s.id === other) otherLabel = s.label || other; });

    U.dialog({
      title: 'このブロックは仕上がりました',
      body: h('div', { class: 'small' }, [
        h('div', { text: '相手の役（' + otherLabel + '）でもやりますか。' }),
        h('div', { style: { marginTop: '.4rem' }, class: 'muted',
          text: '相手の台詞は S1〜S4 で何度も音読しているので、2周目は速く仕上がります。S1〜S4 はやり直しません。' })
      ]),
      buttons: [
        { label: 'あとで', value: 'later' },
        { label: '相手の役でやる', value: 'swap', kind: 'primary' }
      ]
    }).then(function (v) {
      if (!S || S.closing) return;
      if (v === 'swap') {
        // activeRole だけを書き換える。Topic には触らない。
        S.tp.activeRole = other;
        S.tp.roleSwapOffered = false;
        // 相手役の S5 から始める。S1〜S4 はやり直さない（§5.6）
        EST.stage.setCurrentStage(S.tp, S.topic, 'S5');
        S.tp.stageReps = S.tp.stageReps || {};
        S.tp.stageReps.S5 = 0;
        S.tp.stageReps.S6 = 0;
        EST.stage.saveTopicProgress(S.tp).then(function () {
          var topicId = S.topic.id;
          stopSession();
          renderPractice(document.getElementById('view'), topicId);
        });
        return;
      }
      markBlockDone();
    });
  }

  /* §1.5 ブロックを終えて次へ。全ブロック完了なら通しモードを解放する。 */
  function markBlockDone() {
    var U = ui();
    var bid = S.tp.currentBlockId;
    S.tp.blocks[bid] = S.tp.blocks[bid] || {};
    S.tp.blocks[bid].done = true;

    var blocks = EST.stage.blocksOf(S.topic);
    var idx = 0;
    blocks.forEach(function (b, i) { if (b.id === bid) idx = i; });

    if (idx + 1 < blocks.length) {
      // 次のブロックへ。ステージは S1 から。
      S.tp.currentBlockId = blocks[idx + 1].id;
      S.tp.blocks[S.tp.currentBlockId] = S.tp.blocks[S.tp.currentBlockId] || { stage: 'S1', done: false };
      S.tp.stageReps = {};
      S.tp.streak = 0; S.tp.s3FactorIndex = 0; S.tp.s3Streak = 0;
      S.tp.roleSwapOffered = false;
      EST.stage.saveTopicProgress(S.tp).then(function () {
        var topicId = S.topic.id;
        stopSession();
        renderPractice(document.getElementById('view'), topicId);
      });
      return;
    }

    // 全ブロック完了 → 通しモードを解放（§1.5）
    S.tp.fullRun = S.tp.fullRun || {};
    S.tp.fullRun.unlocked = true;
    EST.stage.saveTopicProgress(S.tp).then(function () {
      U.dialog({
        title: 'この台本は仕上がりました',
        body: h('div', { class: 'small', text: '全ブロックが S6 まで終わりました。通しモードが使えます。' }),
        buttons: [{ label: 'トピックへ戻る', value: 'ok', kind: 'primary' }]
      }).then(function () {
        var topicId = S.topic ? S.topic.id : null;
        stopSession();
        location.hash = topicId ? ('#/topic/' + encodeURIComponent(topicId)) : '#/';
      });
    });
  }

  function showAdvanceOffer() {
    var U = ui();
    var nx = EST.stage.nextStage(S.stage);
    if (!nx) { runLine(); return; }
    el.notice.textContent = '';

    U.dialog({
      title: EST.stage.stageLabel(nx) + ' に進めます',
      body: h('div', { class: 'small' }, [
        h('div', { text: '押さなければ ' + EST.stage.stageLabel(S.stage) + ' を続けられます。回数は積み上がります。' })
      ]),
      buttons: [
        { label: '続ける', value: 'stay' },
        { label: '進む', value: 'go', kind: 'primary' }
      ]
    }).then(function (v) {
      if (!S || S.closing) return;
      if (v === 'go') {
        // §5.6 blocks[] に書く。S5・S6 なら byRole にも記録される。
        EST.stage.setCurrentStage(S.tp, S.topic, nx);
        S.tp.streak = 0; S.tp.s3FactorIndex = 0; S.tp.s3Streak = 0;
        S.tp.stageReps = S.tp.stageReps || {};
        S.tp.stageReps[nx] = 0;
        EST.stage.saveTopicProgress(S.tp).then(function () {
          // ステージが変わるとTTS・マイクの扱いも変わるので入り直す
          var topicId = S.topic.id;
          stopSession();
          renderPractice(document.getElementById('view'), topicId);
        });
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
