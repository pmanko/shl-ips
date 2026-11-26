import { json, type RequestHandler } from '@sveltejs/kit';
import {
  SERVER_LOCAL_DEMO_MODE,
  WAHS_DEFAULT_MODEL,
  WAHS_DEFAULT_PROFILE,
  WAHS_DEFAULT_TARGET_BUDGET_TOKENS,
  WAHS_ENGINE_URL
} from '$lib/server/config';

const SAFE_PROFILE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const ALLOWED_ENRICHER_IDS = new Set([
  'temporal',
  'terminology_kb',
  'note_rag',
  'overflow_lookup',
  'guideline_kb',
  'core_generalizable',
  'all_generalizable'
]);

export const DEFAULT_ENRICHER_CATALOG = [
  { id: 'temporal', label: 'Temporal Anchor & Lab Trends', short_label: 'Temporal' },
  { id: 'terminology_kb', label: 'CIEL & Public Standards Terminology KB', short_label: 'CIEL/Standards KB' },
  { id: 'note_rag', label: 'Tier-2 Unseen-Span Note RAG', short_label: 'Note RAG' },
  { id: 'overflow_lookup', label: 'Tier-2 Overflow Item Recovery', short_label: 'Overflow' },
  { id: 'guideline_kb', label: 'Public Clinical Guideline Snippets [K1]', short_label: 'Guidelines [K1]' }
];

export const DEFAULT_PROFILES_MAP: Record<string, any> = {
  'core-enriched': {
    id: 'core-enriched',
    label: 'WAHS + Core Enrichers (Temporal, Terminology, RAG, Overflow)',
    enrichers: ['temporal', 'terminology_kb', 'note_rag', 'overflow_lookup'],
    preferred_chart_tokens: 16384
  },
  baseline: {
    id: 'baseline',
    label: 'WAHS Verbatim Condensation',
    enrichers: [],
    preferred_chart_tokens: null
  },
  'full-enriched': {
    id: 'full-enriched',
    label: 'WAHS + Core Enrichers + Public Guideline Snippets',
    enrichers: ['temporal', 'terminology_kb', 'note_rag', 'overflow_lookup', 'guideline_kb'],
    preferred_chart_tokens: 32768
  },
  'rag-overflow': {
    id: 'rag-overflow',
    label: 'WAHS + Tier-2 Note RAG & Overflow Recovery',
    enrichers: ['note_rag', 'overflow_lookup'],
    preferred_chart_tokens: 16384
  },
  terminology: {
    id: 'terminology',
    label: 'WAHS + CIEL & Public Standards Terminology KB',
    enrichers: ['terminology_kb'],
    preferred_chart_tokens: 32768
  },
  temporal: {
    id: 'temporal',
    label: 'WAHS + Temporal Anchor & Trends',
    enrichers: ['temporal'],
    preferred_chart_tokens: 32768
  },
  'temporal-terminology': {
    id: 'temporal-terminology',
    label: 'WAHS + Temporal & Terminology KB',
    enrichers: ['temporal', 'terminology_kb'],
    preferred_chart_tokens: 32768
  }
};

export function resolveEngineV1Base(rawUrl: string = WAHS_ENGINE_URL): string {
  const trimmed = (rawUrl || 'http://wahs-engine:8080/v1').replace(/\/+$/, '');
  if (trimmed.endsWith('/v1')) {
    return trimmed;
  }
  return `${trimmed}/v1`;
}

function buildEngineHeaders(authHeader: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json'
  };
  if (authHeader && authHeader !== 'Bearer local-demo-token') {
    headers['Authorization'] = authHeader;
  }
  return headers;
}

export function buildEngineChatPayload(
  body: Record<string, any>,
  allowLocalBundle: boolean = SERVER_LOCAL_DEMO_MODE,
  isPreview: boolean = false
): Record<string, any> {
  const wahsIn = body?.wahs && typeof body.wahs === 'object' ? body.wahs : {};
  const rawMessages = Array.isArray(body?.messages) ? body.messages : [];
  const messages =
    rawMessages.length > 0
      ? rawMessages
      : isPreview
        ? [{ role: 'user', content: 'Preview context' }]
        : [];

  const rawBudget = wahsIn.target_budget_tokens ?? body?.target_budget_tokens;
  const parsedBudget =
    rawBudget !== undefined && rawBudget !== null && rawBudget !== '' ? Number(rawBudget) : null;

  const rawProfile = wahsIn.profile ?? body?.profile;
  const parsedProfile =
    typeof rawProfile === 'string' && SAFE_PROFILE_RE.test(rawProfile.trim())
      ? rawProfile.trim()
      : null;

  const rawEnrichers = wahsIn.enrichers ?? body?.enrichers;
  const parsedEnrichers = Array.isArray(rawEnrichers)
    ? Array.from(
        new Set(
          rawEnrichers
            .map((e: any) => String(e || '').trim())
            .filter((eid: string) => ALLOWED_ENRICHER_IDS.has(eid))
        )
      )
    : null;

  const wahsOptions: Record<string, any> = {
    ...(parsedBudget !== null && Number.isFinite(parsedBudget) && parsedBudget > 0
      ? { target_budget_tokens: Math.trunc(parsedBudget) }
      : {}),
    ...(parsedProfile !== null ? { profile: parsedProfile } : {}),
    ...(parsedEnrichers !== null ? { enrichers: parsedEnrichers } : {}),
    chart_scope:
      wahsIn.chart_scope && typeof wahsIn.chart_scope === 'object'
        ? wahsIn.chart_scope
        : body?.chart_scope && typeof body.chart_scope === 'object'
          ? body.chart_scope
          : {},
    overlay_resources: Array.isArray(wahsIn.overlay_resources)
      ? wahsIn.overlay_resources
      : Array.isArray(body?.overlay_resources)
        ? body.overlay_resources
        : []
  };

  // Security invariant: never forward browser-supplied fhir_bundle outside explicit local demo mode.
  // In real deployments, wahs-engine resolves MasterPatient + linked datasets strictly via fhir-auth.
  const candidateBundle = wahsIn.fhir_bundle ?? body?.fhir_bundle;
  if (allowLocalBundle && candidateBundle && typeof candidateBundle === 'object') {
    wahsOptions.fhir_bundle = candidateBundle;
  }

  return {
    model: String(body?.model || WAHS_DEFAULT_MODEL),
    messages,
    stream: isPreview ? false : Boolean(body?.stream ?? true),
    temperature: typeof body?.temperature === 'number' ? body.temperature : 0.1,
    max_tokens: typeof body?.max_tokens === 'number' ? body.max_tokens : 1024,
    wahs: wahsOptions
  };
}

