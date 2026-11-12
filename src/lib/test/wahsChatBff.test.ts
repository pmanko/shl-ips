import { describe, expect, it, vi } from 'vitest';
import {
  buildEngineChatPayload,
  GET,
  POST,
  resolveEngineV1Base
} from '../../routes/(common)/api/chat/+server';
import { getLocalDemoPersonaFixture } from '$lib/utils/localDemoPersonas';

describe('WAHS SvelteKit BFF /api/chat (+server.ts)', () => {
  it('normalizes WAHS_ENGINE_URL to /v1 base cleanly', () => {
    expect(resolveEngineV1Base('http://wahs-engine:8080')).toBe('http://wahs-engine:8080/v1');
    expect(resolveEngineV1Base('http://wahs-engine:8080/v1/')).toBe('http://wahs-engine:8080/v1');
    expect(resolveEngineV1Base('http://127.0.0.1:8095/')).toBe('http://127.0.0.1:8095/v1');
  });

  it('strips browser-supplied fhir_bundle when allowLocalBundle is false (production zero-privilege boundary)', () => {
    const payload = buildEngineChatPayload(
      {
        model: 'wahs-12b-kb',
        messages: [{ role: 'user', content: 'Check my medications' }],
        wahs: {
          target_budget_tokens: 2400,
          sharing_posture: 'external_share',
          chart_scope: { include_sources: ['UW Medicine Cardiology & Nephrology'] },
          overlay_resources: [{ resourceType: 'Goal', description: { text: 'Lower A1c' } }],
          fhir_bundle: { resourceType: 'Bundle', entry: [] }
        }
      },
      false,
      false
    );

    expect(payload.model).toBe('wahs-12b-kb');
    expect(payload.wahs.target_budget_tokens).toBe(2400);
    expect(payload.wahs.sharing_posture).toBe('external_share');
    expect(payload.wahs.chart_scope).toEqual({
      include_sources: ['UW Medicine Cardiology & Nephrology']
    });
    expect(payload.wahs.overlay_resources).toHaveLength(1);
    expect(payload.wahs.fhir_bundle).toBeUndefined();
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
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"x_wahs":{"citation_map":{"1":{"id":"alex-med-warfarin","resourceType":"MedicationRequest","source":"UW Medicine","display":"Warfarin 5 mg"}},"ai_provenance":{"resourceType":"Provenance","profile":"http://hl7.org/fhir/uv/aitransparency/StructureDefinition/AI-Provenance","recorded_model":"gemma4:12b","engine":"wahs-engine/0.1.0"}}}\n\n',
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
        model: 'wahs-12b-kb',
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

  it('proxies GET /api/chat to wahs-engine /v1/models', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ object: 'list', data: [{ id: 'wahs-12b-kb' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    );
    const req = new Request('http://localhost:4000/api/chat', {
      method: 'GET',
      headers: { Authorization: 'Bearer real-jwt-token' }
    });
    const res = await GET({ request: req, fetch: mockFetch } as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data[0].id).toBe('wahs-12b-kb');
  });

  it('builds valid multi-source WAHS FHIR R4 fixtures for alex and leo local demo personas', () => {
    const alex = getLocalDemoPersonaFixture('alex');
    expect(alex.masterPatient.link).toHaveLength(4);
    expect(alex.collections).toHaveLength(4);

    const leo = getLocalDemoPersonaFixture('leo');
    expect(leo.masterPatient.link).toHaveLength(3);
    expect(leo.collections).toHaveLength(3);
  });
});
