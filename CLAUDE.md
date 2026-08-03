# english-script-trainer

英会話台本を反射的に口から出る状態まで持っていくための個人用トレーニングアプリ。
仕様は `docs/SPEC.md` にある。実装前に必ず該当フェーズの節を読むこと。

## 進め方

- 実装は `docs/SPEC.md` の §11 実装フェーズ（F1〜F10）の順に進める
- **1回の依頼で1フェーズだけ実装する。** 指示されていない先のフェーズには手を出さない
- 各フェーズの終わりで必ず単体で動く状態にする
- 実装前に何を作るかを一度示すこと（勝手に大量のファイルを作らない）

## 技術方針（守ること）

- 素のHTML + CSS + JavaScript（ES2020）。フレームワーク・ビルドツール・パッケージ依存なし
- **外部CDNを一切参照しない。** 全部インラインで自己完結させる
- ESモジュール（import/export）は使わない。最終的に1ファイルへ結合するため
- グローバル変数を作らない。すべて `window.EST` 名前空間の下にぶら下げる
- データ保存は IndexedDB。`localStorage` は設定のミラーにのみ使ってよい
- 音声Blobを扱うので、保存先を localStorage にしない

## ファイル構成

```
docs/SPEC.md          仕様書（触らない）
src/index.html        シェル
src/styles.css
src/js/00-store.js    IndexedDBラッパ
src/js/01-schema.js   スキーマ検証・正規化・台本パーサ
src/js/02-speech.js   音声エンジン抽象化（内蔵TTS）
src/js/03-mic.js      音量検知エンジン
src/js/04-stage.js    ステージ進行
src/js/05-mastery.js  定着判定
src/js/1x-ui-*.js     各画面
src/js/99-main.js     起動・ルーティング
build.js              src/ を dist/trainer.html に結合（Node、依存ゼロ）
dist/trainer.html     成果物。これ1枚で動く
```

ファイルは番号順に結合される。新しいファイルを足すときは番号を振ること。

## コーディング規約

- UIの文言（ラベル・ボタン・エラー）はすべて日本語
- コメントも日本語。特に「なぜそうしたか」を残す
- 調整が必要な閾値・係数は**すべてファイル先頭の定数にまとめる**（実機で必ず調整する）
- 英文表示は `-apple-system, "Segoe UI", Roboto`、日本語は `"Hiragino Sans", "Noto Sans JP"` とフォントを分ける
- 音声・マイク系の失敗はダイアログを出さず、機能を隠すか静かにフォールバックする
- `EST.mic` はUIから独立させ、コンソールから `EST.mic.start()` で単体確認できる形にする

## やってはいけないこと

- npm パッケージの追加
- React / Vue / TypeScript の導入
- 仕様書に書かれていない機能の先回り実装
- `docs/SPEC.md` の書き換え（仕様変更が必要なら理由を説明して確認を取る）

## 動作確認

```
node build.js          # dist/trainer.html を生成
```

生成後、`dist/trainer.html` をブラウザで開いて確認する。
マイクを使う機能は `file://` では動かないので、確認時は簡易サーバを立てる。

```
npx serve dist         # または python -m http.server
```
