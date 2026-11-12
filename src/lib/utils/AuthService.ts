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
import { INSTANCE_CONFIG } from '$lib/config/instance_config';
import type { IAuthService } from '$lib/utils/types';

// Set when a failed sign-in callback has already restarted login once, so a
// callback that keeps failing surfaces an error instead of redirecting forever.
const CALLBACK_RETRY_KEY = 'auth:callbackRetry';
const DEMO_PERSONA_STORAGE_KEY = 'wahs:demoPersona';

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
      const savedPersona =
        typeof window !== 'undefined'
          ? window.localStorage.getItem(DEMO_PERSONA_STORAGE_KEY) || 'alex'
          : 'alex';
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
      scope: "openid profile online_access",
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
    this.userManager.events.addSilentRenewError((error: Error) => {
      console.error('Silent renew failed', error);
      return this.sessionEnded();
    });
    this.userManager.events.addAccessTokenExpired(() => {
      // Safety net in case automaticSilentRenew's own retry didn't recover in time.
      // Skipped mid-callback: a stale expired user left in sessionStorage fires
      // this on page load, and clearing it would race the sign-in in progress.
      if (this.processingCallback) return;
      return this.sessionEnded();
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
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(DEMO_PERSONA_STORAGE_KEY, persona);
    }
    const demoUser = buildLocalDemoUser(persona);
    this._user.set(demoUser);
    this._authenticated.set(true);
    return demoUser;
  }

  getDemoPersona(): string {
    if (typeof window !== 'undefined') {
      return window.localStorage.getItem(DEMO_PERSONA_STORAGE_KEY) || 'alex';
    }
    return 'alex';
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
      if (user && !user.expired && user?.access_token) {
        return user.access_token;
      } else {
        // renewToken handles its own failures (including signing in again)
        const user = await this.renewToken();
        return user?.access_token;
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
      sessionStorage.removeItem(CALLBACK_RETRY_KEY);
      if (user) {
        this.redirect_url = user.url_state ?? "";
        this.storeUser(user);
        return user;
      }
    } catch (error) {
      // A callback can fail after a long idle, e.g. the IdP's login page timed
      // out or the sign-in state was cleared. Restart login once; the IdP
      // session from the login that just happened usually completes it silently.
      if (sessionStorage.getItem(CALLBACK_RETRY_KEY)) {
        sessionStorage.removeItem(CALLBACK_RETRY_KEY);
        this._error.set(error);
        console.error(error);
        return;
      }
      sessionStorage.setItem(CALLBACK_RETRY_KEY, '1');
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

  async renewToken(): Promise<User | null> {
    try {
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
    }
  }

  async logout(): Promise<void> {
    await this.userManager.signoutRedirect();
  }
}

export default AuthService;
