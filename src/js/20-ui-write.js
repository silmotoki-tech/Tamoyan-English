/* =====================================================================
   20-ui-write.js — 和文英訳ドリル（SPEC §9.1・§1.7）

   声を出せない時間の書くレーン。和訳だけを見せて英文をキーボードで
   入力させる。音読レーンのS5の筆記版にあたるので、対象は自分の役の行、
   順序はシャッフル。レイテンシは測らない（打鍵速度が混ざるため）。

   採点は 19-diff-score.js に丸投げする。ヒントは3段階、使っても減点しない
   （§9.1）。「これも正解として登録」は §9.3 の要にあたるので必ず出す。
   ===================================================================== */
;(function (EST) {
  'use strict';

  var h = null;
  function ui() { h = EST.ui.h; return EST.ui; }

  var W = null;   // 進行中のドリル

  function renderWrite(view, topicId) {
    stopSession();
    var U = ui();

    EST.store.get('topics', topicId).then(function (topic) {
      if (!topic) {
        EST.app.setBar('和文英訳', []);
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
            EST.app.setBar('和文英訳', []);
            U.mount(view, h('div', { class: 'empty', text: '自分の役の行がありません。' }));
            return;
          }
          var items = EST.stage.shuffle(lines, null, function (l) { return l.id; })
            .map(function (l) { return { line: l }; });
          W = {
            view: view, topic: topic, tp: tp, role: role, settings: settings,
            strictness: settings.writeStrictness || 'normal',
            queue: items, idx: 0, correct: 0, total: 0,
            hintLevel: 0, result: null, closing: false, el: {}
          };
          runItem();
        });
      });
    });
  }

  function stopSession() {
    if (!W) return;
    W.closing = true;
    try { EST.speech.cancel(); } catch (e) {}
    W = null;
  }

  /* ---- 画面 ---------------------------------------------------------------- */
  function runItem() {
    if (!W || W.closing) return;
    if (W.idx >= W.queue.length) { finishDrill(); return; }
    W.hintLevel = 0;
    W.result = null;
    buildScreen();
  }

  function buildScreen() {
    var U = ui();
    var line = W.queue[W.idx].line;

    EST.app.setBar('和文英訳', [
      h('button', { class: 'btn btn--sm', text: 'やめる',
        onClick: function () { location.hash = '#/topic/' + encodeURIComponent(W.topic.id); } })
    ]);

    var count = h('div', { class: 'write-count', text: (W.idx + 1) + ' / ' + W.queue.length + '（正解 ' + W.correct + '）' });
    var ja = h('div', { class: 'write-ja', text: line.ja || '' });
    var input = h('textarea', { class: 'write-input', rows: 2, placeholder: '英語で入力…' });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(input.value); }
    });

    var hintArea = h('div', { class: 'write-hints' });
    var hintBtn = h('button', { class: 'btn btn--sm', text: 'ヒント' });
    hintBtn.addEventListener('click', function () { W.hintLevel = Math.min(3, W.hintLevel + 1); renderHint(hintArea, line, input); });

    var submitBtn = h('button', { class: 'btn btn--primary', text: '答え合わせ' });
    submitBtn.addEventListener('click', function () { submit(input.value); });

    var resultHost = h('div', {});
    W.el = { resultHost: resultHost, count: count };

    U.mount(W.view, h('div', { class: 'write-screen' }, [
      count, ja, input,
      h('div', { style: { display: 'flex', gap: '.5rem' } }, [hintBtn, submitBtn]),
      hintArea, resultHost
    ]));
    setTimeout(function () { try { input.focus(); } catch (e) {} }, 0);
  }

  // §9.1 ヒントは3段階。使っても減点しない。
  //  ①語数だけ　②最初の1語　③チャンクを並べ替え候補として提示（タップで挿入）
  function renderHint(hintArea, line, input) {
    var U = ui();
    if (W.hintLevel === 1) {
      var words = EST.schema.countWords(line.en);
      U.mount(hintArea, h('div', { class: 'write-hint', text: Array(words).fill('_').join(' ') }));
    } else if (W.hintLevel === 2) {
      var first = String(line.en || '').trim().split(/\s+/)[0] || '';
      U.mount(hintArea, h('div', { class: 'write-hint', text: '最初の1語: ' + first }));
    } else if (W.hintLevel >= 3) {
      var chunks = (line.chunks && line.chunks.length) ? line.chunks : EST.schema.splitChunks(line.en);
      var shuffled = EST.stage.shuffle(chunks, null, function (c) { return c; });
      U.mount(hintArea, h('div', { class: 'write-hints' }, shuffled.map(function (c) {
        var chip = h('button', { class: 'write-chunk', type: 'button', text: c });
        chip.addEventListener('click', function () {
          input.value = (input.value ? input.value.replace(/\s+$/, '') + ' ' : '') + c + ' ';
          input.focus();
        });
        return chip;
      })));
    }
  }

  function submit(answerText) {
    if (!W || W.closing || W.result) return;
    var line = W.queue[W.idx].line;
    var r = EST.diffScore.scoreAnswer(answerText, line, { strictness: W.strictness });
    W.result = r;
    W.total++;
    if (r.passed) W.correct++;
    if (W.el.count) W.el.count.textContent = (W.idx + 1) + ' / ' + W.queue.length + '（正解 ' + W.correct + '）';
    EST.stage.recordWritingResult(W.topic.id, line.id, 'essay', r.passed);
    renderResult(line, answerText, r);
  }

  function renderResult(line, answerText, r) {
    var U = ui();
    var scoreClass = r.exact ? 'write-score--pass' : (r.passed ? 'write-score--warn' : 'write-score--fail');
    var scoreLabel = r.exact ? '正解' : (r.passed ? '合格（惜しい）' : '不合格');

    var target = h('div', { class: 'write-target' }, U.diffSpans(r.targetWordDiff));
    var tags = h('div', { class: 'write-tags' }, r.tags.map(function (t) {
      return h('span', { class: 'write-tag' + (EST.diffScore.CLOSE_CALL_TAGS[t] ? ' write-tag--warn' : ''), text: TAG_LABEL[t] || t });
    }));

    var playBtn = h('button', { class: 'btn btn--sm', text: '🔊 模範解答を再生' });
    playBtn.addEventListener('click', function () {
      EST.speech.speak(r.targetText, { gender: genderOf(line), topicId: W.topic.id, lineId: line.id });
    });

    var actions = [playBtn];
    if (!r.exact) {
      var registerBtn = h('button', { class: 'btn btn--sm', text: 'これも正解として登録' });
      registerBtn.addEventListener('click', function () { registerAlt(line, answerText, registerBtn); });
      actions.push(registerBtn);
    }

    var nextBtn = h('button', { class: 'btn btn--primary', text: W.idx + 1 < W.queue.length ? '次へ' : '終える' });
    nextBtn.addEventListener('click', function () { W.idx++; runItem(); });

    U.mount(W.el.resultHost, h('div', { class: 'write-result' }, [
      h('div', { class: 'write-score ' + scoreClass, text: scoreLabel + '（' + r.score + '点）' }),
      target,
      r.tags.length ? tags : null,
      h('div', { style: { display: 'flex', gap: '.5rem', flexWrap: 'wrap' } }, actions),
      nextBtn
    ]));
  }

  function registerAlt(line, answerText, btn) {
    var text = String(answerText || '').trim().replace(/\s+/g, ' ');
    if (!text) return;
    (line.alt = line.alt || []);
    var lower = text.toLowerCase();
    if (line.alt.some(function (a) { return String(a).toLowerCase() === lower; })) {
      ui().toast('すでに登録されています'); return;
    }
    line.alt.push(text);
    W.topic.updatedAt = Date.now();
    EST.store.put('topics', W.topic).then(function () {
      btn.textContent = '登録しました';
      btn.disabled = true;
      ui().toast('これ以降は正解として扱います');
    });
  }

  function genderOf(line) {
    var sp = (W.topic.speakers || []).filter(function (s) { return s.id === line.speakerId; })[0];
    return sp ? sp.gender : '';
  }

  var TAG_LABEL = {
    article: '冠詞', plural: '単複', tense: '時制', preposition: '前置詞',
    wordorder: '語順', missing: '抜け', extra: '余分'
  };

  function finishDrill() {
    var U = ui();
    EST.app.setBar('和文英訳', []);
    U.mount(W.view, h('div', { class: 'empty' }, [
      h('div', { text: '終わりました（' + W.correct + ' / ' + W.total + '）' }),
      h('button', { class: 'btn btn--primary', style: { marginTop: '.8rem' }, text: 'トピックに戻る',
        onClick: function () { location.hash = '#/topic/' + encodeURIComponent(W.topic.id); } })
    ]));
  }

  EST.uiWrite = { renderWrite: renderWrite, stopSession: stopSession };
})(window.EST = window.EST || {});
