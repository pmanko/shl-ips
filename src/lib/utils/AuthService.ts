import {
  AUTH_URL,
  AUTH_CLIENT_ID,
  AUTH_REDIRECT_URI,
  AUTH_SILENT_REDIRECT_URI,
  AUTH_POST_LOGOUT_URI
} from '$lib/config/config';
import { isLocalDemoMode } from '$lib/utils/localDemoPersonas';
import { derived, writable, type Writable, type Readable } from 'svelte/store';
import { type User, UserManager } from 'oidc-client-ts';
import { decodeJwt } from 'jose';
import { INSTANCE_CONFIG } from '$lib/config/instance_config';
import type { IAuthService } from '$lib/utils/types';

// Set when a failed sign-in callback has already restarted login once, so a
// callback that keeps failing surfaces an error instead of redirecting forever.
const CALLBACK_RETRY_KEY = 'auth:callbackRetry';
const DEMO_PERSONA_STORAGE_KEY = 'wahs:demoPersona';
const AUTH_METHOD_STORAGE_KEY = 'wahs:authMethod';
const SEEDED_PROFILE_SLUG_KEY = 'wahs:seededProfileSlug';
const PROACTIVE_REFRESH_BUFFER_SEC = 90;

function safeStorageGet(kind: 'localStorage' | 'sessionStorage', key: string): string | null {
  try {
    if (typeof window !== 'undefined' && window[kind]) {
      return window[kind].getItem(key);
    }
    const store = (globalThis as Record<string, any>)[kind];
    return store ? store.getItem(key) : null;
  } catch {
    return null;
  }
}

function safeStorageSet(kind: 'localStorage' | 'sessionStorage', key: string, value: string): void {
  try {
    if (typeof window !== 'undefined' && window[kind]) {
      window[kind].setItem(key, value);
      return;
    }
    const store = (globalThis as Record<string, any>)[kind];
    store?.setItem(key, value);
  } catch {
    // Ignore storage quota or WebKit restriction errors
  }
}

function safeStorageRemove(kind: 'localStorage' | 'sessionStorage', key: string): void {
  try {
    if (typeof window !== 'undefined' && window[kind]) {
      window[kind].removeItem(key);
      return;
    }
    const store = (globalThis as Record<string, any>)[kind];
    store?.removeItem(key);
  } catch {
    // Ignore storage errors
  }
}

function decodeJwtPayload(jwt?: string): Record<string, any> {
  if (!jwt || typeof jwt !== 'string' || !jwt.includes('.')) return {};
  try {
    return (decodeJwt(jwt) as Record<string, any>) || {};
  } catch {
    return {};
  }
}

function buildLocalDemoUser(persona: string = 'alex'): User {
  const isLeo = persona === 'leo';
  return {
    id_token: 'local-demo-id-token',
    session_state: 'local-demo-session',
    access_token: 'local-demo-token',
    token_type: 'Bearer',
    scope: 'openid profile online_access',
    profile: {
      sub: `demo-user-${persona}`,
      iss: 'http://localhost:4000',
      aud: 'shl_creator',
      exp: Math.floor(Date.now() / 1000) + 86400 * 30,
      iat: Math.floor(Date.now() / 1000),
      given_name: isLeo ? 'Leo' : 'Alex',
      family_name: 'Johnson',
      name: isLeo ? 'Leo Johnson (Child Proxy)' : 'Alex Johnson',
      email: isLeo ? 'leo.proxy@example.org' : 'alex.johnson@example.org',
      gender: 'male',
      birthday: isLeo ? '2019-08-22' : '1962-03-14'
    },
    expires_at: Math.floor(Date.now() / 1000) + 86400 * 30,
    state: undefined,
    toStorageString: () => JSON.stringify({ persona }),
    expires_in: 86400 * 30,
    expired: false,
    scopes: ['openid', 'profile', 'online_access']
  } as unknown as User;
}

export class AuthService implements IAuthService {
  private userManager: UserManager;
  protected redirect_url: string = "";
  private loginInProgress: Promise<void> | null = null;
  private renewInProgress: Promise<User | null | undefined> | null = null;
  private quietRecoverInProgress: Promise<User | null> | null = null;
  private processingCallback = false;

