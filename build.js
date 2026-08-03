#!/usr/bin/env node
/* =====================================================================
   build.js — src/ を dist/trainer.html 1枚に結合する
   Node の標準ライブラリだけを使う（npm パッケージは足さない）。
   使い方:  node build.js
   ===================================================================== */
'use strict';

var fs = require('fs');
var path = require('path');

var ROOT    = __dirname;
var SRC     = path.join(ROOT, 'src');
var JS_DIR  = path.join(SRC, 'js');
var DOCS    = path.join(ROOT, 'docs');
// GitHub Pages はリポジトリ直下の index.html をそのまま公開する（SPEC §6.5 / §10.4）。
// data/scripts.json は運用データなので、このスクリプトからは一切触らない。
var OUT     = path.join(ROOT, 'index.html');

// 付録B: 短い台本と長い台本の両方を必ず内蔵する
var SAMPLE_FILES = ['sample-topic.json', 'sample-topic-simcard.json'];

function read(p) { return fs.readFileSync(p, 'utf8'); }

// </script> がJS文字列やコメントに現れるとHTMLが途中で切れるので必ず割る
function safeForScript(s) { return s.replace(/<\/script/gi, '<\\/script'); }

function collectJs() {
  if (!fs.existsSync(JS_DIR)) throw new Error('src/js がありません');
  return fs.readdirSync(JS_DIR)
    .filter(function (f) { return /\.js$/i.test(f); })
    .sort()                                   // ファイル名の番号順に結合する
    .map(function (f) {
      return {
        name: f,
        code: read(path.join(JS_DIR, f)).replace(/^﻿/, '')
      };
    });
}

function collectSamples() {
  var out = [];
  SAMPLE_FILES.forEach(function (f) {
    var p = path.join(DOCS, f);
    if (!fs.existsSync(p)) {
      console.warn('  ! サンプルが見つかりません: docs/' + f);
      return;
    }
    try {
      out.push(JSON.parse(read(p)));
    } catch (e) {
      console.warn('  ! サンプルのJSONが壊れています: docs/' + f + ' — ' + e.message);
    }
  });
  return out;
}

function build() {
  var html = read(path.join(SRC, 'index.html'));
  var css = read(path.join(SRC, 'styles.css'));
  var files = collectJs();
  var samples = collectSamples();

  var styleTag = '<style>\n' + css + '\n</style>';

  var samplesTag = '<script>\n' +
    'window.EST = window.EST || {};\n' +
    'window.EST.SAMPLES = ' + safeForScript(JSON.stringify(samples)) + ';\n' +
    '</script>';

  var scriptTag = files.map(function (f) {
    return '<script>\n/* ---- ' + f.name + ' ---- */\n' + safeForScript(f.code) + '\n</script>';
  }).join('\n');

  var out = html
    .replace('<!--STYLES-->', function () { return styleTag; })
    .replace('<!--SAMPLES-->', function () { return samplesTag; })
    .replace('<!--SCRIPTS-->', function () { return scriptTag; });

  if (out.indexOf('<!--SCRIPTS-->') >= 0 || out === html) {
    throw new Error('src/index.html に差し込み位置のコメントが見つかりません');
  }

  fs.writeFileSync(OUT, out, 'utf8');

  console.log('index.html を生成しました');
  files.forEach(function (f) {
    console.log('  + src/js/' + f.name + '  (' + f.code.length.toLocaleString() + ' 文字)');
  });
  console.log('  + サンプル台本 ' + samples.length + '本');
  console.log('  合計 ' + (out.length / 1024).toFixed(1) + ' KB');

  // 外部CDNを踏んでいないことを機械的に確かめる（SPEC §12「外部CDNを参照しない」）
  var ext = out.match(/(?:src|href)\s*=\s*["']https?:\/\/[^"']+/gi);
  if (ext) {
    console.warn('  ! 外部参照が残っています:');
    ext.forEach(function (e) { console.warn('    ' + e); });
    process.exitCode = 1;
  }
}

try {
  build();
} catch (e) {
  console.error('ビルドに失敗しました: ' + e.message);
  process.exit(1);
}
