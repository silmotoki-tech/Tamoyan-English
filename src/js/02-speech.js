/* =====================================================================
   02-speech.js — 音声エンジンの抽象化と内蔵TTS（SPEC §7.1 / §7.2 / §7.5）

   UIコードは内蔵／外部の別を一切意識しない（§7.1）。この層が窓口になり、
   中でエンジンを差し替える。F3 では内蔵（Web Speech API）だけを登録する。
   外部TTS（§7.3）は engines に1つ足すだけで載る形にしてある。
   ===================================================================== */
;(function (EST) {
  'use strict';

  /* ---- 調整用の定数（実機で必ず調整する。SPEC §12） ------------------ */
  var VOICE_RETRY_MS   = 200;    // §7.2 voices の非同期ロード。リトライ間隔
  var VOICE_RETRY_MAX  = 3;      // 同上。リトライ回数
  var KEEPALIVE_MS     = 10000;  // §7.2 Chromeは15秒以上で止まる。10秒ごとに突く
  var TIMEOUT_FACTOR   = 2;      // §7.2 end が来ない場合の保険。想定所要の何倍で打ち切るか
  var TIMEOUT_MIN_MS   = 3000;   // 短文で早すぎる打ち切りをしないための下限
  var WORD_MS          = 400;    // §2.3 内蔵TTS想定の1語あたり（タイムアウト見積り用）
  var PITCH_SHIFT      = 0.15;   // §7.2 片方の性別しか取れないときのpitchのずらし幅
  var PITCH_MIN        = 0.5;
  var PITCH_MAX        = 1.5;
  var RATE_STEPS       = [0.7, 0.85, 1.0, 1.15, 1.3];  // §7.5 速度の5段
  var RATE_MIN         = 0.5;
  var RATE_MAX         = 2.0;
  var DEFAULT_RATE     = 0.85;   // §5.7 ttsRate の既定（§7.5 の5段階に含まれる値）

  // §7.2 英語ボイスの優先語
  var PREFERRED = ['google', 'samantha', 'ava', 'natural', 'enhanced'];

  // ボイス名からの性別推定（§7.2）。端末ごとに品揃えが違うので、
  // 当たらなくても止まらないように「推定できなければ不明」で通す。
  var FEMALE_HINTS = ['samantha', 'karen', 'moira', 'tessa', 'fiona', 'victoria', 'ava',
    'allison', 'susan', 'zira', 'hazel', 'serena', 'kate', 'catherine', 'nicky', 'joanna',
    'salli', 'kimberly', 'amy', 'emma', 'aria', 'jenny', 'michelle', 'sonia', 'libby',
    'natasha', 'clara', 'nova', 'shelley', 'veena', 'rishi female'];
  var MALE_HINTS = ['alex', 'daniel', 'fred', 'tom', 'aaron', 'arthur', 'oliver', 'rishi',
    'david', 'mark', 'george', 'ryan', 'guy', 'nathan', 'matthew', 'brian', 'justin',
    'joey', 'eric', 'christopher', 'roger', 'steffan', 'thomas', 'william', 'liam',
    'gordon', 'reed', 'albert', 'junior'];

  // 実測長は audio ストアに置く（§5.8 の6ストアから増やさない）。
  // audio は §5.9 で「共有・端末内で再生成できる」扱いなので、
  // 端末とボイスに依存する実測長の置き場所として性質が一致する。
  var DUR_PREFIX = 'dur|';

  /* ---- 状態 ------------------------------------------------------------ */
  var voicesCache = null;      // SpeechSynthesisVoice[]（生）
  var voicesPromise = null;
  var auto = { female: null, male: null, any: null };  // 自動割り当ての結果
  var manual = { female: null, male: null, def: null };// 設定での手動指定（voiceId）
  var currentRate = DEFAULT_RATE;
  var currentEngine = 'local'; // §5.7 engine。F3 では local だけを登録する
  var current = null;          // 再生中のutteranceと後始末
  var unlocked = false;        // iOSの解錠済みか

  function syn() { return self.speechSynthesis; }

  /* =====================================================================
     内蔵エンジン（Web Speech API）
     ===================================================================== */
  var localEngine = {
    name: 'local',

    isAvailable: function () {
      return !!(self.speechSynthesis && self.SpeechSynthesisUtterance);
    },

    // §7.1 事前生成は外部TTSのみ意味を持つ。内蔵では何もしないで即座に返す。
    prepare: function () { return Promise.resolve(null); },

    speak: function (text, opts) {
      return loadVoices().then(function () {
        return new Promise(function (resolve) {
          stopCurrent();

          var rate = clampRate(opts.rate != null ? opts.rate : currentRate);
          var pick = resolveVoice(opts);
          var u = new SpeechSynthesisUtterance(text);
          if (pick.voice) { u.voice = pick.voice; u.lang = pick.voice.lang || 'en-US'; }
          else { u.lang = 'en-US'; }
          u.rate = rate;
          u.pitch = pick.pitch;
          u.volume = opts.volume == null ? 1 : opts.volume;

          var t0 = 0, done = false, keepTimer = null, failTimer = null;

          function finish(ok) {
            if (done) return;
            done = true;
            if (keepTimer) clearInterval(keepTimer);
            if (failTimer) clearTimeout(failTimer);
            if (current && current.finish === finish) current = null;
            var ms = t0 ? (Date.now() - t0) : 0;
            // §2.3 実測長は測ったときの rate と一緒に保存する。
            // あとで速度を変えたら 実測Ms × 測定時のrate ÷ 新しいrate で補正できる。
            if (ok && ms > 0 && opts.topicId && opts.lineId) {
              saveDuration(opts.topicId, opts.lineId, ms, rate, pick.id);
            }
            resolve({ durationMs: ms, rate: rate, voiceId: pick.id, pitch: pick.pitch, spoken: !!ok });
          }

          u.onstart = function () {
            t0 = Date.now();
            // §7.2 Chromeは15秒以上の連続発話で止まる。10秒ごとに pause→resume で突く。
            keepTimer = setInterval(function () {
              try {
                if (syn() && syn().speaking) { syn().pause(); syn().resume(); }
              } catch (e) { /* 対応していない端末は放っておく */ }
            }, KEEPALIVE_MS);
          };
          u.onend = function () { finish(true); };
          u.onerror = function () { finish(false); };

          // §7.2 end が来ない端末があるので、想定所要の2倍で打ち切る
          var expect = estimateMs(text, rate);
          failTimer = setTimeout(function () {
            try { syn().cancel(); } catch (e) {}
            finish(t0 > 0);
          }, Math.max(TIMEOUT_MIN_MS, expect * TIMEOUT_FACTOR));

          current = { finish: finish };
          try { syn().speak(u); } catch (e) { finish(false); }
        });
      });
    }
  };

  var engines = { local: localEngine };

  // §7.1 いまのエンジンを返す。未実装のエンジンが指定されていたら黙って内蔵に落とす。
  function engine() {
    return engines[currentEngine] || engines.local;
  }

  /* =====================================================================
     ボイスの読み込みと選択（§7.2）
     ===================================================================== */
  function loadVoices() {
    if (voicesCache && voicesCache.length) return Promise.resolve(voicesCache);
    if (voicesPromise) return voicesPromise;

    voicesPromise = new Promise(function (resolve) {
      if (!localEngine.isAvailable()) { voicesCache = []; resolve([]); return; }

      var tries = 0;
      function attempt() {
        var list = [];
        try { list = syn().getVoices() || []; } catch (e) { list = []; }
        if (list.length) { setVoices(list); resolve(voicesCache); return; }
        // §7.2 getVoices() は初回空配列。200msのリトライを3回。
        if (tries++ >= VOICE_RETRY_MAX) { voicesCache = []; resolve([]); return; }
        setTimeout(attempt, VOICE_RETRY_MS);
      }

      // voiceschanged が遅れて来る端末があるので、来たら取り込み直す
      try {
        syn().addEventListener('voiceschanged', function () {
          var list = [];
          try { list = syn().getVoices() || []; } catch (e) { list = []; }
          if (list.length) setVoices(list);
        });
      } catch (e) {}

      attempt();
    });
    return voicesPromise;
  }

  function setVoices(list) {
    voicesCache = list;
    assignByGender();
  }

  function isEnglish(v) { return /^en(-|_|$)/i.test(v.lang || ''); }

  // §7.2 の優先語を含むものを先に持ってくる
  function englishVoices() {
    var list = (voicesCache || []).filter(isEnglish);
    return list.slice().sort(function (a, b) {
      return prefScore(b) - prefScore(a);
    });
  }

  function prefScore(v) {
    var n = (v.name || '').toLowerCase();
    for (var i = 0; i < PREFERRED.length; i++) {
      if (n.indexOf(PREFERRED[i]) >= 0) return PREFERRED.length - i;
    }
    return 0;
  }

  function voiceId(v) { return v ? (v.voiceURI || v.name) : null; }

  function byId(id) {
    if (!id) return null;
    var hit = null;
    (voicesCache || []).forEach(function (v) { if (!hit && voiceId(v) === id) hit = v; });
    return hit;
  }

  // 名前・voiceURI から男女を推定する。分からなければ ''。
  function guessGender(v) {
    if (!v) return '';
    var s = ((v.name || '') + ' ' + (v.voiceURI || '')).toLowerCase();
    // "female" は "male" を含むので先に見る
    if (s.indexOf('female') >= 0) return 'female';
    if (s.indexOf('male') >= 0) return 'male';
    var i;
    for (i = 0; i < FEMALE_HINTS.length; i++) if (s.indexOf(FEMALE_HINTS[i]) >= 0) return 'female';
    for (i = 0; i < MALE_HINTS.length; i++) if (s.indexOf(MALE_HINTS[i]) >= 0) return 'male';
    return '';
  }

  // §7.2 手順1〜2: 優先順に並べ、gender ごとに1つずつ確保する
  function assignByGender() {
    var list = englishVoices();
    auto = { female: null, male: null, any: list[0] || null };
    list.forEach(function (v) {
      var g = guessGender(v);
      if (g === 'female' && !auto.female) auto.female = v;
      if (g === 'male' && !auto.male) auto.male = v;
    });
  }

  /* 話者に割り当てるボイスとpitchを決める（§7.2）。
     取れなかったときは静かに劣化させ、機能は止めない。 */
  function resolveVoice(opts) {
    opts = opts || {};
    var gender = (opts.gender === 'female' || opts.gender === 'male') ? opts.gender : '';
    var base = byId(manual.def) || auto.any;

    // 呼び出し側が明示したボイスが最優先（設定画面の試聴など）
    if (opts.voiceId) {
      var forced = byId(opts.voiceId);
      if (forced) return { voice: forced, pitch: clampPitch(opts.pitch == null ? 1 : opts.pitch), id: voiceId(forced) };
    }
    // 設定画面で手動指定されていればそれに従う
    if (gender && manual[gender]) {
      var mv = byId(manual[gender]);
      if (mv) return { voice: mv, pitch: 1, id: voiceId(mv) };
    }
    // 性別が分からない話者は既定ボイスのまま
    if (!gender) return { voice: base, pitch: 1, id: voiceId(base) };

    // 手順2: 男女とも確保できている
    if (auto.female && auto.male) {
      var av = auto[gender];
      return { voice: av, pitch: 1, id: voiceId(av) };
    }
    // 手順3: 片方しか取れない → 同じボイスで pitch を ±0.15 ずらして区別する。
    // 英語ボイスが1つも無い端末（voiceは未指定でブラウザ任せ）でも pitch は効くので、
    // ここで諦めずにずらす。手順4の「同じ声で通す」は、
    // 必要な性別のボイスがちょうど取れているときだけ。
    var have = auto.female ? 'female' : (auto.male ? 'male' : '');
    var only = auto.female || auto.male || base;   // null でも構わない
    if (have === gender && only) {
      return { voice: only, pitch: 1, id: voiceId(only) };
    }
    var pitch = 1 + (gender === 'female' ? PITCH_SHIFT : -PITCH_SHIFT);
    return { voice: only, pitch: clampPitch(pitch), id: voiceId(only), degraded: true };
  }

  /* =====================================================================
     実測長の保存（§2.3）
     ===================================================================== */
  function durKey(topicId, lineId) { return DUR_PREFIX + topicId + '|' + lineId; }

  function saveDuration(topicId, lineId, ms, rate, vid) {
    return EST.store.put('audio', {
      key: durKey(topicId, lineId),
      kind: 'duration',
      topicId: topicId,
      lineId: lineId,
      ms: ms,
      rate: rate,          // 測ったときの速度。F4・F5 がこれで補正する
      voiceId: vid,
      at: Date.now()
    }).catch(function (e) {
      // 測れなくても再生自体は成立しているので、黙って諦める
      console.warn('[speech] 実測長を保存できませんでした', e);
    });
  }

  function getDuration(topicId, lineId) {
    return EST.store.get('audio', durKey(topicId, lineId)).then(function (r) {
      return (r && r.kind === 'duration') ? r : null;
    }).catch(function () { return null; });
  }

  // 語数からの概算（§2.3 の代用式）。タイムアウト計算にも使う。
  function estimateMs(text, rate) {
    var words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
    return words * WORD_MS / clampRate(rate || currentRate);
  }

  // §2.3（v3.0）カウント判定に使う expectedMs。実測があれば内蔵TTSでもそれを使う。
  // 実測は測定時のrateと一緒に保存してあるので、いまのrateとの比で補正する。
  // F3では返すところまでだった実測値を、F4（カウント判定）で初めて消費する。
  function expectedMsFor(topicId, lineId, text, rate) {
    var r = clampRate(rate || currentRate);
    return getDuration(topicId, lineId).then(function (rec) {
      if (rec && rec.ms > 0 && rec.rate > 0) return rec.ms * rec.rate / r;
      return estimateMs(text, r);
    });
  }

  /* =====================================================================
     公開インターフェース（§7.1）
     ===================================================================== */
  function isAvailable() { return engine().isAvailable(); }

  function prepare(text, opts) { return engine().prepare(text, opts || {}); }

  function speak(text, opts) {
    opts = opts || {};
    var t = String(text == null ? '' : text).trim();
    if (!t || !isAvailable()) return Promise.resolve({ durationMs: 0, spoken: false });
    return engine().speak(t, opts);
  }

  function stopCurrent() {
    var c = current;
    current = null;
    if (c && c.finish) c.finish(false);
    try { if (syn()) syn().cancel(); } catch (e) {}
  }

  function cancel() { stopCurrent(); }

  function isSpeaking() {
    try { return !!(syn() && (syn().speaking || syn().pending)); } catch (e) { return false; }
  }

  function setRate(r) { currentRate = clampRate(r); }
  function getRate() { return currentRate; }

  // UIが SpeechSynthesisVoice を直接触らないように整えて返す
  function getVoices() {
    return loadVoices().then(function () {
      return englishVoices().map(function (v) {
        return { id: voiceId(v), name: v.name, lang: v.lang, gender: guessGender(v) };
      });
    });
  }

  // 設定を反映する。起動時と設定変更時に呼ぶ。
  function applySettings(s) {
    if (!s) return;
    currentEngine = engines[s.engine] ? s.engine : 'local';
    if (s.ttsRate != null) currentRate = clampRate(s.ttsRate);
    manual.def = s.localVoiceEn || null;
    var g = s.localVoiceByGender || {};
    manual.female = g.female || null;
    manual.male = g.male || null;
  }

  // §7.2 iOS Safari は最初の発話をユーザージェスチャの同期処理内で行う必要がある。
  // 起動後の最初のタップで無音のUtteranceを鳴らして解錠する。
  function unlock() {
    if (unlocked || !isAvailable()) return;
    unlocked = true;
    try {
      var u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      syn().speak(u);
    } catch (e) { /* 解錠できなくても以降の再生は試みる */ }
  }

  function clampRate(r) {
    r = Number(r);
    if (!isFinite(r) || r <= 0) return DEFAULT_RATE;
    return Math.min(RATE_MAX, Math.max(RATE_MIN, r));
  }
  function clampPitch(p) {
    p = Number(p);
    if (!isFinite(p)) return 1;
    return Math.min(PITCH_MAX, Math.max(PITCH_MIN, p));
  }

  EST.speech = {
    RATE_STEPS: RATE_STEPS,
    // §7.1 のインターフェース
    prepare: prepare,
    speak: speak,
    cancel: cancel,
    setRate: setRate,
    isAvailable: isAvailable,
    getVoices: getVoices,
    // 補助
    getRate: getRate,
    isSpeaking: isSpeaking,
    applySettings: applySettings,
    unlock: unlock,
    getDuration: getDuration,
    estimateMs: estimateMs,
    expectedMsFor: expectedMsFor,
    resolveVoiceFor: function (gender) { return resolveVoice({ gender: gender }); }
  };
})(window.EST = window.EST || {});
