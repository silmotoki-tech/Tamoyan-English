#!/usr/bin/env node
/* =====================================================================
   publish.js — data/topics/*.json をまとめて data/scripts.json を作る
   SPEC §6.5。Node の標準ライブラリだけを使う（npm パッケージは足さない）。

   使い方:  node publish.js

   台本を足す作業を「ファイルを1つ置く」だけにするためのスクリプト。
   ここが重くなると台本が増えず、台本が増えなければこのアプリは使われない。
   ===================================================================== */
'use strict';

var fs = require('fs');
var path = require('path');

var ROOT = __dirname;
var TOPICS_DIR = path.join(ROOT, 'data', 'topics');
var OUT = path.join(ROOT, 'data', 'scripts.json');

// §5.1 誰の課題か
var AUDIENCES = ['tamo', 'mari', 'both'];

function read(p) { return fs.readFileSync(p, 'utf8'); }

/* ---- 検証（§6.3 の表）--------------------------------------------------
   エラーは全部まとめて返す。1件ずつ直させない。 */
function validateTopic(t, file, seenTopicIds, seenLineIds) {
  var errors = [];
  var where = path.basename(file);

  if (!t || typeof t !== 'object' || Array.isArray(t)) {
    return [where + ': トピックのオブジェクトとして読めません'];
  }

  // title
  if (!String(t.title == null ? '' : t.title).trim()) {
    errors.push(where + ': title が空です');
  }

  // id — ファイルをまたいだ重複を検査する。被ると進捗が混線する。
  var id = String(t.id == null ? '' : t.id).trim();
  if (!id) {
    errors.push(where + ': id がありません');
  } else if (seenTopicIds[id]) {
    errors.push(where + ': topic.id が ' + path.basename(seenTopicIds[id]) + ' と重複しています（' + id + '）');
  }

  // audience
  if (t.audience != null && AUDIENCES.indexOf(String(t.audience)) < 0) {
    errors.push(where + ': audience の値が不正です（' + t.audience + '）。' + AUDIENCES.join(' / ') + ' のいずれかにしてください');
  }

  // speakers[].id の重複
  var speakerIds = {};
  var speakers = Array.isArray(t.speakers) ? t.speakers : [];
  if (!speakers.length) {
    errors.push(where + ': speakers がありません');
  }
  speakers.forEach(function (s, i) {
    var sid = s && s.id != null ? String(s.id) : '';
    if (!sid) { errors.push(where + ': speakers[' + i + '].id がありません'); return; }
    if (speakerIds[sid]) errors.push(where + ': speakers[].id が重複しています（' + sid + '）');
    speakerIds[sid] = true;
  });

  // myRole
  var myRole = t.myRole != null ? String(t.myRole) : '';
  if (!myRole) {
    errors.push(where + ': myRole がありません（S5/S6 に必須）');
  } else if (speakers.length && !speakerIds[myRole]) {
    errors.push(where + ': myRole が speakers に無いidを指しています（' + myRole + '）');
  }

  // lines
  var lines = Array.isArray(t.lines) ? t.lines : [];
  if (!lines.length) {
    errors.push(where + ': lines が空です');
  }
  lines.forEach(function (l, i) {
    var at = where + ': lines[' + i + ']';
    if (!l || typeof l !== 'object') { errors.push(at + ' がオブジェクトではありません'); return; }

    var en = String(l.en == null ? '' : l.en).trim();
    if (!en) errors.push(at + '.en が空です');
    else if (!/[A-Za-z]/.test(en)) errors.push(at + '.en に英字が含まれていません');

    // lines[].id — こちらもファイルをまたいで検査する
    var lid = l.id != null ? String(l.id).trim() : '';
    if (!lid) {
      errors.push(at + '.id がありません（一度振ったidは変えない規則なので必須）');
    } else {
      // §5.5 の進捗キーは profileId|topicId|lineId なので、行idは
      // topic.id と組にして初めて一意になる。別トピックで同じ ln_001 を
      // 使うのは正常（同梱サンプル2本もそうなっている）。
      // したがって検査するのは「同じトピック内での重複」と、
      // topic.id が被った結果として起きる衝突。
      var key = id + '|' + lid;
      if (seenLineIds[key]) {
        errors.push(at + '.id が同じトピック内で重複しています（' + lid + '）');
      } else {
        seenLineIds[key] = where;
      }
    }

    if (l.speakerId != null && speakers.length && !speakerIds[String(l.speakerId)]) {
      errors.push(at + '.speakerId が speakers に無いidを指しています（' + l.speakerId + '）');
    }
  });

  if (id && !seenTopicIds[id]) seenTopicIds[id] = file;
  return errors;
}

