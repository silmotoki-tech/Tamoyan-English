/* =====================================================================
   21-ui-dictation.js — ディクテーションドリル（SPEC §9.2・§1.7）

   音声を聞いて英文を書き取る。全文書き取りと、キーワード穴埋め（4択）の
   2段階。「3回以内で書けた率」を指標にするので、再生回数を必ず記録する。
   採点は 19-diff-score.js に丸投げする（大文字小文字は別枠でチェック）。
   ===================================================================== */
;(function (EST) {
  'use strict';

  var h = null;
  function ui() { h = EST.ui.h; return EST.ui; }

  var SLOW_RATE = 0.7;   // §9.2 速度は0.7倍を下限とする
  var D = null;   // 進行中のドリル

  function renderDictation(view, topicId) {
    stopSession();
    var U = ui();

    EST.store.get('topics', topicId).then(function (topic) {
      if (!topic) {
        EST.app.setBar('ディクテーション', []);
        U.mount(view, h('div', { class: 'empty', text: 'このトピックは見つかりませんでした。' }));
        return;
      }
      if (!EST.profile.canSee(topic)) {
        location.hash = EST.profile.canEdit() ? ('#/edit/' + encodeURIComponent(topic.id)) : '#/';
        return;
      }
      return EST.stage.loadTopicProgress(topic.id, topic).then(function (tp) {
        return EST.store.loadSettings().then(function (settings) {
          var role = EST.stage.activeRole(tp, topic);
          var lines = (topic.lines || []).filter(function (l) {
            return !l.skip && String(l.en || '').trim() && l.speakerId === role;
          });
          if (!lines.length) {
            EST.app.setBar('ディクテーション', []);
            U.mount(view, h('div', { class: 'empty', text: '自分の役の行がありません。' }));
            return;
          }
          var items = EST.stage.shuffle(lines, null, function (l) { return l.id; })
            .map(function (l) { return { line: l }; });
          D = {
            view: view, topic: topic, tp: tp, role: role, settings: settings,
            strictness: settings.writeStrictness || 'normal',
            mode: 'full',   // 'full' | 'blank'
            queue: items, idx: 0, correct: 0, total: 0, within3: 0,
            replays: 0, result: null, closing: false, el: {}, blankPicks: {}
          };
          runItem();
        });
      });
    });
  }

  function stopSession() {
    if (!D) return;
    D.closing = true;
    try { EST.speech.cancel(); } catch (e) {}
    D = null;
  }

  function runItem() {
    if (!D || D.closing) return;
    if (D.idx >= D.queue.length) { finishDrill(); return; }
    D.replays = 0;
    D.result = null;
    D.blankPicks = {};
    buildScreen();
  }

  function genderOf(line) {
    var sp = (D.topic.speakers || []).filter(function (s) { return s.id === line.speakerId; })[0];
    return sp ? sp.gender : '';
  }

  function play(line, rate) {
    D.replays++;
    if (D.el.replayCount) D.el.replayCount.textContent = '再生 ' + D.replays + '回';
    EST.speech.speak(line.en, { rate: rate, gender: genderOf(line), topicId: D.topic.id, lineId: line.id });
  }

  /* ---- 画面 ---------------------------------------------------------------- */
  function buildScreen() {
    var U = ui();
    var line = D.queue[D.idx].line;

    var modeToggle = h('div', { class: 'dict-mode-toggle' }, [
      h('button', { class: 'btn btn--sm' + (D.mode === 'full' ? ' btn--primary' : ''), text: '全文書き取り',
        onClick: function () { D.mode = 'full'; runItem(); } }),
      h('button', { class: 'btn btn--sm' + (D.mode === 'blank' ? ' btn--primary' : ''), text: '穴埋め',
        onClick: function () { D.mode = 'blank'; runItem(); } })
    ]);

    EST.app.setBar('ディクテーション', [
      h('button', { class: 'btn btn--sm', text: 'やめる',
        onClick: function () { location.hash = '#/topic/' + encodeURIComponent(D.topic.id); } })
    ]);

    var count = h('div', { class: 'write-count',
      text: (D.idx + 1) + ' / ' + D.queue.length + '（3回以内 ' + D.within3 + ' / ' + D.total + '）' });

    D.el.replayCount = h('span', { class: 'muted', text: '再生 0回' });
    var playBtn = h('button', { class: 'btn', text: '🔊 再生' });
    playBtn.addEventListener('click', function () { play(line, D.settings.ttsRate); });
    var slowBtn = h('button', { class: 'btn btn--sm', text: 'ゆっくり(0.7x)' });
    slowBtn.addEventListener('click', function () { play(line, SLOW_RATE); });

    var body = D.mode === 'blank' ? buildBlankBody(line) : buildFullBody(line);

    var resultHost = h('div', {});
    D.el.resultHost = resultHost;
    D.el.count = count;

    U.mount(D.view, h('div', { class: 'write-screen' }, [
      modeToggle, count,
      h('div', { style: { display: 'flex', gap: '.5rem', alignItems: 'center' } }, [playBtn, slowBtn, D.el.replayCount]),
      body, resultHost
    ]));
  }

  function buildFullBody(line) {
    var U = ui();
    var input = h('textarea', { class: 'write-input', rows: 2, placeholder: '聞こえた英文を入力…' });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitFull(line, input.value); }
    });
    var submitBtn = h('button', { class: 'btn btn--primary', text: '答え合わせ' });
    submitBtn.addEventListener('click', function () { submitFull(line, input.value); });
    setTimeout(function () { try { input.focus(); } catch (e) {} }, 0);
    return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '.5rem' } }, [input, submitBtn]);
  }

  function submitFull(line, answerText) {
    if (!D || D.closing || D.result) return;
    var r = EST.diffScore.scoreAnswer(answerText, line, {
      strictness: D.strictness, checkCase: true, rawAnswer: answerText
    });
    finishItem(line, r.passed, r);
  }

  // §9.2 穴埋めの空欄は自動選択（19-diff-score.js）。4択で選ばせる。
  function buildBlankBody(line) {
    var U = ui();
    var blanks = EST.diffScore.pickBlanks(line, D.topic);
    var words = String(line.en || '').replace(/[.,!?]/g, '').split(/\s+/).filter(Boolean);
    var blankByIdx = {};
    blanks.forEach(function (b) { blankByIdx[b.index] = b.word; });

    var sentenceEl = h('div', { class: 'write-target' });
    words.forEach(function (w, i) {
      if (blankByIdx[i] == null) {
        U.append(sentenceEl, w + ' ');
        return;
      }
      var correctWord = blankByIdx[i];
      var options = EST.stage.shuffle(
        [correctWord].concat(EST.diffScore.buildDistractors(correctWord, D.topic, 3)),
        null, function (x) { return x; }
      );
      var optEls = options.map(function (opt) {
        var btn = h('button', { class: 'dict-blank__opt', type: 'button', text: opt });
        btn.addEventListener('click', function () {
          D.blankPicks[i] = opt;
          Array.prototype.forEach.call(btn.parentNode.children, function (c) { c.classList.remove('is-selected'); });
          btn.classList.add('is-selected');
        });
        return btn;
      });
      U.append(sentenceEl, h('span', { class: 'dict-blank' }, optEls));
      U.append(sentenceEl, ' ');
    });

    D.el.blankAnswerKey = blankByIdx;

    var submitBtn = h('button', { class: 'btn btn--primary', text: '答え合わせ' });
    submitBtn.addEventListener('click', function () { submitBlank(line, blankByIdx); });
    return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '.6rem' } }, [sentenceEl, submitBtn]);
  }

  function submitBlank(line, blankByIdx) {
    if (!D || D.closing || D.result) return;
    var keys = Object.keys(blankByIdx);
    var allPicked = keys.every(function (i) { return D.blankPicks[i] != null; });
    if (!allPicked) { ui().toast('すべての空欄を選んでください'); return; }
    var allCorrect = keys.every(function (i) { return D.blankPicks[i] === blankByIdx[i]; });
    finishItem(line, allCorrect, null);
  }

  function finishItem(line, passed, diffResult) {
    D.total++;
    if (passed) D.correct++;
    if (D.replays > 0 && D.replays <= 3) D.within3++;
    D.result = { passed: passed };
    if (D.el.count) D.el.count.textContent = (D.idx + 1) + ' / ' + D.queue.length + '（3回以内 ' + D.within3 + ' / ' + D.total + '）';
    EST.stage.recordWritingResult(D.topic.id, line.id, 'dictation', passed, { replays: D.replays });
    renderResult(line, passed, diffResult);
  }

  function renderResult(line, passed, diffResult) {
    var U = ui();
    var parts = [];
    parts.push(h('div', { class: 'write-score ' + (passed ? 'write-score--pass' : 'write-score--fail'),
      text: passed ? '正解' : '不正解' }));

    if (diffResult) {
      parts.push(h('div', { class: 'write-target' }, U.diffSpans(diffResult.targetWordDiff)));
      if (diffResult.caseIssues && diffResult.caseIssues.length) {
        parts.push(h('div', { class: 'write-tags' }, [
          h('span', { class: 'write-tag write-tag--warn', text: '大文字小文字の違いあり' })
        ]));
      }
    } else {
      parts.push(h('div', { class: 'write-target', text: line.en }));
    }

    var playBtn = h('button', { class: 'btn btn--sm', text: '🔊 もう一度聞く' });
    playBtn.addEventListener('click', function () { play(line, D.settings.ttsRate); });

    var nextBtn = h('button', { class: 'btn btn--primary', text: D.idx + 1 < D.queue.length ? '次へ' : '終える' });
    nextBtn.addEventListener('click', function () { D.idx++; runItem(); });

    parts.push(h('div', { style: { display: 'flex', gap: '.5rem' } }, [playBtn]));
    parts.push(nextBtn);

    U.mount(D.el.resultHost, h('div', { class: 'write-result' }, parts));
  }

  function finishDrill() {
    var U = ui();
    EST.app.setBar('ディクテーション', []);
    U.mount(D.view, h('div', { class: 'empty' }, [
      h('div', { text: '終わりました（' + D.correct + ' / ' + D.total + '、3回以内 ' + D.within3 + ' / ' + D.total + '）' }),
      h('button', { class: 'btn btn--primary', style: { marginTop: '.8rem' }, text: 'トピックに戻る',
        onClick: function () { location.hash = '#/topic/' + encodeURIComponent(D.topic.id); } })
    ]));
  }

  EST.uiDictation = { renderDictation: renderDictation, stopSession: stopSession };
})(window.EST = window.EST || {});