  private _user: Writable<User | null> = writable(null);
  public readonly user: Readable<User | null> = derived(this._user, ($user) => $user);
  public readonly userId: Readable<string> = derived(this._user, ($user) => $user?.profile.sub ?? "");

  private _authenticated: Writable<boolean> = writable(false);
  public readonly authenticated: Readable<boolean> = derived(this._authenticated, ($authenticated) => $authenticated);

  private _error: Writable<any> = writable(null);
  public readonly error: Readable<any> = derived(this._error, ($error) => $error);

  constructor() {
    const demoMode = isLocalDemoMode();
    if (demoMode) {
      const savedPersona = safeStorageGet('localStorage', DEMO_PERSONA_STORAGE_KEY) || 'alex';
      const demoUser = buildLocalDemoUser(savedPersona);
      this._user.set(demoUser);
      this._authenticated.set(true);
    }
    const settings = {
      authority: AUTH_URL,
      client_id: AUTH_CLIENT_ID,
      redirect_uri: AUTH_REDIRECT_URI,
      silent_redirect_uri: AUTH_SILENT_REDIRECT_URI,
      post_logout_redirect_uri: AUTH_POST_LOGOUT_URI,
      // iframeScriptOrigin: "http://localhost:3000",
      scope: "openid profile email online_access",
      automaticSilentRenew: !demoMode,
    };
    this.userManager = new UserManager(settings);

    // Background renewal fires no lifecycle hook in the app's Svelte layout,
    // so the renewed token must be pushed to the server cookie here.
    this.userManager.events.addUserLoaded(async (user: User) => {
      this.storeUser(user);
      if (user.access_token) {
        await this.syncTokenToServer(user.access_token);
      }
    });
    this.userManager.events.addSilentRenewError(async (error: Error) => {
      console.error('Silent renew failed', error);
      const recovered = await this.recoverSessionQuietly();
      if (!recovered) {
        return this.sessionEnded();
      }
    });
    this.userManager.events.addAccessTokenExpired(async () => {
      // Safety net in case automaticSilentRenew's own retry didn't recover in time.
      // Skipped mid-callback: a stale expired user left in sessionStorage fires
      // this on page load, and clearing it would race the sign-in in progress.
      if (this.processingCallback) return;
      const recovered = await this.recoverSessionQuietly();
      if (!recovered) {
        return this.sessionEnded();
      }
    });
  }

  /**
   * Signs the user out locally without redirecting. Pages that require a
   * session watch the user store and initiate the login redirect themselves.
   */
  private async sessionEnded(): Promise<void> {
    await this.userManager.removeUser();
    this.storeUser(null);
  }

