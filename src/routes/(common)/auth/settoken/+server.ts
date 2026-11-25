import { json, error } from '@sveltejs/kit';
import { SERVER_API_BASE } from '$lib/server/config';
import { setAuthCookie } from '$lib/server/keycloakAuth';

export const POST = async ({ request, cookies, url }) => {
  const { token } = await request.json();

  if (!token) throw error(400, 'No token provided');

  // Validate the new token before setting it
  const response = await fetch(`${SERVER_API_BASE}/authcheck`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) throw error(401, 'Token validation failed');

  // Token is valid — set the cookie server-side with SameSite=Lax so
  // sibling-origin navigations (e.g. OpenClinAI gate/portal redirects) retain auth in Safari.
  setAuthCookie(cookies, token, url, request);

  return json({ ok: true });
};

export const DELETE = async ({ cookies }) => {
  cookies.delete('auth_token', { path: '/' });
  return json({ ok: true });
};