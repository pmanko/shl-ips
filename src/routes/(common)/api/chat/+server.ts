import { json, type RequestHandler } from '@sveltejs/kit';
import { SERVER_LOCAL_DEMO_MODE, WAHS_ENGINE_URL } from '$lib/server/config';

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
  const wahsIn = (body?.wahs && typeof body.wahs === 'object') ? body.wahs : {};
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

  const wahsOptions: Record<string, any> = {
    ...(parsedBudget !== null && Number.isFinite(parsedBudget) && parsedBudget > 0
      ? { target_budget_tokens: Math.trunc(parsedBudget) }
      : {}),
    sharing_posture: String(
      wahsIn.sharing_posture ?? body?.sharing_posture ?? 'patient_self'
    ),
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
    model: String(body?.model || 'wahs-12b-kb'),
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
  try {
    const upstream = await fetch(`${engineBase}/models`, {
      method: 'GET',
      headers: buildEngineHeaders(authHeader)
    });
    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => upstream.statusText);
      return json(
        { error: `wahs-engine /v1/models returned ${upstream.status}`, detail },
        { status: upstream.status }
      );
    }
    const payload = await upstream.json();
    return json(payload);
  } catch (err: any) {
    return json(
      {
        object: 'list',
        data: [
          { id: 'wahs-12b-kb', object: 'model' },
          { id: 'wahs-e4b-kb', object: 'model' },
          { id: 'wahs-26b-kb', object: 'model' }
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
  const payload = buildEngineChatPayload(body, SERVER_LOCAL_DEMO_MODE, isPreview);

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
