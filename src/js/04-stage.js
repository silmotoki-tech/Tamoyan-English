/* =====================================================================
   04-stage.js — ステージ進行とカウント判定（SPEC §1.1 / §1.2 / §1.5 / §2.3）

   EST.mic と同じ理由でUIから独立させる。カウント判定と進級判定を
   コンソールから単体で試せるようにしておくと、実機で閾値を触るときに
   練習画面を経由せずに済む。

   §2.8 カウント成否の判定はここ（ステージ層）の仕事。expectedMs を
   知っているのもここ。EST.mic は起きた事実だけを報告する。
   ===================================================================== */
;(function (EST) {
  'use strict';

  /* ---- 調整用の定数（実機で必ず調整する。SPEC §12） ------------------ */
  var COUNT_RATIO_DEFAULT = 0.55;   // §2.3 spokenMs/expectedMs がこれ以上で成立
  // §1.2 各ステージの最低回数
  var MIN_REPS = { S1: 3, S2: 10, S3: 15, S4: 15 };
  // §1.2 S2・S4 は「カウント成立が3回連続」、S3 は「各係数で3回連続」
  var STREAK_NEEDED = 3;
  // §1.2 S3 の目標時間の係数。各係数で3回連続成功したら次の段階へ。
  var S3_TIME_FACTORS = [1.3, 1.15, 1.0, 0.9];
  // §2.6 TTSが鳴るステージで、再生終了から回を閉じるまでの猶予
  var TTS_CLOSE_DELAY_MS = 800;
  // §1.4 で使う定着閾値の係数（F7で使う。ここでは持つだけ）
  var MASTERY_BASE_MS = 1200;
  var MASTERY_PER_WORD_MS = 60;

  var STAGES = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'];
  var STAGE_LABELS = {
    S1: 'S1 聞いてなぞる',
    S2: 'S2 重ねて読む',
    S3: 'S3 見て読む',
    S4: 'S4 影を追う',
    S5: 'S5 和訳から出す',
    S6: 'S6 相手に返す'
  };
  // F5 の対象。S5・S6 は F7。
  var IMPLEMENTED = { S1: true, S2: true, S3: true, S4: true };

  // §2.6 ステージごとのTTS・マイクの扱い
  var STAGE_MODE = {
    S1: { tts: true,  mic: false, showEn: true,  showJa: true,  timeBar: false },
    S2: { tts: true,  mic: true,  showEn: true,  showJa: false, timeBar: false },
    S3: { tts: false, mic: true,  showEn: true,  showJa: false, timeBar: true },
    S4: { tts: true,  mic: true,  showEn: false, showJa: false, timeBar: false }
  };

  function stageLabel(st) { return STAGE_LABELS[st] || st; }
  function stageMode(st) { return STAGE_MODE[st] || STAGE_MODE.S3; }
  function minReps(st) { return MIN_REPS[st] || 0; }

  /* ---- カウント判定（§2.3） ----------------------------------------------
     ここが F4 から移ってきた部分。EST.mic は spokenMs を出すだけで、
     何回と数えるかは知らない。 */
  function judgeCount(spokenMs, expectedMs, ratio) {
    if (!expectedMs || expectedMs <= 0) return false;
    var r = (ratio == null) ? COUNT_RATIO_DEFAULT : ratio;
    return (spokenMs / expectedMs) >= r;
  }

  /* ---- TopicProgress（§5.6） ---------------------------------------------
     stage と、進級判定に必要な連続成功カウント・S3の係数段階を持つ。
     アプリを閉じても失われないよう保存する。 */
  function defaultTopicProgress(profileId, topicId) {
    return {
      topicId: EST.store.topicProgressKey(topicId),
      profileId: profileId,
      realTopicId: topicId,
      stage: 'S1',
      blockIndex: 0,          // §1.5 ブロックごとにステージが独立して進む
      streak: 0,              // 連続でカウント成立した回数
      s3FactorIndex: 0,       // §1.2 S3 の係数段階
      s3Streak: 0,            // 現在の係数での連続成功数
      stageReps: {},          // ステージごとの実施回数（S1は再生回数）
      laps: { total: 0, byStage: {} },
      sessions: [],
      updatedAt: 0
    };
  }

  function loadTopicProgress(topicId) {
    var key = EST.store.topicProgressKey(topicId);
    return EST.store.get('topicProgress', key).then(function (rec) {
      if (rec) return rec;
      return defaultTopicProgress(EST.profile.get(), topicId);
    });
  }

  function saveTopicProgress(tp) {
    tp.updatedAt = Date.now();
    return EST.store.put('topicProgress', tp);
  }

  /* ---- 進級判定（§1.2） ---------------------------------------------------
     最低回数と達成条件の両方を満たすと進める。進級は強制しない。 */
  function canAdvance(tp) {
    var st = tp.stage;
    var reps = (tp.stageReps && tp.stageReps[st]) || 0;
    if (reps < minReps(st)) return false;

    if (st === 'S1') return true;                       // 3回聞けば進める
    if (st === 'S2' || st === 'S4') return tp.streak >= STREAK_NEEDED;
    if (st === 'S3') {
      // 0.9（最後の係数）で3回連続できたら進級条件を満たす
      return tp.s3FactorIndex >= S3_TIME_FACTORS.length - 1 && tp.s3Streak >= STREAK_NEEDED;
    }
    return false;
  }

  function nextStage(st) {
    var i = STAGES.indexOf(st);
    return (i >= 0 && i < STAGES.length - 1) ? STAGES[i + 1] : null;
  }

  function advance(tp) {
    var nx = nextStage(tp.stage);
    if (!nx) return tp;
    tp.stage = nx;
    tp.streak = 0;
    tp.s3FactorIndex = 0;
    tp.s3Streak = 0;
    return tp;
  }

  function currentS3Factor(tp) {
    return S3_TIME_FACTORS[Math.min(tp.s3FactorIndex, S3_TIME_FACTORS.length - 1)];
  }

  /* ---- 1回ぶんの結果を記録する ---------------------------------------------
     result: { ok, spokenMs, latencyMs, stalls, withinTime }
     ok は §2.3 の判定結果。withinTime は S3 の目標時間内に読めたか。 */
  function recordRep(tp, lineId, topicId, result) {
    var st = tp.stage;
    tp.stageReps = tp.stageReps || {};
    tp.stageReps[st] = (tp.stageReps[st] || 0) + 1;

    if (st === 'S2' || st === 'S4') {
      tp.streak = result.ok ? (tp.streak + 1) : 0;
    } else if (st === 'S3') {
      // §1.2 目標時間内に詰まりなく読み切るのを3回連続
      var good = result.ok && result.withinTime && !(result.stalls && result.stalls.length);
      if (good) {
        tp.s3Streak++;
        if (tp.s3Streak >= STREAK_NEEDED && tp.s3FactorIndex < S3_TIME_FACTORS.length - 1) {
          tp.s3FactorIndex++;
          tp.s3Streak = 0;   // 次の係数で改めて3回連続を数える
        }
      } else {
        tp.s3Streak = 0;
      }
      tp.streak = good ? (tp.streak + 1) : 0;
    } else if (st === 'S1') {
      tp.streak = tp.stageReps.S1;   // S1は聞くだけなので実施回数がそのまま
    }
    return tp;
  }

  /* ---- Progress（§5.5）の更新 ---------------------------------------------
     行ごとの累計回数・レイテンシ・詰まりを記録する。 */
  function recordLineProgress(topicId, lineId, stage, result) {
    var key = EST.store.progressKey(topicId, lineId);
    return EST.store.get('progress', key).then(function (rec) {
      var p = rec || EST.schema.defaultProgress(EST.profile.get(), topicId, lineId);
      p.counts = p.counts || { total: 0, byStage: {} };
      if (result.ok) {
        p.counts.total = (p.counts.total || 0) + 1;
        p.counts.byStage[stage] = (p.counts.byStage[stage] || 0) + 1;
      }
      if (result.latencyMs != null) {
        p.latency = p.latency || { history: [], median5: null, best: null };
        p.latency.history = (p.latency.history || []).concat([result.latencyMs]).slice(-20);
        p.latency.median5 = EST.mic.medianOfLastN(p.latency.history, 5);
        p.latency.best = p.latency.history.reduce(function (a, b) { return Math.min(a, b); }, Infinity);
      }
      if (result.stalls && result.stalls.length) {
        p.stalls = (p.stalls || 0) + result.stalls.length;
      }
      p.updatedAt = Date.now();
      return EST.store.put('progress', p).then(function () { return p; });
    });
  }

  // 「今のはナシ」（§2.4）。直前の1回ぶんを巻き戻す。
  function undoLineProgress(topicId, lineId, stage, result) {
    var key = EST.store.progressKey(topicId, lineId);
    return EST.store.get('progress', key).then(function (p) {
      if (!p) return null;
      if (result.ok) {
        p.counts.total = Math.max(0, (p.counts.total || 0) - 1);
        p.counts.byStage[stage] = Math.max(0, (p.counts.byStage[stage] || 0) - 1);
      }
      if (result.latencyMs != null && p.latency && p.latency.history.length) {
        p.latency.history = p.latency.history.slice(0, -1);
        p.latency.median5 = EST.mic.medianOfLastN(p.latency.history, 5);
        p.latency.best = p.latency.history.length
          ? p.latency.history.reduce(function (a, b) { return Math.min(a, b); }, Infinity) : null;
      }
      if (result.stalls && result.stalls.length) {
        p.stalls = Math.max(0, (p.stalls || 0) - result.stalls.length);
      }
      p.updatedAt = Date.now();
      return EST.store.put('progress', p).then(function () { return p; });
    });
  }

  /* ---- ブロック（§1.5） ---------------------------------------------------
     13行以上のときだけUIにブロックの概念が出る。12行以下は
     1トピック＝1ブロック扱いで、ブロックという言葉を出さない。 */
  function blocksOf(topic) {
    var blocks = topic.blocks || [];
    if (!blocks.length) return [{ id: 'all', label: '', from: null, to: null }];
    return blocks;
  }

  function usesBlocks(topic) {
    return (topic.blocks || []).length > 1;
  }

  function linesOfBlock(topic, blockIndex) {
    var all = (topic.lines || []).filter(function (l) { return !l.skip && String(l.en || '').trim(); });
    if (!usesBlocks(topic)) return all;
    var b = (topic.blocks || [])[blockIndex];
    if (!b) return all;
    var fromIdx = -1, toIdx = -1;
    all.forEach(function (l, i) {
      if (l.id === b.from) fromIdx = i;
      if (l.id === b.to) toIdx = i;
    });
    if (fromIdx < 0) fromIdx = 0;
    if (toIdx < 0) toIdx = all.length - 1;
    return all.slice(fromIdx, toIdx + 1);
  }

  EST.stage = {
    STAGES: STAGES,
    STAGE_LABELS: STAGE_LABELS,
    IMPLEMENTED: IMPLEMENTED,
    S3_TIME_FACTORS: S3_TIME_FACTORS,
    STREAK_NEEDED: STREAK_NEEDED,
    COUNT_RATIO_DEFAULT: COUNT_RATIO_DEFAULT,
    TTS_CLOSE_DELAY_MS: TTS_CLOSE_DELAY_MS,
    MASTERY_BASE_MS: MASTERY_BASE_MS,
    MASTERY_PER_WORD_MS: MASTERY_PER_WORD_MS,

    stageLabel: stageLabel,
    stageMode: stageMode,
    minReps: minReps,
    judgeCount: judgeCount,

    defaultTopicProgress: defaultTopicProgress,
    loadTopicProgress: loadTopicProgress,
    saveTopicProgress: saveTopicProgress,

    canAdvance: canAdvance,
    nextStage: nextStage,
    advance: advance,
    currentS3Factor: currentS3Factor,
    recordRep: recordRep,
    recordLineProgress: recordLineProgress,
    undoLineProgress: undoLineProgress,

    blocksOf: blocksOf,
    usesBlocks: usesBlocks,
    linesOfBlock: linesOfBlock
  };
})(window.EST = window.EST || {});
