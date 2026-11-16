import { error, json } from '@sveltejs/kit';
import {
  PUBLIC_AUTH_URL,
  SEEDED_DEMO_PASSWORD,
  SEEDED_PROFILES_ENABLED,
  SERVER_API_BASE,
  SERVER_AUTH_CLIENT_ID,
  SERVER_LOCAL_DEMO_MODE,
  resolveInternalKeycloakRealmUrl
} from '$lib/server/config';
import { SEEDED_DEMO_ACCOUNTS, findSeededProfile } from '$lib/utils/seededProfiles';

export const GET = async () => {
  return json({
    enabled: SEEDED_PROFILES_ENABLED,
    accounts: SEEDED_PROFILES_ENABLED ? SEEDED_DEMO_ACCOUNTS : []
  });
};

export const POST = async ({ request, cookies, url }) => {
  if (!SEEDED_PROFILES_ENABLED) {
    throw error(403, 'Seeded profile sign-in is disabled');
  }

  let body: { slug?: string } = {};
  try {
    body = await request.json();
  } catch {
    throw error(400, 'Invalid JSON body');
  }

  const acct = findSeededProfile(String(body?.slug || ''));
  if (!acct) {
    throw error(400, 'Unknown seeded patient profile');
  }

  const isHttps =
    url.protocol === 'https:' ||
    request.headers.get('x-forwarded-proto') === 'https';

  if (SERVER_LOCAL_DEMO_MODE) {
    cookies.set('auth_token', 'local-demo-token', {
      path: '/',
      sameSite: 'strict',
      secure: isHttps,
      httpOnly: true
    });
    return json({ ok: true, localDemo: true, account: acct });
  }

  const realmBase = resolveInternalKeycloakRealmUrl();
  const form = new URLSearchParams();
  form.set('grant_type', 'password');
  form.set('client_id', SERVER_AUTH_CLIENT_ID);
  form.set('username', acct.email);
  form.set('password', SEEDED_DEMO_PASSWORD);
  form.set('scope', 'openid profile email');

  const tokenHeaders: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded'
  };
  try {
    const pubUrl = new URL(PUBLIC_AUTH_URL);
    tokenHeaders['X-Forwarded-Proto'] = pubUrl.protocol.replace(/:$/, '');
    tokenHeaders['X-Forwarded-Host'] = pubUrl.host;
  } catch {
    // Ignore malformed PUBLIC_AUTH_URL and rely on internal default headers
  }

  const kcResp = await fetch(`${realmBase}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: tokenHeaders,
    body: form.toString()
  });

  const kcData = await kcResp.json().catch(() => ({} as Record<string, any>));
  if (!kcResp.ok || !kcData?.access_token) {
    throw error(
      kcResp.status >= 400 && kcResp.status < 500 ? 401 : 502,
      kcData?.error_description || kcData?.error || 'Keycloak seeded sign-in failed'
    );
  }

  const authCheckResp = await fetch(`${SERVER_API_BASE}/authcheck`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${kcData.access_token}`
    }
  });
  if (!authCheckResp.ok) {
    throw error(401, 'Seeded token validation failed');
  }

  cookies.set('auth_token', kcData.access_token, {
    path: '/',
    sameSite: 'strict',
    secure: isHttps,
    httpOnly: true
  });

  return json({
    ok: true,
    account: acct,
    access_token: kcData.access_token,
    id_token: kcData.id_token,
    refresh_token: kcData.refresh_token,
    token_type: kcData.token_type || 'Bearer',
    scope: kcData.scope || 'openid profile email',
    session_state: kcData.session_state ?? null,
    expires_in: kcData.expires_in ?? 300
  });
};
