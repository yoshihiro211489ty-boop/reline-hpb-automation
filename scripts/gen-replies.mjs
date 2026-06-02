#!/usr/bin/env node
/**
 * gen-replies.mjs
 * Google ビジネスプロフィール口コミ返信文生成スクリプト
 * Anthropic API (claude-opus-4-7) を使用
 */

import Anthropic from "@anthropic-ai/sdk";
import { execSync } from "child_process";

// ── APIキー取得 ────────────────────────────────────────────────
let apiKey;
try {
  apiKey = execSync(
    "security find-generic-password -s reline-anthropic -a api-key -w",
    { encoding: "utf8" }
  ).trim();
} catch {
  console.error("Keychain から API キーを取得できませんでした。");
  process.exit(1);
}

const client = new Anthropic({ apiKey });

// ── ペルソナ (persona_takeda.md の要約) ────────────────────────
const TAKEDA_PERSONA = `
あなたは「リライン（ReLINE）」の代表・武田嘉浩として口コミに返信します。

【プロフィール】
- 国家資格「柔道整復師」、累計施術実績7万回以上
- 「何度『揉む』より一度『整える』」が哲学
- iPad視覚化診断・卒業ロードマップ・完全個室が特徴

【声のトーン】
- 一人称：「私」、相手：「〇〇さま」「お客様」
- 国家資格者としての専門性と落ち着き
- 米子の地域密着感（親しみやすく、軽くない）
- 「揉む整体」と一線を画す矜持

【必ず1つ盛り込む要素（毎回ローテーション）】
- 「整える」というキーワード
- iPad視覚化診断への言及
- 「卒業」という表現
- 完全個室・プライバシーへの言及

【専門用語】解剖学用語は1つだけ使い、直後に平易な言い換えを置く

【絶対に使わない表現】
- 「治る」「治癒」「治療」「治療効果保証」「完治」「再発しない」
- 「またのご来店心よりお待ちしております」
- 他店比較・誇大表現

【文末スタイル】
- 断定と柔らかい問いかけを混ぜる
- 一文40〜60字・複数文で積み上げる
- 絵文字最大1個、「！」最大2個

【署名】返信末尾に必ず「たけだ整骨院 院長 武田嘉浩」
`.trim();

const ROOTS_PERSONA = `
あなたはパーソナルジムRootsのスタッフとして口コミに返信します。

【スタイル】
- 丁寧で温かみのある文体
- 治療効果の約束・保証は一切しない
- 施術後の感想への共感と次回来店の布石
- 絵文字最大1個、「！」最大2個

【構成】御礼→引用共感→専門性への言及→次回の布石

【署名】返信末尾に必ず「パーソナルジムRoots スタッフ一同」
`.trim();

// ── 口コミデータ ───────────────────────────────────────────────
const reviews = [
  {
    index: 1,
    store: "たけだ整骨院｜むちうち・交通事故治療",
    author: "m k",
    content:
      "肩こりからくる頭痛がつらくて通院しています。施術後は肩が軽くなり、頭痛も以前より気にならなくなりました。夜遅くまで営業しているので仕事帰りに通いやすく、保険適用がある点も助かっています。さらに、自宅でできるストレッチやセルフケアの方法も教えてくださるので、日常的なケアにも役立っています。",
    stars: 5,
    type: "seikotsu",
  },
  {
    index: 2,
    store: "たけだ整骨院 安来院",
    author: "山岡良子",
    content:
      "急遽の予約でしたが対応してもらえてありがたかったです。処置も丁寧にしてくださりよかったです。また、通わせていただきたいと思います。",
    stars: 5,
    type: "seikotsu",
  },
  {
    index: 3,
    store: "たけだ整骨院｜むちうち・交通事故治療",
    author: "しらす\"だいこん\"おろし",
    content:
      "いつも息子がお世話になっています。腰の調子も良くなり、その都度状態に合った施術をしてくださいます。",
    stars: 5,
    type: "seikotsu",
  },
  {
    index: 4,
    store: "たけだ整骨院｜むちうち・交通事故治療",
    author: "藤本舞衣子",
    content:
      "知り合いの紹介で1年前から通い始めましたが、先生もとても親切で痛みも軽減するのでこれからもお世話になります。テーピングのやり方や家でのストレッチ方法も教えてくださるので、スポーツしてる子にはオススメです。",
    stars: 5,
    type: "seikotsu",
  },
  {
    index: 5,
    store: "たけだ整骨院 安来院",
    author: "北川",
    content:
      "マッサージと水素をした翌日に痛みが和らぎました。スタッフの方も優しく話しやすかったです。",
    stars: 5,
    type: "seikotsu",
  },
  {
    index: 6,
    store: "たけだ整骨院 安来院",
    author: "tossy nozalin",
    content: "劇的に良くなりました！ありがとうございました。",
    stars: 5,
    type: "seikotsu",
  },
  {
    index: 7,
    store: "パーソナルジムRoots",
    author: "小前裕之",
    content:
      "全身脱毛をやってもらいました。レーザーを当てる時にかなり身構えてましたが痛みが全くと言っていいほど無く、とても快適でした！",
    stars: 5,
    type: "roots",
  },
  {
    index: 8,
    store: "パーソナルジムRoots",
    author: "m k",
    content:
      "初めて全身脱毛とBBL光フェイシャルを受けました。痛みや熱さもなく、安心して施術を受けられました。担当の方も丁寧で、施術後は肌がすべすべになり大満足です。",
    stars: 5,
    type: "roots",
  },
  {
    index: 9,
    store: "パーソナルジムRoots",
    author: "千代華歩",
    content:
      "全く痛くない脱毛でした。今日照射したばかりなので効果はまだわからないですが、経過がとても楽しみです。対応もとても丁寧にしていただきありがとうございました。また機会があれば利用したいと思います。",
    stars: 5,
    type: "roots",
  },
  {
    index: 10,
    store: "パーソナルジムRoots",
    author: "田村純麗",
    content: "プライベートな空間で心地よいサロンさんです！",
    stars: 5,
    type: "roots",
  },
];

