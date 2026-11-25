import { error, json } from '@sveltejs/kit';
import {
  SERVER_AUTH_CLIENT_ID,
  SERVER_LOCAL_DEMO_MODE
} from '$lib/server/config';
import { exchangeKeycloakTokenAndSetCookie, setAuthCookie } from '$lib/server/keycloakAuth';

export const POST = async ({ request, cookies, url, fetch }) => {
  let body: { refresh_token?: string } = {};
  try {
    body = await request.json();
  } catch {
    throw error(400, 'Invalid JSON body');
  }

  if (SERVER_LOCAL_DEMO_MODE) {
    setAuthCookie(cookies, 'local-demo-token', url, request);
    return json({ ok: true, localDemo: true, access_token: 'local-demo-token', expires_in: 3600 });
  }

  const refreshToken = String(body?.refresh_token || '').trim();
  if (!refreshToken) {
    throw error(400, 'No refresh_token provided');
  }

  const form = new URLSearchParams();
  form.set('grant_type', 'refresh_token');
  form.set('client_id', SERVER_AUTH_CLIENT_ID);
  form.set('refresh_token', refreshToken);

  const tokens = await exchangeKeycloakTokenAndSetCookie({
    form,
    request,
    cookies,
    url,
    fetchFn: fetch,
    failureMessage: 'Keycloak token refresh failed'
  });

  return json({
    ok: true,
    ...tokens
  });
};
