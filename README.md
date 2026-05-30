# リライン HPB集客自動化システム

ホットペッパービューティー「リライン（ReLINE）」の集客を全自動化するエージェントシステムです。

## 構成

| エージェント | 役割 | スケジュール |
|---|---|---|
| ReviewWatcher | HPBの新着口コミ検知 | 毎朝 |
| SafetyClassifier | 口コミのリスク分類 | 毎朝 |
| ReplyDrafter | 武田代表ペルソナで返信文生成 | 毎朝 |
| ReplyPoster | サロンボードへ実投稿 | 毎朝 |
| BlogIdeator | ブログテーマ選定 | 月・水・金 |
| BlogWriter | ブログ本文執筆（1,200〜1,800字） | 月・水・金 |
| BlogPoster | サロンボードのブログへ投稿 | 月・水・金 |
| CompetitorScraper | 米子市内競合10店のデータ収集 | 月曜 |
| RankWatcher | HPB検索順位の確認 | 月曜 |
| WeeklyReporter | 週次KPIレポート生成・LINE送信 | 月曜 |

## 初回セットアップ

### 1. 認証情報の登録（Keychain）

```bash
bash scripts/setup-keychain.sh
```

以下の情報が必要です：
- サロンボードのログインID・パスワード
- Anthropic APIキー（https://console.anthropic.com/settings/keys）
- LINEチャネルアクセストークン（LINE Developersコンソール）
- 武田さん個人のLINE ユーザーID

### 2. 依存パッケージのインストール

```bash
npm install
npx playwright install chromium
```

### 3. ビルドとDB初期化

```bash
npm run build
npm run db:init
```

### 4. LINE通知のテスト

```bash
bash scripts/test-line.sh
```

### 5. ドライランで動作確認（1週間推奨）

`config/salon.yaml` の `posting.dry_run: true` になっていることを確認してから：

```bash
npm run dry-run
```

口コミ返信のドラフトと生成内容がLINEに届きます。品質を確認してください。

### 6. 本番モードへの切り替え

`config/salon.yaml` の `dry_run: false` に変更後：

```bash
npm run build
```

### 7. launchd 登録（毎朝8時の自動実行）

```bash
bash scripts/install-launchd.sh
```

## 日常運用

### 毎朝8:30頃、LINEに届くサマリー例

```
☀ リライン 自動化システム
─────────────────
2026年5月24日(金) の実行結果

口コミ:
  新着 1件
  自動返信済み 1件
ブログ: 投稿完了
エラー: 0件
```

### 承認待ちの口コミ（⚠️）

リスクありの口コミにはドラフトと一緒に通知が届きます。
内容を確認し、問題なければサロンボードから直接投稿してください。

### 危険な口コミ（🚨）

法的示唆・身体被害の主張など危険と判定された口コミは、返信を行わず即時アラートします。
武田さんが直接対応してください。

## 設定ファイル

| ファイル | 内容 |
|---|---|
| `config/salon.yaml` | 店舗情報・投稿設定・安全設定 |
| `config/competitors.yaml` | 競合店リスト |
| `config/keywords.yaml` | 順位監視キーワード |
| `config/schedule.yaml` | 実行スケジュール |
| `prompts/persona_takeda.md` | 武田代表のペルソナ定義（要チューニング）|

## トラブルシューティング

### サロンボードへのログインが失敗する場合

1. `data/cookies.json` を削除してキャッシュをクリア
2. `npm run dry-run -- --agents=reviewWatcher` でテスト
3. サロンボードのパスワードが変わっていないか確認
4. 再設定: `bash scripts/setup-keychain.sh`

### LINE通知が届かない場合

1. `bash scripts/test-line.sh` を実行
2. LINEチャネルアクセストークン・ユーザーIDを確認
3. LINE Messaging APIの送信上限（月500通）を確認

### ビルドエラーが出る場合

```bash
npm install
npm run build 2>&1 | head -50
```

## ファイル構成

```
.
├── src/
│   ├── orchestrator.ts       # メインエントリポイント
│   ├── agents/               # 各エージェント実装
│   └── lib/                  # 共通ライブラリ
├── prompts/                  # AIプロンプト（Markdown）
├── config/                   # 設定ファイル（YAML）
├── data/                     # SQLiteデータベース（自動生成）
├── logs/                     # 実行ログ（自動生成）
└── reports/                  # 週次HTMLレポート（自動生成）
```

---

**重要**: サロンボードの利用規約上、ブラウザ自動化の可否をリクルート社の担当者に事前確認することを推奨します。