// ── 返信生成ルール ─────────────────────────────────────────────
// ペルソナローテーション要素
const ROTATION_ELEMENTS = [
  "「整える」というキーワードを自然に含める（揉むではなく整える、という哲学）",
  "iPad視覚化診断への言及（データで見る・数値で確認する、という表現）",
  "「卒業」という表現（依存させない・自立した身体づくり）",
  "完全個室・プライバシーへの言及",
];

/**
 * 1件の口コミに対して返信を生成する
 */
async function generateReply(review, rotationIndex) {
  const isSeikotsu = review.type === "seikotsu";
  const persona = isSeikotsu ? TAKEDA_PERSONA : ROOTS_PERSONA;
  const rotationHint = isSeikotsu
    ? `\n【今回必ず盛り込む要素】${ROTATION_ELEMENTS[rotationIndex % 4]}`
    : "";

  const systemPrompt = `${persona}${rotationHint}

【返信の構成】御礼 → 口コミ内容の引用共感 → 専門性への言及 → 次回の布石 → 署名
【文字数】150〜250字（署名含む）
【禁止】「治る」「完治」「治療効果保証」「またのご来院心よりお待ちしております」「またのご来店心よりお待ちしております」
【出力形式】返信文のみを出力してください。前置きや説明は不要です。`;

  const userPrompt = `以下の口コミへの返信文を生成してください。

店舗: ${review.store}
投稿者: ${review.author}
評価: ${review.stars}星
口コミ内容:
${review.content}`;

  const response = await client.messages.create({
    model: "claude-opus-4-7",
    max_tokens: 1024,
    thinking: { type: "adaptive" },
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  // テキストブロックを抽出
  const textBlock = response.content.find((b) => b.type === "text");
  return textBlock ? textBlock.text.trim() : "";
}

// ── メイン処理 ─────────────────────────────────────────────────
async function main() {
  console.error("口コミ返信文を生成中...\n");

  const results = [];
  let seikotsuRotation = 0;

  for (const review of reviews) {
    console.error(
      `[${review.index}/10] ${review.store} — ${review.author} さんへの返信を生成中...`
    );

    try {
      const reply = await generateReply(
        review,
        review.type === "seikotsu" ? seikotsuRotation++ : 0
      );

      results.push({
        index: review.index,
        store: review.store,
        author: review.author,
        reply,
      });

      console.error(`  完了 (${reply.length}字)`);
    } catch (err) {
      console.error(`  エラー: ${err.message}`);
      results.push({
        index: review.index,
        store: review.store,
        author: review.author,
        reply: `【生成エラー】${err.message}`,
      });
    }

    // レート制限対策: 少し待機
    if (review.index < reviews.length) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  // JSON出力
  console.log(JSON.stringify(results, null, 2));
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
