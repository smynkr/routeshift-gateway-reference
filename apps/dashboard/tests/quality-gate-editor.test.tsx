// @vitest-environment jsdom

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QUALITY_GATE_MAX_CHECKS, validateQualityGateConfig } from '@routeshift/shared';
import {
  QualityGateEditor,
  buildQualityGateConfig,
  defaultQualityGateDraft,
  newCheckDraft,
  type QualityGateDraft,
} from '@/components/routing/quality-gate-editor';

afterEach(cleanup);

function draftWith(overrides: Partial<QualityGateDraft>): QualityGateDraft {
  return { ...defaultQualityGateDraft(), ...overrides };
}

describe('buildQualityGateConfig', () => {
  it('rejects a draft whose billing acknowledgement is not explicitly checked', () => {
    const result = buildQualityGateConfig(draftWith({ checks: [newCheckDraft('stop_reason')] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('billing acknowledgement');
  });

  it('rejects an enabled gate with no checks', () => {
    const result = buildQualityGateConfig(draftWith({ billingAck: true, checks: [] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('at least one quality check');
  });

  it('rejects non-integer or out-of-band min_chars values with the offending check numbered', () => {
    for (const bad of ['', 'abc', '0', '1.5', '-3']) {
      const draft = draftWith({
        billingAck: true,
        checks: [{ type: 'nonempty_content', minChars: bad, allowToolOnly: false }],
      });
      const result = buildQualityGateConfig(draft);
      expect(result.ok, `minChars=${JSON.stringify(bad)}`).toBe(false);
      if (!result.ok) expect(result.error).toContain('Check 1');
    }
  });

  it('builds a validator-valid config with the fixed v1 fields and mapped checks', () => {
    const draft = draftWith({
      billingAck: true,
      onStream: 'bypass',
      checks: [
        newCheckDraft('stop_reason'),
        { type: 'nonempty_content', minChars: '200', allowToolOnly: true },
        newCheckDraft('json_parse'),
        { type: 'tool_call_shape', requireJsonArguments: true },
      ],
    });

    const result = buildQualityGateConfig(draft);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(validateQualityGateConfig(result.config).ok).toBe(true);
    expect(result.config).toEqual({
      version: 1,
      mode: 'cascade',
      on_stream: 'bypass',
      unknown_signal: 'reject',
      multi_attempt_billing_ack: true,
      checks: [
        { type: 'stop_reason', reject: ['max_tokens'] },
        { type: 'nonempty_content', min_chars: 200, allow_tool_only: true },
        { type: 'json_parse', when: 'response_format_json' },
        { type: 'tool_call_shape', require_json_arguments: true },
      ],
    });
  });

  it('omits optional false flags so persisted configs stay minimal', () => {
    const draft = draftWith({
      billingAck: true,
      checks: [
        { type: 'nonempty_content', minChars: '1', allowToolOnly: false },
        { type: 'tool_call_shape', requireJsonArguments: false },
      ],
    });
    const result = buildQualityGateConfig(draft);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.checks).toEqual([
      { type: 'nonempty_content', min_chars: 1 },
      { type: 'tool_call_shape' },
    ]);
  });
});

describe('QualityGateEditor', () => {
  function renderEditor(overrides: Partial<QualityGateDraft> = {}) {
    const props = {
      enabled: true,
      onEnabledChange: vi.fn(),
      draft: draftWith(overrides),
      onDraftChange: vi.fn(),
    };
    const utils = render(
      <QualityGateEditor
        enabled={props.enabled}
        onEnabledChange={props.onEnabledChange}
        draft={props.draft}
        onDraftChange={props.onDraftChange}
      />,
    );
    return { ...utils, ...props };
  }

  it('never pre-checks the multi-attempt billing acknowledgement', () => {
    expect(defaultQualityGateDraft().billingAck).toBe(false);
    const { onDraftChange } = renderEditor();
    const ack = screen.getByRole('checkbox', { name: 'Acknowledge multi-attempt billing' });
    expect((ack as HTMLInputElement).checked).toBe(false);

    fireEvent.click(ack);
    expect(onDraftChange).toHaveBeenCalledWith(expect.objectContaining({ billingAck: true }));
  });

  it('hides gate configuration until the gate is enabled', () => {
    const { rerender } = render(
      <QualityGateEditor
        enabled={false}
        onEnabledChange={() => undefined}
        draft={defaultQualityGateDraft()}
        onDraftChange={() => undefined}
      />,
    );
    expect(screen.queryByLabelText('Streaming requests')).toBeNull();

    rerender(
      <QualityGateEditor
        enabled
        onEnabledChange={() => undefined}
        draft={defaultQualityGateDraft()}
        onDraftChange={() => undefined}
      />,
    );
    expect(screen.getByLabelText('Streaming requests')).toBeTruthy();
  });

  it('toggles the gate through the switch', () => {
    const onEnabledChange = vi.fn();
    render(
      <QualityGateEditor
        enabled={false}
        onEnabledChange={onEnabledChange}
        draft={defaultQualityGateDraft()}
        onDraftChange={() => undefined}
      />,
    );
    fireEvent.click(screen.getByRole('switch', { name: 'Enable quality gate' }));
    expect(onEnabledChange).toHaveBeenCalledWith(true);
  });

  it('adds a default stop_reason check', () => {
    const { onDraftChange } = renderEditor({ billingAck: true });
    fireEvent.click(screen.getByText('+ Add Check'));
    expect(onDraftChange).toHaveBeenCalledWith(
      expect.objectContaining({ checks: [{ type: 'stop_reason' }] }),
    );
  });

  it('re-types a check and resets its fields to the new type defaults', () => {
    const { onDraftChange } = renderEditor({
      billingAck: true,
      checks: [newCheckDraft('stop_reason')],
    });
    fireEvent.change(screen.getByLabelText('Check 1 type'), { target: { value: 'nonempty_content' } });
    expect(onDraftChange).toHaveBeenCalledWith(
      expect.objectContaining({ checks: [{ type: 'nonempty_content', minChars: '1', allowToolOnly: false }] }),
    );
  });

  it('removes a check by position', () => {
    const { onDraftChange } = renderEditor({
      billingAck: true,
      checks: [newCheckDraft('stop_reason'), newCheckDraft('json_parse')],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Remove check 1' }));
    expect(onDraftChange).toHaveBeenCalledWith(expect.objectContaining({ checks: [{ type: 'json_parse' }] }));
  });

  it('disables adding checks at the shared maximum', () => {
    const checks = Array.from({ length: QUALITY_GATE_MAX_CHECKS }, () => newCheckDraft('json_parse'));
    renderEditor({ billingAck: true, checks });
    expect((screen.getByText('+ Add Check') as HTMLButtonElement).disabled).toBe(true);
  });

  it('explains fixed v1 behavior for stop_reason and json_parse checks', () => {
    renderEditor({ billingAck: true, checks: [newCheckDraft('stop_reason'), newCheckDraft('json_parse')] });
    expect(screen.getByText(/the only stop reason configurable in gate version 1/)).toBeTruthy();
    expect(screen.getByText(/asked for JSON output/)).toBeTruthy();
  });
});
