/* =====================================================================
   10-ui-home.js — ホームとトピック一覧・トピック詳細（SPEC §8）
   F1 の時点では練習・検索・語彙の中身がまだ無いので、
   該当する導線は枠だけ置いて押せない状態にしてある。
   ===================================================================== */
;(function (EST) {
  'use strict';

  var h = null;   // 起動時に EST.ui.h を受け取る（読み込み順に依存しないため）

  function ui() { h = EST.ui.h; return EST.ui; }

  /* ---- ホーム ---------------------------------------------------------- */
  function renderHome(view) {
    var U = ui();
    EST.app.setBar('英会話台本トレーナー', [
      h('span', { class: 'chip', text: EST.profile.label() }),
      h('button', { class: 'btn btn--sm', text: '設定', onClick: function () { location.hash = '#/settings'; } })
    ]);

    var wrap = h('div', {});

    // §6.5 台本が更新されたことを一度だけ知らせる
    var fed = EST.publish.takeResult();
    if (fed && (fed.added || fed.updated || fed.removed)) {
      var parts = [];
      if (fed.added) parts.push('追加' + fed.added + '件');
      if (fed.updated) parts.push('更新' + fed.updated + '件');
      if (fed.removed) parts.push('削除' + fed.removed + '件');
      U.append(wrap, h('div', { class: 'note-box note-box--warn', style: { marginBottom: '.7rem' },
        text: '台本を更新しました（' + parts.join(' / ') + '）' }));
    }

    // まだ使えない導線。押せてしまうと壊れているように見えるので disabled にする。
    function pending(icon, label, phase) {
      return h('button', { class: 'home-item', disabled: true }, [
        h('span', { class: 'home-item__icon', text: icon }),
        h('span', { class: 'home-item__body' }, [
          h('div', { text: label }),
          h('div', { class: 'home-item__sub', text: 'まだ使えません（' + phase + 'で追加）' })
        ])
      ]);
    }

    U.append(wrap, [
      pending('🔍', '検索（全トピック横断）', 'F2'),
      pending('📅', '今日の練習', 'F5'),
      pending('🔁', '再確認', 'F7'),
      pending('📇', '語彙をまわす', 'F6')
    ]);

    U.append(wrap, h('div', { class: 'section-title', text: 'トピック' }));

    var listBox = h('div', {});
    U.append(wrap, listBox);

    // §5.9 まりの部屋では編集系の導線をグレーアウトではなく「出さない」
    if (EST.profile.canEdit()) {
      U.append(wrap, [
        h('button', {
          class: 'btn btn--primary btn--block', text: '＋ 新規トピック',
          onClick: function () { location.hash = '#/import'; }
        })
      ]);
    }

    U.mount(view, wrap);

    EST.store.getAll('topics').then(function (topics) {
      topics.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
      if (!topics.length) {
        U.mount(listBox, h('div', { class: 'empty', text: EST.profile.canEdit()
          ? 'まだトピックがありません。「＋ 新規トピック」から台本を入れてください。'
          : 'まだ台本が届いていません。しばらくしてから開き直してください。' }));
        return;
      }
      U.mount(listBox, topics.map(topicCard));
    }).catch(function (e) {
      U.mount(listBox, h('div', { class: 'note-box note-box--err', text: '読み込みに失敗しました: ' + e.message }));
    });
  }

  function topicCard(t) {
    var U = ui();
    var sec = EST.schema.lapSeconds(t.lines);
    var meta = [
      t.lines.length + '行',
      (t.blocks && t.blocks.length ? t.blocks.length + 'ブロック' : 'ブロックなし'),
      '語彙' + (t.words ? t.words.length : 0) + '個',
      '1周 約' + U.fmtSeconds(sec)
    ].join(' ・ ');

    return h('button', {
      class: 'topic-card',
      onClick: function () { location.hash = '#/topic/' + encodeURIComponent(t.id); }
    }, [
      h('div', { class: 'topic-card__title', text: t.title || '(無題)' }),
      t.titleEn ? h('div', { class: 'topic-card__meta en', text: t.titleEn }) : null,
      h('div', { class: 'topic-card__meta', text: meta }),
      h('div', { class: 'topic-card__meta', text: '更新 ' + U.fmtDate(t.updatedAt) })
    ]);
  }

  /* ---- トピック詳細 ----------------------------------------------------- */
  function renderTopic(view, id) {
    var U = ui();
    EST.store.get('topics', id).then(function (t) {
      if (!t) {
        EST.app.setBar('トピック', []);
        U.mount(view, h('div', { class: 'empty', text: 'このトピックは見つかりませんでした。' }));
        return;
      }
      EST.app.setBar(t.title || '(無題)', EST.profile.canEdit() ? [
        h('button', { class: 'btn btn--sm', text: '編集', onClick: function () { location.hash = '#/edit/' + encodeURIComponent(t.id); } })
      ] : []);
      U.mount(view, buildTopicDetail(t));
    });
  }

  function buildTopicDetail(t) {
    var U = ui();
    var sec = EST.schema.lapSeconds(t.lines);
    var myLabel = '';
    (t.speakers || []).forEach(function (s) { if (s.id === t.myRole) myLabel = s.label; });

    var head = h('div', { class: 'card' }, [
      t.titleEn ? h('div', { class: 'en', text: t.titleEn }) : null,
      h('div', { class: 'small muted' }, [
        [t.level, (t.tags || []).join(' / ')].filter(Boolean).join(' ・ ')
      ]),
      h('div', { class: 'stat-bar', style: { position: 'static', marginTop: '.5rem', marginBottom: '0' } }, [
        h('span', {}, ['1周 約', h('b', { text: U.fmtSeconds(sec) })]),
        h('span', {}, [h('b', { text: String(t.lines.length) }), '行']),
        h('span', {}, [h('b', { text: String((t.blocks || []).length || 1) }), 'ブロック']),
        h('span', {}, ['語彙 ', h('b', { text: String((t.words || []).length) }), '個']),
        h('span', {}, ['自分の役 ', h('b', { text: myLabel || '未設定' })])
      ])
    ]);

    // §5.9 まりの部屋には書き出し・削除を出さない
    var canEdit = EST.profile.canEdit();
    var actions = h('div', { class: 'card' }, [
      h('div', { class: 'row row--tight' }, [
        h('button', { class: 'btn btn--primary', text: '続きから', disabled: true }),
        h('button', { class: 'btn', text: '一覧を見る', disabled: true }),
        canEdit ? h('button', {
          class: 'btn', text: 'JSON書き出し',
          onClick: function () { exportTopic(t); }
        }) : null,
        canEdit ? h('button', {
          class: 'btn btn--danger', text: '削除',
          onClick: function () { removeTopic(t); }
        }) : null
      ]),
      h('div', { class: 'tiny muted', style: { marginTop: '.35rem' },
        text: '「続きから」は F5、「一覧を見る」は F2 で使えるようになります。' })
    ]);

    var body = h('div', { class: 'card' }, buildLineList(t));

    var words = null;
    if ((t.words || []).length) {
      words = h('div', { class: 'card' }, [
        h('h2', { class: 'card__title', text: '語彙 ' + t.words.length + '個' }),
        h('div', {}, t.words.map(function (w) {
          return h('div', { class: 'line-view' }, [
            h('div', { class: 'grow' }, [
              h('div', { class: 'en', text: w.en }),
              h('div', { class: 'line-view__ja', text: w.ja })
            ]),
            h('span', { class: 'chip', text: w.type === 'phrase' ? '句' : '語' })
          ]);
        }))
      ]);
    }

    return [head, actions, body, words];
  }

  function buildLineList(t) {
    var out = [];
    var startAt = {};
    (t.blocks || []).forEach(function (b, i) { startAt[b.from] = { no: i + 1, label: b.label }; });
    var spLabel = {};
    (t.speakers || []).forEach(function (s) { spLabel[s.id] = s.label; });

    t.lines.forEach(function (l, i) {
      var st = startAt[l.id];
      if (st) out.push(h('div', { class: 'block-head', text: 'ブロック' + st.no + '　' + (st.label || '') }));
      out.push(h('div', { class: 'line-view' }, [
        h('div', { class: 'line-view__no' }, [
          h('div', { text: String(i + 1) }),
          h('div', { class: t.myRole === l.speakerId ? 'line-view__mine' : '', text: spLabel[l.speakerId] || l.speakerId })
        ]),
        h('div', { class: 'grow' }, [
          h('div', { class: 'line-view__en en', text: l.en }),
          l.ja ? h('div', { class: 'line-view__ja', text: l.ja }) : null,
          l.note ? h('div', { class: 'tiny muted', text: l.note }) : null
        ])
      ]));
    });
    return out;
  }

  function exportTopic(t) {
    var copy = JSON.parse(JSON.stringify(t));
    var name = (t.title || 'topic').replace(/[\\/:*?"<>|]/g, '_');
    EST.ui.download(name + '.json', JSON.stringify(copy, null, 2));
    EST.ui.toast('JSONを書き出しました');
  }

  function removeTopic(t) {
    EST.ui.confirm('トピックを削除', '「' + (t.title || '無題') + '」を削除します。元に戻せません。', '削除する', 'danger')
      .then(function (ok) {
        if (!ok) return;
        return EST.store.del('topics', t.id)
          .then(function () { return EST.store.del('topicProgress', t.id); })
          .then(function () { return EST.backup.snapshot('削除: ' + (t.title || '')); })
          .then(function () {
            EST.ui.toast('削除しました');
            location.hash = '#/';
          });
      });
  }

  EST.uiHome = { renderHome: renderHome, renderTopic: renderTopic };
})(window.EST = window.EST || {});
