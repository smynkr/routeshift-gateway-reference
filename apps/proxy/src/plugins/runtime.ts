import { supportsNativePdf, type CanonicalRequest } from '@routeshift/shared';
import {
  augmentWithFileParser,
  type FileParserWarningCode,
} from './file-parser.js';
import type { PluginId, PluginSpec } from './specs.js';
import {
  augmentWithWebSearch,
  WebSearchPolicyError,
  type WebSearchPolicyReason,
} from './web-search.js';

export { safeFetch } from './safe-fetch.js';

export type PluginWarningCode =
  | 'plugin_backend_not_configured'
  | 'plugin_backend_failed'
  | WebSearchPolicyReason
  | FileParserWarningCode;

export interface PluginWarning {
  plugin: PluginId;
  code: PluginWarningCode;
  reason: string;
  message: string;
}

export type PluginRunStatus = 'ok' | 'warning' | 'error' | 'skipped';

/** A deliberately small, safe handoff for RSH-105 persistence. `detail` is
 * always a stable code, never a URL, file name, file body, or backend payload. */
export interface PluginRunOutcome {
  plugin: PluginId;
  status: PluginRunStatus;
  costMicrocents: number;
  latencyMs: number;
  detail?: PluginWarningCode;
}

export interface PluginRunResult {
  canonical: CanonicalRequest;
  warnings: PluginWarning[];
  outcomes: PluginRunOutcome[];
  surchargeMicrocents: number;
}

/**
 * Returns the maximum deterministic surcharge that a plugin request can incur
 * before its backend is invoked. Credits mode uses this to reserve funds
 * before an external plugin can spend money; the final runtime result is still
 * settled from the measured surcharge so an unavailable/optional plugin is
 * refunded correctly.
 */
export function estimatePluginSurchargeMicrocents(specs: readonly PluginSpec[]): number {
  return specs.reduce((total, spec) => (
    spec.id === 'web' ? total + webSearchSurchargeMicrocents() : total
  ), 0);
}

export interface PluginRuntimeContext {
  /** Actual post-routing target. Native handling must never infer this from a
   * requested model string because rules and auto-routing can change it. */
  providerId?: string;
  routedModel?: string;
  /** `executeFallbackChain` reuses canonical content unchanged, so every
   * possible target must support the same internal PDF part. */
  fallbackCandidates?: ReadonlyArray<{ provider: string; model: string }>;
  /** Explicit `file-parser` requests deliberately opt out of native PDF
   * passthrough even when the target supports it. */
  forceFileExtraction?: boolean;
}

export class PluginRequiredError extends Error {
  code = 'plugin_required_failed' as const;

  constructor(
    public plugin: PluginId,
    public reason: string,
    public warnings: PluginWarning[],
    public outcomes: PluginRunOutcome[],
    public surchargeMicrocents: number,
  ) {
    super(`Required plugin ${plugin} failed: ${reason}`);
    this.name = 'PluginRequiredError';
  }
}

export class PluginUnavailableError extends Error {
  code = 'plugin_backend_not_configured' as const;

  constructor(
    public plugin: PluginId,
    public reason: string,
  ) {
    super(`Plugin ${plugin} unavailable: ${reason}`);
    this.name = 'PluginUnavailableError';
  }
}

