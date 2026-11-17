<script lang="ts">
  import { getContext, onMount } from 'svelte';
  import { INSTANCE_CONFIG } from '$lib/config/instance_config';
  import {
    SEEDED_DEMO_ACCOUNTS,
    findSeededProfile,
    type SeededPatientProfile
  } from '$lib/utils/seededProfiles';
  import type { IAuthService } from '$lib/utils/types';

  export let nextPath: string = INSTANCE_CONFIG.defaultRedirectURI ?? '/data';

  let authService: IAuthService | undefined = getContext('authService');

  let enabled = true;
  let accounts: readonly SeededPatientProfile[] = SEEDED_DEMO_ACCOUNTS;
  let selectedSlug = '';
  let showDirectory = false;
  let submitting = false;
  let errorMsg = '';

  $: activeEntry =
    accounts.find((a) => (a.slug || a.id) === selectedSlug) ?? null;

  function resolvePostLoginPath(rawNext: string | null): string {
    const fallback = INSTANCE_CONFIG.defaultRedirectURI ?? '/data';
    const candidate = (rawNext || nextPath || fallback).trim();
    if (!candidate.startsWith('/') || candidate.startsWith('//')) {
      return fallback;
    }
    return candidate;
  }

  export async function signInWithProfile(slug: string): Promise<void> {
    if (submitting || !slug) return;
    if (typeof authService?.loginWithSeededProfile !== 'function') {
      errorMsg = 'Seeded profile sign-in is unavailable in this environment.';
      return;
    }
    errorMsg = '';
    submitting = true;
    try {
      await authService.loginWithSeededProfile(slug);
      if (typeof window !== 'undefined') {
        const qs = new URLSearchParams(window.location.search);
        window.location.assign(resolvePostLoginPath(qs.get('next')));
      }
    } catch (err: any) {
      errorMsg = err?.message || 'Unable to sign in with seeded patient profile.';
      submitting = false;
    }
  }

  onMount(async () => {
    if (typeof window === 'undefined') return;
    const qs = new URLSearchParams(window.location.search);
    const requested = findSeededProfile(qs.get('profile') || '');
    if (requested) {
      selectedSlug = requested.slug;
    }

    if (typeof fetch === 'function') {
      try {
        const resp = await fetch('/auth/seeded-login', { credentials: 'same-origin' });
        if (resp.ok) {
          const data = await resp.json().catch(() => null);
          if (data && typeof data.enabled === 'boolean') {
            enabled = data.enabled;
          }
          if (Array.isArray(data?.accounts) && data.accounts.length > 0) {
            accounts = data.accounts;
          }
        }
      } catch {
        // Keep static SEEDED_DEMO_ACCOUNTS fallback when offline or in unit tests
      }
    }
  });
</script>

{#if enabled && accounts.length > 0}
  <div class="card border-0 shadow-sm mt-3 text-start">
    <div class="card-body p-3">
      <div class="d-flex align-items-center justify-content-between gap-2 mb-2">
        <span
          class="text-primary fw-bold text-uppercase"
          style="font-size: 0.72rem; letter-spacing: 0.05em;"
        >
          Seeded Clinical Profiles ({accounts.length} Real Keycloak Accounts)
        </span>
        <button
          type="button"
          class="btn btn-link btn-sm p-0 text-decoration-none fw-semibold"
          aria-expanded={showDirectory}
          disabled={submitting}
          on:click={() => (showDirectory = !showDirectory)}
        >
          {showDirectory ? 'Hide all ▲' : 'Browse all ▾'}
        </button>
      </div>

      <select
        class="form-select form-select-sm fw-semibold"
        aria-label="Choose Seeded Patient Account"
        bind:value={selectedSlug}
        disabled={submitting}
      >
        <option value="">Select a seeded patient ({accounts.length} available)…</option>
        {#each accounts as acct (acct.slug || acct.id)}
          <option value={acct.slug || acct.id}>
            {acct.name} ({acct.email}) — {acct.cohort}
          </option>
        {/each}
      </select>

      {#if activeEntry}
        <div class="mt-2 pt-1">
          <div class="text-muted mb-2" style="font-size: 0.78rem; line-height: 1.4;">
            <strong>Clinical focus:</strong> {activeEntry.clinicalFocus}
          </div>
          <button
            type="button"
            class="btn btn-primary btn-sm w-100 fw-semibold"
            disabled={submitting}
            on:click={() => signInWithProfile(activeEntry.slug || activeEntry.id)}
          >
            {submitting
              ? `Signing in as ${activeEntry.name}…`
              : `Continue as ${activeEntry.name} →`}
          </button>
        </div>
      {/if}

      {#if errorMsg}
        <div class="alert alert-danger py-1 px-2 mt-2 mb-0" role="alert" style="font-size: 0.78rem;">
          {errorMsg}
        </div>
      {/if}

      {#if showDirectory}
        <div
          class="mt-2 pt-2 border-top d-grid gap-2"
          style="max-height: 230px; overflow-y: auto;"
        >
          {#each accounts as acct (acct.slug || acct.id)}
            <button
              type="button"
              class="btn btn-outline-secondary btn-sm text-start bg-white text-dark"
              disabled={submitting}
              on:click={() => signInWithProfile(acct.slug || acct.id)}
            >
              <div class="fw-bold" style="font-size: 0.8rem;">
                {acct.name}
                <span class="text-primary fw-semibold">· {acct.cohort}</span>
              </div>
              <div class="text-muted" style="font-size: 0.73rem;">
                {acct.email} — {acct.clinicalFocus}
              </div>
            </button>
          {/each}
        </div>
      {/if}
    </div>
  </div>
{/if}
