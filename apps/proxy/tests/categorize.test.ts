import { describe, expect, it } from 'vitest';
import type { CanonicalMessage, CanonicalStreamChunk, CanonicalToolCall } from '@routeshift/shared';
import { categorize, extractToolCallsFromChunks } from '../src/logging/categorize.js';

const userMsg = (content: string): CanonicalMessage => ({ role: 'user', content });

const toolCall = (name: string, args: Record<string, unknown> = {}): CanonicalToolCall => ({
  id: 't_' + name,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});

describe('categorize', () => {
  it('classifies an Edit tool call as coding', () => {
    const result = categorize({
      messages: [userMsg('please update this file')],
      toolCalls: [toolCall('Edit')],
    });
    expect(result).toBe('coding');
  });

  it('classifies a Write tool call as coding', () => {
    const result = categorize({
      messages: [userMsg('add a new module')],
      toolCalls: [toolCall('Write')],
    });
    expect(result).toBe('coding');
  });

  it('classifies fix/error keywords plus a tool call as debugging', () => {
    const result = categorize({
      messages: [userMsg('the build is broken — fix the failing test')],
      toolCalls: [toolCall('Bash', { command: 'pnpm build' })],
    });
    expect(result).toBe('debugging');
  });

  it('classifies bash + pytest invocation as testing', () => {
    const result = categorize({
      messages: [userMsg('run the suite')],
      toolCalls: [toolCall('Bash', { command: 'pytest tests/ -v' })],
    });
    expect(result).toBe('testing');
  });

  it('classifies bash + git push as git_ops', () => {
    const result = categorize({
      messages: [userMsg('push to origin')],
      toolCalls: [toolCall('Bash', { command: 'git push origin master' })],
    });
    expect(result).toBe('git_ops');
  });

  it('classifies Read/Grep with no edits as exploration', () => {
    const result = categorize({
      messages: [userMsg('where is the auth handler defined')],
      toolCalls: [toolCall('Grep'), toolCall('Read')],
    });
    expect(result).toBe('exploration');
  });

  it('classifies EnterPlanMode as planning', () => {
    const result = categorize({
      messages: [userMsg('plan the migration')],
      toolCalls: [toolCall('EnterPlanMode')],
    });
    expect(result).toBe('planning');
  });

  it('classifies Agent spawns as delegation', () => {
    const result = categorize({
      messages: [userMsg('research this in parallel')],
      toolCalls: [toolCall('Agent')],
    });
    expect(result).toBe('delegation');
  });

  it('classifies bash + npm build as build_deploy', () => {
    const result = categorize({
      messages: [userMsg('cut a release')],
      toolCalls: [toolCall('Bash', { command: 'npm run build && docker build .' })],
    });
    expect(result).toBe('build_deploy');
  });

  it('classifies brainstorm keyword with no tools as brainstorming', () => {
    const result = categorize({
      messages: [userMsg("let's brainstorm a few approaches")],
      toolCalls: [],
    });
    expect(result).toBe('brainstorming');
  });

  it('classifies pure text with no tools as conversation', () => {
    const result = categorize({
      messages: [userMsg('thanks for the help')],
      toolCalls: [],
    });
    expect(result).toBe('conversation');
  });

  it('classifies feature_dev keywords with tool use as feature_dev', () => {
    const result = categorize({
      messages: [userMsg('please implement the new exporter')],
      toolCalls: [toolCall('Bash', { command: 'ls src/' })],
    });
    expect(result).toBe('feature_dev');
  });

  it('classifies refactor keywords with tool use as refactoring', () => {
    const result = categorize({
      messages: [userMsg('refactor this module to extract the helpers')],
      toolCalls: [toolCall('Bash', { command: 'ls src/' })],
    });
    expect(result).toBe('refactoring');
  });

  it('falls back to general for unmatched tool calls', () => {
    const result = categorize({
      messages: [userMsg('do the thing')],
      toolCalls: [toolCall('SomeUnknownTool')],
    });
    expect(result).toBe('general');
  });

  it('keyword matching is case-insensitive', () => {
    const result = categorize({
      messages: [userMsg("LET'S BRAINSTORM")],
      toolCalls: [],
    });
    expect(result).toBe('brainstorming');
  });

  it('keyword matching uses only the last user message', () => {
    const result = categorize({
      messages: [
        userMsg("let's brainstorm new ideas"),
        { role: 'assistant', content: 'sure' },
        userMsg('thanks'),
      ],
      toolCalls: [],
    });
    expect(result).toBe('conversation');
  });

  it('coding wins over debugging when Edit is present alongside fix keyword', () => {
    // Per ticket acceptance: an Edit tool call lands as coding regardless.
    const result = categorize({
      messages: [userMsg('fix the parser bug')],
      toolCalls: [toolCall('Edit')],
    });
    expect(result).toBe('coding');
  });
});

