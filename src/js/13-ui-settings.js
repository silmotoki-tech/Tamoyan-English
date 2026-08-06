/* =====================================================================
   13-ui-settings.js — 設定とバックアップ（SPEC §5.7 / §6.4）
   F1 の時点で意味を持つ設定（テーマ・文字サイズ）と、
   データを守るためのバックアップ操作だけを出す。
   音声・マイクの設定は該当フェーズ（F3・F4）で足す。
   ===================================================================== */
;(function (EST) {
  'use strict';

  var h = null;
  function ui() { h = EST.ui.h; return EST.ui; }

  function render(view) {
    var U = ui();
    // 前回このカードでマイクのテストを起動したままだったら止める
    if (stopActiveMicTest) { stopActiveMicTest(); stopActiveMicTest = null; }
    EST.app.setBar('設定', []);

    var box = h('div', {});
    U.mount(view, box);

    EST.store.loadSettings().then(function (s) {
      U.mount(box, [
        profileCard(),
        displayCard(s),
        speechCard(s),
        micCard(s),
        listModeCard(s),
        EST.profile.canEdit() ? publishCard() : null,
        backupCard(),
        autoBackupCard(),
        EST.profile.canEdit() ? sampleCard() : null,
        infoCard(s),
        dangerCard()
      ]);
    });
  }

  /* ---- プロフィール（部屋）§5.9 ------------------------------------------ */
  function profileCard() {
    var U = ui();
    var cur = EST.profile.get();
    return h('div', { class: 'card' }, [
      h('h2', { class: 'card__title', text: '部屋' }),
      h('div', { class: 'small muted', text: '台本は「誰の台本か」で振り分けられ、練習の記録は部屋ごとに完全に分かれます。相手の記録は見えません。' }),
      h('div', { class: 'row', style: { marginTop: '.5rem' } }, EST.profile.all().map(function (p) {
        return h('button', {
          class: 'btn' + (p.id === cur ? ' btn--primary' : ''),
          text: p.label + '（' + p.sub + '）',
          onClick: function () {
            if (p.id === cur) return;
            U.confirm('部屋を切り替える', p.label + 'の部屋に切り替えます。練習の記録は部屋ごとに別々です。', '切り替える')
              .then(function (ok) {
                if (!ok) return;
                EST.profile.set(p.id);
                location.hash = '#/';
                location.reload();   // 設定も進捗も読み直しになるので、まるごと再起動する
              });
          }
        });
      }))
    ]);
  }

  /* ---- 配信（タモやんのみ）§6.5 ------------------------------------------ */
  function publishCard() {
    var U = ui();
    return h('div', { class: 'card' }, [
      h('h2', { class: 'card__title', text: '台本の配信' }),
      h('div', { class: 'small muted', text:
        'いまアプリに入っている台本を scripts.json として書き出します。これを data/scripts.json に置いて push すると、次にまりが開いたときに反映されます。' }),
      h('div', { class: 'row', style: { marginTop: '.5rem' } }, [
        h('button', {
          class: 'btn btn--primary', text: '配信用に書き出す',
          onClick: function () {
            EST.publish.exportFeedFile().then(function (feed) {
              U.toast(feed.topics.length + '本を書き出しました');
            });
          }
        }),
        h('button', {
          class: 'btn', text: 'いま配信を取りに行く',
          onClick: function () {
            EST.publish.sync().then(function (r) {
              if (!r) { U.toast('更新はありませんでした'); return; }
              U.toast('台本を更新しました');
              location.hash = '#/';
              EST.app.route();
            });
          }
        })
      ])
    ]);
  }

  /* ---- 表示 -------------------------------------------------------------- */
  function displayCard(s) {
    return h('div', { class: 'card' }, [
      h('h2', { class: 'card__title', text: '表示' }),
      h('div', { class: 'setting-row' }, [
        h('div', { class: 'setting-row__label' }, [
          'テーマ',
          h('div', { class: 'setting-row__sub', text: '「端末に合わせる」なら夜は自動で暗くなります' })
        ]),
        h('select', {
          onChange: function (e) {
            s.theme = e.target.value;
            EST.store.saveSettings(s).then(function () { EST.app.applyTheme(s); });
          }
        }, [
          h('option', { value: 'auto', selected: s.theme === 'auto' }, '端末に合わせる'),
          h('option', { value: 'light', selected: s.theme === 'light' }, '明るい'),
          h('option', { value: 'dark', selected: s.theme === 'dark' }, '暗い')
        ])
      ]),
      h('div', { class: 'setting-row' }, [
        h('div', { class: 'setting-row__label' }, [
          '文字サイズ',
          h('div', { class: 'setting-row__sub', text: '音読中に見やすい大きさに合わせてください' })
        ]),
        h('select', {
          onChange: function (e) {
            s.fontScale = Number(e.target.value);
            EST.store.saveSettings(s).then(function () { EST.app.applyTheme(s); });
          }
        }, [0.9, 1.0, 1.1, 1.25, 1.4].map(function (v) {
          return h('option', { value: String(v), selected: Number(s.fontScale) === v }, Math.round(v * 100) + '%');
        }))
      ])
    ]);
  }

  // §7.5 の5段に、いまの値が含まれないときだけそれを足す。
  // 既定は §5.7 で 0.85（5段に含まれる）に直ったが、それ以前の 0.95 のまま
  // 保存されている端末があるので、開いただけで速度が黙って変わらないよう残す。
  function rateOptions(cur) {
    var steps = EST.speech.RATE_STEPS.slice();
    if (steps.indexOf(cur) < 0 && isFinite(cur) && cur > 0) steps.push(cur);
    steps.sort(function (a, b) { return a - b; });
    return steps.map(function (v) {
      return h('option', { value: String(v), selected: cur === v }, v.toFixed(2) + '倍');
    });
  }

  /* ---- 音声 §7.2 / §7.5 --------------------------------------------------- */
  function speechCard(s) {
    var U = ui();
    // 使えない環境では設定ごと出さない（CLAUDE.md: ダイアログを出さず機能を隠す）
    if (!EST.speech.isAvailable()) {
      return h('div', { class: 'card' }, [
        h('h2', { class: 'card__title', text: '音声' }),
        h('div', { class: 'small muted', text: 'この端末では音声読み上げが使えません。' })
      ]);
    }

    var body = h('div', { class: 'small muted', text: 'ボイスを読み込み中…' });

    EST.speech.getVoices().then(function (voices) {
      if (!voices.length) {
        U.mount(body, h('div', { class: 'small muted', text: '英語のボイスが見つかりませんでした。端末に英語の音声を追加すると使えるようになります。' }));
        return;
      }
      s.localVoiceByGender = s.localVoiceByGender || { female: null, male: null };

      // §7.2 話者ごとに声を変える。自動割り当ての結果を見せたうえで、手で選び直せるようにする。
      function voiceRow(label, key, gender) {
        var auto = EST.speech.resolveVoiceFor(gender);
        var autoName = auto && auto.voice ? auto.voice.name : '（なし）';
        var cur = key === 'def' ? (s.localVoiceEn || '') : (s.localVoiceByGender[key] || '');
        var sel = h('select', {
          onChange: function (e) {
            var v = e.target.value || null;
            if (key === 'def') s.localVoiceEn = v;
            else s.localVoiceByGender[key] = v;
            EST.store.saveSettings(s).then(function () { EST.speech.applySettings(s); });
          }
        }, [h('option', { value: '', selected: !cur }, '自動（' + autoName + '）')].concat(
          voices.map(function (v) {
            var g = v.gender === 'female' ? '女性' : (v.gender === 'male' ? '男性' : '不明');
            return h('option', { value: v.id, selected: cur === v.id }, v.name + '（' + g + '）');
          })
        ));
        return h('div', { class: 'setting-row' }, [
          h('div', { class: 'setting-row__label' }, [
            label,
            auto && auto.degraded
              ? h('div', { class: 'setting-row__sub', text: '別々のボイスが取れないので、声の高さをずらして区別しています' })
              : null
          ]),
          h('div', { class: 'row row--tight' }, [
            sel,
            h('button', {
              class: 'btn btn--sm', text: '試聴',
              onClick: function () {
                EST.speech.speak('Good morning. May I see your passport, please?', { gender: gender });
              }
            })
          ])
        ]);
      }

      U.mount(body, [
        voiceRow('女性の話者', 'female', 'female'),
        voiceRow('男性の話者', 'male', 'male'),
        voiceRow('性別の指定がない話者', 'def', '')
      ]);
    });

    return h('div', { class: 'card' }, [
      h('h2', { class: 'card__title', text: '音声' }),
      h('div', { class: 'setting-row' }, [
        h('div', { class: 'setting-row__label' }, [
          '読み上げの速さ',
          h('div', { class: 'setting-row__sub', text: 'シャドーイングで速くしたいときに使います' })
        ]),
        h('select', {
          onChange: function (e) {
            s.ttsRate = Number(e.target.value);
            EST.store.saveSettings(s).then(function () { EST.speech.applySettings(s); });
          }
        }, rateOptions(Number(s.ttsRate)))
      ]),
      body
    ]);
  }

  /* ---- マイク §2.1〜§2.5 ---------------------------------------------------
     練習画面（F5）の「常時置く再較正ボタン」ではなく、実機で単体確認する
     ための診断パネル。較正・音量バー・onset/offsetのログを見られる。 */
  var stopActiveMicTest = null;   // 設定画面を離れるときに確実に止めるため

  function micCard(s) {
    var U = ui();
    if (!EST.mic.isSupported()) {
      return h('div', { class: 'card' }, [
        h('h2', { class: 'card__title', text: 'マイク' }),
        h('div', { class: 'small muted', text: 'この端末ではマイクが使えません。' })
      ]);
    }

    var statusBox = h('div', { class: 'small muted', text: '確認中…' });
    var meterFill = h('div', { class: 'mic-meter__fill' });
    var logBox = h('div', { class: 'mic-log' });
    var logLines = [];
    var testing = false;
    var testBtn;

    function refreshStatus() {
      EST.store.loadSettings().then(function (cur) {
        var m = cur.mic || {};
        U.mount(statusBox, m.calibratedAt
          ? h('span', { text: '最終較正: ' + U.fmtDate(m.calibratedAt) })
          : h('span', { text: '未較正（既定値で動作しています）' }));
      });
    }
    refreshStatus();

    function pushLog(line) {
      logLines.unshift(line);
      logLines = logLines.slice(0, 6);
      U.mount(logBox, logLines.map(function (l) { return h('div', { class: 'tiny muted', text: l }); }));
    }

    var onLevel, onOnset, onOffset;

    function stopTest() {
      if (!testing) return;
      EST.mic.off('level', onLevel);
      EST.mic.off('onset', onOnset);
      EST.mic.off('offset', onOffset);
      EST.mic.stop();
      testing = false;
      stopActiveMicTest = null;
      testBtn.textContent = '発話を試す';
      meterFill.style.width = '0%';
    }

    function startTest() {
      EST.mic.start().then(function () {
        testing = true;
        stopActiveMicTest = stopTest;
        testBtn.textContent = '停止';
        onLevel = EST.mic.on('level', function (e) {
          meterFill.style.width = Math.min(100, Math.round(e.rms * 300)) + '%';
        });
        onOnset = EST.mic.on('onset', function () { pushLog('onset'); });
        onOffset = EST.mic.on('offset', function (e) { pushLog('offset durationMs=' + e.durationMs); });
      }).catch(function (err) {
        var msg = err && err.reason === 'denied' ? 'マイクの許可が必要です'
          : err && err.reason === 'no-device' ? 'マイクが見つかりません'
          : 'マイクを使えませんでした';
        U.toast(msg);
      });
    }

    testBtn = h('button', {
      class: 'btn btn--sm', text: '発話を試す',
      onClick: function () { testing ? stopTest() : startTest(); }
    });

    var ratioInput = h('input', {
      type: 'number', step: '0.05', min: '0.1', max: '1',
      value: String(s.countRatio || EST.mic.COUNT_RATIO_DEFAULT), style: { width: '5rem' },
      onChange: function (e) {
        var v = Number(e.target.value);
        if (!isFinite(v) || v <= 0 || v > 1) { e.target.value = String(s.countRatio || EST.mic.COUNT_RATIO_DEFAULT); return; }
        s.countRatio = v;
        EST.store.saveSettings(s).then(function () { EST.mic.applySettings(s); });
      }
    });

    return h('div', { class: 'card' }, [
      h('h2', { class: 'card__title', text: 'マイク' }),
      statusBox,
      h('div', { class: 'row row--tight', style: { marginTop: '.5rem' } }, [
        h('button', {
          class: 'btn btn--sm', text: '較正する',
          onClick: function () {
            U.alert('較正', ['1.5秒間、静かにしてください。準備ができたら閉じてください。']).then(function () {
              return EST.mic.calibrate();
            }).then(function (r) {
              refreshStatus();
              U.toast('較正しました');
            }).catch(function (err) {
              var msg = err && err.reason === 'denied' ? 'マイクの許可が必要です' : 'マイクを使えませんでした';
              U.toast(msg);
            });
          }
        }),
        testBtn
      ]),
      h('div', { class: 'mic-meter', style: { marginTop: '.5rem' } }, [meterFill]),
      logBox,
      h('div', { class: 'setting-row' }, [
        h('div', { class: 'setting-row__label' }, [
          'カウント成立の比率',
          h('div', { class: 'setting-row__sub', text: '発話区間が想定の何割あれば1回とカウントするか（既定0.55）' })
        ]),
        ratioInput
      ])
    ]);
  }

  /* ---- 一覧モード §4.1 ---------------------------------------------------- */
  function listModeCard(s) {
    var U = ui();
    var row = h('div', { class: 'row row--tight' });
    function draw() {
      U.mount(row, [
        h('button', {
          class: 'btn btn--sm' + (s.recordOpens ? ' btn--primary' : ''),
          text: 'ON',
          onClick: function () { s.recordOpens = true; EST.store.saveSettings(s).then(draw); }
        }),
        h('button', {
          class: 'btn btn--sm' + (!s.recordOpens ? ' btn--primary' : ''),
          text: 'OFF',
          onClick: function () { s.recordOpens = false; EST.store.saveSettings(s).then(draw); }
        })
      ]);
    }
    draw();
    return h('div', { class: 'card' }, [
      h('h2', { class: 'card__title', text: '一覧モード' }),
      h('div', { class: 'setting-row' }, [
        h('div', { class: 'setting-row__label' }, [
          '開いた行を復習に回す',
          h('div', { class: 'setting-row__sub', text: '一覧モードでタップして開いた行を「思い出せなかった」として記録します' })
        ]),
        row
      ])
    ]);
  }

  /* ---- バックアップ ------------------------------------------------------- */
  function backupCard() {
    return h('div', { class: 'card' }, [
      h('h2', { class: 'card__title', text: 'バックアップ' }),
      // §5.9 まりは自分の進捗だけ。台本は配信で届くのでバックアップに含めない。
      h('div', { class: 'small muted', text: EST.profile.canEdit()
        ? '全トピックと進捗と設定を1つのJSONにまとめます。音声キャッシュは再生成できるので含めません。'
        : 'あなたの練習の記録と設定をJSONにまとめます。台本は配信で届くので含めません。' }),
      h('div', { class: 'row', style: { marginTop: '.5rem' } }, [
        h('button', { class: 'btn btn--primary', text: '書き出す', onClick: doExport }),
        h('button', { class: 'btn', text: 'ファイルから復元', onClick: doImport })
      ])
    ]);
  }

  function doExport() {
    var U = ui();
    EST.backup.exportAllText().then(function (text) {
      var d = new Date();
      var p = function (n) { return ('0' + n).slice(-2); };
      var name = 'est-backup-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + '.json';
      U.download(name, text);
      U.toast('書き出しました');
    });
  }

  function doImport() {
    var U = ui();
    U.pickFile('.json,application/json').then(function (f) {
      if (!f) return;
      var r = EST.schema.parseJsonWithPosition(f.text);
      if (!r.ok) {
        U.alert('JSONとして読めませんでした', [r.error, r.where ? ('位置: ' + r.where) : '']);
        return;
      }
      var data = r.value;
      if (!data || data.kind !== EST.backup.BACKUP_KIND) {
        U.alert('復元できません', ['このファイルはこのアプリのバックアップではないようです。']);
        return;
      }
      // まりのバックアップには topics が入っていない（§5.9）
      var summary = Array.isArray(data.topics)
        ? ('トピック ' + data.topics.length + '件')
        : ('練習の記録 ' + ((data.progress || []).length + (data.topicProgress || []).length) + '件');
      U.choose('復元のしかた',
        summary + '。上書きすると今のデータは消えます。',
        [
          { label: '中止', value: null },
          { label: 'マージ（同じidは新しい方）', value: 'merge' },
          { label: '上書き', value: 'overwrite', kind: 'danger' }
        ]
      ).then(function (mode) {
        if (!mode) return;
        return EST.backup.importAll(data, mode).then(function () {
          U.toast('復元しました');
          location.hash = '#/';
          location.reload();
        });
      }).catch(function (e) {
        U.alert('復元に失敗しました', [String(e && e.message || e)]);
      });
    });
  }

  function autoBackupCard() {
    var U = ui();
    var box = h('div', { class: 'small muted', text: '読み込み中…' });
    EST.backup.listAuto().then(function (list) {
      if (!list.length) {
        U.mount(box, h('div', { class: 'small muted', text: 'まだありません。トピックを保存すると自動で作られます。' }));
        return;
      }
      U.mount(box, list.map(function (b) {
        return h('div', { class: 'setting-row' }, [
          h('div', { class: 'setting-row__label' }, [
            U.fmtDate(b.at),
            h('div', { class: 'setting-row__sub', text: (b.label || '') + '　' + U.fmtBytes(b.size || 0) })
          ]),
          h('button', {
            class: 'btn btn--sm', text: 'ここへ戻す',
            onClick: function () {
              U.confirm('自動バックアップから戻す', U.fmtDate(b.at) + ' の状態に戻します。今のデータは上書きされます。', '戻す', 'danger')
                .then(function (ok) {
                  if (!ok) return;
                  return EST.backup.restoreAuto(b.index, 'overwrite').then(function () {
                    U.toast('戻しました');
                    location.reload();
                  });
                });
            }
          })
        ]);
      }));
    });

    return h('div', { class: 'card' }, [
      h('h2', { class: 'card__title', text: '自動バックアップ（直近' + EST.backup.AUTO_KEEP + '世代）' }),
      box
    ]);
  }

  /* ---- サンプル ----------------------------------------------------------- */
  function sampleCard() {
    var U = ui();
    var n = (EST.SAMPLES || []).length;
    return h('div', { class: 'card' }, [
      h('h2', { class: 'card__title', text: 'サンプル台本' }),
      h('div', { class: 'small muted', text: n
        ? ('短い台本と長い台本の ' + n + '本を入れ直します。同じIDのものは上書きされます。')
        : 'このビルドにはサンプルが含まれていません。' }),
      h('button', {
        class: 'btn', style: { marginTop: '.5rem' }, text: 'サンプルを入れ直す', disabled: !n,
        onClick: function () {
          EST.app.seedSamples(true).then(function (cnt) {
            U.toast(cnt + '本を入れ直しました');
          });
        }
      })
    ]);
  }

  /* ---- 情報 --------------------------------------------------------------- */
  function infoCard(s) {
    var U = ui();
    var box = h('div', { class: 'small muted', text: '集計中…' });
    Promise.all([
      EST.store.getAll('topics'),
      EST.store.getAll('progress'),
      EST.store.getAll('topicProgress')
    ]).then(function (r) {
      var rows = [
        '部屋 ' + EST.profile.label() + '（' + EST.profile.get() + '）',
        'トピック ' + r[0].length + '件',
        '行の進捗 ' + r[1].length + '件',
        'トピックの進捗 ' + r[2].length + '件',
        'データベース ' + EST.store.DB_NAME + ' v' + EST.store.DB_VERSION
      ];
      // §10.1 file:// ではマイクとService Workerが使えない。F4以降で効いてくるので今から出しておく。
      if (location.protocol === 'file:') {
        rows.push('※ file:// で開いています。マイク自動カウントを使うにはWeb配信（HTTPS）が必要です。');
      }
      U.mount(box, rows.map(function (t) { return h('div', { text: t }); }));
    });

    return h('div', { class: 'card' }, [
      h('h2', { class: 'card__title', text: '情報' }),
      box,
      h('div', { class: 'tiny muted', style: { marginTop: '.4rem' },
        text: '音声・マイク・練習の設定は F3〜F5 で追加されます。' })
    ]);
  }

  /* ---- 危険な操作 ---------------------------------------------------------- */
  function dangerCard() {
    var U = ui();
    // §5.9 まりは共有の台本を消せない。自分の記録だけを消す。
    var full = EST.profile.canEdit();
    var label = full ? '全データを削除' : 'わたしの記録を削除';
    var detail = full
      ? 'トピック・進捗・設定・自動バックアップをすべて消します。'
      : 'あなたの練習の記録と設定だけを消します。台本は残ります。';
    return h('div', { class: 'card' }, [
      h('h2', { class: 'card__title', text: 'データを消す' }),
      h('div', { class: 'small muted', text: '先にバックアップを書き出しておいてください。元に戻せません。' }),
      h('button', {
        class: 'btn btn--danger', style: { marginTop: '.5rem' }, text: label,
        onClick: function () {
          U.confirm(label, detail, '削除する', 'danger')
            .then(function (ok) {
              if (!ok) return;
              return (full ? EST.backup.wipeAll() : EST.backup.wipeProfile()).then(function () {
                U.toast('削除しました');
                location.hash = '#/';
                location.reload();
              });
            });
        }
      })
    ]);
  }

  EST.uiSettings = { render: render };
})(window.EST = window.EST || {});
