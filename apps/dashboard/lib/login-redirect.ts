import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

export async function redirectToLogin(fallbackCallbackUrl = '/overview'): Promise<never> {
  const headerList = await headers();
  const callbackUrl = headerList.get('x-routeshift-callback-url') ?? fallbackCallbackUrl;
  redirect(`/login?callbackUrl=${encodeURIComponent(callbackUrl)}`);
}