  async syncTokenToServer(token: string): Promise<boolean> {
    const response = await fetch('/auth/settoken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token })
    });
    return response.ok;
  }

  private async handleError(error: any) {
    this.userManager.clearStaleState();
    if (error?.error === "login_required") {
      return;
    }
    this._error.set(error);
    console.error(error);
    // Errors here mean the IdP session or stored tokens are no longer usable
    // (e.g. after an idle night). Signing out would only land the user on the
    // IdP's logout confirmation, so drop the local user and sign in again.
    await this.userManager.removeUser();
    this.storeUser(null);
    // Inside the silent-renew iframe, the parent window handles recovery.
    if (window.self !== window.top) {
      return;
    }
    await this.login();
  }

  setDemoPersona(persona: string): User {
    safeStorageSet('localStorage', DEMO_PERSONA_STORAGE_KEY, persona);
    const demoUser = buildLocalDemoUser(persona);
    this._user.set(demoUser);
    this._authenticated.set(true);
    return demoUser;
  }

  getDemoPersona(): string {
    return safeStorageGet('localStorage', DEMO_PERSONA_STORAGE_KEY) || 'alex';
  }

  async getUser(): Promise<User | null> {
    if (isLocalDemoMode()) {
      return buildLocalDemoUser(this.getDemoPersona());
    }
    const user = await this.userManager.getUser();
    return user;
  }

  async getAccessToken(): Promise<string | undefined> {
    if (isLocalDemoMode()) {
      return 'local-demo-token';
    }
    try {
      const user = await this.getUser();
      const nowSec = Math.floor(Date.now() / 1000);
      const expiringSoon = Boolean(
        user?.expires_at && user.expires_at <= nowSec + PROACTIVE_REFRESH_BUFFER_SEC
      );
      if (user && !user.expired && !expiringSoon && user?.access_token) {
        return user.access_token;
      } else {
        // renewToken handles its own failures (including signing in again)
        const refreshed = await this.renewToken();
        return refreshed?.access_token;
      }
    } catch (error) {
      await this.handleError(error);
    }
  }

  async getProfile(): Promise<any | undefined> {
    const user = await this.getUser();
    return user?.profile;
  }

  getRedirectUrl(): string {
    let url = this.redirect_url;
    this.redirect_url = "";
    return url;
  }

  async signinCallback(): Promise<User | undefined> {
    if (isLocalDemoMode()) {
      const demoUser = buildLocalDemoUser(this.getDemoPersona());
      this._user.set(demoUser);
      this._authenticated.set(true);
      return demoUser;
    }
    this.processingCallback = true;
    try {
      const user = await this.userManager.signinCallback();
      safeStorageRemove('sessionStorage', CALLBACK_RETRY_KEY);
      if (user) {
        safeStorageRemove('sessionStorage', AUTH_METHOD_STORAGE_KEY);
        safeStorageRemove('sessionStorage', SEEDED_PROFILE_SLUG_KEY);
        this.redirect_url = user.url_state ?? "";
        this.storeUser(user);
        return user;
      }
    } catch (error) {
      // A callback can fail after a long idle, e.g. the IdP's login page timed
      // out or the sign-in state was cleared. Restart login once; the IdP
      // session from the login that just happened usually completes it silently.
      if (safeStorageGet('sessionStorage', CALLBACK_RETRY_KEY)) {
        safeStorageRemove('sessionStorage', CALLBACK_RETRY_KEY);
        this._error.set(error);
        console.error(error);
        return;
      }
      safeStorageSet('sessionStorage', CALLBACK_RETRY_KEY, '1');
      await this.handleError(error);
    } finally {
      this.processingCallback = false;
    }
  }

  storeUser(user: User | null): void {
    if (!user) {
      this._user.set(null);
      this._authenticated.set(false);
      this.userManager.clearStaleState();
      return;
    }
    this._user.set(user);
    this._authenticated.set(true);
    this.userManager.storeUser(user);
  }

  async login(): Promise<void> {
    if (isLocalDemoMode()) {
      const demoUser = buildLocalDemoUser(this.getDemoPersona());
      this._user.set(demoUser);
      this._authenticated.set(true);
      return;
    }
    // Token expiry, silent renew failure and page checks can all request a
    // login at once after an idle period; only start one redirect.
    if (this.loginInProgress) {
      return this.loginInProgress;
    }
    let currentUrl = new URL(window.location.href.split('?')[0]);
    let redirectUrl = currentUrl.href;
    if (currentUrl.pathname === '/' || currentUrl.pathname === '/home') {
      redirectUrl = INSTANCE_CONFIG.defaultRedirectURI ?? '/data';
    }
    const redirect = this.userManager.signinRedirect({ url_state: redirectUrl })
      .finally(() => {
        this.loginInProgress = null;
      });
    this.loginInProgress = redirect;
    return await redirect;
  }

  private buildAndStoreTokenResponseUser(
    data: Record<string, any>,
    fallback: {
      slug?: string;
      profile?: Record<string, any>;
      refresh_token?: string;
      id_token?: string;
      session_state?: any;
      scope?: string;
    } = {}
  ): User {
    const claims = {
      ...decodeJwtPayload(data.access_token),
      ...decodeJwtPayload(data.id_token || fallback.id_token)
    };
    const acct = data.account || {};
    const prevProfile = fallback.profile || {};
    const slug = fallback.slug || '';
    const nowSec = Math.floor(Date.now() / 1000);
    const expiresIn = Number(data.expires_in) > 0 ? Number(data.expires_in) : 300;
    const expiresAt = typeof claims.exp === 'number' ? claims.exp : nowSec + expiresIn;
    const scopeStr = String(data.scope || fallback.scope || 'openid profile email');
    const profile = {
      ...prevProfile,
      ...claims,
      sub: String(claims.sub || prevProfile.sub || acct.slug || slug),
      given_name: claims.given_name || prevProfile.given_name || acct.givenName || acct.name || slug,
      family_name: claims.family_name || prevProfile.family_name || acct.familyName || '',
      name: claims.name || prevProfile.name || acct.name || slug,
      email: claims.email || prevProfile.email || acct.email || '',
      preferred_username:
        claims.preferred_username || prevProfile.preferred_username || acct.email || slug
    };

    const persistedPayload = {
      id_token: data.id_token ?? fallback.id_token,
      session_state: data.session_state ?? fallback.session_state ?? null,
      access_token: data.access_token,
      refresh_token: data.refresh_token ?? fallback.refresh_token,
      token_type: String(data.token_type || 'Bearer'),
      scope: scopeStr,
      profile,
      expires_at: expiresAt
    };

    const user = {
      ...persistedPayload,
      state: undefined,
      url_state: undefined,
      get expires_in() {
        return Math.max(0, Math.floor((this.expires_at ?? 0) - Date.now() / 1000));
      },
      get expired() {
        return (this.expires_at ?? 0) <= Math.floor(Date.now() / 1000);
      },
      scopes: scopeStr.split(/\s+/).filter(Boolean),
      toStorageString: () => JSON.stringify(persistedPayload)
    } as unknown as User;

    this.storeUser(user);
    return user;
  }

  async loginWithSeededProfile(slug: string): Promise<User> {
    if (isLocalDemoMode()) {
      const demoUser = this.setDemoPersona(slug);
      await this.syncTokenToServer('local-demo-token').catch(() => false);
      return demoUser;
    }

    const resp = await fetch('/auth/seeded-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug })
    });
    const data = await resp.json().catch(() => ({} as Record<string, any>));
    if (!resp.ok) {
      throw new Error(data?.message || data?.error || `Seeded profile sign-in failed (${resp.status})`);
    }
    if (data?.localDemo) {
      return this.setDemoPersona(slug);
    }
    if (!data?.access_token) {
      throw new Error('Seeded profile sign-in response missing access_token');
    }

    safeStorageRemove('sessionStorage', CALLBACK_RETRY_KEY);
    safeStorageSet('sessionStorage', AUTH_METHOD_STORAGE_KEY, 'seeded_profile');
    safeStorageSet('sessionStorage', SEEDED_PROFILE_SLUG_KEY, slug);
    return this.buildAndStoreTokenResponseUser(data, { slug });
  }

  async isAuthenticated(): Promise<boolean | undefined> {
    if (isLocalDemoMode()) {
      const demoUser = buildLocalDemoUser(this.getDemoPersona());
      this._user.set(demoUser);
      this._authenticated.set(true);
      return true;
    }
    try {
      const user = await this.userManager.getUser();
      if (user) {
        this.storeUser(user);
        return true;
      } else {
        return false;
      }
    } catch (error) {
      await this.handleError(error);
    }
  }

  /**
   * For public pages: if this tab has no stored user (oidc-client-ts keeps users in
   * per-tab sessionStorage), try to pick up the existing identity provider session
   * through a hidden iframe. Never redirects and never throws; resolves false if
   * there is no session or it can't be reached in time.
   */
  async restoreSession(timeoutMs: number = 4000): Promise<boolean> {
    if (isLocalDemoMode()) {
      const demoUser = buildLocalDemoUser(this.getDemoPersona());
      this._user.set(demoUser);
      this._authenticated.set(true);
      return true;
    }
    try {
      const stored = await this.userManager.getUser();
      if (stored && !stored.expired) {
        return await this.isAuthenticated() ?? false;
      }
      const user = await Promise.race([
        this.userManager.signinSilent(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs))
      ]);
      if (!user) {
        console.warn(`restoreSession: silent sign-in did not complete within ${timeoutMs}ms`);
        await this.clearExpiredUser(stored);
        return false;
      }
      this.storeUser(user);
      if (user.access_token) {
        await this.syncTokenToServer(user.access_token);
      }
      return true;
    } catch (error) {
      // login_required etc: simply not signed in
      console.warn('restoreSession: silent sign-in failed', error);
      this.userManager.clearStaleState();
      await this.clearExpiredUser();
      return false;
    }
  }

  /** Drops a stored user whose session could not be renewed, so the app shows it as signed out. */
  private async clearExpiredUser(stored?: User | null): Promise<void> {
    const user = stored === undefined ? await this.userManager.getUser() : stored;
    if (user?.expired) {
      await this.userManager.removeUser();
      this.storeUser(null);
    }
  }

  private async _attemptQuietRecovery(): Promise<User | null> {
    let stored: User | null = null;
    try {
      stored = (await this.userManager.getUser()) ?? null;
    } catch {
      stored = null;
    }
    if (stored?.refresh_token) {
      try {
        const resp = await fetch('/auth/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: stored.refresh_token })
        });
        const data = await resp.json().catch(() => ({} as Record<string, any>));
        if (resp.ok && data?.access_token) {
          return this.buildAndStoreTokenResponseUser(data, {
            slug: safeStorageGet('sessionStorage', SEEDED_PROFILE_SLUG_KEY) || undefined,
            profile: stored.profile as Record<string, any> | undefined,
            refresh_token: stored.refresh_token,
            id_token: stored.id_token,
            session_state: stored.session_state,
            scope: stored.scope
          });
        }
      } catch {
        // Fall through to seeded-profile recovery if configured
      }
    }

    const seededSlug = safeStorageGet('sessionStorage', SEEDED_PROFILE_SLUG_KEY);
    if (seededSlug) {
      try {
        return await this.loginWithSeededProfile(seededSlug);
      } catch {
        return null;
      }
    }
    return null;
  }

  private async recoverSessionQuietly(): Promise<User | null> {
    if (this.quietRecoverInProgress) {
      return await this.quietRecoverInProgress;
    }
    const promise = this._attemptQuietRecovery().finally(() => {
      this.quietRecoverInProgress = null;
    });
    this.quietRecoverInProgress = promise;
    return await promise;
  }

  async renewToken(): Promise<User | null> {
    if (this.renewInProgress) {
      return (await this.renewInProgress) ?? null;
    }
    const promise = (async () => {
      try {
        const quiet = await this.recoverSessionQuietly();
        if (quiet) {
          return quiet;
        }
        const user = await this.userManager.signinSilent();
        if (user) {
          this.storeUser(user);
          if (user.access_token) {
            // Awaited here (rather than left to addUserLoaded) so callers that
            // depend on the cookie being set, like invalidateAll(), don't race it.
            const synced = await this.syncTokenToServer(user.access_token);
            if (!synced) {
              await this.login();
            }
          }
          return user;
        } else {
          throw Error('Unable to authenticate user in background');
        }
      } catch (error) {
        await this.handleError(error);
        return null;
      }
    })().finally(() => {
      this.renewInProgress = null;
    });
    this.renewInProgress = promise;
    return await promise;
  }

  protected navigateTo(url: string): void {
    if (typeof window !== 'undefined') {
      window.location.assign(url);
    }
  }

  async logout(): Promise<void> {
    if (typeof window !== 'undefined') {
      await fetch('/auth/settoken', { method: 'DELETE' }).catch(() => {});
    }
    const isSeededAuth =
      safeStorageGet('sessionStorage', AUTH_METHOD_STORAGE_KEY) === 'seeded_profile';
    safeStorageRemove('sessionStorage', AUTH_METHOD_STORAGE_KEY);
    safeStorageRemove('sessionStorage', SEEDED_PROFILE_SLUG_KEY);
    if (isSeededAuth) {
      await this.userManager.removeUser();
      this.storeUser(null);
      this.navigateTo('/');
      return;
    }
    await this.userManager.signoutRedirect();
  }
}

export default AuthService;
