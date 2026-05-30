#!/bin/bash
# launchd plist を配置してジョブを登録する
# 実行: bash scripts/install-launchd.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PLIST_NAME="com.reline.hpb-automation.plist"
PLIST_SRC="$PROJECT_DIR/launchd/$PLIST_NAME"
PLIST_DST="$HOME/Library/LaunchAgents/$PLIST_NAME"

echo ""
echo "==================================="
echo " launchd ジョブ登録"
echo "==================================="
echo "作業ディレクトリ: $PROJECT_DIR"
echo ""

# Node.js パスを確認
NODE_PATH=$(which node)
echo "Node.js: $NODE_PATH"

# plistを作業ディレクトリ、node pathで書き換えてコピー
sed \
  -e "s|WORKING_DIR_PLACEHOLDER|$PROJECT_DIR|g" \
  -e "s|/usr/local/bin/node|$NODE_PATH|g" \
  "$PLIST_SRC" > "$PLIST_DST"

echo "✅ plistをコピーしました: $PLIST_DST"

# 既存ジョブのアンロード（失敗してもOK）
launchctl unload "$PLIST_DST" 2>/dev/null || true

# ロード
launchctl load "$PLIST_DST"
echo "✅ launchd ジョブを登録しました"

echo ""
echo "登録内容:"
launchctl list | grep reline || echo "(まだ未実行)"
echo ""
echo "毎朝8:00に自動実行されます。"
echo ""
echo "手動でテスト実行する場合:"
echo "  launchctl start com.reline.hpb-automation"
echo ""
echo "ジョブを停止する場合:"
echo "  launchctl unload ~/Library/LaunchAgents/$PLIST_NAME"
