#!/bin/bash
# LINE通知のテスト送信
# 実行: bash scripts/test-line.sh

cd "$(dirname "${BASH_SOURCE[0]}")/.."
npm run build 2>/dev/null || true
node -e "
const { notify } = require('./dist/lib/line.js');
notify('info', 'テスト通知です。リライン HPB自動化システムが正常に設定されています！').then(() => {
  console.log('✅ LINE通知を送信しました');
}).catch(err => {
  console.error('❌ 送信失敗:', err.message);
  process.exit(1);
});
"
