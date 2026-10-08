import { describe, it, expect } from 'vitest';
import { OpenAIProvider } from '../src/providers/openai.js';
import { AnthropicProvider } from '../src/providers/anthropic.js';
import { GeminiProvider } from '../src/providers/gemini.js';

describe('provider outcome signals (RSH-72 signal preservation)', () => {
  describe('OpenAI', () => {
    const p = new OpenAIProvider();
    const body = (choice: unknown) => ({
      id: 'r1', model: 'gpt-4.1', choices: [choice],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });

    it('preserves the raw finish_reason and reports no refusal/safety for a normal stop', () => {
      const s = p.parseOutcomeSignals!(body({ finish_reason: 'stop', message: { content: 'hi' } }));
      expect(s.provider).toBe('openai');
      expect(s.raw_stop_reason).toBe('stop');
      expect(s.refusal).toBeNull();
      expect(s.safety_blocked).toBeNull();
      expect(s.unknown_fields_present).toBe(false);
      expect(s.provider_parse_status).toBe('parsed');
    });

    it('flags refusal when message.refusal is a non-empty string', () => {
      const s = p.parseOutcomeSignals!(body({ finish_reason: 'stop', message: { content: '', refusal: 'I cannot help with that.' } }));
      expect(s.refusal).toBe(true);
    });

    it('flags safety_blocked for finish_reason content_filter', () => {
      const s = p.parseOutcomeSignals!(body({ finish_reason: 'content_filter', message: { content: '' } }));
      expect(s.safety_blocked).toBe(true);
    });

    it('preserves an unknown finish_reason exactly and sets unknown_fields_present', () => {
      const s = p.parseOutcomeSignals!(body({ finish_reason: 'some_future_outcome', message: { content: 'x' } }));
      expect(s.raw_stop_reason).toBe('some_future_outcome');
      expect(s.unknown_fields_present).toBe(true);
    });

    it('treats the legacy function_call finish_reason as known (not unknown)', () => {
      const s = p.parseOutcomeSignals!(body({ finish_reason: 'function_call', message: { content: '' } }));
      expect(s.raw_stop_reason).toBe('function_call');
      expect(s.unknown_fields_present).toBe(false);
    });
  });

  describe('Anthropic', () => {
    const p = new AnthropicProvider();
    const body = (stop_reason: unknown) => ({
      id: 'r1', model: 'claude', content: [{ type: 'text', text: 'hi' }], stop_reason,
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    it('preserves the raw stop_reason for a normal end_turn', () => {
      const s = p.parseOutcomeSignals!(body('end_turn'));
      expect(s.provider).toBe('anthropic');
      expect(s.raw_stop_reason).toBe('end_turn');
      expect(s.refusal).toBeNull();
      expect(s.unknown_fields_present).toBe(false);
    });

    it('flags refusal for stop_reason refusal', () => {
      const s = p.parseOutcomeSignals!(body('refusal'));
      expect(s.refusal).toBe(true);
      expect(s.unknown_fields_present).toBe(false);
    });

    it('recognizes pause_turn as a known (non-unknown) raw stop_reason', () => {
      const s = p.parseOutcomeSignals!(body('pause_turn'));
      expect(s.raw_stop_reason).toBe('pause_turn');
      expect(s.unknown_fields_present).toBe(false);
      expect(s.refusal).toBeNull();
    });

    it('flags an unknown stop_reason', () => {
      const s = p.parseOutcomeSignals!(body('some_future_outcome'));
      expect(s.unknown_fields_present).toBe(true);
    });
  });

  describe('Gemini', () => {
    const p = new GeminiProvider();
    const body = (candidate: unknown, promptFeedback?: unknown) => ({
      candidates: candidate === undefined ? [] : [candidate],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
      ...(promptFeedback !== undefined ? { promptFeedback } : {}),
    });

    it('preserves the raw finishReason for a normal STOP', () => {
      const s = p.parseOutcomeSignals!(body({ finishReason: 'STOP', content: { parts: [{ text: 'hi' }] } }));
      expect(s.provider).toBe('google');
      expect(s.raw_stop_reason).toBe('STOP');
      expect(s.safety_blocked).toBeNull();
      expect(s.unknown_fields_present).toBe(false);
    });

    it('flags safety_blocked for finishReason SAFETY', () => {
      const s = p.parseOutcomeSignals!(body({ finishReason: 'SAFETY' }));
      expect(s.safety_blocked).toBe(true);
    });

    it('captures promptFeedback.blockReason and flags safety when the prompt is blocked (no candidates)', () => {
      const s = p.parseOutcomeSignals!(body(undefined, { blockReason: 'SAFETY' }));
      expect(s.prompt_block_reason).toBe('SAFETY');
      expect(s.safety_blocked).toBe(true);
      expect(s.raw_stop_reason).toBeNull();
      expect(s.unknown_fields_present).toBe(false);
    });

    it('flags an unknown finishReason', () => {
      const s = p.parseOutcomeSignals!(body({ finishReason: 'SOME_FUTURE_REASON' }));
      expect(s.unknown_fields_present).toBe(true);
      expect(s.raw_stop_reason).toBe('SOME_FUTURE_REASON');
    });

    it('flags an unrecognized promptFeedback.blockReason as unknown', () => {
      const s = p.parseOutcomeSignals!(body(undefined, { blockReason: 'SOME_FUTURE_BLOCK_REASON' }));
      expect(s.prompt_block_reason).toBe('SOME_FUTURE_BLOCK_REASON');
      expect(s.safety_blocked).toBe(true);
      expect(s.unknown_fields_present).toBe(true);
    });
  });

  it('reports provider_parse_status failed for a non-object body', () => {
    const p = new OpenAIProvider();
    expect(p.parseOutcomeSignals!(null).provider_parse_status).toBe('failed');
    expect(p.parseOutcomeSignals!('garbage').provider_parse_status).toBe('failed');
  });
});
