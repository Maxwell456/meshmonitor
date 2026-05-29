import { logger } from '../../utils/logger.js';


export type BotProvider = 'openai' | 'claude';

export interface BotSettings {
  provider: BotProvider;
  apiKey: string;
  apiUrl: string;
  model: string;
  systemPrompt: string;
  maxTokens: number;
  maxChars: number;
  temperature: number;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface BotCallOptions {
  settings: BotSettings;
  userMessage: string;
  context: ChatMessage[];
  nodeContext?: string;
}

async function callOpenAI(opts: BotCallOptions): Promise<string> {
  const { settings, userMessage, context, nodeContext } = opts;
  const baseUrl = settings.apiUrl || 'https://api.openai.com/v1';

  const systemContent = nodeContext
    ? `${settings.systemPrompt}\n\n${nodeContext}`
    : settings.systemPrompt;

  const messages = [
    { role: 'system', content: systemContent },
    ...context,
    { role: 'user', content: userMessage },
  ];

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify({
      model: settings.model,
      messages,
      max_tokens: settings.maxTokens,
      temperature: settings.temperature,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`OpenAI API error ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json() as any;
  return data.choices?.[0]?.message?.content ?? '';
}

async function callClaude(opts: BotCallOptions): Promise<string> {
  const { settings, userMessage, context, nodeContext } = opts;

  const systemContent = nodeContext
    ? `${settings.systemPrompt}\n\n${nodeContext}`
    : settings.systemPrompt;

  const messages = [
    ...context,
    { role: 'user', content: userMessage },
  ];

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': settings.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: settings.model,
      system: systemContent,
      messages,
      max_tokens: settings.maxTokens,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Claude API error ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json() as any;
  return data.content?.[0]?.text ?? '';
}

// Meshtastic TEXT_MESSAGE_APP hard limit is 228 bytes UTF-8.
// Cyrillic chars are 2 bytes each, so effective limit is ~114 Cyrillic chars per packet.
export const MESHTASTIC_MAX_PAYLOAD_BYTES = 228;

function utf8ByteLength(str: string): number {
  let bytes = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

// Splits text into up to maxParts Meshtastic packets (228-byte limit each),
// breaking at sentence or word boundaries where possible.
export function splitIntoPackets(text: string, maxParts = 2): string[] {
  const limit = MESHTASTIC_MAX_PAYLOAD_BYTES;
  const parts: string[] = [];
  let remaining = text.trim();

  while (remaining.length > 0 && parts.length < maxParts) {
    if (utf8ByteLength(remaining) <= limit) {
      parts.push(remaining);
      break;
    }

    // Find max char index fitting within byte limit
    let bytes = 0;
    let cutIdx = 0;
    for (let i = 0; i < remaining.length; i++) {
      const code = remaining.charCodeAt(i);
      let charBytes: number;
      if (code <= 0x7f) charBytes = 1;
      else if (code <= 0x7ff) charBytes = 2;
      else if (code <= 0xffff) charBytes = 3;
      else charBytes = 4;
      if (bytes + charBytes > limit) break;
      bytes += charBytes;
      cutIdx = i + 1;
    }

    const segment = remaining.slice(0, cutIdx);

    // Last allowed part — use whatever fits
    if (parts.length === maxParts - 1) {
      parts.push(segment.trim());
      break;
    }

    // Prefer sentence boundary, fall back to word boundary
    const sentenceEnd = Math.max(
      segment.lastIndexOf('. '),
      segment.lastIndexOf('! '),
      segment.lastIndexOf('? '),
    );
    const wordEnd = segment.lastIndexOf(' ');

    let splitAt: number;
    if (sentenceEnd > segment.length / 3) {
      splitAt = sentenceEnd + 1;
    } else if (wordEnd > 0) {
      splitAt = wordEnd;
    } else {
      splitAt = cutIdx;
    }

    parts.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  return parts.filter(p => p.length > 0);
}

function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '$1')       // **bold** → bold
    .replace(/\*([^*\n]+)\*/g, '$1')          // *italic* → italic
    .replace(/^#{1,6}\s+/gm, '')              // ### headers → plain
    .replace(/```[\s\S]*?```/g, '')           // code blocks → remove
    .replace(/`([^`]+)`/g, '$1')              // `inline code` → plain
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // [text](url) → text
    .replace(/\n{3,}/g, '\n\n')              // collapse excess blank lines
    .trim();
}

export async function getBotResponse(opts: BotCallOptions): Promise<string> {
  const { settings } = opts;

  logger.debug(`🤖 Calling ${settings.provider} model=${settings.model}`);

  let raw: string;
  if (settings.provider === 'claude') {
    raw = await callClaude(opts);
  } else {
    raw = await callOpenAI(opts);
  }

  let result = stripMarkdown(raw.trim());
  // Apply user-configured char limit (for single-packet sends / test endpoint)
  if (result.length > settings.maxChars) {
    result = result.slice(0, settings.maxChars - 1) + '…';
  }
  return result;
}