export async function runPlugins(
  canonical: CanonicalRequest,
  specs: PluginSpec[],
  context: PluginRuntimeContext = {},
): Promise<PluginRunResult> {
  const warnings: PluginWarning[] = [];
  const outcomes: PluginRunOutcome[] = [];
  let surchargeMicrocents = 0;
  let nextCanonical = canonical;
  for (const spec of specs) {
    const startedAt = Date.now();
    try {
      if (spec.id === 'web') {
        nextCanonical = await augmentWithWebSearch(nextCanonical, spec);
        const costMicrocents = webSearchSurchargeMicrocents();
        surchargeMicrocents += costMicrocents;
        outcomes.push({
          plugin: spec.id,
          status: 'ok',
          costMicrocents,
          latencyMs: Date.now() - startedAt,
        });
        continue;
      }

      const parserResult = await augmentWithFileParser(nextCanonical, {
        nativePdf: context.forceFileExtraction !== true && hasSafeNativePdfRoute(context),
      });
      nextCanonical = parserResult.canonical;
      const parserWarnings = parserResult.warnings.map((warning) => buildFileParserWarning(warning.code));
      if (parserWarnings.length > 0) {
        const detail = parserWarnings[0].code;
        if (spec.required) {
          outcomes.push({
            plugin: spec.id,
            status: 'error',
            costMicrocents: 0,
            latencyMs: Date.now() - startedAt,
            detail,
          });
          throwRequired(spec.id, detail, warnings, outcomes, surchargeMicrocents);
        }
        warnings.push(...parserWarnings);
        outcomes.push({
          plugin: spec.id,
          status: 'warning',
          costMicrocents: 0,
          latencyMs: Date.now() - startedAt,
          detail,
        });
        continue;
      }
      outcomes.push({
        plugin: spec.id,
        status: 'ok',
        costMicrocents: 0,
        latencyMs: Date.now() - startedAt,
      });
    } catch (error) {
      if (error instanceof PluginRequiredError) throw error;

      if (error instanceof WebSearchPolicyError) {
        if (spec.required) {
          outcomes.push({
            plugin: spec.id,
            status: 'error',
            costMicrocents: 0,
            latencyMs: Date.now() - startedAt,
            detail: error.code,
          });
          throwRequired(spec.id, error.code, warnings, outcomes, surchargeMicrocents);
        }
        warnings.push({
          plugin: spec.id,
          code: error.code,
          reason: error.code,
          message: `Plugin ${spec.id} skipped: ${error.code}`,
        });
        outcomes.push({
          plugin: spec.id,
          status: 'warning',
          costMicrocents: 0,
          latencyMs: Date.now() - startedAt,
          detail: error.code,
        });
        continue;
      }

      if (spec.id === 'file-parser') {
        const warning = buildFileParserWarning('file_parse_failed');
        if (spec.required) {
          outcomes.push({
            plugin: spec.id,
            status: 'error',
            costMicrocents: 0,
            latencyMs: Date.now() - startedAt,
            detail: warning.code,
          });
          throwRequired(spec.id, warning.code, warnings, outcomes, surchargeMicrocents);
        }
        warnings.push(warning);
        outcomes.push({
          plugin: spec.id,
          status: 'warning',
          costMicrocents: 0,
          latencyMs: Date.now() - startedAt,
          detail: warning.code,
        });
        continue;
      }

      const unavailable = error instanceof PluginUnavailableError
        || (error instanceof Error && error.message.includes('not configured'));
      // Backend errors can contain response bodies, URLs, or credentials. Keep
      // the externally visible warning/audit contract to stable reason codes;
      // PluginRunOutcome.detail is deliberately the same bounded vocabulary.
      const normalizedReason = unavailable
        ? `No backend configured for plugin ${spec.id}`
        : `Plugin ${spec.id} backend request failed`;
      const code = unavailable ? 'plugin_backend_not_configured' : 'plugin_backend_failed';
      if (spec.required) {
        outcomes.push({
          plugin: spec.id,
          status: 'error',
          costMicrocents: 0,
          latencyMs: Date.now() - startedAt,
          detail: code,
        });
        throwRequired(spec.id, normalizedReason, warnings, outcomes, surchargeMicrocents);
      }
      warnings.push(buildWarning(spec.id, code, unavailable));
      outcomes.push({
        plugin: spec.id,
        status: 'warning',
        costMicrocents: 0,
        latencyMs: Date.now() - startedAt,
        detail: code,
      });
    }
  }

  return { canonical: nextCanonical, warnings, outcomes, surchargeMicrocents };
}

function hasSafeNativePdfRoute(context: PluginRuntimeContext): boolean {
  if (!context.providerId || !context.routedModel) return false;
  if (!supportsNativePdf(context.providerId, context.routedModel)) return false;
  return (context.fallbackCandidates ?? []).every((candidate) => (
    supportsNativePdf(candidate.provider, candidate.model)
  ));
}

function throwRequired(
  plugin: PluginId,
  reason: string,
  warnings: PluginWarning[],
  outcomes: PluginRunOutcome[],
  surchargeMicrocents: number,
): never {
  throw new PluginRequiredError(plugin, reason, [...warnings], [...outcomes], surchargeMicrocents);
}

function webSearchSurchargeMicrocents(): number {
  const parsed = Number(process.env.WEB_SEARCH_SURCHARGE_MICROCENTS ?? '500000');
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 500_000;
}

function buildFileParserWarning(code: FileParserWarningCode): PluginWarning {
  return {
    plugin: 'file-parser',
    code,
    reason: code,
    message: `Plugin file-parser skipped: ${code}`,
  };
}

function buildWarning(
  plugin: PluginId,
  code: PluginWarningCode,
  unavailable: boolean,
): PluginWarning {
  const reason = unavailable
    ? `No backend configured for plugin ${plugin}`
    : `Plugin ${plugin} backend request failed`;
  return {
    plugin,
    code,
    reason,
    message: `Plugin ${plugin} skipped: ${reason}`,
  };
}
