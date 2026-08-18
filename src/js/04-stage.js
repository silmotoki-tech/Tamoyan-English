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
  var MIN_REPS = { S1: 3, S2: 10, S3: 15, S4: 15, S5: 10, S6: 10 };
  // §1.2 S2・S4 は「カウント成立が3回連続」、S3 は「各係数で3回連続」
  var STREAK_NEEDED = 3;
  // §1.2 S3 の目標時間の係数。各係数で3回連続成功したら次の段階へ。
  var S3_TIME_FACTORS = [1.3, 1.15, 1.0, 0.9];
  // §2.6 TTSが鳴るステージで、再生終了から回を閉じるまでの猶予
  var TTS_CLOSE_DELAY_MS = 800;
  // §1.4 で使う定着閾値の係数（F7で使う。ここでは持つだけ）
  var MASTERY_BASE_MS = 1200;
  var MASTERY_PER_WORD_MS = 60;
  // §1.9 F8: レイテンシ推移グラフの点の上限。超えたら間引いて分解能を半分にする。
  var LATENCY_TREND_MAX = 120;
  // §1.9 F8: 日次ログ（sessions）の保持日数。習慣グラフとして持つには十分な長さ。
  var SESSION_LOG_MAX_DAYS = 120;
  // §1.9 F8: 継続日数の判定で「今日はまだやっていない」を切らさないための猶予。
  // 昨日までの記録が続いていれば、今日やる前でも継続日数を保つ。
  var STREAK_GRACE_DAYS = 1;

  var STAGES = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'];
  var STAGE_LABELS = {
    S1: 'S1 聞いてなぞる',
    S2: 'S2 重ねて読む',
    S3: 'S3 見て読む',
    S4: 'S4 影を追う',
    S5: 'S5 和訳から出す',
    S6: 'S6 相手に返す'
  };
  var IMPLEMENTED = { S1: true, S2: true, S3: true, S4: true, S5: true, S6: true };

  // §2.6 ステージごとのTTS・マイクの扱い
  var STAGE_MODE = {
    S1: { tts: true,  mic: false, showEn: true,  showJa: true,  timeBar: false },
    S2: { tts: true,  mic: true,  showEn: true,  showJa: false, timeBar: false },
    S3: { tts: false, mic: true,  showEn: true,  showJa: false, timeBar: true },
    S4: { tts: true,  mic: true,  showEn: false, showJa: false, timeBar: false },
    // §1.1 S5・S6 は自分の役だけをシャッフルして出す。
    // §2.6 S5 はTTSが鳴らない。S6 は相手の台詞だけ鳴らし、
    // 相手の台詞が終わってから測定を開始する。
    S5: { tts: false, mic: true,  showEn: false, showJa: true,  timeBar: false, shuffled: true, myRoleOnly: true },
    S6: { tts: true,  mic: true,  showEn: false, showJa: false, timeBar: false, shuffled: true, myRoleOnly: true, cueIsPartner: true }
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
      // §5.6 ステージはブロックごとに独立して進む
      currentBlockId: null,
      blocks: {},             // { b1: { stage:'S1', done:false } }
      // §5.6 S5・S6 のみ役に依存する。S1〜S4 は両役を音読するので共通。
      byRole: {},             // { S2: { blocks: { b1: 'S6' } } }
      // §5.6 いま演じている役。Topic.myRole は書き換えない（配信で戻される）
      activeRole: null,
      fullRun: { unlocked: false, stage: null },   // §1.5 通しモード
      roleSwapOffered: false, // §1.1 役交代の提案は S6 完了ごとに1回だけ
      streak: 0,              // 連続でカウント成立した回数
      s3FactorIndex: 0,       // §1.2 S3 の係数段階
      s3Streak: 0,            // 現在の係数での連続成功数
      stageReps: {},          // ステージごとの実施回数（S1は再生回数）
      laps: { total: 0, byStage: {} },
      sessions: [],
      // §1.6 F6: S0（語彙の下ごしらえ）を済ませたか。
      s0: { done: false, doneAt: null },
      // §1.9 F8: 可視化。latencyTrend は間引いて保持するので、x軸（累計回数）は
      // 配列の長さに頼らずこのカウンタで別に持つ。
      repLatencyCount: 0,
      latencyTrend: [],
      updatedAt: 0
    };
  }

  // F5 で作った旧形式（stage / blockIndex を直に持つ）を §5.6 の形に移す。
  // 既存の進捗を壊さないための処理で、変換済みなら何もしない。
  function migrateTopicProgress(tp, topic) {
    if (!tp) return tp;
    if (!tp.blocks) tp.blocks = {};
    if (!tp.byRole) tp.byRole = {};
    if (!tp.fullRun) tp.fullRun = { unlocked: false, stage: null };
    if (tp.activeRole === undefined) tp.activeRole = null;
    if (tp.roleSwapOffered === undefined) tp.roleSwapOffered = false;
    if (!tp.s0) tp.s0 = { done: false, doneAt: null };   // F6より前に作られた進捗を補う
    // F8より前に作られた進捗を補う
    if (!tp.sessions) tp.sessions = [];
    if (!tp.latencyTrend) tp.latencyTrend = [];
    if (tp.repLatencyCount == null) tp.repLatencyCount = 0;

    // 旧形式の stage / blockIndex を blocks[] へ移す
    if (tp.stage && !Object.keys(tp.blocks).length) {
      var blocks = blocksOf(topic);
      var idx = tp.blockIndex || 0;
      var bid = (blocks[idx] && blocks[idx].id) || 'all';
      tp.blocks[bid] = { stage: tp.stage, done: false };
      tp.currentBlockId = bid;
    }
    if (!tp.currentBlockId) {
      var bs = blocksOf(topic);
      tp.currentBlockId = (bs[0] && bs[0].id) || 'all';
    }
    if (!tp.blocks[tp.currentBlockId]) {
      tp.blocks[tp.currentBlockId] = { stage: 'S1', done: false };
    }
    // 旧フィールドは残しておく（読み手が無くなるまで壊さない）
    return tp;
  }

  function loadTopicProgress(topicId, topic) {
    var key = EST.store.topicProgressKey(topicId);
    return EST.store.get('topicProgress', key).then(function (rec) {
      var tp = rec || defaultTopicProgress(EST.profile.get(), topicId);
      return topic ? migrateTopicProgress(tp, topic) : tp;
    });
  }

  /* ---- 役（§5.6） ---------------------------------------------------------
     Topic.myRole は配信で配られる初期値で、読むだけ。書き込むのは
     TopicProgress.activeRole。書き戻すと次の配信で役が勝手に戻り、
     audience:"both" の台本では相手の役まで変わる。 */
  /* 現在ブロックのステージ。§5.6 の blocks[] を読む窓口。
     S5・S6 は役ごとに分かれるので、役の進捗があればそちらを優先する。 */
  function currentStage(tp, topic) {
    var bid = tp.currentBlockId;
    if (!bid || !tp.blocks || !tp.blocks[bid]) return 'S1';
    var st = tp.blocks[bid].stage || 'S1';
    if (st === 'S5' || st === 'S6') {
      var role = activeRole(tp, topic);
      var rs = roleStage(tp, role, bid);
      if (rs) return rs;
    }
    return st;
  }

  function setCurrentStage(tp, topic, stage) {
    var bid = tp.currentBlockId;
    if (!bid) return tp;
    tp.blocks = tp.blocks || {};
    tp.blocks[bid] = tp.blocks[bid] || { stage: 'S1', done: false };
    tp.blocks[bid].stage = stage;
    // §5.6 S5・S6 は役ごとにも記録する
    if (stage === 'S5' || stage === 'S6') {
      setRoleStage(tp, activeRole(tp, topic), bid, stage);
    }
    return tp;
  }

  function activeRole(tp, topic) {
    if (tp && tp.activeRole) return tp.activeRole;
    return (topic && topic.myRole) || null;
  }

  function otherRole(topic, role) {
    var ids = (topic.speakers || []).map(function (s) { return s.id; });
    var hit = null;
    ids.forEach(function (id) { if (id !== role && !hit) hit = id; });
    return hit;
  }

  // §5.6 S5・S6 のステージは役ごとに持つ
  function roleStage(tp, role, blockId) {
    var r = tp.byRole && tp.byRole[role];
    return (r && r.blocks && r.blocks[blockId]) || null;
  }

  function setRoleStage(tp, role, blockId, stage) {
    tp.byRole = tp.byRole || {};
    tp.byRole[role] = tp.byRole[role] || { blocks: {} };
    tp.byRole[role].blocks = tp.byRole[role].blocks || {};
    tp.byRole[role].blocks[blockId] = stage;
    return tp;
  }

  function saveTopicProgress(tp) {
    tp.updatedAt = Date.now();
    return EST.store.put('topicProgress', tp);
  }

  /* ---- S0 下ごしらえ（§1.6。F6） -------------------------------------
     §8「そのトピックで S0 が未完了なら、最初に語彙の下ごしらえへ回す」。
     語彙が1つも無い台本ではそもそも下ごしらえる対象が無いので、
     未完了のままでも回さない（s0.done を立てなくても素通りしてよい）。 */
  function s0Needed(tp, topic) {
    if (!topic || !(topic.words || []).length) return false;
    return !(tp && tp.s0 && tp.s0.done);
  }

  function markS0Done(tp) {
    tp.s0 = { done: true, doneAt: Date.now() };
    return tp;
  }

  /* ---- 可視化のための記録（§1.9。F8） -------------------------------------
     ここで作るデータはすべて「今は貯まっていない」もの。表示側（新設の
     進捗画面）はここが書いたものを読むだけにする。 */

  // ローカル日付（"YYYY-MM-DD"）。日次ログは「その人の1日」で数えたいので
  // toISOString（UTC）は使わない。深夜0時をまたぐタイミングの誤差は許容する。
  function localDateStr(d) {
    d = d || new Date();
    var y = d.getFullYear(), m = d.getMonth() + 1, day = d.getDate();
    return y + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day;
  }

  // レイテンシ推移グラフの1点を足す。横軸は「間引いても狂わない」よう
  // 専用のカウンタ（repLatencyCount）を別に持ち、配列の長さには頼らない。
  function recordLatencyTrend(tp, latencyMs) {
    if (latencyMs == null) return tp;
    tp.repLatencyCount = (tp.repLatencyCount || 0) + 1;
    tp.latencyTrend = (tp.latencyTrend || []).concat([{ totalCount: tp.repLatencyCount, avgMs: latencyMs }]);
    // 上限を超えたら1つおきに間引いて分解能を半分にする（グラフの形はほぼ保たれる）
    if (tp.latencyTrend.length > LATENCY_TREND_MAX) {
      tp.latencyTrend = tp.latencyTrend.filter(function (_, i) { return i % 2 === 0; });
    }
    return tp;
  }

  // 日次ログ（sessions）。周回数はラップが確定するたびに、分数はセッションを
  // 終えるときにそれぞれ加算する（呼び出し側が該当するほうだけ渡せばよい）。
  function logSessionActivity(tp, delta) {
    delta = delta || {};
    var today = localDateStr();
    var list = tp.sessions || [];
    var last = list[list.length - 1];
    var entry = (last && last.date === today) ? last : null;
    if (!entry) {
      entry = { date: today, laps: 0, minutes: 0 };
      list.push(entry);
      if (list.length > SESSION_LOG_MAX_DAYS) list = list.slice(-SESSION_LOG_MAX_DAYS);
    }
    if (delta.laps) entry.laps = (entry.laps || 0) + delta.laps;
    if (delta.minutes) entry.minutes = Math.round(((entry.minutes || 0) + delta.minutes) * 10) / 10;
    tp.sessions = list;
    return tp;
  }

  // 継続日数。sessions は都度計算の元データとしてだけ使い、値そのものは
  // 保存しない（保存すると sessions との整合を別途取る羽目になる）。
  // 今日の分がまだ無くても、昨日までが続いていれば継続扱いにする
  // （STREAK_GRACE_DAYS）。そうしないと、今日やる前の時点で毎日0に見えてしまう。
  function currentStreak(tp) {
    var dates = {};
    (tp.sessions || []).forEach(function (s) { if (s && s.date) dates[s.date] = true; });
    var cursor = new Date();
    var n = 0, graceLeft = STREAK_GRACE_DAYS;
    for (;;) {
      var key = localDateStr(cursor);
      if (dates[key]) {
        n++;
      } else if (graceLeft > 0 && n === 0) {
        graceLeft--;   // 今日（まだ）分だけ待つ。1日で使い切る
      } else {
        break;
      }
      cursor.setDate(cursor.getDate() - 1);
    }
    return n;
  }

  // よく詰まるチャンクの集計（§1.8）。stall の elapsedMs から、その文の
  // チャンクのどれで詰まったかを推定して積む。厳密な推定ではないので、
  // 「よく引っかかる構文に気づく」きっかけ程度に使う。
  function recordChunkStalls(topicId, line, stalls, expectedMs) {
    if (!line || !line.chunks || !line.chunks.length || !stalls || !stalls.length || !expectedMs) return Promise.resolve();
    var chain = Promise.resolve();
    stalls.forEach(function (st) {
      var text = EST.mic.estimateStallChunk(line.chunks, st && st.elapsedMs, expectedMs);
      if (!text) return;
      chain = chain.then(function () { return EST.store.recordChunkStall(text, topicId, line.id); });
    });
    return chain;
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
    // §1.2 S5・S6 は「全行が定着基準を満たす」。判定は非同期なので
    // canAdvanceMastery() を使う。ここでは false を返す。
    return false;
  }

  // §1.2 S5・S6 用。全行が定着したかを見る（非同期）。
  function canAdvanceMastery(tp, topic, lines, role) {
    var st = tp.blocks && tp.currentBlockId && tp.blocks[tp.currentBlockId]
      ? tp.blocks[tp.currentBlockId].stage : null;
    if (st !== 'S5' && st !== 'S6') return Promise.resolve(false);
    var reps = (tp.stageReps && tp.stageReps[st]) || 0;
    if (reps < minReps(st)) return Promise.resolve(false);
    return allMastered(topic, lines, role);
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
    // §1.9 F8: レイテンシ推移グラフ用。ステージを問わず、測れた回はすべて拾う。
    recordLatencyTrend(tp, result.latencyMs);
    return tp;
  }

  /* ---- Progress（§5.5）の更新 ---------------------------------------------
     行ごとの累計回数・レイテンシ・詰まりを記録する。 */
  function recordLineProgress(topicId, lineId, stage, result, line, opts) {
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
      // §1.4 定着判定は「直近3回に詰まりが無いこと」を見るので、
      // 回ごとの詰まり件数を並びとして持っておく（合計値では判定できない）。
      p.recentStalls = (p.recentStalls || []).concat([(result.stalls || []).length]).slice(-10);

      // §9.4 書くレーンで落とした行は次の音読セッションで優先出題する。
      // 音読レーンに出た時点（＝ここ）で役目を終えるので下ろす。
      if (p.needsAudioReview) p.needsAudioReview = false;

      // §1.4 定着はシャッフル状態（S5以降）での測定でのみ判定する
      if (opts && opts.shuffled && line) {
        if (!p.mastered && EST.mastery.isMastered(p, line.en, { shuffled: true })) {
          EST.mastery.markMastered(p);
        }
      }
      p.updatedAt = Date.now();
      // §1.8 F8: よく詰まるチャンクの集計。expectedMs が無いと位置を推定できない
      // ステージ（S3など、opts側で渡していない場合）は静かにスキップする。
      if (opts && opts.expectedMs) {
        // 集計に失敗しても本筋の進捗記録は止めない（診断用のおまけデータのため）
        recordChunkStalls(topicId, line, result.stalls, opts.expectedMs).catch(function (e) {
          console.warn('[stage] チャンク詰まりの集計に失敗しました', e);
        });
      }
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

  /* ---- 書くレーンの結果を記録する（§9.4） ----------------------------------
     同じ Progress に書き込み、counts.total は加算される。ただし byStage・
     latency は音読レーン専用のままにし、判定（mastered）はここでは一切
     動かさない（書くレーンで満点でも定着にはしない）。
     lane: 'essay'（和文英訳） | 'dictation'（ディクテーション）
     opts.replays: ディクテーションの再生回数（「3回以内で書けた率」の元データ） */
  function recordWritingResult(topicId, lineId, lane, passed, opts) {
    opts = opts || {};
    var key = EST.store.progressKey(topicId, lineId);
    return EST.store.get('progress', key).then(function (rec) {
      var p = rec || EST.schema.defaultProgress(EST.profile.get(), topicId, lineId);
      p.counts = p.counts || { total: 0, byStage: {} };
      p.counts.total = (p.counts.total || 0) + 1;
      p.writing = p.writing || { essayAttempts: 0, essayCorrect: 0, dictationAttempts: 0, dictationCorrect: 0, dictationReplayHistory: [] };
      if (lane === 'dictation') {
        p.writing.dictationAttempts = (p.writing.dictationAttempts || 0) + 1;
        if (passed) p.writing.dictationCorrect = (p.writing.dictationCorrect || 0) + 1;
        if (opts.replays != null) {
          p.writing.dictationReplayHistory = (p.writing.dictationReplayHistory || []).concat([opts.replays]).slice(-20);
        }
      } else {
        p.writing.essayAttempts = (p.writing.essayAttempts || 0) + 1;
        if (passed) p.writing.essayCorrect = (p.writing.essayCorrect || 0) + 1;
      }
      // §9.4 落としたら次の音読セッションで優先出題。合格しても、音読で
      // 確認できたわけではないのでフラグはここでは下ろさない。
      if (!passed) p.needsAudioReview = true;
      p.updatedAt = Date.now();
      return EST.store.put('progress', p).then(function () { return p; });
    });
  }

  // 「3回以内で書けた率」（§9.2）。トピック全体で集計する。
  function within3Rate(recs) {
    var hist = [];
    (recs || []).forEach(function (p) {
      ((p && p.writing && p.writing.dictationReplayHistory) || []).forEach(function (n) { hist.push(n); });
    });
    if (!hist.length) return null;
    var within3 = hist.filter(function (n) { return n <= 3; }).length;
    return { within3: within3, total: hist.length };
  }

  // §9.4 書くレーンで落とした行をキューの先頭に寄せる（S5/S6のみ。
  // S1〜S4は「順」で読む規則があるので触らない＝§1.3参照）。
  function applyWritingPriority(queue, topicId) {
    if (!queue || !queue.length) return Promise.resolve(queue);
    return Promise.all(queue.map(function (it) {
      return EST.store.get('progress', EST.store.progressKey(topicId, it.line.id));
    })).then(function (recs) {
      var flagged = [], rest = [];
      queue.forEach(function (it, i) {
        (recs[i] && recs[i].needsAudioReview ? flagged : rest).push(it);
      });
      return flagged.length ? flagged.concat(rest) : queue;
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

  // その行がどのブロックに属するか（F6の再確認ランナーが使う）。
  // ブロックを使わない台本は先頭ブロックの id をそのまま返す。
  function blockIdOfLine(topic, lineId) {
    var blocks = blocksOf(topic);
    if (!usesBlocks(topic)) return blocks[0].id;
    var all = (topic.lines || []).filter(function (l) { return !l.skip && String(l.en || '').trim(); });
    var idx = -1;
    all.forEach(function (l, i) { if (l.id === lineId) idx = i; });
    if (idx < 0) return blocks[0].id;
    var found = blocks[0].id;
    blocks.forEach(function (b) {
      var fromIdx = -1, toIdx = -1;
      all.forEach(function (l, i) {
        if (l.id === b.from) fromIdx = i;
        if (l.id === b.to) toIdx = i;
      });
      if (fromIdx < 0) fromIdx = 0;
      if (toIdx < 0) toIdx = all.length - 1;
      if (idx >= fromIdx && idx <= toIdx) found = b.id;
    });
    return found;
  }

  /* ---- シャッフル（§1.3） -------------------------------------------------
     完全ランダムではなく、直前に出たものが連続しないようにする程度の制約。 */
  function shuffle(items, lastKey, keyOf) {
    var arr = items.slice();
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    // 直前に出たものが先頭に来たら、2番目と入れ替える
    if (lastKey && arr.length > 1 && keyOf(arr[0]) === lastKey) {
      var tmp = arr[0]; arr[0] = arr[1]; arr[1] = tmp;
    }
    return arr;
  }

  /* ---- S5 の出題（§1.1）--------------------------------------------------
     自分の役の行だけを、和訳をキューにして出す。 */
  function s5Items(topic, lines, role) {
    return lines.filter(function (l) { return l.speakerId === role; })
      .map(function (l) { return { kind: 'line', line: l, cueJa: l.ja || '' }; });
  }

  /* ---- S6 の組（§1.3）----------------------------------------------------
     行ではなく「相手の台詞＋自分の返し」の組をシャッフルする。行だけを
     ばらすと、どの台詞に返しているのか分からなくなる。

     組の作り方:
       自分の台詞について、その直前にある相手の台詞を探して対にする
       直前も自分の台詞なら、さらに前へ遡って最初に見つかる相手の台詞を使う
       1行目が自分の台詞なら相手の台詞が無いので、和訳をキューにする（S5と同じ形）
  --------------------------------------------------------------------- */
  function s6Pairs(topic, lines, role) {
    var out = [];
    lines.forEach(function (l, i) {
      if (l.speakerId !== role) return;
      var cue = null;
      for (var j = i - 1; j >= 0; j--) {
        if (lines[j].speakerId !== role) { cue = lines[j]; break; }
      }
      out.push(cue
        ? { kind: 'pair', line: l, cueLine: cue }
        // 相手の台詞が見つからない（台本の頭が自分の台詞）→ S5と同じ形にする
        : { kind: 'line', line: l, cueJa: l.ja || '' });
    });
    return out;
  }

  // ステージに応じた出題の並び。S5・S6 は必ずシャッフルする（§1.3）
  function buildQueue(stage, topic, lines, role, lastKey) {
    var items = (stage === 'S6') ? s6Pairs(topic, lines, role) : s5Items(topic, lines, role);
    return shuffle(items, lastKey, function (it) { return it.line.id; });
  }

  /* ---- S5・S6 の進級（§1.2） ----------------------------------------------
     「全行が定着基準を満たす」。S5・S6 は自分の役だけを扱うので、
     判定の対象もそのブロックの自分の役の行に限る。 */
  function allMastered(topic, lines, role) {
    var targets = lines.filter(function (l) { return l.speakerId === role; });
    if (!targets.length) return Promise.resolve(false);
    return Promise.all(targets.map(function (l) {
      return EST.store.get('progress', EST.store.progressKey(topic.id, l.id));
    })).then(function (recs) {
      return recs.every(function (p) { return p && p.mastered; });
    });
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
    migrateTopicProgress: migrateTopicProgress,
    loadTopicProgress: loadTopicProgress,
    saveTopicProgress: saveTopicProgress,
    currentStage: currentStage,
    setCurrentStage: setCurrentStage,
    activeRole: activeRole,
    otherRole: otherRole,
    roleStage: roleStage,
    setRoleStage: setRoleStage,
    s0Needed: s0Needed,
    markS0Done: markS0Done,
    logSessionActivity: logSessionActivity,
    currentStreak: currentStreak,
    localDateStr: localDateStr,
    shuffle: shuffle,
    s5Items: s5Items,
    s6Pairs: s6Pairs,
    buildQueue: buildQueue,
    allMastered: allMastered,

    canAdvance: canAdvance,
    canAdvanceMastery: canAdvanceMastery,
    nextStage: nextStage,
    advance: advance,
    currentS3Factor: currentS3Factor,
    recordRep: recordRep,
    recordLineProgress: recordLineProgress,
    undoLineProgress: undoLineProgress,
    recordWritingResult: recordWritingResult,
    within3Rate: within3Rate,
    applyWritingPriority: applyWritingPriority,

    blocksOf: blocksOf,
    usesBlocks: usesBlocks,
    linesOfBlock: linesOfBlock,
    blockIdOfLine: blockIdOfLine
  };
})(window.EST = window.EST || {});
