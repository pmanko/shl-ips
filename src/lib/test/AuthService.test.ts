import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import * as jose from 'jose';
import { AuthService } from '../utils/AuthService';
import { POST as setTokenPost } from '../../routes/(common)/auth/settoken/+server';
import { POST as seededLoginPost } from '../../routes/(common)/auth/seeded-login/+server';
import { POST as refreshPost } from '../../routes/(common)/auth/refresh/+server';

// vi.mock factories are hoisted above imports, so anything they reference
// must be created through vi.hoisted rather than a plain top-level const.
const { MockUserManager, mockUserManagerInstances } = vi.hoisted(() => {
  class MockUserManager {
    settings: any;
    events = {
      addUserLoaded: vi.fn(),
      addSilentRenewError: vi.fn(),
      addAccessTokenExpired: vi.fn(),
      addAccessTokenExpiring: vi.fn()
    };
    getUser = vi.fn();
    signinSilent = vi.fn();
    signinRedirect = vi.fn().mockResolvedValue(undefined);
    signinCallback = vi.fn();
    storeUser = vi.fn();
    removeUser = vi.fn().mockResolvedValue(undefined);
    signoutRedirect = vi.fn();
    clearStaleState = vi.fn();

    constructor(settings: any) {
      this.settings = settings;
      mockUserManagerInstances.push(this);
    }
  }
  const mockUserManagerInstances: InstanceType<typeof MockUserManager>[] = [];
  return { MockUserManager, mockUserManagerInstances };
});

vi.mock('oidc-client-ts', () => ({
  UserManager: MockUserManager
}));

// AuthService pulls these from the instance-specific config; real config.ts
// touches import.meta.env / window.__env and drags in an SCSS import via
// instance_config.ts, none of which is relevant to AuthService's own logic.
vi.mock('$lib/config/config', () => ({
  AUTH_URL: 'https://issuer.example.com',
  AUTH_CLIENT_ID: 'test-client',
  AUTH_REDIRECT_URI: 'https://app.example.com/auth',
  AUTH_SILENT_REDIRECT_URI: 'https://app.example.com/auth/silent-renew',
  AUTH_POST_LOGOUT_URI: 'https://app.example.com/logout'
}));

vi.mock('$lib/config/instance_config', () => ({
  INSTANCE_CONFIG: { defaultRedirectURI: '/data' }
}));

function latestManager() {
  return mockUserManagerInstances[mockUserManagerInstances.length - 1];
}

function fakeUser(overrides: Record<string, unknown> = {}): any {
  return {
    profile: { sub: 'user-1' },
    access_token: 'access-token-1',
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    expired: false,
    url_state: '',
    ...overrides
  };
}

