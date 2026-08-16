/* =====================================================================
   05-mastery.js — 定着判定と再確認キュー（SPEC §1.4）

   EST.mic / EST.stage と同じ理由でUIから独立させる。判定を
   コンソールから単体で試せるようにしておくと、実機で閾値を触るときに
   練習画面を経由せずに済む。
   ===================================================================== */
;(function (EST) {
  'use strict';

  /* ---- 調整用の定数（実機で必ず調整する。SPEC §12） ------------------ */
  // §1.4 閾値(ms) = MASTERY_BASE_MS + 語数 × MASTERY_PER_WORD_MS
  var MASTERY_BASE_MS     = 1200;
  var MASTERY_PER_WORD_MS = 60;
  var MASTERY_STREAK      = 3;        // 直近この回数がすべて閾値未満なら定着
  // §1.4 定着から7日経過した行は再確認対象になる
  var REVIEW_AFTER_MS     = 7 * 24 * 60 * 60 * 1000;
  // §5.4 語彙の閾値（F6で使う。係数だけ差し替えて同じ関数を通す）
  var WORD_BASE_MS        = 900;
  var WORD_PER_WORD_MS    = 60;

  /* ---- 閾値（§1.4） -------------------------------------------------------
     文と語で別々の判定コードを書かない（§5.4）。係数だけ差し替える。 */
  function thresholdMs(text, opts) {
    opts = opts || {};
    var base = opts.isWord ? WORD_BASE_MS : MASTERY_BASE_MS;
    var per = opts.isWord ? WORD_PER_WORD_MS : MASTERY_PER_WORD_MS;
    var words = EST.schema.countWords(text);
    return base + words * per;
  }

  /* ---- 定着したか（§1.4） -------------------------------------------------
     直近3回のレイテンシがすべて閾値未満で、その3回に詰まりが無く、
     シャッフル状態（S5以降）での測定であること。 */
  function isMastered(progress, text, opts) {
    opts = opts || {};
    if (!progress) return false;
    // シャッフル状態での測定でなければ定着とみなさない
    if (!opts.shuffled) return false;

    var hist = (progress.latency && progress.latency.history) || [];
    if (hist.length < MASTERY_STREAK) return false;

    var recent = hist.slice(-MASTERY_STREAK);
    var limit = thresholdMs(text, opts);
    var allFast = recent.every(function (ms) { return ms != null && ms < limit; });
    if (!allFast) return false;

    // その3回に詰まりが無いこと。直近3回ぶんの詰まり件数を別に持つ。
    var recentStalls = (progress.recentStalls || []).slice(-MASTERY_STREAK);
    var noStall = recentStalls.every(function (n) { return !n; });
    return noStall;
  }

  /* ---- 定着の記録 --------------------------------------------------------- */
  function markMastered(progress) {
    progress.mastered = true;
    progress.masteredAt = Date.now();
    progress.reviewAt = Date.now() + REVIEW_AFTER_MS;
    return progress;
  }

  function clearMastered(progress) {
    progress.mastered = false;
    progress.masteredAt = null;
    progress.reviewAt = null;
    return progress;
  }

  /* ---- 再確認（§1.4 / §1.6） ------------------------------------------
     定着から7日経過した行・語が対象。トピックをまたいで1つのキューにまとめる。
     isDue 自体は Progress / WordProgress どちらも同じ形（mastered / reviewAt）
     なので共通で使える。 */
  function isDue(progress, now) {
    if (!progress || !progress.mastered) return false;
    var at = progress.reviewAt || (progress.masteredAt ? progress.masteredAt + REVIEW_AFTER_MS : null);
    if (!at) return false;
    return (now || Date.now()) >= at;
  }

  // 戻り値: [{ kind:'line', progress, topic, line } | { kind:'word', progress, topic, word }] を古い順に
  // §1.6「再確認への合流」。ユーザーから見れば1つの復習キューで、
  // 中身が文だったり語だったりするだけ。別々のキューにすると片方が放置される。
  function buildReviewQueue(now) {
    now = now || Date.now();
    return Promise.all([
      EST.store.getAll('progress'),
      EST.store.getAll('wordProgress'),
      EST.store.getAll('topics')
    ]).then(function (res) {
      var progs = res[0], wprogs = res[1], topics = res[2];
      var byId = {};
      topics.forEach(function (t) { byId[t.id] = t; });
      var me = EST.profile.get();

      var out = [];
      progs.forEach(function (p) {
        // 自分の部屋の記録だけを見る（§5.9）
        if (p.profileId && p.profileId !== me) return;
        if (!isDue(p, now)) return;
        var topic = byId[p.topicId];
        if (!topic || !EST.profile.canSee(topic)) return;
        var line = null;
        (topic.lines || []).forEach(function (l) { if (l.id === p.lineId) line = l; });
        if (!line || line.skip) return;
        out.push({ kind: 'line', progress: p, topic: topic, line: line });
      });
      wprogs.forEach(function (p) {
        if (p.profileId && p.profileId !== me) return;
        if (!isDue(p, now)) return;
        var topic = byId[p.topicId];
        if (!topic || !EST.profile.canSee(topic)) return;
        var word = null;
        (topic.words || []).forEach(function (w) { if (w.id === p.wordId) word = w; });
        if (!word) return;
        out.push({ kind: 'word', progress: p, topic: topic, word: word });
      });

      out.sort(function (a, b) {
        return (a.progress.reviewAt || 0) - (b.progress.reviewAt || 0);
      });
      return out;
    });
  }

  function countDue(now) {
    return buildReviewQueue(now).then(function (q) { return q.length; });
  }

  /* ---- 再確認1回ぶんの判定（§1.4） -----------------------------------------
     閾値未満 かつ 詰まりなし → 定着を維持し、次の再確認を7日後に置き直す
     それ以外               → 定着を外す
     1回の失敗で外す。猶予を入れると崩れに気づくのが遅れる。

     text は判定対象の英文（文なら line.en、語なら word.en）。opts.isWord を
     立てると語の係数で閾値を取る（thresholdMs と同じ約束）。

     文が外れた場合に「そのトピックのS5に戻す」（§1.4）のはUI側
     （16-ui-vocab.js）の仕事にする。TopicProgress は現在のブロック進行や
     役交代など状態が絡み合っていて、ここ（判定だけを持つ層）から
     直接書き換えると壊れたときに追いにくい。 */
  function judgeReview(progress, text, result, opts) {
    var limit = thresholdMs(text, opts);
    var fast = result.latencyMs != null && result.latencyMs < limit;
    var noStall = !(result.stalls && result.stalls.length);
    var kept = fast && noStall;

    if (kept) {
      progress.reviewAt = Date.now() + REVIEW_AFTER_MS;
    } else {
      clearMastered(progress);
    }
    progress.updatedAt = Date.now();
    return { kept: kept, thresholdMs: limit, latencyMs: result.latencyMs };
  }

  EST.mastery = {
    MASTERY_BASE_MS: MASTERY_BASE_MS,
    MASTERY_PER_WORD_MS: MASTERY_PER_WORD_MS,
    MASTERY_STREAK: MASTERY_STREAK,
    REVIEW_AFTER_MS: REVIEW_AFTER_MS,

    thresholdMs: thresholdMs,
    isMastered: isMastered,
    markMastered: markMastered,
    clearMastered: clearMastered,
    isDue: isDue,
    buildReviewQueue: buildReviewQueue,
    countDue: countDue,
    judgeReview: judgeReview
  };
})(window.EST = window.EST || {});