export const GET: RequestHandler = async ({ request, fetch }) => {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return json({ error: 'Missing Authorization Bearer token' }, { status: 401 });
  }

  const engineBase = resolveEngineV1Base();
  const headers = buildEngineHeaders(authHeader);
  try {
    const [upstream, profilesResp] = await Promise.all([
      fetch(`${engineBase}/models`, { method: 'GET', headers }),
      fetch(`${engineBase}/wahs/profiles`, { method: 'GET', headers }).catch(() => null)
    ]);
    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => upstream.statusText);
      return json(
        { error: `wahs-engine /v1/models returned ${upstream.status}`, detail },
        { status: upstream.status }
      );
    }
    const payload = await upstream.json();
    const profilesPayload =
      profilesResp && profilesResp.ok
        ? await profilesResp.json().catch(() => null)
        : null;
    const hasEngineProfiles =
      profilesPayload &&
      typeof profilesPayload === 'object' &&
      profilesPayload.profiles &&
      typeof profilesPayload.profiles === 'object';

    return json({
      ...payload,
      default_model:
        payload?.default_model ||
        (hasEngineProfiles ? profilesPayload.default_model : null) ||
        WAHS_DEFAULT_MODEL,
      default_profile:
        (hasEngineProfiles ? profilesPayload.default_profile : null) || WAHS_DEFAULT_PROFILE,
      default_target_budget_tokens:
        hasEngineProfiles && typeof profilesPayload.default_target_budget_tokens === 'number'
          ? profilesPayload.default_target_budget_tokens
          : WAHS_DEFAULT_TARGET_BUDGET_TOKENS,
      available_enrichers:
        hasEngineProfiles && Array.isArray(profilesPayload.available_enrichers)
          ? profilesPayload.available_enrichers
          : DEFAULT_ENRICHER_CATALOG,
      profiles: hasEngineProfiles ? profilesPayload.profiles : DEFAULT_PROFILES_MAP
    });
  } catch (err: any) {
    return json(
      {
        object: 'list',
        default_model: WAHS_DEFAULT_MODEL,
        default_profile: WAHS_DEFAULT_PROFILE,
        default_target_budget_tokens: WAHS_DEFAULT_TARGET_BUDGET_TOKENS,
        available_enrichers: DEFAULT_ENRICHER_CATALOG,
        profiles: DEFAULT_PROFILES_MAP,
        data: [
          { id: 'wahs-26b', object: 'model' },
          { id: 'wahs-12b', object: 'model' },
          { id: 'wahs-e4b', object: 'model' }
        ],
        fallback: true,
        warning: err?.message || 'wahs-engine unreachable'
      },
      { status: 200 }
    );
  }
};

export const POST: RequestHandler = async ({ request, url, fetch }) => {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return json({ error: 'Missing Authorization Bearer token' }, { status: 401 });
  }

  let body: Record<string, any>;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON request body' }, { status: 400 });
  }

  const isPreview = url.searchParams.get('mode') === 'preview' || body?.mode === 'preview';
  const isLocalDemoToken = authHeader === 'Bearer local-demo-token';
  const payload = buildEngineChatPayload(
    body,
    SERVER_LOCAL_DEMO_MODE && isLocalDemoToken,
    isPreview
  );

  if (!isPreview && (!Array.isArray(payload.messages) || payload.messages.length === 0)) {
    return json({ error: 'messages array must not be empty' }, { status: 400 });
  }

  const engineBase = resolveEngineV1Base();
  const targetEndpoint = isPreview
    ? `${engineBase}/wahs/context/preview`
    : `${engineBase}/chat/completions`;

  let upstream: Response;
  try {
    upstream = await fetch(targetEndpoint, {
      method: 'POST',
      headers: buildEngineHeaders(authHeader),
      body: JSON.stringify(payload)
    });
  } catch (err: any) {
    return json(
      { error: `Unable to reach wahs-engine at ${engineBase}`, detail: err?.message },
      { status: 502 }
    );
  }

  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => upstream.statusText);
    return new Response(errText, {
      status: upstream.status,
      headers: {
        'Content-Type': upstream.headers.get('Content-Type') || 'application/json'
      }
    });
  }

  const prefixHash = upstream.headers.get('X-WAHS-Prefix-Hash');
  if (isPreview || !payload.stream) {
    const data = await upstream.text();
    const outHeaders: Record<string, string> = {
      'Content-Type': 'application/json'
    };
    if (prefixHash) {
      outHeaders['X-WAHS-Prefix-Hash'] = prefixHash;
    }
    return new Response(data, { status: 200, headers: outHeaders });
  }

  const streamHeaders: Record<string, string> = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  };
  if (prefixHash) {
    streamHeaders['X-WAHS-Prefix-Hash'] = prefixHash;
  }

  return new Response(upstream.body, {
    status: 200,
    headers: streamHeaders
  });
};
