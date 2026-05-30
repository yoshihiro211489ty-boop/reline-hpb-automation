#!/bin/bash
# リライン HPB自動化 Keychain初期設定スクリプト
# 実行: bash scripts/setup-keychain.sh

set -e

echo ""
echo "==================================="
echo " リライン HPB自動化 初期設定"
echo "==================================="
echo "各項目を入力してください。"
echo "入力した内容はmacOS Keychainに安全に保存されます。"
echo ""

read_secret() {
  local prompt="$1"
  local var_name="$2"
  echo -n "$prompt"
  read -rs val
  echo ""
  eval "$var_name='$val'"
}

read_normal() {
  local prompt="$1"
  local var_name="$2"
  echo -n "$prompt"
  read -r val
  eval "$var_name='$val'"
}

# サロンボード
echo "--- サロンボード (https://salonboard.com) ---"
read_normal "ログインID: " SALONBOARD_USER
read_secret "パスワード: " SALONBOARD_PASS

# Anthropic API キー
echo ""
echo "--- Anthropic API ---"
echo "APIキーは https://console.anthropic.com/settings/keys から取得できます"
read_secret "Anthropic APIキー (sk-ant-...): " ANTHROPIC_API_KEY

# LINE Messaging API
echo ""
echo "--- LINE Messaging API ---"
echo "LINE Developersコンソール (https://developers.line.biz) でチャネルを作成し"
echo "「Messaging API設定」からチャネルアクセストークンを取得してください"
read_secret "LINEチャネルアクセストークン: " LINE_CHANNEL_TOKEN

echo ""
echo "次に、通知の送り先（武田さん個人のLINE ユーザーID）を設定します。"
echo "取得方法: LINE Developersコンソール > Messaging API > Webhook URL に"
echo "テストメッセージを送ると userId が取得できます"
echo "(または https://api.line.me/v2/profile を叩く)"
read_normal "LINE ユーザーID (Uxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx): " LINE_USER_ID

# HPB Salon ID
echo ""
echo "--- HPB設定 ---"
HPB_SALON_ID="H000804013"
echo "HPBサロンID: $HPB_SALON_ID (自動設定)"

# Keychainに保存
echo ""
echo "Keychainに保存中..."

save_keychain() {
  local service="$1"
  local account="$2"
  local password="$3"
  security add-generic-password -s "$service" -a "$account" -p "$password" -U 2>/dev/null || \
  security delete-generic-password -s "$service" -a "$account" 2>/dev/null && \
  security add-generic-password -s "$service" -a "$account" -p "$password"
}

save_keychain "reline-salonboard" "salonboard-user" "$SALONBOARD_USER"
save_keychain "reline-salonboard" "salonboard-pass" "$SALONBOARD_PASS"
save_keychain "reline-anthropic"  "api-key"          "$ANTHROPIC_API_KEY"
save_keychain "reline-line"       "channel-access-token" "$LINE_CHANNEL_TOKEN"
save_keychain "reline-line"       "target-user-id"   "$LINE_USER_ID"
save_keychain "reline-hpb"        "salon-id"         "$HPB_SALON_ID"

echo ""
echo "✅ Keychainへの保存が完了しました！"
echo ""
echo "次のステップ:"
echo "  1. npm install"
echo "  2. npx playwright install chromium"
echo "  3. npm run build"
echo "  4. npm run db:init"
echo "  5. npm run dry-run     ← まず1週間はドライランで品質確認"
echo "  6. launchd登録: bash scripts/install-launchd.sh"
echo ""
