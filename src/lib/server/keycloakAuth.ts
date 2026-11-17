import { error, type Cookies } from '@sveltejs/kit';
import {
  PUBLIC_AUTH_URL,
  SERVER_API_BASE,
  SERVER_AUTH_CLIENT_ID,
  resolveInternalKeycloakRealmUrl
} from '$lib/server/config';

export function isHttpsRequest(url: URL, request: Request): boolean {
  const fwdProto = (request.headers.get('x-forwarded-proto') || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  return url.protocol === 'https:' || fwdProto === 'https';
}

export function setAuthCookie(
  cookies: Cookies,
  token: string,
  url: URL,
  request: Request
): void {
  cookies.set('auth_token', token, {
    path: '/',
    sameSite: 'lax',
    secure: isHttpsRequest(url, request),
    httpOnly: true
  });
}

export interface KeycloakTokenExchangeResult {
  access_token: string;
  id_token?: string;
  refresh_token?: string;
  token_type: string;
  scope: string;
  session_state: string | null;
  expires_in: number;
}

export async function exchangeKeycloakTokenAndSetCookie(params: {
  form: URLSearchParams;
  request: Request;
  cookies: Cookies;
  url: URL;
  fetchFn?: typeof fetch;
  failureMessage?: string;
}): Promise<KeycloakTokenExchangeResult> {
  const {
    form,
    request,
    cookies,
    url,
    fetchFn = fetch,
    failureMessage = 'Keycloak token exchange failed'
  } = params;

  if (!form.has('client_id')) {
    form.set('client_id', SERVER_AUTH_CLIENT_ID);
  }

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

  const realmBase = resolveInternalKeycloakRealmUrl();
  const kcResp = await fetchFn(`${realmBase}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: tokenHeaders,
    body: form.toString()
  });

  const kcData = await kcResp.json().catch(() => ({} as Record<string, any>));
  if (!kcResp.ok || !kcData?.access_token) {
    throw error(
      kcResp.status >= 400 && kcResp.status < 500 ? 401 : 502,
      kcData?.error_description || kcData?.error || failureMessage
    );
  }

  const authCheckResp = await fetchFn(`${SERVER_API_BASE}/authcheck`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${kcData.access_token}`
    }
  });
  if (!authCheckResp.ok) {
    throw error(401, 'Token validation failed');
  }

  setAuthCookie(cookies, kcData.access_token, url, request);

  return {
    access_token: kcData.access_token,
    id_token: kcData.id_token,
    refresh_token: kcData.refresh_token,
    token_type: kcData.token_type || 'Bearer',
    scope: kcData.scope || 'openid profile email',
    session_state: kcData.session_state ?? null,
    expires_in: kcData.expires_in ?? 300
  };
}
