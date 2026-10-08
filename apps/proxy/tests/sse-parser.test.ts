import { describe, it, expect } from 'vitest';
import { SSEParser } from '../src/streaming/sse-parser.js';

describe('SSEParser', () => {
  it('parses complete SSE events', () => {
    const parser = new SSEParser();
    const events = parser.push('data: {"content":"hello"}\n\ndata: {"content":"world"}\n\n');
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ data: '{"content":"hello"}' });
    expect(events[1]).toEqual({ data: '{"content":"world"}' });
  });

  it('handles split chunks', () => {
    const parser = new SSEParser();
    const e1 = parser.push('data: {"con');
    expect(e1).toHaveLength(0);
    const e2 = parser.push('tent":"hello"}\n\n');
    expect(e2).toHaveLength(1);
    expect(e2[0]).toEqual({ data: '{"content":"hello"}' });
  });

  it('parses event type prefix', () => {
    const parser = new SSEParser();
    const events = parser.push('event: message_start\ndata: {"type":"message_start"}\n\n');
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ event: 'message_start', data: '{"type":"message_start"}' });
  });

  it('handles [DONE] sentinel', () => {
    const parser = new SSEParser();
    const events = parser.push('data: [DONE]\n\n');
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ data: '[DONE]' });
  });

  it('handles multiple splits across many chunks', () => {
    const parser = new SSEParser();
    expect(parser.push('da')).toHaveLength(0);
    expect(parser.push('ta: hel')).toHaveLength(0);
    expect(parser.push('lo\n')).toHaveLength(0);
    const events = parser.push('\n');
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ data: 'hello' });
  });

  it('handles empty data field', () => {
    const parser = new SSEParser();
    const events = parser.push('data:\n\n');
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ data: '' });
  });

  it('supports event: and data: lines without a space', () => {
    const parser = new SSEParser();
    const events = parser.push('event:message_delta\ndata:{"x":1}\n\n');

    expect(events).toEqual([{ event: 'message_delta', data: '{"x":1}' }]);
  });

  it('joins multiline data blocks with newline', () => {
    const parser = new SSEParser();
    const events = parser.push('data: first\ndata:second\n\n');

    expect(events).toEqual([{ data: 'first\nsecond' }]);
  });

  it('ignores blocks without data lines', () => {
    const parser = new SSEParser();
    const events = parser.push('event: ping\n\n');

    expect(events).toEqual([]);
  });
});