/* ---- 内容の比較 ---------------------------------------------------------
   §6.5 内容が前回と同じなら publishedAt を据え置く。毎回更新すると、
   中身が変わっていないのに「台本を更新しました」が出続けて信用されなくなる。 */
function sameTopics(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function main() {
  if (!fs.existsSync(TOPICS_DIR)) {
    console.error('data/topics/ がありません。台本を置いてから実行してください。');
    process.exit(1);
  }

  var files = fs.readdirSync(TOPICS_DIR)
    .filter(function (f) { return /\.json$/i.test(f); })
    .sort()
    .map(function (f) { return path.join(TOPICS_DIR, f); });

  if (!files.length) {
    console.error('data/topics/ に .json がありません。');
    process.exit(1);
  }

  var errors = [];
  var topics = [];
  var seenTopicIds = {};
  var seenLineIds = {};

  files.forEach(function (file) {
    var raw;
    try {
      raw = read(file);
    } catch (e) {
      errors.push(path.basename(file) + ': 読み込めません（' + e.message + '）');
      return;
    }
    var parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      // 「不正なJSON」だけ出さない。位置を添える。
      var m = /position\s+(\d+)/i.exec(e.message);
      var where = '';
      if (m) {
        var before = raw.slice(0, Number(m[1]));
        where = '（' + before.split('\n').length + '行目あたり）';
      }
      errors.push(path.basename(file) + ': JSONとして読めません' + where + ' — ' + e.message);
      return;
    }
    if (Array.isArray(parsed)) {
      errors.push(path.basename(file) + ': 配列ではなく1本のトピックを入れてください');
      return;
    }

    var errs = validateTopic(parsed, file, seenTopicIds, seenLineIds);
    if (errs.length) { errors = errors.concat(errs); return; }
    topics.push(parsed);
  });

  // §6.5 1件でもエラーがあれば scripts.json を書かずに終了する。
  // 壊れたファイル1つで配信全体を落とさない。
  if (errors.length) {
    console.error('配信を中止しました。' + errors.length + '件のエラーがあります。\n');
    errors.forEach(function (e) { console.error('  - ' + e); });
    console.error('\ndata/scripts.json は変更していません。');
    process.exit(1);
  }

  // 前回の内容と比べる
  var prev = null;
  if (fs.existsSync(OUT)) {
    try { prev = JSON.parse(read(OUT)); } catch (e) { prev = null; }
  }

  var publishedAt;
  if (prev && Array.isArray(prev.topics) && sameTopics(prev.topics, topics) && prev.publishedAt) {
    publishedAt = prev.publishedAt;
    console.log('内容に変更がないので publishedAt を据え置きます。');
  } else {
    publishedAt = Date.now();
  }

  var out = { publishedAt: publishedAt, topics: topics };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n', 'utf8');

  console.log('data/scripts.json を生成しました');
  console.log('  publishedAt: ' + publishedAt + '（' + new Date(publishedAt).toISOString() + '）');
  console.log('  台本 ' + topics.length + '本');
  topics.forEach(function (t) {
    console.log('    - ' + t.id + ' | ' + (t.audience || '(未指定→both扱い)') +
                ' | ' + (t.lines || []).length + '行 | ' + t.title);
  });
}

try {
  main();
} catch (e) {
  console.error('配信に失敗しました: ' + e.message);
  process.exit(1);
}
