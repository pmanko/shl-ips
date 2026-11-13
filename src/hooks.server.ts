/**
 * checkCookieAuth() reuses the existing /authcheck endpoint by passing the cookie token as a Bearer header.
 * Invalid/expired cookies are silently cleared rather than throwing a 401, so a stale cookie doesn't block the user from accessing public pages.
 *  - Individual +page.server.ts load() functions can decide whether locals.token being absent is an error for that route (except for app pages, these are all authenticated within the layout).
 */

import { error, type Handle } from '@sveltejs/kit';
import { SERVER_API_BASE, SERVER_LOCAL_DEMO_MODE } from '$lib/server/config';
import { INSTANCE_CONFIG } from '$lib/config/instance_config';

const disallowedEndpoints = INSTANCE_CONFIG.disallowedEndpoints;
const authenticatedAPIs = ['/api'];

const SKIP_AUTH_PREFIXES = ['/_app', '/favicon', '/images', INSTANCE_CONFIG.imgPath].filter(Boolean);

function isStaticAsset(pathname: string) {
  return SKIP_AUTH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

async function checkAuth(request: Request) {
  console.log('Checking auth');
  const auth = request.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) {
    console.log('Unauthorized');
    throw error(401, { message: 'Unauthorized' });
  }
  if (SERVER_LOCAL_DEMO_MODE && (!SERVER_API_BASE || auth === 'Bearer local-demo-token')) {
    return new Response(null, { status: 200 });
  }
  return await fetch(`${SERVER_API_BASE}/authcheck`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: auth
    }
  });
}

async function checkCookieAuth(token: string) {
  console.log('Checking cookie auth');
  const response = await fetch(`${SERVER_API_BASE}/authcheck`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    }
  });
  console.log(response);
  return response.ok;
}

function isPathAuthenticatedAPI(pathname: string) {
  return authenticatedAPIs.some(
    (path) => path === pathname || pathname.startsWith(path)
  );
}

export const handle: Handle = async ({ event, resolve }) => {
  const { url, request } = event;

  // Block disallowed API endpoints
  if (
    url.pathname.split('/')[1] === 'api' &&
    disallowedEndpoints !== undefined &&
    disallowedEndpoints.includes(url.pathname.split('/')[2])
  ) {
    throw error(404, { message: 'Page not found' });
  }

  // Existing header-based auth for /api/* routes
  if (isPathAuthenticatedAPI(url.pathname)) {
    const authorized = await checkAuth(request);
    if (!authorized.ok) {
      console.log('Authorization check failed');
      console.log(authorized.status, authorized.statusText, await authorized.text());
      throw error(401, { message: 'Authorization check failed' });
    }
  } else if (!isStaticAsset(url.pathname)) {
    // Cookie-based auth for page loads — attach token to locals for use in load functions
    const token = event.cookies.get('auth_token');
    if (token) {
      if (SERVER_LOCAL_DEMO_MODE && (!SERVER_API_BASE || token === 'local-demo-token')) {
        event.locals.token = token;
      } else {
        const valid = await checkCookieAuth(token);
        if (valid) {
          event.locals.token = token;
        } else {
          // Token present but invalid — clear the stale cookie
          event.cookies.delete('auth_token', { path: '/' });
        }
      }
    } else if (SERVER_LOCAL_DEMO_MODE && !SERVER_API_BASE) {
      event.locals.token = 'local-demo-token';
    }
  }

  return resolve(event);
};