describe('extractToolCallsFromChunks', () => {
  it('reassembles tool calls from streamed deltas', () => {
    const chunks: CanonicalStreamChunk[] = [
      { type: 'tool_call_delta', tool_call: { id: 'call_1', name: 'Bash', arguments_delta: '{"command":"git ' } },
      { type: 'tool_call_delta', tool_call: { id: 'call_1', name: 'Bash', arguments_delta: 'push"}' } },
      { type: 'tool_call_delta', tool_call: { id: 'call_2', name: 'Edit', arguments_delta: '{}' } },
    ];
    const result = extractToolCallsFromChunks(chunks);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      id: 'call_1',
      type: 'function',
      function: { name: 'Bash', arguments: '{"command":"git push"}' },
    });
    expect(result[1]).toEqual({
      id: 'call_2',
      type: 'function',
      function: { name: 'Edit', arguments: '{}' },
    });
  });

  it('returns empty when there are no tool_call_delta chunks', () => {
    const chunks: CanonicalStreamChunk[] = [
      { type: 'content_delta', content: 'hi' },
      { type: 'done' },
    ];
    expect(extractToolCallsFromChunks(chunks)).toEqual([]);
  });

  it('groups by index when id/name arrive only on the first delta (Anthropic-style)', () => {
    const chunks: CanonicalStreamChunk[] = [
      { type: 'tool_call_delta', tool_call: { id: 'toolu_1', name: 'Bash', arguments_delta: '', index: 0 } },
      { type: 'tool_call_delta', tool_call: { id: '', name: '', arguments_delta: '{"cmd":', index: 0 } },
      { type: 'tool_call_delta', tool_call: { id: '', name: '', arguments_delta: '"ls"}', index: 0 } },
    ];
    expect(extractToolCallsFromChunks(chunks)).toEqual([
      { id: 'toolu_1', type: 'function', function: { name: 'Bash', arguments: '{"cmd":"ls"}' } },
    ]);
  });

  it('keeps parallel tool calls separate by index even when continuation deltas share empty ids', () => {
    const chunks: CanonicalStreamChunk[] = [
      { type: 'tool_call_delta', tool_call: { id: 'call_a', name: 'f0', arguments_delta: '{"a"', index: 0 } },
      { type: 'tool_call_delta', tool_call: { id: 'call_b', name: 'f1', arguments_delta: '{"b"', index: 1 } },
      { type: 'tool_call_delta', tool_call: { id: '', name: '', arguments_delta: ':1}', index: 0 } },
      { type: 'tool_call_delta', tool_call: { id: '', name: '', arguments_delta: ':2}', index: 1 } },
    ];
    expect(extractToolCallsFromChunks(chunks)).toEqual([
      { id: 'call_a', type: 'function', function: { name: 'f0', arguments: '{"a":1}' } },
      { id: 'call_b', type: 'function', function: { name: 'f1', arguments: '{"b":2}' } },
    ]);
  });
});
