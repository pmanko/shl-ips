import { error, json } from '@sveltejs/kit';
import {
  SEEDED_DEMO_PASSWORD,
  SEEDED_PROFILES_ENABLED,
  SERVER_AUTH_CLIENT_ID,
  SERVER_LOCAL_DEMO_MODE
} from '$lib/server/config';
import { exchangeKeycloakTokenAndSetCookie, setAuthCookie } from '$lib/server/keycloakAuth';
import { SEEDED_DEMO_ACCOUNTS, findSeededProfile } from '$lib/utils/seededProfiles';

export const GET = async () => {
  return json({
    enabled: SEEDED_PROFILES_ENABLED,
    accounts: SEEDED_PROFILES_ENABLED ? SEEDED_DEMO_ACCOUNTS : []
  });
};

export const POST = async ({ request, cookies, url, fetch }) => {
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

  if (SERVER_LOCAL_DEMO_MODE) {
    setAuthCookie(cookies, 'local-demo-token', url, request);
    return json({ ok: true, localDemo: true, account: acct });
  }

  const form = new URLSearchParams();
  form.set('grant_type', 'password');
  form.set('client_id', SERVER_AUTH_CLIENT_ID);
  form.set('username', acct.email);
  form.set('password', SEEDED_DEMO_PASSWORD);
  form.set('scope', 'openid profile email');

  const tokens = await exchangeKeycloakTokenAndSetCookie({
    form,
    request,
    cookies,
    url,
    fetchFn: fetch,
    failureMessage: 'Keycloak seeded sign-in failed'
  });

  return json({
    ok: true,
    account: acct,
    ...tokens
  });
};
