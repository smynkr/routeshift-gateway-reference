import { NextResponse } from 'next/server';
import aws4 from 'aws4';
import { MODEL_REGISTRY, PROVIDERS_WITHOUT_RUNTIME_ADAPTER } from '@routeshift/shared';
import { requireRole } from '@/lib/rbac';
import { isValidProvider, VALID_PROVIDERS, validateProviderMetadata } from '@/lib/provider-metadata';
import { DEMO_WRITE_BLOCKED_MESSAGE, isDemoActive } from '@/lib/demo';
import { readJsonObject } from '@/lib/request-json';

const ANTHROPIC_KEY_TEST_MODEL =
  MODEL_REGISTRY.find((model) => model.provider === 'anthropic' && model.canonical_name === 'claude-haiku-4-5')?.api_model_id
  ?? 'claude-haiku-4-5';

function validateAzureEndpointUrl(endpointUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(endpointUrl);
  } catch {
    return 'Azure endpoint_url must be a valid URL';
  }

  const hostname = parsed.hostname.toLowerCase();
  const isAzureHost = hostname.endsWith('.openai.azure.com') || hostname.endsWith('.cognitiveservices.azure.com');
  if (parsed.protocol !== 'https:' || !isAzureHost || parsed.username || parsed.password || parsed.search || parsed.hash) {
    return 'Azure endpoint_url must be an HTTPS Azure OpenAI endpoint with no credentials, query, or fragment';
  }

  const path = parsed.pathname.replace(/\/$/, '') || '/';
  if (path !== '/' && path !== '/openai/v1' && path !== '/openai/v1/chat/completions') {
    return 'Azure endpoint_url path must be empty, /openai/v1, or /openai/v1/chat/completions';
  }

  return null;
}

function validateAzureResourceName(resourceName: string): string | null {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(resourceName)) {
    return 'Azure resource_name must be a single Azure resource label that starts and ends with a letter or number';
  }
  return null;
}

function validateAwsRegion(region: string): string | null {
  if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(region)) {
    return 'Bedrock region must be a valid AWS region identifier';
  }
  return null;
}

