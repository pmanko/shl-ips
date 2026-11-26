import { describe, expect, it, vi } from 'vitest';
import {
  buildEngineChatPayload,
  GET,
  POST,
  resolveEngineV1Base
} from '../../routes/(common)/api/chat/+server';
import { getLocalDemoPersonaFixture } from '$lib/utils/localDemoPersonas';
import {
  resetWahsPrewarmStateForTests,
  warmWahsContextAfterSignIn
} from '$lib/utils/wahsPrewarm';
import { writable } from 'svelte/store';

describe('WAHS SvelteKit BFF /api/chat (+server.ts)', () => {
  it('normalizes WAHS_ENGINE_URL to /v1 base cleanly', () => {
    expect(resolveEngineV1Base('http://wahs-engine:8080')).toBe('http://wahs-engine:8080/v1');
    expect(resolveEngineV1Base('http://wahs-engine:8080/v1/')).toBe('http://wahs-engine:8080/v1');
    expect(resolveEngineV1Base('http://127.0.0.1:8095/')).toBe('http://127.0.0.1:8095/v1');
  });

  it('strips browser-supplied fhir_bundle and omits legacy flags while forwarding profile and generalizable enrichers', () => {
    const payload = buildEngineChatPayload(
      {
        model: 'wahs-12b',
        messages: [{ role: 'user', content: 'Check my medications' }],
        wahs: {
          target_budget_tokens: 16384,
          profile: 'core-enriched',
          enrichers: [
            'temporal',
            'terminology_kb',
            'experimental.clinical_reconciliation',
            'bogus'
          ],
          sharing_posture: 'external_share',
          retrieval_strategy: 'note_rag',
          enable_kb: true,
          chart_scope: { include_sources: ['UW Medicine Cardiology & Nephrology'] },
          overlay_resources: [{ resourceType: 'Goal', description: { text: 'Lower A1c' } }],
          fhir_bundle: { resourceType: 'Bundle', entry: [] }
        }
      },
      false,
      false
    );

    expect(payload.model).toBe('wahs-12b');
    expect(payload.wahs.target_budget_tokens).toBe(16384);
    expect(payload.wahs.profile).toBe('core-enriched');
    expect(payload.wahs.enrichers).toEqual(['temporal', 'terminology_kb']);
    expect(payload.wahs.sharing_posture).toBeUndefined();
    expect(payload.wahs.retrieval_strategy).toBeUndefined();
    expect(payload.wahs.enable_kb).toBeUndefined();
    expect(payload.wahs.chart_scope).toEqual({
      include_sources: ['UW Medicine Cardiology & Nephrology']
    });
    expect(payload.wahs.overlay_resources).toHaveLength(1);
    expect(payload.wahs.fhir_bundle).toBeUndefined();

    const baselineOverridePayload = buildEngineChatPayload(
      {
        model: 'wahs-26b',
        messages: [{ role: 'user', content: 'Verbatim check' }],
        wahs: { profile: 'baseline', enrichers: [] }
      },
      false,
      false
    );
    expect(baselineOverridePayload.wahs.profile).toBe('baseline');
    expect(baselineOverridePayload.wahs.enrichers).toEqual([]);

    const defaultPayload = buildEngineChatPayload(
      {
        model: 'wahs-12b',
        messages: [{ role: 'user', content: 'Check my medications' }]
      },
      false,
      false
    );
    expect(defaultPayload.wahs.target_budget_tokens).toBeUndefined();
    expect(defaultPayload.wahs.profile).toBeUndefined();
    expect(defaultPayload.wahs.enrichers).toBeUndefined();

    for (const invalidBudget of [0, -50, Number.NaN, null, '']) {
      const invalidPayload = buildEngineChatPayload(
        {
          model: 'wahs-12b',
          messages: [{ role: 'user', content: 'Check invalid budget' }],
          wahs: { target_budget_tokens: invalidBudget }
        },
        false,
        false
      );
      expect(invalidPayload.wahs.target_budget_tokens).toBeUndefined();
    }
  });

  it('forwards POST /api/chat?mode=preview to /v1/wahs/context/preview without target_budget_tokens and strips fhir_bundle', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          prefix_cache_key_hash: 'preview-hash-001',
          x_wahs: { condensation: { budget_effective: 16384 } }
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );
    const req = new Request('http://localhost:4000/api/chat?mode=preview', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyLXByZXYifQ.sig'
      },
      body: JSON.stringify({
        model: 'wahs-12b',
        wahs: {
          chart_scope: {},
          fhir_bundle: { resourceType: 'Bundle', entry: [] }
        }
      })
    });
    const res = await POST({
      request: req,
      url: new URL('http://localhost:4000/api/chat?mode=preview'),
      fetch: mockFetch
    } as any);
    expect(res.status).toBe(200);
    const [calledUrl, calledInit] = mockFetch.mock.calls[0];
    expect(calledUrl).toMatch(/\/v1\/wahs\/context\/preview$/);
    const forwarded = JSON.parse(calledInit.body);
    expect(forwarded.stream).toBe(false);
    expect(forwarded.messages).toEqual([{ role: 'user', content: 'Preview context' }]);
    expect(forwarded.wahs.target_budget_tokens).toBeUndefined();
    expect(forwarded.wahs.fhir_bundle).toBeUndefined();
  });

  it('rejects unauthenticated POST without Bearer header', async () => {
    const req = new Request('http://localhost:4000/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Hi' }] })
    });
    const res = await POST({
      request: req,
      url: new URL('http://localhost:4000/api/chat'),
      fetch: vi.fn()
    } as any);
    expect(res.status).toBe(401);
  });

  it('forwards Keycloak Bearer JWT, chart_scope, and streams SSE + x_wahs back to browser', async () => {
    const sseBody = [
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Warfarin [1] interacts with ibuprofen [2]."},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"x_wahs":{"citation_map":{"1":{"id":"alex-med-warfarin","resourceType":"MedicationRequest","source":"UW Medicine","display":"Warfarin 5 mg"}},"ai_provenance":{"resourceType":"Provenance","profile":"http://hl7.org/fhir/uv/aitransparency/StructureDefinition/AI-Provenance","recorded_model":"ollama/gemma4:12b","engine":"wahs-engine/0.2.0"}}}\n\n',
      'data: [DONE]\n\n'
    ].join('');

    const mockFetch = vi.fn().mockResolvedValue(
      new Response(sseBody, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'X-WAHS-Prefix-Hash': 'abc123def456'
        }
      })
    );

    const req = new Request('http://localhost:4000/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyLTFhMmIifQ.sig'
      },
      body: JSON.stringify({
        model: 'wahs-12b',
        stream: true,
        messages: [{ role: 'user', content: 'Any interactions?' }],
        wahs: {
          chart_scope: { include_sources: ['UW Medicine', 'MultiCare Urgent Care'] }
        }
      })
    });

    const res = await POST({
      request: req,
      url: new URL('http://localhost:4000/api/chat'),
      fetch: mockFetch
    } as any);

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/event-stream');
    expect(res.headers.get('X-WAHS-Prefix-Hash')).toBe('abc123def456');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = mockFetch.mock.calls[0];
    expect(calledUrl).toMatch(/\/v1\/chat\/completions$/);
    expect(calledInit.headers.Authorization).toBe(
      'Bearer eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyLTFhMmIifQ.sig'
    );
    const forwardedBody = JSON.parse(calledInit.body);
    expect(forwardedBody.wahs.chart_scope).toEqual({
      include_sources: ['UW Medicine', 'MultiCare Urgent Care']
    });

    const streamedText = await res.text();
    expect(streamedText).toContain('Warfarin [1] interacts with ibuprofen [2].');
    expect(streamedText).toContain('"x_wahs"');
    expect(streamedText).toContain('AI-Provenance');
  });

  it('proxies GET /api/chat to wahs-engine /v1/models + /v1/wahs/profiles and defaults to wahs-26b + 16k + core-enriched', async () => {
    const mockFetch = vi.fn(async (url: string) => {
      if (String(url).endsWith('/wahs/profiles')) {
        return new Response(
          JSON.stringify({
            default_model: 'wahs-26b',
            default_profile: 'core-enriched',
            default_target_budget_tokens: 16384,
            profiles: { 'core-enriched': { id: 'core-enriched', enrichers: ['temporal', 'terminology_kb', 'note_rag', 'overflow_lookup'] } }
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(JSON.stringify({ object: 'list', data: [{ id: 'wahs-12b' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    });
    const req = new Request('http://localhost:4000/api/chat', {
      method: 'GET',
      headers: { Authorization: 'Bearer real-jwt-token' }
    });
    const res = await GET({ request: req, fetch: mockFetch } as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data[0].id).toBe('wahs-12b');
    expect(body.default_model).toBe('wahs-26b');
    expect(body.default_profile).toBe('core-enriched');
    expect(body.default_target_budget_tokens).toBe(16384);

    const implicitModelPayload = buildEngineChatPayload(
      {
        messages: [{ role: 'user', content: 'Check default model' }]
      },
      false,
      false
    );
    expect(implicitModelPayload.model).toBe('wahs-26b');
  });

  it('builds valid multi-source WAHS FHIR R4 fixtures for alex and leo local demo personas', () => {
    const alex = getLocalDemoPersonaFixture('alex');
    expect(alex.masterPatient.link).toHaveLength(4);
    expect(alex.collections).toHaveLength(4);

    const leo = getLocalDemoPersonaFixture('leo');
    expect(leo.masterPatient.link).toHaveLength(3);
    expect(leo.collections).toHaveLength(3);
  });

  it('pre-warms /api/chat?mode=preview after sign-in data hydration, deduplicates, and skips on /chat or demo mode', async () => {
    resetWahsPrewarmStateForTests();
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const mockFetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ x_wahs: { ok: true } }), { status: 200 });
    });
    const fakeAuth = { getAccessToken: vi.fn(async () => 'jwt-real-token') };
    const fakeFhir = {
      masterPatient: writable({ resource: { id: 'pat-1' } } as any),
      getAllResourceCollections: vi.fn(() => [{} as any, {} as any])
    };

    expect(
      await warmWahsContextAfterSignIn({
        authService: fakeAuth,
        fhirDataService: fakeFhir,
        pathname: '/data',
        demoMode: true,
        fetchImpl: mockFetch as any
      })
    ).toBe(false);
    expect(
      await warmWahsContextAfterSignIn({
        authService: fakeAuth,
        fhirDataService: fakeFhir,
        pathname: '/chat',
        demoMode: false,
        fetchImpl: mockFetch as any
      })
    ).toBe(false);
    expect(calls).toHaveLength(0);

    expect(
      await warmWahsContextAfterSignIn({
        authService: fakeAuth,
        fhirDataService: fakeFhir,
        pathname: '/data',
        demoMode: false,
        fetchImpl: mockFetch as any
      })
    ).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/chat?mode=preview');
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({
      model: 'wahs-26b',
      wahs: {
        profile: 'core-enriched',
        target_budget_tokens: 16384,
        chart_scope: {}
      }
    });

    expect(
      await warmWahsContextAfterSignIn({
        authService: fakeAuth,
        fhirDataService: fakeFhir,
        pathname: '/data',
        demoMode: false,
        fetchImpl: mockFetch as any
      })
    ).toBe(false);
    expect(calls).toHaveLength(1);

    fakeFhir.masterPatient.set({ resource: { id: 'pat-2' } } as any);
    const errFetch = vi.fn(async () => {
      throw new Error('network down');
    });
    expect(
      await warmWahsContextAfterSignIn({
        authService: fakeAuth,
        fhirDataService: fakeFhir,
        pathname: '/data',
        demoMode: false,
        fetchImpl: errFetch as any
      })
    ).toBe(false);
  });
});
