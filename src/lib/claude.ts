import Anthropic from '@anthropic-ai/sdk';
import { keychain } from './keychain.js';

let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!_client) {
    _client = new Anthropic({ apiKey: keychain.anthropicApiKey() });
  }
  return _client;
}

export interface ClaudeResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export async function askClaude(opts: {
  system: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
  model?: string;
}): Promise<ClaudeResponse> {
  const client = getClient();
  const response = await client.messages.create({
    model: opts.model ?? 'claude-sonnet-4-6',
    max_tokens: opts.maxTokens ?? 2048,
    temperature: opts.temperature ?? 0.7,
    system: opts.system,
    messages: [{ role: 'user', content: opts.user }],
  });

  const text = response.content
    .filter(b => b.type === 'text')
    .map(b => (b as { type: 'text'; text: string }).text)
    .join('');

  return {
    text,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
}

/** JSON 文字列内のリテラル改行を \n にエスケープして修復 */
function repairJson(jsonStr: string): string {
  // JSON文字列値内のリテラル改行（\nでエスケープされていない改行）を置換
  // "..." の中にある改行を \n に変換
  return jsonStr.replace(/"((?:[^"\\]|\\.)*)"/gs, (match, content) => {
    const fixed = content
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t');
    return `"${fixed}"`;
  });
}

export async function askClaudeJson<T>(opts: {
  system: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
}): Promise<T> {
  const result = await askClaude({ ...opts, temperature: opts.temperature ?? 0 });
  const raw = result.text;

  // コードブロック内のJSONを優先的に抽出（```json ... ``` 形式）
  const codeBlockMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (codeBlockMatch) {
    const inner = codeBlockMatch[1].trim();
    const jsonInBlock = inner.match(/\{[\s\S]*\}/s);
    if (jsonInBlock) {
      try {
        return JSON.parse(jsonInBlock[0]) as T;
      } catch {
        // JSON修復を試みる
        try {
          return JSON.parse(repairJson(jsonInBlock[0])) as T;
        } catch {
          // fallthrough
        }
      }
    }
  }

  // フォールバック: テキスト内の最初の { ... } を抽出（greedy）
  const jsonMatch = raw.match(/\{[\s\S]*\}/s);
  if (!jsonMatch) throw new Error(`Claude returned no JSON. Raw: ${raw.slice(0, 500)}`);
  try {
    return JSON.parse(jsonMatch[0]) as T;
  } catch {
    try {
      return JSON.parse(repairJson(jsonMatch[0])) as T;
    } catch {
      throw new Error(`Claude JSON parse failed. Raw: ${raw.slice(0, 500)}`);
    }
  }
}
