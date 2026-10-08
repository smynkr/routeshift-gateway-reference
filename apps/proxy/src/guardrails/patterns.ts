export type GuardrailCategory = 'pii' | 'injection';
export type GuardrailSeverity = 'block' | 'warn';

export interface GuardrailPattern {
  id: string;
  name: string;
  description: string;
  regex: string;
  flags: string;
  severity: GuardrailSeverity;
  category: GuardrailCategory;
}

export const BUILT_IN_PATTERNS: readonly GuardrailPattern[] = [
  {
    id: 'pii_email',
    name: 'Email address',
    description: 'Detects email addresses',
    regex: '[a-zA-Z0-9._%+\\-]+@[a-zA-Z0-9.\\-]+\\.[a-zA-Z]{2,}',
    flags: 'g',
    severity: 'block',
    category: 'pii',
  },
  {
    id: 'pii_phone_us',
    name: 'US phone number',
    description: 'Detects US phone numbers',
    regex: '(?:\\+1[\\-.\\s]?)?(?:\\(\\d{3}\\)[\\-.\\s]?|\\d{3}[\\-.\\s])\\d{3}[\\-.\\s]?\\d{4}',
    flags: 'g',
    severity: 'block',
    category: 'pii',
  },
  {
    id: 'pii_ssn',
    name: 'Social Security Number',
    description: 'Detects US SSNs',
    regex: '\\b\\d{3}-\\d{2}-\\d{4}\\b',
    flags: 'g',
    severity: 'block',
    category: 'pii',
  },
  {
    id: 'pii_credit_card',
    name: 'Credit card number',
    description: 'Detects major credit card numbers',
    regex: '\\b(?:4\\d{3}|5[1-5]\\d{2}|3[47]\\d{2}|6(?:011|5\\d{2}))[-\\s]?\\d{4}[-\\s]?\\d{4}[-\\s]?\\d{4}\\b',
    flags: 'g',
    severity: 'block',
    category: 'pii',
  },
  {
    id: 'pii_ip_address',
    name: 'IP address',
    description: 'Detects IPv4 addresses',
    regex: '\\b(?:\\d{1,3}\\.){3}\\d{1,3}\\b',
    flags: 'g',
    severity: 'warn',
    category: 'pii',
  },
  {
    id: 'pii_api_key_generic',
    name: 'Generic API key',
    description: 'Detects common API key patterns',
    regex: '\\b(?:sk|pk|api|key|token)[_-][a-zA-Z0-9]{20,}\\b',
    flags: 'g',
    severity: 'block',
    category: 'pii',
  },
  {
    id: 'pii_aws_access_key',
    name: 'AWS access key',
    description: 'Detects AWS access key IDs',
    regex: '\\bAKIA[0-9A-Z]{16}\\b',
    flags: 'g',
    severity: 'block',
    category: 'pii',
  },
  {
    id: 'inj_role_hijack',
    name: 'Role hijacking',
    description: 'Detects attempts to override system instructions',
    regex: '\\b(?:ignore|disregard|forget)\\s+(?:all\\s+)?(?:previous|prior|above|earlier)\\s+(?:instructions?|prompts?|rules?)',
    flags: 'gi',
    severity: 'block',
    category: 'injection',
  },
  {
    id: 'inj_identity_override',
    name: 'Identity override',
    description: 'Detects attempts to reassign the model identity',
    regex: '\\byou\\s+are\\s+now\\b|\\bact\\s+as\\s+(?:if\\s+you\\s+are\\s+)?a\\b|\\bpretend\\s+(?:to\\s+be|you\\s+are)\\b',
    flags: 'gi',
    severity: 'warn',
    category: 'injection',
  },
  {
    id: 'inj_encoding_bypass',
    name: 'Encoding bypass',
    description: 'Detects attempts to use encoding to bypass filters',
    regex: '\\b(?:base64|rot13|hex)\\s+(?:decode|encode|decrypt)\\b|\\b(?:decode|decrypt)\\s+(?:this|the\\s+following)\\s+(?:base64|rot13|hex)',
    flags: 'gi',
    severity: 'warn',
    category: 'injection',
  },
] as const;
