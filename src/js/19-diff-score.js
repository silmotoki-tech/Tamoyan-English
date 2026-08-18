/* =====================================================================
   19-diff-score.js — 差分・採点エンジン（SPEC §9.3）

   和文英訳ドリル（§9.1）とディクテーションドリル（§9.2）で共用する。
   EST.mic / EST.stage と同じ理由でUIから独立させ、コンソールから
   単体で試せる形にしておく（EST.diffScore.scoreAnswer(...)）。

   採点の考え方:
     ①正規化（小文字化・短縮形展開・数字の表記ゆれ吸収など）
     ②模範解答（line.en）と alt[] の全候補それぞれと単語単位のLCSを取り、
       最もスコアが高い候補を採用する
     ③LCSからあぶれた語を「同じ語が場所だけ違う（語順）」「冠詞だけ」
       「単複だけ」「時制だけ」「前置詞だけ」「抜け」「余分」に分類する
   ===================================================================== */
;(function (EST) {
  'use strict';

  /* ---- 調整用の定数（実機で必ず調整する。SPEC §12） ------------------ */
  var WORDORDER_PENALTY_PER_WORD = 3;
  var WORDORDER_PENALTY_MAX = 15;

  var STRICTNESS = {
    loose:  { pass: 70,  requireExact: false },
    normal: { pass: 85,  requireExact: false },
    strict: { pass: 100, requireExact: true }   // 完全一致（惜しい系も含めて全部だめ）
  };

  // 「惜しい」判定の対象タグ（黄色表示。赤の抜け・余分・語順とは分ける）
  var CLOSE_CALL_TAGS = { article: true, plural: true, tense: true, preposition: true };

  var ARTICLES = { a: true, an: true, the: true };
  var PREPOSITIONS = {
    in: true, on: true, at: true, for: true, with: true, about: true, from: true, to: true,
    of: true, by: true, into: true, onto: true, over: true, under: true, near: true,
    through: true, during: true, before: true, after: true, between: true, without: true
  };
  // 不規則動詞（原形 <-> 過去/過去分詞）。同一動詞の時制違いを検出するための最小限の表。
  var IRREGULAR_VERBS = [
    ['go', 'went', 'gone'], ['have', 'had', 'had'], ['do', 'did', 'done'],
    ['be', 'was', 'been'], ['be', 'were', 'been'], ['get', 'got', 'gotten'],
    ['make', 'made', 'made'], ['take', 'took', 'taken'], ['see', 'saw', 'seen'],
    ['come', 'came', 'come'], ['know', 'knew', 'known'], ['think', 'thought', 'thought'],
    ['say', 'said', 'said'], ['tell', 'told', 'told'], ['find', 'found', 'found'],
    ['give', 'gave', 'given'], ['leave', 'left', 'left'], ['bring', 'brought', 'brought'],
    ['buy', 'bought', 'bought'], ['pay', 'paid', 'paid'], ['send', 'sent', 'sent'],
    ['put', 'put', 'put'], ['run', 'ran', 'run'], ['eat', 'ate', 'eaten'],
    ['write', 'wrote', 'written'], ['read', 'read', 'read'], ['speak', 'spoke', 'spoken'],
    ['meet', 'met', 'met'], ['feel', 'felt', 'felt'], ['keep', 'kept', 'kept']
  ];
  var VERB_FORM_OF = {};   // 活用形 -> 原形
  IRREGULAR_VERBS.forEach(function (row) {
    row.forEach(function (form) { VERB_FORM_OF[form] = row[0]; });
  });

  // §9.3 数字の表記ゆれ。1〜20と主要な数（十の位・百）だけ吸収する。
  var NUMBER_WORDS = {
    zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7',
    eight: '8', nine: '9', ten: '10', eleven: '11', twelve: '12', thirteen: '13',
    fourteen: '14', fifteen: '15', sixteen: '16', seventeen: '17', eighteen: '18',
    nineteen: '19', twenty: '20', thirty: '30', forty: '40', fifty: '50', sixty: '60',
    seventy: '70', eighty: '80', ninety: '90', hundred: '100'
  };

  // ストップワード（§9.2 穴埋めの空欄自動選択で除外する。約60語）
  var STOPWORDS = {
    a: 1, an: 1, the: 1, i: 1, you: 1, he: 1, she: 1, it: 1, we: 1, they: 1,
    me: 1, him: 1, her: 1, us: 1, them: 1, my: 1, your: 1, his: 1, its: 1, our: 1, their: 1,
    am: 1, is: 1, are: 1, was: 1, were: 1, be: 1, been: 1, being: 1,
    do: 1, does: 1, did: 1, doing: 1, done: 1,
    have: 1, has: 1, had: 1, having: 1,
    will: 1, would: 1, shall: 1, should: 1, can: 1, could: 1, may: 1, might: 1, must: 1,
    and: 1, or: 1, but: 1, so: 1, if: 1, because: 1, that: 1, this: 1, these: 1, those: 1,
    of: 1, to: 1, in: 1, on: 1, at: 1, for: 1, with: 1, about: 1, from: 1, by: 1, as: 1,
    not: 1, no: 1, yes: 1, up: 1, out: 1, than: 1, then: 1, there: 1, here: 1, what: 1,
    who: 1, whom: 1, which: 1, when: 1, where: 1, why: 1, how: 1, please: 1
  };

  /* ---- 正規化（§9.3） ----------------------------------------------------
     曖昧な短縮形（it's）は候補を2つ持つので、戻り値は配列。
     通常は要素1つだけの配列になる。 */
  function normalizeVariants(text) {
    var s = String(text || '').toLowerCase().trim().replace(/\s+/g, ' ');
    // カーリークォートを直立に統一
    s = s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
    // 文末の句読点を除去、文中のカンマを除去
    s = s.replace(/[.!?]+(\s|$)/g, '$1').trim();
    s = s.replace(/,/g, '');

    var variants = [s];
    variants = expandAmbiguous(variants, /\bit's\b/, ['it is', 'it has']);

    variants = variants.map(function (v) { return expandContractions(v); });
    variants = variants.map(function (v) { return v.replace(/\s+/g, ' ').trim(); });

    return variants.map(function (v) { return tokenize(v); });
  }

  // 曖昧な短縮形を、他の候補に影響しないよう複製して展開する
  function expandAmbiguous(variants, pattern, replacements) {
    var out = [];
    variants.forEach(function (v) {
      if (pattern.test(v)) {
        replacements.forEach(function (r) { out.push(v.replace(pattern, r)); });
      } else {
        out.push(v);
      }
    });
    return out;
  }

  function expandContractions(s) {
    // 固有の短縮形（曖昧でないもの）
    s = s.replace(/\bi'm\b/g, 'i am');
    s = s.replace(/\bdon't\b/g, 'do not');
    s = s.replace(/\bdoesn't\b/g, 'does not');
    s = s.replace(/\bdidn't\b/g, 'did not');
    s = s.replace(/\blet's\b/g, 'let us');
    s = s.replace(/\bcan't\b/g, 'cannot');
    s = s.replace(/\bwon't\b/g, 'will not');
    s = s.replace(/\bshan't\b/g, 'shall not');
    // 一般形（語幹+'ll/'ve/'d/'re）。isn't/aren't/wasn't/weren't 等の
    // 「動詞+n't」は "not" 展開ではなく素直に1語として残す（誤爆を避ける）。
    s = s.replace(/([a-z]+)'ll\b/g, '$1 will');
    s = s.replace(/([a-z]+)'ve\b/g, '$1 have');
    s = s.replace(/([a-z]+)'d\b/g, '$1 would');
    s = s.replace(/([a-z]+)'re\b/g, '$1 are');
    return s;
  }

  function tokenize(s) {
    return s.split(' ').filter(function (w) { return w; }).map(canonicalizeNumber);
  }

  function canonicalizeNumber(w) {
    return Object.prototype.hasOwnProperty.call(NUMBER_WORDS, w) ? NUMBER_WORDS[w] : w;
  }

  /* ---- 単語単位のLCS -------------------------------------------------- */
  function wordLCS(a, b) {
    var n = a.length, m = b.length;
    var dp = [];
    for (var i = 0; i <= n; i++) dp.push(new Array(m + 1).fill(0));
    for (i = 1; i <= n; i++) {
      for (var j = 1; j <= m; j++) {
        dp[i][j] = (a[i - 1] === b[j - 1]) ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
    // 経路を戻ってマッチしたペア (aIdx, bIdx) を集める
    var pairs = [];
    i = n; var j = m;
    while (i > 0 && j > 0) {
      if (a[i - 1] === b[j - 1]) { pairs.unshift([i - 1, j - 1]); i--; j--; }
      else if (dp[i - 1][j] >= dp[i][j - 1]) { i--; }
      else { j--; }
    }
    return pairs;
  }

  /* ---- 語幹の簡易比較（単複判定用） ------------------------------------
     "es"/"s" を落として同じになれば同一語幹とみなす。ごく単純な近似。 */
  function stem(w) {
    if (w.length > 4 && /ies$/.test(w)) return w.slice(0, -3) + 'y';
    if (w.length > 3 && /(sses|shes|ches|xes)$/.test(w)) return w.slice(0, -2);
    if (w.length > 3 && /s$/.test(w) && !/ss$/.test(w)) return w.slice(0, -1);
    return w;
  }

  function verbRoot(w) {
    if (VERB_FORM_OF[w]) return VERB_FORM_OF[w];
    if (w.length > 4 && /ied$/.test(w)) return w.slice(0, -3) + 'y';
    if (w.length > 3 && /ed$/.test(w)) return w.slice(0, -2).replace(/(.)\1$/, '$1'); // 二重子音を1つに戻す
    return w;
  }

  /* ---- 1組の候補（answerTokens vs targetTokens）を採点する ---------------- */
  function scoreOne(answerTokens, targetTokens) {
    var pairs = wordLCS(answerTokens, targetTokens);
    var matchedA = {}, matchedB = {};
    pairs.forEach(function (p) { matchedA[p[0]] = true; matchedB[p[1]] = true; });

    var unmatchedA = [];   // {idx, word}
    var unmatchedB = [];
    answerTokens.forEach(function (w, i) { if (!matchedA[i]) unmatchedA.push({ idx: i, word: w }); });
    targetTokens.forEach(function (w, i) { if (!matchedB[i]) unmatchedB.push({ idx: i, word: w }); });

    var tags = [];          // 出現したタグの集合（表示用バッジ）
    var wordDiff = [];      // 単語ごとの表示情報

    // Step B: 完全に同じ語（語順だけ違う）を先に拾う
    unmatchedB.forEach(function (b) {
      if (b.used) return;
      var hit = null;
      for (var k = 0; k < unmatchedA.length; k++) {
        if (!unmatchedA[k].used && unmatchedA[k].word === b.word) { hit = unmatchedA[k]; break; }
      }
      if (hit) { hit.used = true; b.used = true; hit.tag = 'wordorder'; b.tag = 'wordorder'; }
    });

    // Step C: 冠詞・単複・時制・前置詞の近似ペアリング（残りだけを対象に、出現順で貪欲に）
    unmatchedA.forEach(function (a) {
      if (a.used) return;
      for (var k = 0; k < unmatchedB.length; k++) {
        var b = unmatchedB[k];
        if (b.used) continue;
        var tag = classifyPair(a.word, b.word);
        if (tag) { a.used = true; b.used = true; a.tag = tag; b.tag = tag; break; }
      }
    });

    var wordorderCount = 0;
    unmatchedA.filter(function (a) { return a.tag === 'wordorder'; }).forEach(function () { wordorderCount++; });

    unmatchedA.forEach(function (a) { if (!a.used) a.tag = 'extra'; });
    unmatchedB.forEach(function (b) { if (!b.used) b.tag = 'missing'; });

    tags = uniq(unmatchedA.map(function (a) { return a.tag; }).concat(unmatchedB.map(function (b) { return b.tag; })));

    var lcsLen = pairs.length;
    var scoreBase = 100 * lcsLen / Math.max(answerTokens.length, targetTokens.length, 1);
    var penalty = Math.min(wordorderCount * WORDORDER_PENALTY_PER_WORD, WORDORDER_PENALTY_MAX);
    var score = clamp(scoreBase - penalty, 0, 100);

    // 表示用の単語列を作る（模範解答側の並びを軸に、抜け・一致を並べ、
    // 余分は解答側にしかないので別に持つ）
    var targetWordDiff = targetTokens.map(function (w, i) {
      if (matchedB[i]) return { word: w, kind: 'match' };
      var b = unmatchedB.filter(function (x) { return x.idx === i; })[0];
      return { word: w, kind: b ? b.tag : 'missing' };
    });
    var answerWordDiff = answerTokens.map(function (w, i) {
      if (matchedA[i]) return { word: w, kind: 'match' };
      var a = unmatchedA.filter(function (x) { return x.idx === i; })[0];
      return { word: w, kind: a ? a.tag : 'extra' };
    });

    return {
      score: score, tags: tags, wordorderCount: wordorderCount,
      targetWordDiff: targetWordDiff, answerWordDiff: answerWordDiff
    };
  }

  function classifyPair(aWord, bWord) {
    if (aWord === bWord) return null; // 完全一致はここに来ないはず（呼び出し側で除外済み）
    if (ARTICLES[aWord] && ARTICLES[bWord]) return 'article';
    if (stem(aWord) === stem(bWord) && aWord !== bWord) return 'plural';
    if (PREPOSITIONS[aWord] && PREPOSITIONS[bWord]) return 'preposition';
    if (verbRoot(aWord) === verbRoot(bWord) && aWord !== bWord) return 'tense';
    return null;
  }

  function uniq(arr) {
    var seen = {}, out = [];
    arr.forEach(function (x) { if (x && !seen[x]) { seen[x] = true; out.push(x); } });
    return out;
  }
  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

  /* ---- 解答を採点する（§9.3） --------------------------------------------
     line.en と line.alt[] の全候補と比較し、最高スコアの結果を採用する。
     opts: { strictness: 'loose'|'normal'|'strict', checkCase, rawAnswer } */
  function scoreAnswer(answerText, line, opts) {
    opts = opts || {};
    var strictness = STRICTNESS[opts.strictness] || STRICTNESS.normal;
    var answerVariants = normalizeVariants(answerText);
    var targets = [line.en].concat(line.alt || []);

    var best = null;
    targets.forEach(function (t) {
      normalizeVariants(t).forEach(function (targetTokens) {
        answerVariants.forEach(function (answerTokens) {
          // Step B/C の前に単独の冠詞を先に拾っておく（"a/an/the" 単独の有無）
          var r = scoreOneWithLoneArticles(answerTokens, targetTokens);
          if (!best || r.score > best.score) { best = r; best.targetText = t; }
        });
      });
    });
    if (!best) best = { score: 0, tags: [], targetWordDiff: [], answerWordDiff: [], targetText: line.en };

    var closeCallOnly = best.tags.length > 0 && best.tags.every(function (t) { return CLOSE_CALL_TAGS[t]; });
    var exact = best.score === 100 && best.tags.length === 0;

    var passed;
    if (strictness.requireExact) {
      passed = exact;
    } else {
      passed = best.score >= strictness.pass;
    }

    var result = {
      score: Math.round(best.score),
      tags: best.tags,
      closeCallOnly: closeCallOnly,
      exact: exact,
      passed: passed,
      warn: passed && !exact && closeCallOnly,   // normalで合格したが惜しい系が残っている
      targetText: best.targetText,
      targetWordDiff: best.targetWordDiff,
      answerWordDiff: best.answerWordDiff
    };

    // ディクテーションのみ：大文字小文字は別枠でチェックする（§9.2）
    if (opts.checkCase && opts.rawAnswer != null) {
      result.caseIssues = checkCasing(opts.rawAnswer, best.targetText);
      if (strictness.requireExact && result.caseIssues.length) result.passed = false;
    }

    return result;
  }

  function scoreOneWithLoneArticles(answerTokens, targetTokens) {
    var r = scoreOne(answerTokens, targetTokens);
    // scoreOne内部の未使用配列は外に出ていないので、単独冠詞の再分類は
    // wordDiff の 'missing'/'extra' から拾い直して 'article' に格上げする
    r.targetWordDiff = r.targetWordDiff.map(function (d) {
      return (d.kind === 'missing' && ARTICLES[d.word]) ? { word: d.word, kind: 'article' } : d;
    });
    r.answerWordDiff = r.answerWordDiff.map(function (d) {
      return (d.kind === 'extra' && ARTICLES[d.word]) ? { word: d.word, kind: 'article' } : d;
    });
    var tagSet = {};
    r.targetWordDiff.concat(r.answerWordDiff).forEach(function (d) { if (d.kind !== 'match') tagSet[d.kind] = true; });
    r.tags = Object.keys(tagSet);
    return r;
  }

  // 単語ごとの大文字小文字チェック（正規化後は失われるので原文同士を単語数だけ揃えて見る）
  function checkCasing(rawAnswer, targetText) {
    var a = String(rawAnswer || '').trim().split(/\s+/);
    var b = String(targetText || '').trim().split(/\s+/);
    var issues = [];
    var n = Math.min(a.length, b.length);
    for (var i = 0; i < n; i++) {
      var aw = a[i].replace(/[.,!?]+$/, ''), bw = b[i].replace(/[.,!?]+$/, '');
      if (aw.toLowerCase() === bw.toLowerCase() && aw !== bw) {
        issues.push({ index: i, expected: bw, got: aw });
      }
    }
    return issues;
  }

  /* ---- §9.2 穴埋めの空欄自動選択 -------------------------------------------
     ストップワードを除いた内容語のうち、優先順位:
       ①行の note に出てくる語  ②words[] に登録されている語
       ③文中で最も長い語        ④動詞と思われる語
     1文あたり1〜3語。5語以下の文は1語だけ。 */
  function contentWords(line) {
    var raw = String(line.en || '').replace(/[.,!?]/g, '').split(/\s+/).filter(Boolean);
    return raw.map(function (w, i) { return { word: w, lower: w.toLowerCase(), idx: i }; })
      .filter(function (t) { return !STOPWORDS[t.lower]; });
  }

  function pickBlanks(line, topic) {
    var words = contentWords(line);
    if (!words.length) return [];
    var totalWords = String(line.en || '').split(/\s+/).filter(Boolean).length;
    var maxBlanks = totalWords <= 5 ? 1 : Math.min(3, Math.max(1, Math.ceil(words.length / 4)));

    var noteWords = extractNoteWords(line.note);
    var vocabWords = {};
    ((topic && topic.words) || []).forEach(function (w) {
      String(w.en || '').toLowerCase().split(/\s+/).forEach(function (tok) { vocabWords[tok] = true; });
    });

    function priority(t) {
      if (noteWords[t.lower]) return 0;
      if (vocabWords[t.lower]) return 1;
      return looksLikeVerb(t.lower) ? 3 : 2;   // 長さ優先(2)を動詞疑い(3)より先にする
    }
    var ranked = words.slice().sort(function (x, y) {
      var px = priority(x), py = priority(y);
      if (px !== py) return px - py;
      if (px === 2) return y.word.length - x.word.length;  // 長さ優先枠は長い語から
      return x.idx - y.idx;
    });
    var picked = [];
    var usedIdx = {};
    for (var i = 0; i < ranked.length && picked.length < maxBlanks; i++) {
      if (usedIdx[ranked[i].idx]) continue;
      usedIdx[ranked[i].idx] = true;
      picked.push(ranked[i]);
    }
    picked.sort(function (a, b) { return a.idx - b.idx; });
    return picked.map(function (t) { return { word: t.word, index: t.idx }; });
  }

  function extractNoteWords(note) {
    var out = {};
    if (!note) return out;
    // "run out of = 使い切る、切らす" のような "X = 意味" パターン（§5.3と同じ約束）
    var m = String(note).split('=')[0];
    m.toLowerCase().split(/\s+/).forEach(function (w) { if (w) out[w] = true; });
    return out;
  }

  var VERB_SUFFIXES = ['ing', 'ed', 'ize', 'ise', 'ify', 'ate'];
  var COMMON_VERBS = { is: 1, are: 1, was: 1, were: 1, go: 1, get: 1, take: 1, make: 1, have: 1,
    check: 1, want: 1, need: 1, see: 1, know: 1, think: 1, come: 1, give: 1, use: 1, find: 1 };
  function looksLikeVerb(lower) {
    if (COMMON_VERBS[lower]) return true;
    return VERB_SUFFIXES.some(function (suf) { return lower.length > suf.length + 2 && lower.slice(-suf.length) === suf; });
  }

  /* ---- §9.2 4択のダミー ----------------------------------------------------
     同じトピックの他の行から、語長と品詞（動詞らしさ）が近い語を借りる。 */
  function buildDistractors(word, topic, count) {
    count = count || 3;
    var lower = String(word).toLowerCase();
    var pool = {};
    ((topic && topic.lines) || []).forEach(function (l) {
      contentWords(l).forEach(function (t) { if (t.lower !== lower) pool[t.lower] = t.word; });
    });
    var candidates = Object.keys(pool).map(function (k) { return pool[k]; });
    var wantVerb = looksLikeVerb(lower);
    candidates.sort(function (a, b) {
      var da = Math.abs(a.length - word.length) + (looksLikeVerb(a.toLowerCase()) === wantVerb ? 0 : 2);
      var db = Math.abs(b.length - word.length) + (looksLikeVerb(b.toLowerCase()) === wantVerb ? 0 : 2);
      return da - db;
    });
    return candidates.slice(0, count);
  }

  EST.diffScore = {
    STRICTNESS: STRICTNESS,
    CLOSE_CALL_TAGS: CLOSE_CALL_TAGS,
    STOPWORDS: STOPWORDS,
    normalizeVariants: normalizeVariants,
    scoreAnswer: scoreAnswer,
    pickBlanks: pickBlanks,
    buildDistractors: buildDistractors,
    // テスト・デバッグ用に内部関数も少しだけ出す
    tokenize: tokenize
  };
})(window.EST = window.EST || {});
