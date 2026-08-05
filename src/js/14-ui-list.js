/* =====================================================================
   14-ui-list.js — 一覧モード（SPEC §4.1）
   和訳だけを縦に並べ、タップすると英文が下に開く。「思い出せなかった」を
   1行ずつ開いたときだけ記録する（§5.5）。音声再生（🔊）はF3の内蔵TTSが
   入ってから追加する。ここでは開閉とテキスト書き出しだけを扱う。
   ===================================================================== */
;(function (EST) {
  'use strict';

  var h = null;
  function ui() { h = EST.ui.h; return EST.ui; }

  // 画面ごとの一時状態。ページを離れたらリセットしてよい。
  var view = {
    topic: null,
    settings: null,
    direction: 'ja',      // 'ja' = 和文が主表示 / 'en' = 英文が主表示
    tab: 'lines',         // 'lines' | 'words'
    openLines: {},
    openWords: {}
  };

  var linesBox = null, tabsBox = null, controlsBox = null;

  function renderList(root, id) {
    var U = ui();
    EST.store.get('topics', id).then(function (t) {
      if (!t) {
        EST.app.setBar('一覧', []);
        U.mount(root, h('div', { class: 'empty', text: 'このトピックは見つかりませんでした。' }));
        return;
      }
      // §5.9 自分の部屋の台本でなければ一覧モードにも入らせない（トピック詳細と同じ扱い）
      if (!EST.profile.canSee(t)) {
        location.hash = EST.profile.canEdit() ? ('#/edit/' + encodeURIComponent(t.id)) : '#/';
        return;
      }

      view = { topic: t, settings: null, direction: 'ja', tab: t.lines.length ? 'lines' : 'words', openLines: {}, openWords: {} };

      EST.app.setBar(t.title || '(無題)', [
        h('button', { class: 'btn btn--sm', text: 'トピックへ', onClick: function () { location.hash = '#/topic/' + encodeURIComponent(t.id); } })
      ]);

      build(root);

      EST.store.loadSettings().then(function (s) {
        view.settings = s;
      });
    });
  }

  function build(root) {
    var U = ui();
    var t = view.topic;

    controlsBox = h('div', { class: 'row row--tight', style: { marginBottom: '.5rem' } });
    tabsBox = h('div', { class: 'row row--tight', style: { marginBottom: '.6rem' } });
    linesBox = h('div', {});

    U.mount(root, [
      h('div', { class: 'card' }, [
        controlsBox,
        tabsBox,
        linesBox
      ]),
      h('div', { class: 'card' }, [
        h('h2', { class: 'card__title', text: '書き出し' }),
        h('div', { class: 'row row--tight' }, [
          h('button', { class: 'btn btn--sm', text: 'テキストで書き出す', onClick: function () { exportAs('text'); } }),
          h('button', { class: 'btn btn--sm', text: 'Markdownで書き出す', onClick: function () { exportAs('md'); } })
        ]),
        h('div', { class: 'tiny muted', style: { marginTop: '.3rem' }, text: '語彙一覧の書き出しはF6で追加します。' })
      ])
    ]);

    if (!t.lines.length) view.tab = 'words';
    drawControls();
    drawTabs();
    drawLines();
  }

  /* ---- 上部の操作（反転トグル・全部開く） -------------------------------- */
  function drawControls() {
    var U = ui();
    var allOpen = isAllOpenInActiveTab();
    U.mount(controlsBox, [
      h('button', {
        class: 'btn btn--sm', text: view.direction === 'ja' ? '和→英 ⇄' : '英→和 ⇄',
        onClick: function () { view.direction = view.direction === 'ja' ? 'en' : 'ja'; drawLines(); }
      }),
      h('button', {
        class: 'btn btn--sm', text: allOpen ? '全部閉じる' : '全部開く',
        onClick: toggleAll
      })
    ]);
  }

  function activeItems() {
    return view.tab === 'lines' ? visibleLines() : (view.topic.words || []);
  }
  function activeOpenSet() {
    return view.tab === 'lines' ? view.openLines : view.openWords;
  }
  function itemKey(item) { return view.tab === 'lines' ? item.id : item.id; }

  function isAllOpenInActiveTab() {
    var items = activeItems();
    if (!items.length) return false;
    var set = activeOpenSet();
    return items.every(function (it) { return !!set[itemKey(it)]; });
  }

  // 「全部開く」は一括で目を通す操作なので、§5.5 の openedCount は増やさない
  function toggleAll() {
    var items = activeItems();
    var set = activeOpenSet();
    var makeOpen = !isAllOpenInActiveTab();
    items.forEach(function (it) { set[itemKey(it)] = makeOpen; });
    drawControls();
    drawLines();
  }

  /* ---- タブ（文 / 語彙） -------------------------------------------------- */
  function drawTabs() {
    var U = ui();
    var t = view.topic;
    U.mount(tabsBox, [
      h('button', {
        class: 'btn btn--sm' + (view.tab === 'lines' ? ' btn--primary' : ''),
        text: '文 ' + visibleLines().length,
        onClick: function () { view.tab = 'lines'; drawControls(); drawLines(); }
      }),
      h('button', {
        class: 'btn btn--sm' + (view.tab === 'words' ? ' btn--primary' : ''),
        text: '語彙 ' + (t.words ? t.words.length : 0),
        onClick: function () { view.tab = 'words'; drawControls(); drawLines(); }
      })
    ]);
  }

  // ト書き等（skip:true）は音読対象ではないので一覧モードにも出さない
  function visibleLines() {
    return (view.topic.lines || []).filter(function (l) { return !l.skip; });
  }

  /* ---- 行の表示 ------------------------------------------------------------ */
  function drawLines() {
    var U = ui();
    if (view.tab === 'lines') {
      var lines = visibleLines();
      if (!lines.length) { U.mount(linesBox, h('div', { class: 'empty', text: '表示できる行がありません。' })); return; }
      U.mount(linesBox, lines.map(function (l, i) { return lineRow(l, i); }));
    } else {
      var words = view.topic.words || [];
      if (!words.length) { U.mount(linesBox, h('div', { class: 'empty', text: 'このトピックには語彙がありません。' })); return; }
      U.mount(linesBox, words.map(function (w) { return wordRow(w); }));
    }
  }

  function lineRow(l, i) {
    var U = ui();
    var open = !!view.openLines[l.id];
    var primaryIsEn = view.direction === 'en';
    var primary = primaryIsEn ? l.en : l.ja;
    var secondary = primaryIsEn ? l.ja : l.en;

    // 行そのものはdivにして、中に「開くボタン」と「🔊」を並べる。
    // button の入れ子はHTMLとして不正なので、行自体をbuttonにはできない。
    return h('div', { class: 'list-row' }, [
      h('button', {
        class: 'list-row__main',
        onClick: function () { toggleLine(l); }
      }, [
        h('div', { class: 'row row--tight' }, [
          h('span', { class: 'tiny muted', text: String(i + 1) }),
          h('span', { class: primaryIsEn ? 'en' : '', text: primary || '（空）' })
        ]),
        open ? h('div', { class: 'tiny muted', style: { marginTop: '.15rem', paddingLeft: '1.2rem' } }, [
          '→ ', h('span', { class: primaryIsEn ? '' : 'en', text: secondary || '（空）' })
        ]) : null
      ]),
      // §4.1 スピーカーは開かなくても音だけ聞ける（音で思い出せるか試せる）。
      // したがって openedCount は増やさない。
      speakButton(l.en, speakerGender(l.speakerId), l.id)
    ]);
  }

  // 使えない環境ではボタン自体を出さない（CLAUDE.md: 機能を隠すか静かにフォールバック）
  function speakButton(text, gender, key) {
    if (!EST.speech.isAvailable() || !String(text || '').trim()) return null;
    return h('button', {
      class: 'speak-btn', title: '英文を聞く', 'aria-label': '英文を聞く',
      onClick: function (e) {
        e.stopPropagation();
        EST.speech.speak(text, { gender: gender, topicId: view.topic.id, lineId: key });
      }
    }, '🔊');
  }

  function speakerGender(speakerId) {
    var g = '';
    (view.topic.speakers || []).forEach(function (s) { if (s.id === speakerId) g = s.gender || ''; });
    return g;
  }

  function wordRow(w) {
    var open = !!view.openWords[w.id];
    var primaryIsEn = view.direction === 'en';
    var primary = primaryIsEn ? w.en : w.ja;
    var secondary = primaryIsEn ? w.ja : w.en;

    return h('div', { class: 'list-row' }, [
      h('button', {
        class: 'list-row__main',
        onClick: function () {
          view.openWords[w.id] = !view.openWords[w.id];   // 語彙は記録対象外（F6で扱う）
          drawControls(); drawLines();
        }
      }, [
        h('div', { class: 'row row--tight' }, [
          h('span', { class: primaryIsEn ? 'en' : '', text: primary || '（空）' }),
          h('span', { class: 'chip', text: w.type === 'phrase' ? '句' : '語' })
        ]),
        open ? h('div', { class: 'tiny muted', style: { marginTop: '.15rem', paddingLeft: '1.2rem' } }, [
          '→ ', h('span', { class: primaryIsEn ? '' : 'en', text: secondary || '（空）' })
        ]) : null
      ]),
      // 語彙は特定の話者の台詞ではないので、性別指定なしの既定ボイスで読む
      speakButton(w.en, '', null)
    ]);
  }

  // 1行ずつ開いたときだけ §5.5 の openedCount を増やす。閉じる操作や
  // 「全部開く」由来のものはここを通らない。
  function toggleLine(l) {
    var willOpen = !view.openLines[l.id];
    view.openLines[l.id] = willOpen;
    drawControls();
    drawLines();
    if (willOpen && view.settings && view.settings.recordOpens !== false) {
      EST.store.markLineOpened(view.topic.id, l.id).catch(function (e) {
        console.warn('[list] 開いた記録に失敗しました', e);
      });
    }
  }

  /* ---- 書き出し（§4.3。テキスト／Markdownのみ。Anki TSVはF6） ------------- */
  function exportAs(kind) {
    var U = ui();
    var t = view.topic;
    var lines = visibleLines();
    var name = (t.title || 'topic').replace(/[\\/:*?"<>|]/g, '_');

    var text;
    if (kind === 'md') {
      var mdParts = ['# ' + (t.title || '(無題)')];
      if (t.titleEn) mdParts.push('*' + t.titleEn + '*');
      lines.forEach(function (l) {
        mdParts.push('- ' + (l.ja || '(和訳なし)') + '\n  → **' + (l.en || '') + '**');
      });
      text = mdParts.join('\n\n');
      U.download(name + '.md', text, 'text/markdown');
    } else {
      var txtParts = [t.title || '(無題)'];
      if (t.titleEn) txtParts.push(t.titleEn);
      txtParts.push('');
      lines.forEach(function (l) {
        txtParts.push('・' + (l.ja || '(和訳なし)'));
        txtParts.push('    → ' + (l.en || ''));
      });
      text = txtParts.join('\n');
      U.download(name + '.txt', text, 'text/plain');
    }
    U.toast('書き出しました');
  }

  EST.uiList = { renderList: renderList };
})(window.EST = window.EST || {});
