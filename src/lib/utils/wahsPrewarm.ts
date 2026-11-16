import { get } from 'svelte/store';
import type FHIRDataService from '$lib/utils/FHIRDataService';
import { isLocalDemoMode } from '$lib/utils/localDemoPersonas';
import type { IAuthService } from '$lib/utils/types';

let lastPrewarmKey = '';

export function resetWahsPrewarmStateForTests(): void {
  lastPrewarmKey = '';
}

export interface WarmWahsContextOptions {
  authService: Pick<IAuthService, 'getAccessToken'>;
  fhirDataService: Pick<FHIRDataService, 'getAllResourceCollections' | 'masterPatient'>;
  pathname?: string;
  demoMode?: boolean;
  fetchImpl?: typeof fetch;
  defaultModel?: string;
}

export async function warmWahsContextAfterSignIn(opts: WarmWahsContextOptions): Promise<boolean> {
  const demoMode = opts.demoMode ?? isLocalDemoMode();
  if (demoMode) {
    return false;
  }
  const pathname = String(opts.pathname ?? '');
  if (pathname.startsWith('/chat')) {
    return false;
  }

  const collections = opts.fhirDataService.getAllResourceCollections();
  if (!Array.isArray(collections) || collections.length === 0) {
    return false;
  }

  const masterId = String(get(opts.fhirDataService.masterPatient)?.resource?.id ?? '').trim();
  const dedupKey = `${masterId}:${collections.length}`;
  if (lastPrewarmKey === dedupKey) {
    return false;
  }

  let token: string | null = null;
  try {
    token = await opts.authService.getAccessToken();
  } catch {
    return false;
  }
  if (!token || token === 'local-demo-token') {
    return false;
  }

  lastPrewarmKey = dedupKey;
  const fetchFn = opts.fetchImpl ?? fetch;
  try {
    const resp = await fetchFn('/api/chat?mode=preview', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        model: opts.defaultModel || 'wahs-26b-kb',
        wahs: {
          sharing_posture: 'patient_self',
          retrieval_strategy: 'condensation_kb',
          enable_kb: true,
          enable_temporal_digest: true,
          enable_overflow_tools: true,
          chart_scope: {}
        }
      })
    });
    return Boolean(resp?.ok);
  } catch {
    return false;
  }
}
