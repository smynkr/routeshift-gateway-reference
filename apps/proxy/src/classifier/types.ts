export interface ClassifierDimension {
  id: string;
  name: string;
  prompt: string;
  values: string[];
}

export interface ClassifierConfig {
  teamId: string;
  enabled: boolean;
  sampleRateBps: number;
  dimensions: ClassifierDimension[];
  classifierProvider: string;
  classifierModel: string;
}

export interface ClassificationResult {
  requestId: string;
  teamId: string;
  dimensions: Record<string, string>;
  costMicrocents: number;
  latencyMs: number;
  classifiedAt: string;
}

export const MAX_DIMENSIONS = 8;
export const MIN_SAMPLE_RATE_BPS = 100;
export const MAX_SAMPLE_RATE_BPS = 10_000;
export const MAX_CLASSIFIER_INPUT_CHARS = 2_000;
