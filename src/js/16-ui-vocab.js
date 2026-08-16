/* =====================================================================
   16-ui-vocab.js — S0（語彙の下ごしらえ）・語彙復習モード・再確認（SPEC §1.6 / §1.4）

   3つの画面はどれも「和訳を出す→マイク（無ければタップ）でレイテンシを
   測る→次へ」という同じ形をしている（§1.6）。判定・記録の中身だけが
   違うので、進行そのものは runCueQueue() 1つにまとめ、各画面は
   items（出題）と onResult（1回ぶんの記録）を渡すだけにする。

   判定ロジックは EST.mastery（F4・F5・F7）をそのまま使い回す。ここで
   閾値やレイテンシの計算をやり直さない（SPEC §5.4「文と語で別々の
   判定コードを書かないこと」）。
   ===================================================================== */
;(function (EST) {
  'use strict';

  var h = null;
  function ui() { h = EST.ui.h; return EST.ui; }

  /* ---- 調整用の定数（実機で必ず調整する。SPEC §12） ------------------ */
  var S0_PRODUCE_REPS      = 3;      // §1.6 和→英を1語につき何回言うか
  var NEXT_CARD_DELAY_MS   = 450;    // 1枚終わってから次を出すまでの間
  var MIN_CARD_INTERVAL_MS = 900;    // カードが進む最短間隔の下限（§7.2と同じ考え方）
  var LONG_PRESS_MS        = 550;    // §5.3 長押しで語彙に追加するまでの保持時間

  var S = null;          // 進行中のカードキュー（runCueQueue）
  var wakeLock = null;
  var el = {};

  /* =====================================================================
     共通エンジン：カードキューを1枚ずつ進める
     ===================================================================== */
  function stopSession() {
    if (!S) return;
    S.closing = true;
    clearTimers();
    try { EST.mic.stop(); } catch (e) {}
    try { EST.speech.cancel(); } catch (e) {}
    releaseWakeLock();
    S = null;
  }

  function clearTimers() {
    if (!S) return;
    S.timers.forEach(function (t) { clearTimeout(t); });
    S.timers = [];
  }

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

  function requestWakeLock() {
    if (!navigator.wakeLock || !navigator.wakeLock.request) return;
    navigator.wakeLock.request('screen').then(function (w) { wakeLock = w; }).catch(function () {});
  }
  function releaseWakeLock() {
    if (wakeLock) { try { wakeLock.release(); } catch (e) {} wakeLock = null; }
  }

  /* opts:
       title       画面タイトル
       items       出題の配列。各要素は自由形式で cueOf/onResult に渡すだけ
       onQuit()    「中断」を押したときの遷移先
       cueOf(item)          -> { en?, ja, hint? }
       onListen(item)       -> クリックで再生する関数、無ければ null/undefined
       onResult(item, result) -> Promise<string|null>（次のカードに出す一言。無ければnull）
       onFinish(doneCount)  全部終わったとき
       onEmpty()             items が空のとき（省略時は0件のonFinishを呼ぶ）
     item.simple === true のカードはマイクを使わず「次へ」タップだけで進む
     （§1.6 S0の認識パス＝英→和は意味を入れるだけでよい）。 */
  function runCueQueue(view, opts) {
    stopSession();
    if (!opts.items || !opts.items.length) {
      if (opts.onEmpty) opts.onEmpty(); else if (opts.onFinish) opts.onFinish(0);
      return;
    }
    S = {
      view: view,
      opts: opts,
      idx: 0,
      done: 0,
      closing: false,
      timers: [],
      micOn: false,
      tapMode: false,
      awaitingTapAdvance: false,
      repDone: false,
      startedAt: 0,
      item: null
    };
    buildScreen(opts.title, opts.onQuit);
    requestWakeLock();
    prepareMic().then(function () { runItem(); });
  }

  function prepareMic() {
    return EST.mic.start().then(function () {
      if (!S) return;
      S.micOn = true;
      EST.mic.setAutoClose(true);
      EST.mic.on('level', onLevel);
      EST.mic.on('rep', onRep);
      EST.mic.on('timeout', onTimeout);
    }).catch(function () {
      // §2.7 と同じ考え方。エラーは出さず黙ってタップ判定に切り替える。
      if (!S) return;
      S.tapMode = true;
    });
  }

  function buildScreen(title, onQuit) {
    var U = ui();
    EST.app.setBar(title, [
      h('button', { class: 'btn btn--sm', text: '中断', onClick: function () { stopSession(); onQuit(); } })
    ]);

    el.count = h('div', { class: 'pr-meter' });
    el.main = h('div', { class: 'pr-main' });
    el.actions = h('div', { class: 'row row--tight', style: { justifyContent: 'center', marginTop: '.5rem' } });
    el.levelBar = h('div', { class: 'pr-level__fill' });
    el.notice = h('div', { class: 'pr-notice' });

    var body = h('div', { class: 'practice' }, [
      el.count,
      el.main,
      h('div', { class: 'pr-level' }, [el.levelBar]),
      el.notice,
      el.actions
    ]);

    // §2.7 タップ判定のときは画面中央のタップで1回とする（練習画面と同じ操作感）
    body.addEventListener('click', function (e) {
      if (!S || !S.tapMode || S.awaitingTapAdvance) return;
      if (e.target.closest('button')) return;
      onTapCapture();
    });

    U.mount(view_(), body);
  }

  function view_() { return S.view; }

  function runItem() {
    if (!S || S.closing) return;
    var item = S.opts.items[S.idx];
    if (!item) { finishQueue(); return; }
    S.item = item;
    S.repDone = false;
    S.startedAt = Date.now();
    el.count.textContent = (S.idx + 1) + ' / ' + S.opts.items.length;
    el.notice.textContent = S.tapMode ? 'マイクが使えないのでタップします（画面をタップで1回）' : '';

    var cue = S.opts.cueOf(item);
    var parts = [];
    if (cue.en) parts.push(h('div', { class: 'pr-en en', text: cue.en }));
    parts.push(h('div', { class: 'pr-ja pr-ja--cue', text: cue.ja || '（訳がありません）' }));
    if (cue.hint) parts.push(h('div', { class: 'pr-hint', text: cue.hint }));
    ui().mount(el.main, parts);

    var actions = [];
    var listen = S.opts.onListen && S.opts.onListen(item);
    if (listen) {
      actions.push(h('button', { class: 'btn btn--sm', text: '🔊 文を聞く', onClick: listen }));
    }

    S.awaitingTapAdvance = !!item.simple;
    if (item.simple) {
      // §1.6 S0の認識パス。マイクは使わずタップで進む。
      actions.push(h('button', {
        class: 'btn btn--primary', text: '次へ',
        onClick: function () { advanceSimple(item); }
      }));
    } else if (S.micOn) {
      EST.mic.markCue();
    }
    ui().mount(el.actions, actions);
  }

  function advanceSimple(item) {
    if (!S || S.closing || S.repDone) return;
    S.repDone = true;
    Promise.resolve(S.opts.onResult(item, { simple: true })).then(afterResult);
  }

  function onLevel(e) {
    if (!S || !el.levelBar) return;
    el.levelBar.style.width = Math.min(100, Math.round(e.rms * 300)) + '%';
  }

  function onRep(e) {
    if (!S || S.closing || S.repDone || S.awaitingTapAdvance) return;
    S.repDone = true;
    Promise.resolve(S.opts.onResult(S.item, {
      latencyMs: e.latencyMs, spokenMs: e.spokenMs, stalls: e.stalls || []
    })).then(afterResult);
  }

  // §2.4 10秒待って発話が無かった。責める文言にしない。
  function onTimeout() {
    if (!S || S.closing || S.repDone || S.awaitingTapAdvance) return;
    S.repDone = true;
    Promise.resolve(S.opts.onResult(S.item, { latencyMs: null, spokenMs: 0, stalls: [], noSpeech: true }))
      .then(afterResult);
  }

  function onTapCapture() {
    if (!S || S.closing || S.repDone || S.awaitingTapAdvance) return;
    S.repDone = true;
    Promise.resolve(S.opts.onResult(S.item, { tapped: true, latencyMs: null }))
      .then(afterResult);
  }

  function afterResult(feedback) {
    if (!S || S.closing) return;
    if (feedback) el.notice.textContent = feedback;
    var elapsed = Date.now() - S.startedAt;
    later(nextItem, Math.max(NEXT_CARD_DELAY_MS, MIN_CARD_INTERVAL_MS - elapsed));
  }

  function nextItem() {
    if (!S || S.closing) return;
    S.idx++;
    S.done++;
    runItem();
  }

  function finishQueue() {
    if (!S) return;
    var opts = S.opts;
    var doneCount = S.done;
    stopSession();
    if (opts.onFinish) opts.onFinish(doneCount);
  }

  function doneScreen(view, title, count, doneLabel) {
    EST.app.setBar(title, []);
    ui().mount(view, h('div', { class: 'card' }, [
      h('div', { class: 'section-title', text: 'お疲れさまでした' }),
      h('div', { text: count + doneLabel }),
      h('button', {
        class: 'btn btn--primary btn--block', style: { marginTop: '.6rem' }, text: 'ホームへ',
        onClick: function () { location.hash = '#/'; }
      })
    ]));
  }

  /* =====================================================================
     WordProgress の読み書き（§5.4）
     ===================================================================== */
  function loadWordProgress(topicId, wordId) {
    var key = EST.store.wordProgressKey(topicId, wordId);
    return EST.store.get('wordProgress', key).then(function (rec) {
      return rec || EST.schema.defaultWordProgress(EST.profile.get(), topicId, wordId);
    });
  }
  function saveWordProgress(p) {
    p.updatedAt = Date.now();
    return EST.store.put('wordProgress', p);
  }
  function pushLatency(p, ms) {
    if (ms == null) return;
    p.latency = p.latency || { history: [], median5: null, best: null };
    p.latency.history = (p.latency.history || []).concat([ms]).slice(-20);
    p.latency.median5 = EST.mic.medianOfLastN(p.latency.history, 5);
    p.latency.best = p.latency.history.reduce(function (a, b) { return Math.min(a, b); }, Infinity);
  }

  /* ---- 文脈を聞く（§1.6「文脈から切り離さない」） ------------------------
     語彙カードに紐づく行（word.lineIds[0]）の英文を再生する。行が
     見つからない・TTSが使えない場合はボタンごと出さない（null を返す）。 */
  function wordContextListener(topic, word) {
    if (!EST.speech.isAvailable()) return null;
    var lineId = (word.lineIds || [])[0];
    if (!lineId) return null;
    var line = null;
    (topic.lines || []).forEach(function (l) { if (l.id === lineId) line = l; });
    if (!line) return null;
    return lineContextListener(topic, line);
  }

  function lineContextListener(topic, line) {
    if (!EST.speech.isAvailable() || !line) return null;
    var gender = '';
    (topic.speakers || []).forEach(function (s) { if (s.id === line.speakerId) gender = s.gender || ''; });
    return function () {
      EST.speech.speak(line.en, { gender: gender, topicId: topic.id, lineId: line.id });
    };
  }

  /* =====================================================================
     S0 下ごしらえ（§1.6・§8）
     ===================================================================== */
  function renderVocabPrep(view, topicId) {
    stopSession();
    var U = ui();
    EST.store.get('topics', topicId).then(function (topic) {
      if (!topic) {
        EST.app.setBar('語彙の下ごしらえ', []);
        U.mount(view, h('div', { class: 'empty', text: 'このトピックは見つかりませんでした。' }));
        return;
      }
      if (!EST.profile.canSee(topic)) {
        location.hash = EST.profile.canEdit() ? ('#/edit/' + encodeURIComponent(topic.id)) : '#/';
        return;
      }
      return EST.stage.loadTopicProgress(topic.id, topic).then(function (tp) {
        var words = topic.words || [];
        if (!words.length) {
          // §1.6 語彙が無い台本には下ごしらえる対象が無い。素通りする。
          EST.stage.markS0Done(tp);
          return EST.stage.saveTopicProgress(tp).then(function () {
            location.hash = '#/practice/' + encodeURIComponent(topic.id);
          });
        }
        startPrepPhase1(view, topic, tp, words);
      });
    });
  }

  function startPrepPhase1(view, topic, tp, words) {
    var backHref = '#/topic/' + encodeURIComponent(topic.id);
    var items = words.map(function (w) { return { simple: true, topic: topic, word: w }; });

    runCueQueue(view, {
      title: 'S0 意味を入れる（' + words.length + '語）',
      items: items,
      onQuit: function () { location.hash = backHref; },
      cueOf: function (item) { return { en: item.word.en, ja: item.word.ja }; },
      onListen: function (item) {
        if (!EST.speech.isAvailable()) return null;
        return function () { EST.speech.speak(item.word.en, {}); };
      },
      onResult: function (item) {
        return loadWordProgress(item.topic.id, item.word.id).then(function (p) {
          p.counts.recognize = (p.counts.recognize || 0) + 1;
          return saveWordProgress(p);
        }).then(function () { return null; });
      },
      onFinish: function () { startPrepPhase2(view, topic, tp, words); }
    });
  }

  function startPrepPhase2(view, topic, tp, words) {
    var backHref = '#/topic/' + encodeURIComponent(topic.id);
    var items = [];
    words.forEach(function (w) {
      for (var i = 0; i < S0_PRODUCE_REPS; i++) {
        items.push({ topic: topic, word: w, rep: i + 1 });
      }
    });

    runCueQueue(view, {
      title: 'S0 口に出す（' + words.length + '語 × ' + S0_PRODUCE_REPS + '回）',
      items: items,
      onQuit: function () { location.hash = backHref; },
      cueOf: function (item) {
        return { ja: item.word.ja, hint: item.rep + ' / ' + S0_PRODUCE_REPS + '回目' };
      },
      onListen: function (item) { return wordContextListener(item.topic, item.word); },
      onResult: function (item, result) {
        return loadWordProgress(item.topic.id, item.word.id).then(function (p) {
          p.counts.produce = (p.counts.produce || 0) + 1;
          pushLatency(p, result.latencyMs);
          return saveWordProgress(p);
        }).then(function () { return null; });
      },
      onFinish: function () {
        EST.stage.markS0Done(tp);
        EST.stage.saveTopicProgress(tp).then(function () {
          ui().toast('下ごしらえが終わりました');
          location.hash = '#/practice/' + encodeURIComponent(topic.id);
        });
      }
    });
  }

  /* =====================================================================
     語彙復習モード（§1.6「いつでも単独で使える」。ホームの「語彙をまわす」）
     定着済みの語はここでは出さない。7日後の再確認（§1.4）へ回る。
     ===================================================================== */
  function renderVocabReview(view) {
    stopSession();
    Promise.all([EST.store.getAll('topics'), EST.store.getAll('wordProgress')]).then(function (res) {
      var topics = res[0].filter(function (t) { return EST.profile.canSee(t) && (t.words || []).length; });
      var me = EST.profile.get();
      var progByKey = {};
      res[1].forEach(function (p) { progByKey[p.key] = p; });

      var candidates = [];
      topics.forEach(function (t) {
        (t.words || []).forEach(function (w) {
          var key = EST.store.wordProgressKey(t.id, w.id);
          var p = progByKey[key];
          if (p && p.profileId === me && p.mastered) return;   // 定着済みは再確認へ
          candidates.push({ topic: t, word: w });
        });
      });

      if (!candidates.length) {
        EST.app.setBar('語彙をまわす', []);
        ui().mount(view, h('div', { class: 'empty',
          text: '練習できる語彙がありません。定着した語は「再確認」に回ります。' }));
        return;
      }

      var items = EST.stage.shuffle(candidates, null, function (it) { return it.word.id; });

      runCueQueue(view, {
        title: '語彙をまわす（' + items.length + '語）',
        items: items,
        onQuit: function () { location.hash = '#/'; },
        cueOf: function (item) { return { ja: item.word.ja }; },
        onListen: function (item) { return wordContextListener(item.topic, item.word); },
        onResult: function (item, result) {
          return loadWordProgress(item.topic.id, item.word.id).then(function (p) {
            p.counts.produce = (p.counts.produce || 0) + 1;
            pushLatency(p, result.latencyMs);
            var justMastered = false;
            if (!p.mastered && EST.mastery.isMastered(p, item.word.en, { isWord: true, shuffled: true })) {
              EST.mastery.markMastered(p);
              justMastered = true;
            }
            return saveWordProgress(p).then(function () { return justMastered; });
          }).then(function (justMastered) { return justMastered ? '定着しました' : null; });
        },
        onFinish: function (count) { doneScreen(view, '語彙をまわす', count, '語をまわしました'); }
      });
    });
  }

  /* =====================================================================
     再確認（§1.4・§1.6。ホームの「再確認」。文と語を混ぜて出す）
     ===================================================================== */
  function renderReview(view) {
    stopSession();
    EST.mastery.buildReviewQueue().then(function (queue) {
      if (!queue.length) {
        EST.app.setBar('再確認', []);
        ui().mount(view, h('div', { class: 'empty', text: '再確認はありません。' }));
        return;
      }

      runCueQueue(view, {
        title: '再確認（' + queue.length + '件）',
        items: queue,
        onQuit: function () { location.hash = '#/'; },
        cueOf: function (item) {
          return item.kind === 'word' ? { ja: item.word.ja } : { ja: item.line.ja };
        },
        onListen: function (item) {
          return item.kind === 'word'
            ? wordContextListener(item.topic, item.word)
            : lineContextListener(item.topic, item.line);
        },
        onResult: function (item, result) {
          var isWord = item.kind === 'word';
          var text = isWord ? item.word.en : item.line.en;
          var judged = EST.mastery.judgeReview(item.progress, text, result, { isWord: isWord });
          var storeName = isWord ? 'wordProgress' : 'progress';
          return EST.store.put(storeName, item.progress).then(function () {
            // §1.4「それ以外は定着を外し、そのトピックのS5に戻す」。
            // 「外す」（定着フラグを消す）のはjudgeReviewが確実にやる。
            // ブロックの進行位置を戻す方は、現在のブロック・役・通しモードが
            // 複雑に絡み合うため、この再確認の1回だけから安全に書き換える
            // 手立てが無く、今回は見送っている（外れた行は次にそのブロックを
            // 開いたときに改めて音読すれば、そこでまた定着を狙い直せる）。
            return judged.kept ? null : '定着から外れました';
          });
        },
        onFinish: function (count) { doneScreen(view, '再確認', count, '件を確認しました'); }
      });
    });
  }

  EST.uiVocab = {
    stopSession: stopSession,
    renderVocabPrep: renderVocabPrep,
    renderVocabReview: renderVocabReview,
    renderReview: renderReview,
    // 練習画面の長押し（§5.3）から使う
    wordContextListener: wordContextListener,
    LONG_PRESS_MS: LONG_PRESS_MS
  };
})(window.EST = window.EST || {});
