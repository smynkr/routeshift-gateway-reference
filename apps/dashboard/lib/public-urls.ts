export const PUBLIC_APP_BASE_URL = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
export const PUBLIC_PROXY_BASE_URL =
  (process.env.NEXT_PUBLIC_PROXY_URL || 'http://localhost:4000').replace(/\/+$/, '');
export const PUBLIC_PROXY_CHAT_COMPLETIONS_URL = `${PUBLIC_PROXY_BASE_URL}/v1/chat/completions`;
export const PUBLIC_REFERENCE_URL = 'https://github.com/smynkr/routeshift-gateway-reference#readme';