describe('AuthService', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockUserManagerInstances.length = 0;
    sessionStorage.clear();
    fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('enables automaticSilentRenew on the underlying UserManager', () => {
    new AuthService();

    expect(latestManager().settings.automaticSilentRenew).toBe(true);
  });

  it('syncs a background-renewed token to the server when the manager fires userLoaded', async () => {
    const service = new AuthService();
    const manager = latestManager();
    const onUserLoaded = manager.events.addUserLoaded.mock.calls[0][0];

    const user = fakeUser({ access_token: 'renewed-token' });
    await onUserLoaded(user);

    expect(fetchMock).toHaveBeenCalledWith('/auth/settoken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'renewed-token' })
    });
    expect(get(service.user)).toEqual(user);
  });

  it('clears the user without redirecting when a silent renew fails', async () => {
    const service = new AuthService();
    const manager = latestManager();
    const onSilentRenewError = manager.events.addSilentRenewError.mock.calls[0][0];
    service.storeUser(fakeUser());

    await onSilentRenewError(new Error('renew failed'));

    expect(manager.removeUser).toHaveBeenCalled();
    expect(get(service.user)).toBeNull();
    expect(get(service.authenticated)).toBe(false);
    expect(manager.signinRedirect).not.toHaveBeenCalled();
  });

  it('clears the user without redirecting when the access token expires', async () => {
    const service = new AuthService();
    const manager = latestManager();
    const onAccessTokenExpired = manager.events.addAccessTokenExpired.mock.calls[0][0];
    service.storeUser(fakeUser());

    await onAccessTokenExpired();

    expect(manager.removeUser).toHaveBeenCalled();
    expect(get(service.user)).toBeNull();
    expect(get(service.authenticated)).toBe(false);
    expect(manager.signinRedirect).not.toHaveBeenCalled();
  });

  describe('restoreSession', () => {
    it('uses a stored user that is still valid without a silent sign-in', async () => {
      const service = new AuthService();
      const manager = latestManager();
      manager.getUser.mockResolvedValue(fakeUser());

      expect(await service.restoreSession()).toBe(true);
      expect(manager.signinSilent).not.toHaveBeenCalled();
    });

    it('renews an expired stored user silently when the IdP session is alive', async () => {
      const service = new AuthService();
      const manager = latestManager();
      manager.getUser.mockResolvedValue(fakeUser({ expired: true }));
      manager.signinSilent.mockResolvedValue(fakeUser({ access_token: 'fresh-token' }));

      expect(await service.restoreSession()).toBe(true);
      expect(get(service.user)?.access_token).toBe('fresh-token');
    });

    it('clears an expired stored user without redirecting when the IdP session has ended', async () => {
      const service = new AuthService();
      const manager = latestManager();
      manager.getUser.mockResolvedValue(fakeUser({ expired: true }));
      manager.signinSilent.mockRejectedValue(
        Object.assign(new Error('Session not active'), { error: 'invalid_grant' })
      );

      expect(await service.restoreSession()).toBe(false);
      expect(manager.removeUser).toHaveBeenCalled();
      expect(manager.signinRedirect).not.toHaveBeenCalled();
      expect(get(service.authenticated)).toBe(false);
    });
  });

  it('ignores token expiry while a sign-in callback is being processed', async () => {
    const service = new AuthService();
    const manager = latestManager();
    const onAccessTokenExpired = manager.events.addAccessTokenExpired.mock.calls[0][0];
    let finishCallback: (user: any) => void = () => {};
    manager.signinCallback.mockReturnValue(new Promise((resolve) => { finishCallback = resolve; }));

    const callback = service.signinCallback();
    onAccessTokenExpired();
    finishCallback(fakeUser());
    await callback;

    expect(manager.removeUser).not.toHaveBeenCalled();
    expect(get(service.authenticated)).toBe(true);
  });

  it('starts only one redirect when several logins are requested at once', () => {
    const service = new AuthService();
    const manager = latestManager();
    manager.signinRedirect.mockReturnValue(new Promise(() => {}));

    service.login();
    service.login();
    service.login();

    expect(manager.signinRedirect).toHaveBeenCalledTimes(1);
  });

  describe('signinCallback', () => {
    it('restarts login rather than signing out when the callback fails', async () => {
      const service = new AuthService();
      const manager = latestManager();
      manager.signinCallback.mockRejectedValue(new Error('No matching state found in storage'));

      await service.signinCallback();

      expect(manager.removeUser).toHaveBeenCalled();
      expect(manager.signinRedirect).toHaveBeenCalled();
      expect(manager.signoutRedirect).not.toHaveBeenCalled();
    });

    it('stops redirecting when the retried callback fails again', async () => {
      const service = new AuthService();
      const manager = latestManager();
      manager.signinCallback.mockRejectedValue(new Error('authentication_expired'));

      await service.signinCallback();
      manager.signinRedirect.mockClear();
      const user = await service.signinCallback();

      expect(user).toBeUndefined();
      expect(manager.signinRedirect).not.toHaveBeenCalled();
      expect(get(service.error)).toBeTruthy();
    });

    it('resets the retry guard after a successful callback', async () => {
      const service = new AuthService();
      const manager = latestManager();
      manager.signinCallback.mockRejectedValueOnce(new Error('first failure'));
      await service.signinCallback();

      manager.signinCallback.mockResolvedValueOnce(fakeUser());
      await service.signinCallback();

      manager.signinRedirect.mockClear();
      manager.signinCallback.mockRejectedValueOnce(new Error('later failure'));
      await service.signinCallback();

      expect(manager.signinRedirect).toHaveBeenCalled();
    });
  });

  describe('renewToken', () => {
    it('stores the renewed user and syncs the token before resolving', async () => {
      const service = new AuthService();
      const manager = latestManager();
      const user = fakeUser({ access_token: 'renewed-token' });
      manager.signinSilent.mockResolvedValue(user);

      const result = await service.renewToken();

      expect(result).toEqual(user);
      expect(get(service.user)).toEqual(user);
      expect(fetchMock).toHaveBeenCalledWith(
        '/auth/settoken',
        expect.objectContaining({ body: JSON.stringify({ token: 'renewed-token' }) })
      );
    });

    it('forces login when the renewed token fails to sync to the server', async () => {
      const service = new AuthService();
      const manager = latestManager();
      manager.signinSilent.mockResolvedValue(fakeUser({ access_token: 'renewed-token' }));
      fetchMock.mockResolvedValue({ ok: false });

      await service.renewToken();

      expect(manager.signinRedirect).toHaveBeenCalled();
    });
  });

  describe('getAccessToken', () => {
    it('returns the current token without renewing when it is still valid', async () => {
      const service = new AuthService();
      const manager = latestManager();
      manager.getUser.mockResolvedValue(fakeUser({ access_token: 'still-valid', expired: false }));

      const token = await service.getAccessToken();

      expect(token).toBe('still-valid');
      expect(manager.signinSilent).not.toHaveBeenCalled();
    });

    it('renews the token when the stored user is expired', async () => {
      const service = new AuthService();
      const manager = latestManager();
      manager.getUser.mockResolvedValue(fakeUser({ expired: true }));
      manager.signinSilent.mockResolvedValue(fakeUser({ access_token: 'fresh-token' }));

      const token = await service.getAccessToken();

      expect(token).toBe('fresh-token');
    });

    it('signs in again rather than signing out when the session has ended', async () => {
      const service = new AuthService();
      const manager = latestManager();
      manager.getUser.mockResolvedValue(fakeUser({ expired: true }));
      manager.signinSilent.mockRejectedValue(
        Object.assign(new Error('Session not active'), { error: 'invalid_grant' })
      );

      const token = await service.getAccessToken();

      expect(token).toBeUndefined();
      expect(manager.signinRedirect).toHaveBeenCalled();
      expect(manager.signoutRedirect).not.toHaveBeenCalled();
    });
  });

  it('syncTokenToServer posts the token and reflects the response status', async () => {
    const service = new AuthService();
    fetchMock.mockResolvedValue({ ok: false });

    const ok = await service.syncTokenToServer('some-token');

    expect(ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledWith('/auth/settoken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'some-token' })
    });
  });

  describe('loginWithSeededProfile', () => {
    it('stores a Keycloak seeded-profile User with refresh_token and logs out locally', async () => {
      const service = new AuthService();
      const manager = latestManager();
      const headerB64 = jose.base64url.encode(
        new TextEncoder().encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
      );
      const payloadB64 = jose.base64url.encode(
        new TextEncoder().encode(
          JSON.stringify({
            sub: 'kc-sub-marcus',
            email: 'marcus.vance@wahs.local',
            given_name: 'Marcus',
            family_name: 'Vance',
            name: 'Marcus Vance',
            exp: Math.floor(Date.now() / 1000) + 600
          })
        )
      );
      const fakeJwt = `${headerB64}.${payloadB64}.sig`;

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          account: {
            slug: 'marcus',
            name: 'Marcus Vance',
            givenName: 'Marcus',
            familyName: 'Vance',
            email: 'marcus.vance@wahs.local'
          },
          access_token: fakeJwt,
          id_token: fakeJwt,
          refresh_token: 'refresh-tok-marcus',
          token_type: 'Bearer',
          scope: 'openid profile email',
          expires_in: 600
        })
      });

      const user = await service.loginWithSeededProfile('marcus');

      expect(fetchMock).toHaveBeenCalledWith('/auth/seeded-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: 'marcus' })
      });
      expect(user.access_token).toBe(fakeJwt);
      expect(user.refresh_token).toBe('refresh-tok-marcus');
      expect(user.profile.email).toBe('marcus.vance@wahs.local');
      expect(manager.storeUser).toHaveBeenCalledTimes(1);
      expect(get(service.authenticated)).toBe(true);
      expect(sessionStorage.getItem('wahs:authMethod')).toBe('seeded_profile');

      fetchMock.mockResolvedValueOnce({ ok: true });
      const navSpy = vi.spyOn(service as any, 'navigateTo').mockImplementation(() => {});
      await service.logout();

      expect(fetchMock).toHaveBeenCalledWith('/auth/settoken', { method: 'DELETE' });
      expect(manager.removeUser).toHaveBeenCalled();
      expect(manager.signoutRedirect).not.toHaveBeenCalled();
      expect(navSpy).toHaveBeenCalledWith('/');
      expect(sessionStorage.getItem('wahs:authMethod')).toBeNull();
      expect(sessionStorage.getItem('wahs:seededProfileSlug')).toBeNull();
      expect(get(service.authenticated)).toBe(false);
    });

    it('renews proactively within 90s via /auth/refresh and falls back to seeded-login on expiry without signing out', async () => {
      const service = new AuthService();
      const manager = latestManager();
      const expiringSoon = fakeUser({
        access_token: 'expiring-jwt',
        refresh_token: 'kc-refresh-1',
        expires_at: Math.floor(Date.now() / 1000) + 45,
        expired: false
      });
      manager.getUser.mockResolvedValue(expiringSoon);
      sessionStorage.setItem('wahs:seededProfileSlug', 'marcus');
      sessionStorage.setItem('wahs:authMethod', 'seeded_profile');

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          access_token: 'refreshed-jwt-1',
          refresh_token: 'kc-refresh-2',
          expires_in: 3600
        })
      });

      const tok = await service.getAccessToken();
      expect(tok).toBe('refreshed-jwt-1');
      expect(fetchMock).toHaveBeenCalledWith(
        '/auth/refresh',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ refresh_token: 'kc-refresh-1' })
        })
      );
      expect(manager.signinSilent).not.toHaveBeenCalled();

      // Simulate refresh_token expiry firing addAccessTokenExpired: recovers quietly via seeded-login
      const onAccessTokenExpired = manager.events.addAccessTokenExpired.mock.calls[0][0];
      fetchMock
        .mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'invalid_grant' }) })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ok: true,
            access_token: 'seeded-recovered-jwt',
            refresh_token: 'kc-refresh-3',
            expires_in: 3600
          })
        });

      await onAccessTokenExpired();
      expect(get(service.authenticated)).toBe(true);
      expect(get(service.user)?.access_token).toBe('seeded-recovered-jwt');
      expect(manager.signinRedirect).not.toHaveBeenCalled();
    });
  });

  describe('server cookie auth routes (Safari SameSite=Lax & /auth/refresh)', () => {
    it('sets auth_token cookie with sameSite=lax on settoken, seeded-login, and refresh', async () => {
      const cookieCalls: Array<{ name: string; value: string; opts: any }> = [];
      const mockCookies = {
        set: (name: string, value: string, opts: any) => cookieCalls.push({ name, value, opts }),
        delete: vi.fn()
      } as any;

      fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      await setTokenPost({
        request: new Request('https://wahs-web.openclinai.org/auth/settoken', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-forwarded-proto': 'https' },
          body: JSON.stringify({ token: 'tok-set' })
        }),
        cookies: mockCookies,
        url: new URL('https://wahs-web.openclinai.org/auth/settoken')
      } as any);

      const routeFetch = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              access_token: 'tok-kc',
              refresh_token: 'ref-kc',
              id_token: 'id-kc',
              expires_in: 3600
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        )
        .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

      await seededLoginPost({
        request: new Request('https://wahs-web.openclinai.org/auth/seeded-login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-forwarded-proto': 'https' },
          body: JSON.stringify({ slug: 'alex' })
        }),
        cookies: mockCookies,
        url: new URL('https://wahs-web.openclinai.org/auth/seeded-login'),
        fetch: routeFetch as any
      } as any);

      routeFetch
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              access_token: 'tok-refreshed',
              refresh_token: 'ref-kc-2',
              expires_in: 3600
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        )
        .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

      const refRes = await refreshPost({
        request: new Request('https://wahs-web.openclinai.org/auth/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-forwarded-proto': 'https' },
          body: JSON.stringify({ refresh_token: 'ref-kc' })
        }),
        cookies: mockCookies,
        url: new URL('https://wahs-web.openclinai.org/auth/refresh'),
        fetch: routeFetch as any
      } as any);
      expect(refRes.status).toBe(200);
      const refBody = await refRes.json();
      expect(refBody.access_token).toBe('tok-refreshed');

      expect(cookieCalls).toHaveLength(3);
      for (const call of cookieCalls) {
        expect(call.name).toBe('auth_token');
        expect(call.opts.sameSite).toBe('lax');
        expect(call.opts.secure).toBe(true);
        expect(call.opts.httpOnly).toBe(true);
      }
    });
  });
});