async function testProviderKey(
  provider: string,
  key: string,
  metadata?: Record<string, unknown>,
): Promise<{ valid: boolean; error?: string }> {
  try {
    let res: Response;

    switch (provider) {
      case 'openai':
        res = await fetch('https://api.openai.com/v1/models', {
          headers: { Authorization: `Bearer ${key}` },
        });
        break;

      case 'anthropic':
        res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': key,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: ANTHROPIC_KEY_TEST_MODEL,
            max_tokens: 1,
            messages: [{ role: 'user', content: 'hi' }],
          }),
        });
        break;

      case 'google': {
        const url = new URL('https://generativelanguage.googleapis.com/v1beta/models');
        url.searchParams.set('key', key);
        res = await fetch(url.toString());
        break;
      }

      case 'together':
        res = await fetch('https://api.together.xyz/v1/models', {
          headers: { Authorization: `Bearer ${key}` },
        });
        break;

      case 'groq':
        res = await fetch('https://api.groq.com/openai/v1/models', {
          headers: { Authorization: `Bearer ${key}` },
        });
        break;

      case 'zai':
        res = await fetch('https://open.bigmodel.cn/api/paas/v4/models', {
          headers: { Authorization: `Bearer ${key}` },
        });
        break;

      case 'cloudflare-workers-ai': {
        const accountId = typeof metadata?.account_id === 'string' ? metadata.account_id.trim() : '';
        if (!/^[0-9a-f]{32}$/.test(accountId)) {
          return { valid: false, error: 'Cloudflare provider requires metadata.account_id as a lowercase 32-character hexadecimal account ID' };
        }
        res = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${key}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model: '@cf/zai-org/glm-5.3-flash',
              messages: [{ role: 'user', content: 'hi' }],
              max_tokens: 1,
            }),
          },
        );
        break;
      }

      case 'neuralwatt':
        res = await fetch('https://api.neuralwatt.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'glm-5.2',
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 1,
          }),
        });
        break;

      case 'xiaomi':
        // Token Plan SGP cluster, OpenAI-compat with `api-key:` header (NOT Bearer).
        res = await fetch('https://token-plan-sgp.xiaomimimo.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'api-key': key,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: 'mimo-v2.5-pro',
            messages: [{ role: 'user', content: 'hi' }],
            max_completion_tokens: 1,
          }),
        });
        break;

      case 'minimax':
        // Token Plan, Anthropic-compat with x-api-key.
        res = await fetch('https://api.minimax.io/anthropic/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': key,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            // Current MiniMax model (MiniMax-M2.7 was the removed id) — keep in
            // sync with MODEL_REGISTRY / model-sources.ts in @routeshift/shared.
            model: 'MiniMax-M2',
            max_tokens: 1,
            messages: [{ role: 'user', content: 'hi' }],
          }),
        });
        break;

      case 'moonshot':
        // Anthropic-compat with Bearer (Anthropic SDK ANTHROPIC_AUTH_TOKEN convention).
        res = await fetch('https://api.moonshot.ai/anthropic/v1/messages', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${key}`,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            // Current Moonshot model (kimi-k2-thinking is deprecated); keep in
            // sync with MODEL_REGISTRY / model-sources.ts in @routeshift/shared.
            model: 'kimi-k2.6',
            max_tokens: 1,
            messages: [{ role: 'user', content: 'hi' }],
          }),
        });
        break;

      case 'qwen':
        res = await fetch('https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models', {
          headers: { Authorization: `Bearer ${key}` },
        });
        break;

      case 'azure': {
        const endpointUrl = typeof metadata?.endpoint_url === 'string' ? metadata.endpoint_url : null;
        const deploymentName = typeof metadata?.deployment_name === 'string' ? metadata.deployment_name : null;
        const resource = typeof metadata?.resource_name === 'string' ? metadata.resource_name : null;
        const apiVersion = typeof metadata?.api_version === 'string' ? metadata.api_version : null;

        if (endpointUrl) {
          const endpointError = validateAzureEndpointUrl(endpointUrl);
          if (endpointError) {
            return { valid: false, error: endpointError };
          }
          if (!deploymentName) {
            return { valid: false, error: 'Azure endpoint_url test requires deployment_name' };
          }
          const base = endpointUrl.replace(/\/$/, '');
          const url = base.endsWith('/chat/completions')
            ? base
            : base.endsWith('/openai/v1')
              ? `${base}/chat/completions`
              : `${base}/openai/v1/chat/completions`;
          res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'api-key': key },
            body: JSON.stringify({
              model: deploymentName,
              messages: [{ role: 'user', content: 'OK' }],
              max_completion_tokens: 1,
            }),
          });
          break;
        }

        if (!resource || !apiVersion) {
          return { valid: false, error: 'Azure requires endpoint_url, or resource_name and api_version' };
        }
        const resourceNameError = validateAzureResourceName(resource);
        if (resourceNameError) {
          return { valid: false, error: resourceNameError };
        }
        // Azure has no `/v1/models` endpoint; the deployments-list endpoint is the
        // canonical "is this key valid for this resource" probe.
        res = await fetch(
          `https://${resource}.openai.azure.com/openai/deployments?api-version=${encodeURIComponent(apiVersion)}`,
          { headers: { 'api-key': key } },
        );
        break;
      }

      case 'bedrock': {
        const accessKeyId = typeof metadata?.access_key_id === 'string' ? metadata.access_key_id : null;
        const region = typeof metadata?.region === 'string' ? metadata.region : null;
        if (!accessKeyId || !region) {
          return { valid: false, error: 'Bedrock requires access_key_id and region' };
        }
        const regionError = validateAwsRegion(region);
        if (regionError) {
          return { valid: false, error: regionError };
        }
        // Probe `bedrock.<region>.amazonaws.com/foundation-models` (control-plane
        // service, distinct from `bedrock-runtime.…` used for invoke). 200 means
        // creds + region are valid AND the IAM principal has bedrock:ListFoundationModels.
        // 403 with valid sigv4 = wrong permissions but valid creds — surface that distinctly.
        const host = `bedrock.${region}.amazonaws.com`;
        const path = '/foundation-models';
        const signed = aws4.sign(
          { service: 'bedrock', region, method: 'GET', host, path, headers: {} },
          { accessKeyId, secretAccessKey: key },
        );
        res = await fetch(`https://${host}${path}`, {
          method: 'GET',
          headers: signed.headers as Record<string, string>,
        });
        if (res.status === 403) {
          // Try a cheaper permission check: invoke with empty body. We expect 400 (bad
          // request) for valid creds and 403 for invalid. This avoids requiring the
          // Bedrock list permission at test time.
          const altPath = '/model/anthropic.claude-3-5-haiku-20241022-v1:0/invoke';
          const altHost = `bedrock-runtime.${region}.amazonaws.com`;
          const altSigned = aws4.sign(
            {
              service: 'bedrock',
              region,
              method: 'POST',
              host: altHost,
              path: altPath,
              headers: { 'Content-Type': 'application/json' },
              body: '{}',
            },
            { accessKeyId, secretAccessKey: key },
          );
          // Strip Content-Length — undici recomputes it; signed value mismatch → 403.
          const altHeaders = { ...(altSigned.headers as Record<string, string>) };
          delete altHeaders['Content-Length'];
          const altRes = await fetch(`https://${altHost}${altPath}`, {
            method: 'POST',
            headers: altHeaders,
            body: '{}',
          });
          // 400 (validation) or 424 (model access not enabled) means creds are valid.
          if (altRes.status === 400 || altRes.status === 424) {
            return { valid: true };
          }
        }
        break;
      }

      default:
        // Cataloged provider without a proxy runtime adapter (single source:
        // PROVIDERS_WITHOUT_RUNTIME_ADAPTER): a key can be stored for
        // planning, but there is no endpoint to test against. Anything else
        // reaching default is genuinely unknown.
        if ((PROVIDERS_WITHOUT_RUNTIME_ADAPTER as readonly string[]).includes(provider)) {
          return {
            valid: false,
            error: `Provider '${provider}' is cataloged but has no runtime adapter yet — keys can be stored, but requests cannot be routed or tested.`,
          };
        }
        return { valid: false, error: `Unknown provider '${provider}'.` };
    }

    if (res.ok) {
      return { valid: true };
    }

    return { valid: false, error: `Provider returned HTTP ${res.status}` };
  } catch (err: any) {
    return { valid: false, error: err.message ?? 'Connection failed' };
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  try {
    if (await isDemoActive()) {
      return NextResponse.json({ error: { message: DEMO_WRITE_BLOCKED_MESSAGE } }, { status: 403 });
    }
    const rbac = await requireRole('admin');
    if (!rbac) {
      return NextResponse.json({ error: { message: 'Forbidden' } }, { status: 403 });
    }

    const { provider } = await params;
    if (!isValidProvider(provider)) {
      return NextResponse.json(
        { error: { message: `Invalid provider. Must be one of: ${VALID_PROVIDERS.join(', ')}` } },
        { status: 400 },
      );
    }

    const body = await readJsonObject(request);
    if (!body) {
      return NextResponse.json({ valid: false, error: 'Invalid JSON body' }, { status: 400 });
    }
    const { key, metadata } = body;
    if (!key || typeof key !== 'string') {
      return NextResponse.json({ error: { message: 'Missing or invalid key' } }, { status: 400 });
    }
    const safeMetadata =
      metadata && typeof metadata === 'object' && !Array.isArray(metadata)
        ? metadata as Record<string, unknown>
        : {};
    const metadataError = validateProviderMetadata(provider, safeMetadata);
    if (metadataError) {
      return NextResponse.json({ valid: false, error: metadataError }, { status: 400 });
    }

    const result = await testProviderKey(provider, key, safeMetadata);
    return NextResponse.json(result);
  } catch (err) {
    console.error('Failed to test provider key:', err);
    return NextResponse.json({ valid: false, error: 'Internal server error' }, { status: 500 });
  }
}
