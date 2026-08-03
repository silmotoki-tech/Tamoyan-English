/* =====================================================================
   01-schema.js — スキーマ検証・正規化・台本パーサ・自動分割
   SPEC §1.5 / §1.8 / §5.1-5.3 / §6.1 / §6.3
   ===================================================================== */
;(function (EST) {
  'use strict';

  /* ---- 調整用の定数（実機で必ず調整する。SPEC §12） ------------------ */
  var SCHEMA_VERSION      = 3;

  var JA_RATIO_MIN        = 0.15;  // §6.1 日本語文字の比率がこれ以上なら JA 行とみなす
  var SPEAKER_LABEL_MAX   = 6;     // 話者ラベルの種類がこれを超えたら「コロンが多いだけ」
  var SPEAKER_LABEL_LEN   = 24;    // 話者ラベルとして許す最大文字数
  var DELIM_RATIO_MIN     = 0.7;   // 区切り文字を含む行がこの比率以上なら列分割へ切り替え
  var PAIR_PURITY_MIN     = 0.6;   // 英文ブロック／和文ブロック形式と判定する純度

  var BLOCK_AUTO_MIN      = 13;    // §1.5 この行数以上でブロック自動分割
  var BLOCK_AUTO_SIZE     = 5;     // 機械的に5行ずつ

  var CHUNK_MAX_WORDS     = 5;     // §1.8 これを超えたらもう一度割る
  var CHUNK_BREAK_MIN     = 3;     // この点数以上の切れ目で割る

  var WORD_MS             = 400;   // §2.3 内蔵TTS想定の1語あたりの所要
  var LINE_GAP_MS         = 350;   // 行と行のあいだの間
  var DEFAULT_RATE        = 0.95;  // §5.7 ttsRate の既定

  /* ---- 語のテーブル（チャンク自動分割用。§1.8） ---------------------- */
  function set(list) { var o = {}; list.forEach(function (w) { o[w] = true; }); return o; }

  var PREP = set(['in','on','at','for','with','about','from','to','of','by','into','onto',
    'over','under','after','before','during','through','across','around','against',
    'between','beyond','near','since','until','till','upon','within','without','off','out']);
  var CONJ = set(['and','but','so','because','if','when','while','although','though',
    'unless','whether','or','nor','yet','as','than','once','whenever']);
  var REL  = set(['who','which','that','whom','whose','where','why']);

  var SEP_MARK = '@@EST_SEP@@';   // 英文/和文ブロックの区切りを退避する内部マーカー

  /* ---- 小道具 -------------------------------------------------------- */
  function pad3(n) { return ('00' + n).slice(-3); }

  function countWords(en) {
    var t = String(en == null ? '' : en).trim();
    if (!t) return 0;
    return t.split(/\s+/).length;
  }

  function jaRatio(s) {
    var t = String(s || '').replace(/\s/g, '');
    if (!t.length) return 0;
    var m = t.match(/[ぁ-ゖァ-ヺー一-鿿々]/g);
    return m ? m.length / t.length : 0;
  }

  // 1行を EN / JA / IGNORE に分類する（§6.1 手順2）
  function classifyLine(s) {
    var t = String(s || '').trim();
    if (!t) return 'IGNORE';
    if (/^[-=_*—]{3,}$/.test(t)) return 'IGNORE';
    if (jaRatio(t) >= JA_RATIO_MIN) return 'JA';
    if (/[A-Za-z]/.test(t)) return 'EN';
    return 'IGNORE';
  }

  // 行頭の「ラベル:」を切り出す（§6.1 手順3）。時刻とURLは除外する。
  function splitLabel(text) {
    var m = /^([^\s:：][^:：]{0,23})[:：][ \t]*(.*)$/.exec(String(text || ''));
    if (!m) return null;
    var label = m[1].trim();
    if (!label) return null;
    if (label.length > SPEAKER_LABEL_LEN) return null;
    if (/^\d{1,2}$/.test(label)) return null;                          // 10:30 のような時刻
    if (/^(https?|ftp|mailto|tel|file|data)$/i.test(label)) return null; // URL
    if (/[.!?。？！]$/.test(label)) return null;                        // 文中のコロン
    return { label: label, rest: m[2].trim() };
  }

  function newTopicId() {
    var d = new Date();
    var ymd = '' + d.getFullYear() + pad3(d.getMonth() + 1).slice(-2) + pad3(d.getDate()).slice(-2);
    var rnd = Math.random().toString(36).slice(2, 6);
    return 'tpc_' + ymd + '_' + rnd;
  }

  /* ---- 台本テキストの正規化（§6.1 手順1） ---------------------------- */
  function normalizeRaw(raw) {
    var t = String(raw == null ? '' : raw);
    t = t.replace(/\r\n?/g, '\n');
    // 全角スペース(U+3000)・ノーブレークスペース(U+00A0)・ゼロ幅スペースを半角に寄せる
    t = t.replace(/[\u3000\u00a0\u200b]/g, ' ');
    t = t.split('\n').map(function (l) { return l.replace(/[ \t]+$/, ''); }).join('\n');
    // 「連続空行2つ以上」は英文ブロックと和文ブロックの区切りの合図なので、
    // 空行を畳み込む前にマーカーへ退避しておく（畳み込むと合図が消えてしまう）
    t = t.replace(/\n[ \t]*\n[ \t]*\n[\s]*/g, '\n' + SEP_MARK + '\n');
    t = t.replace(/^[ \t]*[-=]{3,}[ \t]*$/gm, SEP_MARK);
    return t;
  }

  function toLines(t) {
    return t.split('\n').map(function (l) { return l.trim(); })
            .filter(function (l) { return l.length > 0; });
  }

  /* ---- 台本パーサ（§6.1） -------------------------------------------- */
  // 戻り値: { speakers, lines, warnings, mode }
  function parseScript(raw) {
    var warnings = [];
    var lines = toLines(normalizeRaw(raw));
    if (!lines.length) return { speakers: [], lines: [], warnings: ['台本が空です'], mode: 'empty' };

    var entries = null, mode = '';

    // (a) 英文ブロックのあとに和文ブロックが続く形
    var pair = tryPairMode(lines);
    if (pair) { entries = pair; mode = 'pair'; }

    if (!entries) {
      lines = lines.filter(function (l) { return l !== SEP_MARK; });
      // (b) 区切り文字による列分割（§6.1 手順4）
      var col = tryColumnMode(lines);
      if (col) { entries = col; mode = 'column'; }
    }

    // (c) 英日交互（既定）
    if (!entries) { entries = buildInterleaved(lines, true); mode = 'interleave'; }

    // 話者ラベルの採否（§6.1 手順3）
    var labels = [];
    entries.forEach(function (e) {
      if (e.label && labels.indexOf(e.label) < 0) labels.push(e.label);
    });

    var adopt = labels.length >= 1 && labels.length <= SPEAKER_LABEL_MAX;
    if (labels.length > SPEAKER_LABEL_MAX) {
      // ラベルが多すぎるときは「コロンが多いだけ」とみなし、切り出さずにやり直す
      warnings.push('行頭のコロンが' + labels.length + '種類あったので、話者ラベルとして扱いませんでした');
      if (mode === 'interleave') entries = buildInterleaved(lines, false);
      else entries.forEach(function (e) {
        if (e.label) { e.en = e.label + ': ' + e.en; e.label = null; }
      });
      adopt = false;
    }

    var speakers = resolveSpeakers(entries, adopt);
    if (!adopt) warnings.push('話者が判別できなかったので、A と B に交互に割り当てました');

    var out = entries.filter(function (e) { return e.en && e.en.trim(); })
      .map(function (e, i) {
        return {
          id: 'ln_' + pad3(i + 1),
          speakerId: e.speakerId,
          en: e.en.trim(),
          ja: (e.ja || '').trim(),
          note: '',
          alt: [],
          chunks: splitChunks(e.en),
          skip: false
        };
      });

    var noJa = out.filter(function (l) { return !l.ja; }).length;
    if (noJa) warnings.push('和訳が付いていない行が ' + noJa + ' 件あります（S5 和訳から出す が使えません）');
    if (out.length >= BLOCK_AUTO_MIN) {
      warnings.push(out.length + '行あるので ' + BLOCK_AUTO_SIZE + '行ずつ機械的にブロック分割しました。境界はドラッグで動かせます');
    }

    return { speakers: speakers, lines: out, warnings: warnings, mode: mode };
  }

  // (a) 英文ブロック --- 和文ブロック
  function tryPairMode(lines) {
    var at = lines.indexOf(SEP_MARK);
    if (at <= 0) return null;
    if (lines.lastIndexOf(SEP_MARK) !== at) return null;  // 区切りが複数あるなら別の形式
    var a = lines.slice(0, at).filter(function (l) { return l !== SEP_MARK; });
    var b = lines.slice(at + 1).filter(function (l) { return l !== SEP_MARK; });
    if (!a.length || a.length !== b.length) return null;  // 行数一致が条件（§6.1）

    function purity(arr, kind) {
      var n = 0;
      arr.forEach(function (l) {
        var body = splitLabel(l);
        if (classifyLine(body && body.rest ? body.rest : l) === kind) n++;
      });
      return n / arr.length;
    }
    if (purity(a, 'EN') < PAIR_PURITY_MIN) return null;
    if (purity(b, 'JA') < PAIR_PURITY_MIN) return null;

    return a.map(function (enLine, i) {
      var sp = splitLabel(enLine);
      var label = null, en = enLine;
      if (sp && sp.rest) { label = sp.label; en = sp.rest; }
      var jb = splitLabel(b[i]);
      var ja = (jb && jb.rest) ? jb.rest : b[i];
      return { label: label, en: en, ja: ja };
    });
  }

  // (b) タブ / | / ｜ / / による列分割
  function tryColumnMode(lines) {
    var re = /\t|\||｜/;
    var hit = lines.filter(function (l) { return re.test(l); }).length;
    var useSlash = false;
    if (hit / lines.length < DELIM_RATIO_MIN) {
      // 「/」は英文中にも出るので、タブや縦棒が無いときだけ候補にする
      hit = lines.filter(function (l) { return / \/ |\//.test(l) && jaRatio(l) > 0; }).length;
      if (hit / lines.length < DELIM_RATIO_MIN) return null;
      useSlash = true;
    }
    var splitter = useSlash ? /\s*\/\s*/ : /\s*[\t|｜]\s*/;

    return lines.map(function (l) {
      var parts = l.split(splitter).map(function (p) { return p.trim(); })
                   .filter(function (p) { return p.length > 0; });
      var label = null, en = '', ja = '';
      if (parts.length >= 3 && parts[0].length <= SPEAKER_LABEL_LEN &&
          jaRatio(parts[0]) < JA_RATIO_MIN && !/[.!?]$/.test(parts[0])) {
        label = parts[0]; en = parts[1]; ja = parts.slice(2).join(' ');
      } else if (parts.length >= 2) {
        en = parts[0]; ja = parts.slice(1).join(' ');
      } else {
        en = parts[0] || '';
      }
      var sp = splitLabel(en);
      if (!label && sp && sp.rest) { label = sp.label; en = sp.rest; }
      // 列の並びが逆（和文が先）のときは入れ替える
      if (jaRatio(en) >= JA_RATIO_MIN && jaRatio(ja) < JA_RATIO_MIN) { var t = en; en = ja; ja = t; }
      return { label: label, en: en, ja: ja };
    }).filter(function (e) { return e.en; });
  }

  // (c) 英日交互（§6.1 手順5）
  function buildInterleaved(lines, useLabels) {
    var entries = [];
    var pendingJa = [];   // 英文より先に和文が来た場合の受け皿
    lines.forEach(function (line) {
      if (line === SEP_MARK) return;
      var label = null, text = line;
      if (useLabels) {
        var sp = splitLabel(line);
        if (sp && sp.rest) { label = sp.label; text = sp.rest; }
      }
      var cls = classifyLine(text);
      if (cls === 'JA') {
        if (entries.length) {
          var last = entries[entries.length - 1];
          // JA行が2行続いたら結合する（§6.1 手順5）
          last.ja = last.ja ? (last.ja + text) : text;
        } else {
          pendingJa.push(text);
        }
      } else if (cls === 'EN') {
        // EN行が2行続いたら、前の行は訳なしで確定（新しい entry を積むだけでよい）
        entries.push({ label: label, en: text, ja: pendingJa.join('') });
        pendingJa = [];
      }
    });
    return entries;
  }

  function resolveSpeakers(entries, adopt) {
    var speakers = [], map = {};
    if (adopt) {
      entries.forEach(function (e) {
        if (e.label && !map[e.label]) {
          var id = 'S' + (speakers.length + 1);
          map[e.label] = id;
          speakers.push({ id: id, label: e.label, gender: '' });
        }
      });
      var last = speakers.length ? speakers[0].id : 'S1';
      entries.forEach(function (e) {
        e.speakerId = e.label ? map[e.label] : last;   // ラベルのない行は直前の話者を引き継ぐ
        last = e.speakerId;
      });
    } else {
      speakers = [{ id: 'S1', label: 'A', gender: '' }, { id: 'S2', label: 'B', gender: '' }];
      entries.forEach(function (e, i) { e.speakerId = (i % 2 === 0) ? 'S1' : 'S2'; });
    }
    if (!speakers.length) speakers = [{ id: 'S1', label: 'A', gender: '' }];
    return speakers;
  }

  /* ---- チャンク自動分割（§1.8） -------------------------------------- */
  function bareWord(w) {
    return String(w).replace(/^[^A-Za-z0-9']+/, '').replace(/[^A-Za-z0-9']+$/, '').toLowerCase();
  }

  // tokens[i] の直前で切るべきかの点数。0 なら切らない。
  function breakScore(tokens, i) {
    if (i <= 0 || i >= tokens.length) return 0;
    var prev = tokens[i - 1];
    var cur = bareWord(tokens[i]);
    var s = 0;
    if (/[,;:]$/.test(prev)) s = Math.max(s, 5);                 // カンマの直後がいちばん強い
    if (CONJ[cur] || REL[cur]) s = Math.max(s, 4);               // 接続詞・関係詞の直前
    if (cur === 'to' && i + 1 < tokens.length) s = Math.max(s, 3); // to不定詞の直前
    if (PREP[cur]) s = Math.max(s, 3);                           // 前置詞の直前
    return s;
  }

  function splitChunks(en) {
    var tokens = String(en == null ? '' : en).trim().split(/\s+/).filter(Boolean);
    if (tokens.length <= 1) return tokens.length ? [tokens.join(' ')] : [];

    var cuts = [];
    for (var i = 1; i < tokens.length; i++) {
      if (breakScore(tokens, i) >= CHUNK_BREAK_MIN) cuts.push(i);
    }
    var groups = cutsToGroups(tokens.length, cuts);
    groups = splitLongGroups(tokens, groups);
    groups = absorbSingles(groups);

    return groups.map(function (g) { return tokens.slice(g[0], g[1]).join(' '); });
  }

  function cutsToGroups(len, cuts) {
    var groups = [], start = 0;
    cuts.forEach(function (c) { if (c > start) { groups.push([start, c]); start = c; } });
    groups.push([start, len]);
    return groups;
  }

  // 5語を超えたら、その中の最も強い切れ目でもう一度割る（§1.8）
  function splitLongGroups(tokens, groups) {
    var out = [], guard = 0;
    var queue = groups.slice();
    while (queue.length && guard++ < 200) {
      var g = queue.shift();
      var len = g[1] - g[0];
      if (len <= CHUNK_MAX_WORDS) { out.push(g); continue; }
      var bestAt = -1, bestScore = -1;
      for (var i = g[0] + 1; i < g[1]; i++) {
        var sc = breakScore(tokens, i);
        // 中央に近いほうを優先すると、極端に偏った分割になりにくい
        var center = 1 - Math.abs((i - g[0]) / len - 0.5);
        var total = sc * 10 + center;
        if (sc > 0 && total > bestScore) { bestScore = total; bestAt = i; }
      }
      if (bestAt < 0) bestAt = g[0] + Math.ceil(len / 2);   // 切れ目が無ければ中央で割る
      queue.unshift([bestAt, g[1]]);
      queue.unshift([g[0], bestAt]);
    }
    return out.sort(function (a, b) { return a[0] - b[0]; });
  }

  // 1語だけになったら前のチャンクに吸収する（§1.8）
  function absorbSingles(groups) {
    var out = [];
    groups.forEach(function (g) {
      var len = g[1] - g[0];
      if (len === 1 && out.length) { out[out.length - 1][1] = g[1]; return; }
      out.push([g[0], g[1]]);
    });
    // 先頭が1語のまま残ったら次に吸収させる
    if (out.length >= 2 && out[0][1] - out[0][0] === 1) {
      out[1][0] = out[0][0];
      out.shift();
    }
    return out;
  }

  /* ---- ブロック（§1.5） ---------------------------------------------- */
  // ブロックは「何行目から始まるか」の配列（starts）として扱うほうが編集しやすい。
  function autoBlockStarts(lineCount) {
    if (lineCount < BLOCK_AUTO_MIN) return [];       // 12行以下はブロックを作らない
    var starts = [];
    for (var i = 0; i < lineCount; i += BLOCK_AUTO_SIZE) starts.push(i);
    return starts;
  }

  function blocksToStarts(blocks, lines) {
    if (!blocks || !blocks.length) return [];
    var index = {};
    lines.forEach(function (l, i) { index[l.id] = i; });
    var starts = [];
    blocks.forEach(function (b) {
      var i = index[b && b.from];
      if (typeof i === 'number' && starts.indexOf(i) < 0) starts.push(i);
    });
    starts.sort(function (a, b) { return a - b; });
    if (!starts.length) return [];
    if (starts[0] !== 0) starts.unshift(0);
    return starts;
  }

  function startsToBlocks(starts, lines, labels) {
    if (!starts || starts.length <= 1) return [];
    var out = [];
    starts.forEach(function (s, i) {
      var end = (i + 1 < starts.length ? starts[i + 1] : lines.length) - 1;
      if (s > end) return;
      out.push({
        id: 'b' + (out.length + 1),
        label: (labels && labels[i]) || ('パート' + (out.length + 1)),
        from: lines[s].id,
        to: lines[end].id
      });
    });
    return out;
  }

  /* ---- 検証（§6.3） --------------------------------------------------- */
  // エラーは1個ずつ返さず、全部まとめて返す（直す側が何往復もしないで済むように）
  function validateTopic(t, opts) {
    opts = opts || {};
    var errors = [], warnings = [];
    if (!t || typeof t !== 'object') return { errors: ['台本オブジェクトとして読めません'], warnings: [] };

    if (!String(t.title || '').trim()) errors.push('タイトルを入れてください');

    if (!Array.isArray(t.lines) || !t.lines.length) {
      errors.push('行が1件もありません');
    } else {
      t.lines.forEach(function (l, i) {
        var no = '（' + (i + 1) + '行目）';
        if (!l || !String(l.en || '').trim()) errors.push(no + '英文が空です');
        else if (!/[A-Za-z]/.test(l.en)) errors.push(no + '英文に英字が含まれていません');
        if (l && !String(l.ja || '').trim()) warnings.push(no + '和訳がありません');
      });
      var ids = {};
      t.lines.forEach(function (l, i) {
        if (!l || !l.id) return;
        if (ids[l.id]) errors.push('行IDが重複しています: ' + l.id);
        ids[l.id] = true;
      });
    }

    var sids = {};
    (t.speakers || []).forEach(function (s) {
      if (!s || !s.id) { errors.push('話者IDのない話者があります'); return; }
      if (sids[s.id]) errors.push('話者IDが重複しています: ' + s.id);
      sids[s.id] = true;
    });
    if (!(t.speakers || []).length) errors.push('話者が1人もいません');

    (t.lines || []).forEach(function (l, i) {
      if (l && l.speakerId && !sids[l.speakerId]) {
        errors.push('（' + (i + 1) + '行目）存在しない話者が指定されています: ' + l.speakerId);
      }
    });

    if (!t.myRole) {
      // S5/S6 に必須なので、保存時は通さない（§6.3 手順5）
      (opts.requireMyRole === false ? warnings : errors).push('自分の役（myRole）を選んでください');
    } else if (!sids[t.myRole]) {
      errors.push('自分の役に存在しない話者が指定されています: ' + t.myRole);
    }

    (t.words || []).forEach(function (w, i) {
      if (!w || !String(w.en || '').trim()) errors.push('語彙 ' + (i + 1) + ' 件目の英語が空です');
    });

    return { errors: errors, warnings: warnings };
  }

  /* ---- 正規化（§6.3 手順4・6・7） ------------------------------------- */
  function normalizeTopic(input, opts) {
    opts = opts || {};
    var src = input || {};
    var now = Date.now();

    var speakers = (Array.isArray(src.speakers) ? src.speakers : [])
      .filter(function (s) { return s && s.id; })
      .map(function (s) {
        return { id: String(s.id), label: String(s.label || s.id), gender: s.gender || '' };
      });
    if (!speakers.length) speakers = [{ id: 'S1', label: 'A', gender: '' }];

    var speakerIds = speakers.map(function (s) { return s.id; });

    var lines = (Array.isArray(src.lines) ? src.lines : []).map(function (l, i) {
      l = l || {};
      var en = String(l.en == null ? '' : l.en).trim();
      var chunks = Array.isArray(l.chunks) && l.chunks.length ? l.chunks.map(String) : splitChunks(en);
      return {
        id: l.id ? String(l.id) : 'ln_' + pad3(i + 1),         // 手順4: 無ければ自動採番
        speakerId: (l.speakerId && speakerIds.indexOf(String(l.speakerId)) >= 0)
                     ? String(l.speakerId) : speakerIds[i % speakerIds.length],
        en: en,
        ja: String(l.ja == null ? '' : l.ja).trim(),
        note: String(l.note == null ? '' : l.note),
        alt: Array.isArray(l.alt) ? l.alt.map(String) : [],
        chunks: chunks,
        skip: !!l.skip
      };
    });

    // 手順6: blocks 未指定かつ13行以上なら5行ずつ自動分割
    var starts = blocksToStarts(src.blocks, lines);
    var labels = (Array.isArray(src.blocks) ? src.blocks : []).map(function (b) { return b && b.label; });
    if (!starts.length) { starts = autoBlockStarts(lines.length); labels = []; }
    var blocks = startsToBlocks(starts, lines, labels);

    // 手順7: words の自動抽出は F6 の担当。F1 では与えられたものを保持するだけ。
    var lineIdSet = {};
    lines.forEach(function (l) { lineIdSet[l.id] = true; });
    var words = (Array.isArray(src.words) ? src.words : []).map(function (w, i) {
      w = w || {};
      return {
        id: w.id ? String(w.id) : 'w_' + pad3(i + 1),
        en: String(w.en == null ? '' : w.en).trim(),
        ja: String(w.ja == null ? '' : w.ja).trim(),
        type: (w.type === 'word' || w.type === 'phrase') ? w.type
              : (countWords(w.en) > 1 ? 'phrase' : 'word'),
        lineIds: (Array.isArray(w.lineIds) ? w.lineIds : [])
                   .map(String).filter(function (id) { return lineIdSet[id]; }),
        note: String(w.note == null ? '' : w.note)
      };
    });

    var myRole = src.myRole && speakerIds.indexOf(String(src.myRole)) >= 0 ? String(src.myRole) : '';

    return {
      id: src.id ? String(src.id) : (opts.id || newTopicId()),
      title: String(src.title == null ? '' : src.title).trim(),
      titleEn: String(src.titleEn == null ? '' : src.titleEn).trim(),
      level: String(src.level == null ? '' : src.level).trim(),
      tags: (Array.isArray(src.tags) ? src.tags : []).map(String).filter(Boolean),
      myRole: myRole,
      speakers: speakers,
      blocks: blocks,
      lines: lines,
      words: words,
      createdAt: Number(src.createdAt) || now,
      updatedAt: now,
      schemaVersion: SCHEMA_VERSION
    };
  }

  /* ---- 見積り（§6.2 の「1周 約◯秒」） -------------------------------- */
  function lapSeconds(lines, rate) {
    rate = Number(rate) || DEFAULT_RATE;
    var ms = 0;
    (lines || []).forEach(function (l) {
      if (!l || l.skip) return;
      ms += countWords(l.en) * WORD_MS / rate + LINE_GAP_MS;
    });
    return Math.round(ms / 1000);
  }

  /* ---- JSON のエラー位置（§6.3 手順1「不正なJSON」だけ出さない） ------ */
  function parseJsonWithPosition(text) {
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch (e) {
      var msg = String(e && e.message || e);
      var m = /position\s+(\d+)/i.exec(msg);
      var where = '';
      if (m) {
        var pos = Number(m[1]);
        var before = text.slice(0, pos);
        var line = before.split('\n').length;
        var col = pos - before.lastIndexOf('\n');
        where = line + '行目 ' + col + '文字目';
      } else {
        var lm = /line\s+(\d+)\s+column\s+(\d+)/i.exec(msg);
        if (lm) where = lm[1] + '行目 ' + lm[2] + '文字目';
      }
      return { ok: false, error: msg, where: where };
    }
  }

  EST.schema = {
    SCHEMA_VERSION: SCHEMA_VERSION,
    BLOCK_AUTO_MIN: BLOCK_AUTO_MIN,
    BLOCK_AUTO_SIZE: BLOCK_AUTO_SIZE,
    DEFAULT_RATE: DEFAULT_RATE,

    countWords: countWords,
    jaRatio: jaRatio,
    classifyLine: classifyLine,
    normalizeRaw: normalizeRaw,
    parseScript: parseScript,

    splitChunks: splitChunks,
    autoBlockStarts: autoBlockStarts,
    blocksToStarts: blocksToStarts,
    startsToBlocks: startsToBlocks,

    validateTopic: validateTopic,
    normalizeTopic: normalizeTopic,
    lapSeconds: lapSeconds,
    newTopicId: newTopicId,
    pad3: pad3,
    parseJsonWithPosition: parseJsonWithPosition
  };
})(window.EST = window.EST || {});
