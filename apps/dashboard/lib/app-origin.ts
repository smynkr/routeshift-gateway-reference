export function getRequiredAppOrigin(context: string): string {
  const origin = process.env.NEXT_PUBLIC_APP_URL;
  if (!origin) {
    throw new Error(`NEXT_PUBLIC_APP_URL is required for ${context}`);
  }
  return origin.replace(/\/+$/, '');
}
