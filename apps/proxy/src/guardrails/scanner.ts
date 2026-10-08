import type { CanonicalMessage } from '@routeshift/shared';
import { BUILT_IN_PATTERNS, type GuardrailPattern } from './patterns.js';

export interface ScanMatch {
  patternId: string;
  patternName: string;
  category: 'pii' | 'injection';
  severity: 'block' | 'warn';
  matchedText: string;
  messageIndex: number;
}

export interface ScanResult {
  blocked: boolean;
  matches: ScanMatch[];
  scannedAt: string;
}

export interface PatternOverride {
  id: string;
  enabled: boolean;
  customRegex?: string;
  action?: 'block' | 'warn';
}

export interface GuardrailConfig {
  enabled: boolean;
  patterns: PatternOverride[];
}

function extractTextContent(message: CanonicalMessage): string {
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text' && typeof (p as any).text === 'string')
      .map((p) => p.text)
      .join(' ');
  }
  return '';
}

function redactMatch(text: string): string {
  if (text.length <= 4) return text;
  return text.slice(0, 4) + '...';
}

function compilePattern(pattern: GuardrailPattern, override?: PatternOverride): RegExp | null {
  if (override && !override.enabled) return null;
  const regexSource = override?.customRegex ?? pattern.regex;
  const flags = override?.customRegex ? pattern.flags : pattern.flags;
  try {
    return new RegExp(regexSource, flags);
  } catch {
    return null;
  }
}

const REGEX_TIMEOUT_MS = 50;

function safeExec(regex: RegExp, text: string): RegExpExecArray | null {
  const start = Date.now();
  try {
    regex.lastIndex = 0;
    const match = regex.exec(text);
    if (Date.now() - start > REGEX_TIMEOUT_MS) return null;
    return match;
  } catch {
    return null;
  }
}

export function scanMessages(messages: CanonicalMessage[], config: GuardrailConfig): ScanResult {
  const matches: ScanMatch[] = [];

  for (let i = 0; i < messages.length; i++) {
    const text = extractTextContent(messages[i]!);
    if (!text) continue;

    for (const pattern of BUILT_IN_PATTERNS) {
      const override = config.patterns.find((p) => p.id === pattern.id);
      const regex = compilePattern(pattern, override);
      if (!regex) continue;

      const match = safeExec(regex, text);
      if (match) {
        const severity = override?.action ?? pattern.severity;
        matches.push({
          patternId: pattern.id,
          patternName: pattern.name,
          category: pattern.category,
          severity,
          matchedText: redactMatch(match[0]!),
          messageIndex: i,
        });
      }
    }
  }

  const blocked = matches.some((m) => m.severity === 'block');
  return { blocked, matches, scannedAt: new Date().toISOString() };
}
