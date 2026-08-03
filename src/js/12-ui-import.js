/* =====================================================================
   12-ui-import.js — 台本の取り込み3経路と編集プレビュー
   SPEC §6.1（経路1 貼り付け / 経路2 JSON / 経路3 空から作る）
        §6.2（全経路の合流点である編集プレビュー）
        §6.3（取り込み処理）
   ===================================================================== */
;(function (EST) {
  'use strict';

  var h = null;
  function ui() { h = EST.ui.h; return EST.ui; }

  // 編集中の下書き。画面を離れても保持し、#/edit/new で戻ってこられるようにする。
  var state = null;

  // 再描画で作り直す要素の参照
  var elStats = null, elLines = null, elWords = null, elSpeakers = null;
  var rowEls = [];

  var PASTE_SAMPLE =
    'Staff: How long are you staying?\n' +
    'ご滞在はどのくらいですか？\n' +
    'You: About ten days.\n' +
    '10日ほどです。';

  /* =====================================================================
     取り込み画面
     ===================================================================== */
  function renderImport(view) {
    var U = ui();
    EST.app.setBar('新規トピック', [
      h('button', { class: 'btn btn--sm', text: 'ホーム', onClick: function () { location.hash = '#/'; } })
    ]);

    var ta = h('textarea', {
      class: 'paste-area',
      placeholder: '台本をそのまま貼り付けてください。JSONを貼っても構いません。'
    });

    var card = h('div', { class: 'card' }, [
      h('h2', { class: 'card__title', text: '台本を貼り付ける' }),
      ta,
      h('div', { class: 'row', style: { marginTop: '.5rem' } }, [
        h('button', { class: 'btn btn--primary', text: '解析する', onClick: function () { onAnalyze(ta.value); } }),
        h('button', { class: 'btn', text: 'JSONファイルを選ぶ', onClick: onPickFile }),
        h('button', { class: 'btn', text: '空から作る', onClick: onBlank })
      ])
    ]);

    var hint = h('div', { class: 'card card--flat' }, [
      h('h2', { class: 'card__title', text: '読み取れる形式' }),
      h('div', { class: 'small muted' }, [
        '話者ラベルあり／なし、英日交互、タブや「|」での列分け、',
        '英文をまとめて書いたあとに和文をまとめて書く形（間に空行2つか --- を入れる）、英文だけ。',
        'どの形でも解析後に編集画面で直せます。'
      ]),
      h('div', { class: 'sample-hint en', style: { marginTop: '.5rem' }, text: PASTE_SAMPLE })
    ]);

    U.mount(view, [card, hint]);
    try { ta.focus(); } catch (e) {}
  }

  function onAnalyze(text) {
    var U = ui();
    var trimmed = String(text || '').trim();
    if (!trimmed) { U.toast('台本を貼り付けてください'); return; }

    // JSONらしければ経路2、そうでなければ経路1に自動で振り分ける（§6.1）
    if (/^[\[{]/.test(trimmed)) {
      var r = EST.schema.parseJsonWithPosition(trimmed);
      if (r.ok) { fromJson(r.value); return; }
      U.alert('JSONとして読めませんでした', [
        r.error, r.where ? ('位置: ' + r.where) : '（位置を特定できませんでした）'
      ]);
      return;
    }
    fromText(trimmed);
  }

  function onPickFile() {
    var U = ui();
    U.pickFile('.json,application/json').then(function (f) {
      if (!f) return;
      var r = EST.schema.parseJsonWithPosition(f.text);
      if (!r.ok) {
        U.alert('JSONとして読めませんでした', [r.error, r.where ? ('位置: ' + r.where) : '']);
        return;
      }
      fromJson(r.value);
    });
  }

  function onBlank() {
    var t = EST.schema.normalizeTopic({
      title: '',
      speakers: [{ id: 'S1', label: 'A' }, { id: 'S2', label: 'B' }],
      lines: [
        { speakerId: 'S1', en: '', ja: '' },
        { speakerId: 'S2', en: '', ja: '' }
      ]
    });
    openEditor(t, true, ['空のトピックです。英文と和訳を入れてください。']);
  }

  function fromText(text) {
    var U = ui();
    var parsed = EST.schema.parseScript(text);
    if (!parsed.lines.length) {
      U.alert('解析できませんでした', ['英文として読める行が見つかりませんでした。']);
      return;
    }
    var t = EST.schema.normalizeTopic({
      title: '',
      speakers: parsed.speakers,
      lines: parsed.lines
    });
    openEditor(t, true, parsed.warnings);
  }

  function fromJson(value) {
    var U = ui();
    if (value && value.kind === EST.backup.BACKUP_KIND) {
      U.alert('これはバックアップです', ['全体バックアップのJSONは「設定 → バックアップ」から復元してください。']);
      return;
    }
    var warnings = [];
    if (Array.isArray(value)) {
      if (!value.length) { U.alert('取り込めません', ['配列が空です。']); return; }
      warnings.push('配列が渡されたので先頭の1件だけを取り込みました');
      value = value[0];
    }
    var check = EST.schema.validateTopic(value, { requireMyRole: false });
    var t = EST.schema.normalizeTopic(value);
    if (check.errors.length) {
      // エラーがあっても編集画面までは通す。直す場所が見えないと直せないため。
      warnings = warnings.concat(check.errors);
    }
    if (!t.myRole) warnings.push('自分の役が指定されていません。保存前に選んでください');
    openEditor(t, true, warnings);
  }

  /* =====================================================================
     編集プレビュー（§6.2）
     ===================================================================== */
  function openEditor(topic, isNew, warnings) {
    state = makeState(topic, isNew, warnings);
    location.hash = '#/edit/new';
  }

  function makeState(topic, isNew, warnings) {
    var t = EST.schema.normalizeTopic(topic);
    var starts = EST.schema.blocksToStarts(t.blocks, t.lines);
    return {
      topic: t,
      starts: starts,
      blockLabels: (t.blocks || []).map(function (b) { return b.label; }),
      isNew: !!isNew,
      warnings: warnings || [],
      open: {}     // 行ID -> 詳細（メモ・チャンク）を開いているか
    };
  }

  function renderEditor(view, id) {
    var U = ui();
    if (id === 'new') {
      if (!state) { location.hash = '#/import'; return; }
      build(view);
      return;
    }
    if (state && !state.isNew && state.topic.id === id) { build(view); return; }
    EST.store.get('topics', id).then(function (t) {
      if (!t) {
        EST.app.setBar('編集', []);
        U.mount(view, h('div', { class: 'empty', text: 'このトピックは見つかりませんでした。' }));
        return;
      }
      state = makeState(t, false, []);
      build(view);
    });
  }

  function build(view) {
    var U = ui();
    EST.app.setBar(state.isNew ? '編集プレビュー' : '編集', [
      h('button', { class: 'btn btn--sm', text: '破棄', onClick: discard }),
      h('button', { class: 'btn btn--sm btn--primary', text: '保存', onClick: save })
    ]);

    elStats = h('div', { class: 'stat-bar' });
    elSpeakers = h('div', {});
    elLines = h('div', {});
    elWords = h('div', {});

    var warnBox = state.warnings && state.warnings.length
      ? h('div', { class: 'note-box note-box--warn', style: { marginBottom: '.7rem' } }, [
          h('div', { text: '解析結果の確認' }),
          h('ul', {}, state.warnings.map(function (w) { return h('li', { text: w }); }))
        ])
      : null;

    U.mount(view, [
      elStats,
      warnBox,
      metaCard(),
      h('div', { class: 'card' }, [
        h('div', { class: 'card__head' }, [
          h('h2', { class: 'card__title', text: '話者' }),
          h('button', { class: 'btn btn--sm', text: '＋ 話者', onClick: addSpeaker })
        ]),
        h('div', { class: 'tiny muted', style: { marginBottom: '.4rem' },
          text: 'ここで名前を変えると、全部の行の話者名がまとめて変わります。' }),
        elSpeakers
      ]),
      h('div', { class: 'card' }, [
        h('div', { class: 'card__head' }, [
          h('h2', { class: 'card__title', text: '行' }),
          h('button', { class: 'btn btn--sm', text: '＋ ブロック境界', onClick: addBoundary })
        ]),
        elLines,
        h('button', {
          class: 'btn btn--block', text: '＋ 行を追加', style: { marginTop: '.4rem' },
          onClick: function () { addLine(state.topic.lines.length - 1); }
        })
      ]),
      h('div', { class: 'card' }, [
        h('div', { class: 'card__head' }, [
          h('h2', { class: 'card__title', text: '語彙' }),
          h('button', { class: 'btn btn--sm', text: '＋ 語彙', onClick: addWord })
        ]),
        h('div', { class: 'tiny muted', style: { marginBottom: '.4rem' },
          text: '語彙の自動抽出は F6 で入ります。ここでは手で足し引きできます。' }),
        elWords
      ]),
      h('div', { class: 'row', style: { marginTop: '.8rem' } }, [
        h('button', { class: 'btn btn--primary grow', text: '保存する', onClick: save }),
        h('button', { class: 'btn', text: '破棄', onClick: discard })
      ])
    ]);

    renderSpeakers();
    renderLines();
    renderWords();
    updateStats();
  }

  /* ---- 上部の見出し（タイトル・自分の役） ------------------------------ */
  function metaCard() {
    var t = state.topic;
    return h('div', { class: 'card' }, [
      h('label', { class: 'field' }, [
        h('span', { class: 'field__label', text: 'タイトル（日本語）' }),
        h('input', { type: 'text', value: t.title, placeholder: '例: 空港のチェックインカウンター',
          onInput: function (e) { t.title = e.target.value; } })
      ]),
      h('label', { class: 'field', style: { marginTop: '.4rem' } }, [
        h('span', { class: 'field__label', text: 'タイトル（英語・任意）' }),
        h('input', { type: 'text', class: 'en', value: t.titleEn,
          onInput: function (e) { t.titleEn = e.target.value; } })
      ]),
      h('div', { class: 'row', style: { marginTop: '.4rem' } }, [
        h('label', { class: 'field grow' }, [
          h('span', { class: 'field__label', text: 'レベル' }),
          h('input', { type: 'text', value: t.level, placeholder: 'B1',
            onInput: function (e) { t.level = e.target.value; } })
        ]),
        h('label', { class: 'field grow' }, [
          h('span', { class: 'field__label', text: 'タグ（カンマ区切り）' }),
          h('input', { type: 'text', value: (t.tags || []).join(', '),
            onInput: function (e) {
              t.tags = e.target.value.split(/[,、]/).map(function (s) { return s.trim(); }).filter(Boolean);
            } })
        ])
      ]),
      h('div', { style: { marginTop: '.5rem' } }, [
        h('span', { class: 'field__label', text: '自分の役（S5・S6で使うので必須）' }),
        h('div', { class: 'row row--tight', id: 'myrole-box' }, myRoleButtons())
      ])
    ]);
  }

  function myRoleButtons() {
    var t = state.topic;
    return t.speakers.map(function (s) {
      return h('button', {
        class: 'btn btn--sm' + (t.myRole === s.id ? ' btn--primary' : ''),
        text: s.label || s.id,
        onClick: function () {
          t.myRole = s.id;
          var box = document.getElementById('myrole-box');
          if (box) ui().mount(box, myRoleButtons());
        }
      });
    });
  }

  function refreshMyRole() {
    var box = document.getElementById('myrole-box');
    if (box) ui().mount(box, myRoleButtons());
  }

  /* ---- 話者（ラベルの一括リネーム） ------------------------------------ */
  function renderSpeakers() {
    var U = ui();
    var t = state.topic;
    var used = {};
    t.lines.forEach(function (l) { used[l.speakerId] = (used[l.speakerId] || 0) + 1; });

    U.mount(elSpeakers, t.speakers.map(function (s, i) {
      return h('div', { class: 'row row--tight', style: { marginBottom: '.3rem' } }, [
        h('input', {
          type: 'text', value: s.label, class: 'grow', style: { maxWidth: '10rem' },
          onInput: function (e) {
            s.label = e.target.value;          // 参照は id なので、ここを変えれば全行に効く
            refreshSpeakerOptions();
            refreshMyRole();
          }
        }),
        h('select', {
          style: { width: 'auto' },
          onChange: function (e) { s.gender = e.target.value; }
        }, [
          h('option', { value: '', selected: !s.gender }, '性別なし'),
          h('option', { value: 'female', selected: s.gender === 'female' }, '女性'),
          h('option', { value: 'male', selected: s.gender === 'male' }, '男性')
        ]),
        h('span', { class: 'chip', text: (used[s.id] || 0) + '行' }),
        h('button', {
          class: 'btn btn--sm btn--danger', text: '削除',
          disabled: (used[s.id] || 0) > 0 || t.speakers.length <= 1,
          onClick: function () {
            t.speakers.splice(i, 1);
            if (t.myRole === s.id) t.myRole = '';
            renderSpeakers(); refreshMyRole(); renderLines();
          }
        })
      ]);
    }));
  }

  function addSpeaker() {
    var t = state.topic;
    var n = 1;
    var ids = {};
    t.speakers.forEach(function (s) { ids[s.id] = true; });
    while (ids['S' + n]) n++;
    t.speakers.push({ id: 'S' + n, label: 'S' + n, gender: '' });
    renderSpeakers(); refreshMyRole(); renderLines();
  }

  function refreshSpeakerOptions() {
    var t = state.topic;
    rowEls.forEach(function (row) {
      if (!row || !row.__spSel) return;
      Array.prototype.forEach.call(row.__spSel.options, function (op) {
        t.speakers.forEach(function (s) { if (s.id === op.value) op.textContent = s.label || s.id; });
      });
    });
  }

  /* ---- 行 -------------------------------------------------------------- */
  function renderLines() {
    var U = ui();
    var t = state.topic;
    var y = window.scrollY;
    rowEls = [];

    var startIndexOf = {};
    state.starts.forEach(function (x, i) { startIndexOf[x] = i; });

    var frag = [];
    t.lines.forEach(function (l, i) {
      var bi = startIndexOf[i];
      if (bi !== undefined) frag.push(bi === 0 ? blockHead(0) : blockDivider(bi));
      var row = lineRow(l, i);
      rowEls[i] = row;
      frag.push(row);
    });

    U.mount(elLines, frag);
    window.scrollTo(0, y);
  }

  function blockLabelInput(bi) {
    return h('input', {
      type: 'text', class: 'blk-div__label',
      value: state.blockLabels[bi] || '',
      placeholder: 'パート' + (bi + 1),
      onInput: function (e) { state.blockLabels[bi] = e.target.value; }
    });
  }

  function blockHead(bi) {
    return h('div', { class: 'blk-div', style: { borderStyle: 'solid' } }, [
      h('span', { class: 'blk-div__no', text: 'ブロック1' }),
      blockLabelInput(bi),
      h('span', { class: 'tiny muted right', text: '先頭の境界は動かせません' })
    ]);
  }

  function blockDivider(bi) {
    var el = h('div', { class: 'blk-div' }, [
      h('span', {
        class: 'blk-div__grip', text: '⣿ ドラッグ',
        onPointerdown: function (e) { startDrag(bi, e, el); }
      }),
      h('span', { class: 'blk-div__no', text: 'ブロック' + (bi + 1) }),
      blockLabelInput(bi),
      h('div', { class: 'row row--tight right' }, [
        h('button', { class: 'btn btn--icon', text: '▲', onClick: function () { moveBoundary(bi, state.starts[bi] - 1); } }),
        h('button', { class: 'btn btn--icon', text: '▼', onClick: function () { moveBoundary(bi, state.starts[bi] + 1); } }),
        h('button', {
          class: 'btn btn--icon btn--danger', text: '×',
          disabled: state.starts.length <= 2 && state.topic.lines.length >= EST.schema.BLOCK_AUTO_MIN,
          onClick: function () { removeBoundary(bi); }
        })
      ])
    ]);
    return el;
  }

  function lineRow(l, i) {
    var t = state.topic;
    var spSel = h('select', {
      class: 'ed-line__sp',
      onChange: function (e) { l.speakerId = e.target.value; }
    }, t.speakers.map(function (s) {
      return h('option', { value: s.id, selected: s.id === l.speakerId }, s.label || s.id);
    }));

    var enTa = h('textarea', {
      class: 'en', rows: 2, value: l.en, placeholder: '英文',
      onInput: function (e) {
        l.en = e.target.value;
        l.chunks = EST.schema.splitChunks(l.en);   // 英文が変わればチャンクは作り直す
        updateStats();
      }
    });
    var jaTa = h('textarea', {
      class: 'ja-in', rows: 1, value: l.ja, placeholder: '和訳',
      onInput: function (e) { l.ja = e.target.value; }
    });

    var extra = h('div', { class: 'ed-line__extra' + (state.open[l.id] ? '' : ' hidden') });
    buildExtra(extra, l);

    var row = h('div', { class: 'ed-line' }, [
      h('div', { class: 'ed-line__top' }, [
        h('span', { class: 'ed-line__no', text: String(i + 1) }),
        spSel,
        h('div', { class: 'ed-line__tools' }, [
          h('button', { class: 'btn btn--icon', text: '↑', disabled: i === 0, onClick: function () { moveLine(i, -1); } }),
          h('button', { class: 'btn btn--icon', text: '↓', disabled: i === t.lines.length - 1, onClick: function () { moveLine(i, 1); } }),
          h('button', { class: 'btn btn--sm', text: '分割', onClick: function () { splitLine(i); } }),
          h('button', { class: 'btn btn--sm', text: '結合', disabled: i === t.lines.length - 1, onClick: function () { mergeLine(i); } }),
          h('button', {
            class: 'btn btn--sm', text: '詳細',
            onClick: function () {
              state.open[l.id] = !state.open[l.id];
              extra.className = 'ed-line__extra' + (state.open[l.id] ? '' : ' hidden');
              if (state.open[l.id]) buildExtra(extra, l);
            }
          }),
          h('button', { class: 'btn btn--icon btn--danger', text: '✕', disabled: t.lines.length <= 1, onClick: function () { removeLine(i); } })
        ])
      ]),
      enTa, jaTa, extra
    ]);
    row.__enTa = enTa;
    row.__spSel = spSel;
    return row;
  }

  function buildExtra(box, l) {
    var U = ui();
    U.mount(box, [
      h('label', { class: 'field' }, [
        h('span', { class: 'field__label', text: 'メモ（任意）' }),
        h('input', { type: 'text', value: l.note, onInput: function (e) { l.note = e.target.value; } })
      ]),
      h('div', { style: { marginTop: '.4rem' } }, [
        h('span', { class: 'field__label', text: 'チャンク（区切りをタップで動かせます）' }),
        chunkEditor(l)
      ])
    ]);
  }

  /* チャンク境界エディタ（§1.8 自動分割は必ず外すのでタップで直せるようにする） */
  function chunkEditor(l) {
    var box = h('div', { class: 'chunks' });
    draw();
    return box;

    function draw() {
      var chunks = (l.chunks && l.chunks.length) ? l.chunks : EST.schema.splitChunks(l.en);
      var tokens = [], bounds = {};
      chunks.forEach(function (c) {
        var ws = String(c).trim().split(/\s+/).filter(Boolean);
        if (!ws.length) return;
        if (tokens.length) bounds[tokens.length] = true;
        ws.forEach(function (w) { tokens.push(w); });
      });

      var parts = [];
      tokens.forEach(function (w, i) {
        if (i > 0) {
          if (bounds[i]) {
            parts.push(h('span', {
              class: 'chunks__bar', text: '|', title: 'ここの区切りをやめる',
              onClick: function () { delete bounds[i]; commit(tokens, bounds); }
            }));
          } else {
            parts.push(h('span', {
              class: 'chunks__gap', text: '·', title: 'ここで区切る',
              onClick: function () { bounds[i] = true; commit(tokens, bounds); }
            }));
          }
        }
        parts.push(h('span', { class: 'chunks__w', text: w }));
      });
      if (!tokens.length) parts.push(h('span', { class: 'tiny muted', text: '（英文が空です）' }));
      ui().mount(box, parts);
    }

    function commit(tokens, bounds) {
      var out = [], cur = [];
      tokens.forEach(function (w, i) {
        if (i > 0 && bounds[i]) { out.push(cur.join(' ')); cur = []; }
        cur.push(w);
      });
      if (cur.length) out.push(cur.join(' '));
      l.chunks = out;
      draw();
    }
  }

  /* ---- 行の構造操作 ----------------------------------------------------- */
  function nextLineId() {
    var max = 0;
    state.topic.lines.forEach(function (l) {
      var m = /^ln_(\d+)$/.exec(l.id || '');
      if (m) max = Math.max(max, Number(m[1]));
    });
    return 'ln_' + EST.schema.pad3(max + 1);
  }

  function shiftStarts(fn) {
    state.starts = state.starts.map(fn);
    fixStarts();
  }

  function fixStarts() {
    var n = state.topic.lines.length;
    var s = state.starts.filter(function (x) { return x >= 0 && x < n; });
    s = s.filter(function (x, i, a) { return a.indexOf(x) === i; });
    s.sort(function (a, b) { return a - b; });
    if (s.length && s[0] !== 0) s.unshift(0);
    if (s.length === 1) s = [];        // 境界が先頭だけなら「ブロックなし」と同じ
    state.starts = s;
    state.blockLabels.length = s.length;
  }

  function addLine(afterIndex) {
    var t = state.topic;
    var at = Math.min(Math.max(afterIndex + 1, 0), t.lines.length);
    var prev = t.lines[afterIndex];
    var nextSp = t.speakers.length > 1 && prev
      ? (t.speakers[(indexOfSpeaker(prev.speakerId) + 1) % t.speakers.length].id)
      : (t.speakers[0] && t.speakers[0].id);
    t.lines.splice(at, 0, {
      id: nextLineId(), speakerId: nextSp, en: '', ja: '', note: '', alt: [], chunks: [], skip: false
    });
    shiftStarts(function (x) { return x >= at ? x + 1 : x; });
    renderLines(); renderWords(); renderSpeakers(); updateStats();
  }

  function indexOfSpeaker(id) {
    var idx = 0;
    state.topic.speakers.forEach(function (s, i) { if (s.id === id) idx = i; });
    return idx;
  }

  function removeLine(i) {
    var t = state.topic;
    if (t.lines.length <= 1) return;
    t.lines.splice(i, 1);
    shiftStarts(function (x) { return x > i ? x - 1 : x; });
    renderLines(); renderWords(); renderSpeakers(); updateStats();
  }

  function moveLine(i, dir) {
    var t = state.topic;
    var j = i + dir;
    if (j < 0 || j >= t.lines.length) return;
    var tmp = t.lines[i]; t.lines[i] = t.lines[j]; t.lines[j] = tmp;
    renderLines(); updateStats();
  }

  // カーソル位置で割る。カーソルが無ければ文の切れ目、それも無ければ中央。
  function splitPoint(en, pos) {
    if (pos > 0 && pos < en.length) {
      var p = pos;
      while (p > 0 && !/\s/.test(en.charAt(p - 1))) p--;
      if (p > 0 && p < en.length) return p;
    }
    var m = /[.!?]["')\]]?\s+/.exec(en);
    if (m) {
      var at = m.index + m[0].length;
      if (at > 0 && at < en.length) return at;
    }
    var words = en.split(/\s+/);
    if (words.length < 2) return -1;
    return words.slice(0, Math.ceil(words.length / 2)).join(' ').length + 1;
  }

  function splitLine(i) {
    var U = ui();
    var t = state.topic;
    var l = t.lines[i];
    var ta = rowEls[i] && rowEls[i].__enTa;
    var pos = ta ? ta.selectionStart : 0;
    var p = splitPoint(l.en, pos);
    if (p < 0) { U.toast('この行は分割できません'); return; }

    var a = l.en.slice(0, p).trim();
    var b = l.en.slice(p).trim();
    if (!a || !b) { U.toast('この行は分割できません'); return; }

    l.en = a;
    l.chunks = EST.schema.splitChunks(a);
    t.lines.splice(i + 1, 0, {
      id: nextLineId(), speakerId: l.speakerId, en: b, ja: '', note: '',
      alt: [], chunks: EST.schema.splitChunks(b), skip: false
    });
    shiftStarts(function (x) { return x > i ? x + 1 : x; });
    renderLines(); renderWords(); updateStats();
    U.toast('和訳は前の行に残しました');
  }

  function mergeLine(i) {
    var t = state.topic;
    if (i >= t.lines.length - 1) return;
    var a = t.lines[i], b = t.lines[i + 1];
    a.en = (a.en + ' ' + b.en).trim();
    a.ja = [a.ja, b.ja].filter(Boolean).join('');
    a.note = [a.note, b.note].filter(Boolean).join(' / ');
    a.chunks = EST.schema.splitChunks(a.en);
    t.lines.splice(i + 1, 1);
    shiftStarts(function (x) { return x > i + 1 ? x - 1 : x; });
    renderLines(); renderWords(); updateStats();
  }

  /* ---- ブロック境界 ------------------------------------------------------ */
  function addBoundary() {
    var U = ui();
    var t = state.topic;
    if (t.lines.length < 2) { U.toast('行が足りません'); return; }
    var s = state.starts.slice();
    if (!s.length) s = [0];
    // いちばん長いブロックの真ん中に足す
    var bestAt = -1, bestLen = 1;
    s.forEach(function (start, i) {
      var end = (i + 1 < s.length ? s[i + 1] : t.lines.length);
      var len = end - start;
      if (len > bestLen) { bestLen = len; bestAt = start + Math.floor(len / 2); }
    });
    if (bestAt < 1) { U.toast('これ以上分けられません'); return; }
    s.push(bestAt);
    state.starts = s;
    fixStarts();
    renderLines();
  }

  function removeBoundary(bi) {
    if (bi < 1) return;
    state.starts.splice(bi, 1);
    state.blockLabels.splice(bi, 1);
    fixStarts();
    renderLines();
  }

  function moveBoundary(bi, to) {
    var U = ui();
    var n = state.topic.lines.length;
    to = Math.min(Math.max(to, 1), n - 1);
    if (bi < 1 || bi >= state.starts.length) return;
    if (state.starts[bi] === to) return;
    if (state.starts.indexOf(to) >= 0) { U.toast('そこには既に境界があります'); return; }
    var label = state.blockLabels[bi];
    state.starts[bi] = to;
    // 並べ替えたあともラベルが同じブロックに付いてくるように入れ直す
    var pairs = state.starts.map(function (x, i) { return { s: x, l: i === bi ? label : state.blockLabels[i] }; });
    pairs.sort(function (a, b) { return a.s - b.s; });
    state.starts = pairs.map(function (p) { return p.s; });
    state.blockLabels = pairs.map(function (p) { return p.l; });
    fixStarts();
    renderLines();
  }

  function startDrag(bi, ev, divEl) {
    ev.preventDefault();
    var target = state.starts[bi];
    divEl.classList.add('is-dragging');

    function onMove(e) {
      var g = gapFromY(e.clientY);
      if (g === null) return;
      target = g;
      highlight(g);
    }
    function onUp() {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
      divEl.classList.remove('is-dragging');
      clearHighlight();
      moveBoundary(bi, target);
    }
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
  }

  // 指の位置にいちばん近い「行の上端」を境界候補にする
  function gapFromY(y) {
    var best = null, bestD = Infinity;
    for (var i = 1; i < rowEls.length; i++) {
      if (!rowEls[i]) continue;
      var d = Math.abs(rowEls[i].getBoundingClientRect().top - y);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  function highlight(i) {
    clearHighlight();
    if (rowEls[i]) rowEls[i].classList.add('is-drop');
  }
  function clearHighlight() {
    rowEls.forEach(function (r) { if (r) r.classList.remove('is-drop'); });
  }

  /* ---- 語彙 -------------------------------------------------------------- */
  function renderWords() {
    var U = ui();
    var t = state.topic;
    if (!t.words.length) {
      U.mount(elWords, h('div', { class: 'tiny muted', text: 'まだ語彙がありません。' }));
      return;
    }
    U.mount(elWords, t.words.map(function (w, i) { return wordRow(w, i); }));
  }

  function wordRow(w, i) {
    var t = state.topic;

    var idsBox = h('div', { class: 'word-row__ids' });
    drawIds();

    var lineSel = h('select', { style: { maxWidth: '11rem' } },
      t.lines.map(function (l, li) {
        var label = (li + 1) + ': ' + (l.en || '(空)').slice(0, 24);
        return h('option', { value: l.id }, label);
      })
    );

    return h('div', { class: 'word-row' }, [
      h('div', { class: 'word-row__grid' }, [
        h('input', { type: 'text', class: 'en', value: w.en, placeholder: '英語',
          onInput: function (e) { w.en = e.target.value; } }),
        h('input', { type: 'text', value: w.ja, placeholder: '意味',
          onInput: function (e) { w.ja = e.target.value; } }),
        h('div', { class: 'row row--tight' }, [
          h('select', { style: { width: 'auto' }, onChange: function (e) { w.type = e.target.value; } }, [
            h('option', { value: 'word', selected: w.type === 'word' }, '語'),
            h('option', { value: 'phrase', selected: w.type === 'phrase' }, '句')
          ]),
          h('button', {
            class: 'btn btn--icon btn--danger', text: '✕',
            onClick: function () { t.words.splice(i, 1); renderWords(); updateStats(); }
          })
        ])
      ]),
      h('div', { class: 'row row--tight', style: { marginTop: '.3rem' } }, [
        h('span', { class: 'tiny muted', text: '出てくる行' }),
        lineSel,
        h('button', {
          class: 'btn btn--sm', text: '＋',
          onClick: function () {
            var id = lineSel.value;
            if (id && w.lineIds.indexOf(id) < 0) { w.lineIds.push(id); drawIds(); }
          }
        })
      ]),
      idsBox
    ]);

    function drawIds() {
      var chips = w.lineIds.map(function (id) {
        var no = 0;
        t.lines.forEach(function (l, li) { if (l.id === id) no = li + 1; });
        return h('button', {
          class: 'chip chip--btn', title: 'この行との紐づけを外す',
          onClick: function () {
            w.lineIds = w.lineIds.filter(function (x) { return x !== id; });
            drawIds();
          }
        }, [no ? (no + '行目') : id, ' ×']);
      });
      if (!chips.length) chips = [h('span', { class: 'tiny muted', text: '（紐づけなし）' })];
      ui().mount(idsBox, chips);
    }
  }

  function addWord() {
    state.topic.words.push({ id: nextWordId(), en: '', ja: '', type: 'word', lineIds: [], note: '' });
    renderWords();
    updateStats();
  }

  function nextWordId() {
    var max = 0;
    state.topic.words.forEach(function (w) {
      var m = /^w_(\d+)$/.exec(w.id || '');
      if (m) max = Math.max(max, Number(m[1]));
    });
    return 'w_' + EST.schema.pad3(max + 1);
  }

  /* ---- 統計行（§6.2 上部に常時表示） ------------------------------------ */
  function updateStats() {
    var U = ui();
    var t = state.topic;
    var sec = EST.schema.lapSeconds(t.lines);
    var blocks = state.starts.length || 1;
    U.mount(elStats, [
      h('span', {}, ['1周 約', h('b', { text: U.fmtSeconds(sec) })]),
      h('span', {}, [h('b', { text: String(t.lines.length) }), '行']),
      h('span', {}, [h('b', { text: String(blocks) }), 'ブロック']),
      h('span', {}, ['語彙 ', h('b', { text: String(t.words.length) }), '個'])
    ]);
  }

  /* ---- 保存・破棄 -------------------------------------------------------- */
  function save() {
    var U = ui();
    var t = state.topic;
    t.blocks = EST.schema.startsToBlocks(state.starts, t.lines, state.blockLabels);

    var v = EST.schema.validateTopic(t, { requireMyRole: true });
    if (v.errors.length) { U.alert('保存できません', v.errors); return; }

    var ask = Promise.resolve('save');
    if (state.isNew) {
      ask = EST.store.get('topics', t.id).then(function (exist) {
        if (!exist) return 'save';
        // §6.3 手順3: id重複は「上書き / 別トピックとして追加 / 中止」を選ばせる
        return U.choose('同じIDのトピックがあります',
          '既に「' + (exist.title || '無題') + '」が同じIDで保存されています。',
          [
            { label: '中止', value: 'cancel' },
            { label: '別トピックとして追加', value: 'dup' },
            { label: '上書き', value: 'save', kind: 'danger' }
          ]);
      });
    }

    ask.then(function (mode) {
      if (!mode || mode === 'cancel') return;
      if (mode === 'dup') t.id = EST.schema.newTopicId();
      var norm = EST.schema.normalizeTopic(t);
      return EST.store.put('topics', norm)
        .then(function () { return EST.backup.snapshot('保存: ' + norm.title); })
        .then(function () {
          state = null;
          U.toast(v.warnings.length ? '保存しました（注意 ' + v.warnings.length + '件）' : '保存しました');
          location.hash = '#/topic/' + encodeURIComponent(norm.id);
        });
    }).catch(function (e) {
      U.alert('保存に失敗しました', [String(e && e.message || e)]);
    });
  }

  function discard() {
    ui().confirm('編集を破棄', '編集中の内容は保存されません。', '破棄する', 'danger').then(function (ok) {
      if (!ok) return;
      var wasNew = state.isNew, id = state.topic.id;
      state = null;
      location.hash = wasNew ? '#/' : ('#/topic/' + encodeURIComponent(id));
    });
  }

  EST.uiImport = {
    renderImport: renderImport,
    renderEditor: renderEditor,
    openEditor: openEditor,
    hasDraft: function () { return !!state; }
  };
})(window.EST = window.EST || {});
