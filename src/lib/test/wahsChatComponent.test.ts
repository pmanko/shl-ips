import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { writable } from 'svelte/store';
import { buildColorMap } from '$lib/utils/colors';
import { fakeAuth } from '$lib/test/mocks';
import FHIRDataService from '$lib/utils/FHIRDataService';
import { ResourceCollection } from '$lib/utils/ResourceCollection';
import { CATEGORY_SYSTEM, METHOD_SYSTEM, SOURCE_NAME_SYSTEM } from '$lib/config/config';
import { CATEGORIES, METHODS } from '$lib/config/tags';
import {
  buildChartScopeSignature,
  buildPartitionKey,
  filterMessagesForScope,
  getScopedHistoryStorageKey,
  resolveChatSessionKey
} from '$lib/utils/wahsChatSession';

const { mockDemoMode } = vi.hoisted(() => ({
  mockDemoMode: { value: false }
}));

vi.mock('$lib/utils/localDemoPersonas', () => ({
  isLocalDemoMode: () => mockDemoMode.value
}));

import WAHSChat from '$lib/components/app/WAHSChat.svelte';

function makeSourceCollection(params: {
  patientId: string;
  sourceName: string;
  sourceUri: string;
  observationText: string;
}): ResourceCollection {
  return new ResourceCollection([
    {
      resourceType: 'Patient',
      id: params.patientId,
      meta: {
        source: params.sourceUri,
        tag: [
          { system: CATEGORY_SYSTEM, code: CATEGORIES.PROVIDER_HEALTH_RECORD },
          { system: METHOD_SYSTEM, code: METHODS.PROVIDER_HEALTH_RECORD_SOF },
          { system: SOURCE_NAME_SYSTEM, code: params.sourceName }
        ]
      }
    },
    {
      resourceType: 'Observation',
      id: `obs-${params.patientId}`,
      status: 'final',
      code: { text: params.observationText },
      subject: { reference: `Patient/${params.patientId}` }
    }
  ] as any);
}

function buildContext(fhirDataService: FHIRDataService) {
  return new Map<string, unknown>([
    ['fhirDataService', fhirDataService],
    ['authService', fakeAuth()],
    ['colorMap', writable(buildColorMap(['UW Medicine', 'MultiCare Behavioral Health']))]
  ]);
}

function makeSseResponse(replyText: string): Response {
  const encoder = new TextEncoder();
  const payload = [
    `data: ${JSON.stringify({
      choices: [{ delta: { content: replyText } }],
      x_wahs: {
        citation_map: {},
        condensation: { tier: 1, tier_name: 'Focused', actual_tokens: 120, budget_tokens: 2048 },
        ai_provenance: { engine: 'wahs-engine', recorded_model: 'wahs-12b' }
      }
    })}\n\n`,
    'data: [DONE]\n\n'
  ].join('');
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(payload));
      controller.close();
    }
  });
  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'X-WAHS-Prefix-Hash': 'pref-hash-123456'
    }
  });
}

describe('wahsChatSession helpers', () => {
  it('builds collision-free chart scope signatures across included/excluded source lists', () => {
    const s1 = buildChartScopeSignature({
      includedSources: ['B Clinic', 'A Clinic'],
      excludedSources: { 'C, Inc | Behavioral': true, 'Unused Clinic': false }
    });
    const s2 = buildChartScopeSignature({
      includedSources: ['A Clinic', 'B Clinic'],
      excludedSources: { 'C, Inc | Behavioral': true }
    });
    const sSplitCollisionTest = buildChartScopeSignature({
      includedSources: ['A Clinic'],
      excludedSources: { 'B Clinic': true, 'C, Inc | Behavioral': true }
    });

    expect(s1).toBe(s2);
    expect(s1).not.toBe(sSplitCollisionTest);
  });

  it('resolves null while masterPatient is missing in authenticated mode and never falls back to authenticated', () => {
    expect(
      resolveChatSessionKey({ demoMode: false, activePersona: 'alex', masterPatientId: null })
    ).toBeNull();
    expect(
      resolveChatSessionKey({ demoMode: false, activePersona: 'alex', masterPatientId: '   ' })
    ).toBeNull();
    expect(
      resolveChatSessionKey({
        demoMode: false,
        activePersona: 'alex',
        masterPatientId: '  pat-789  '
      })
    ).toBe('pat-789');
    expect(
      resolveChatSessionKey({ demoMode: true, activePersona: 'leo', masterPatientId: null })
    ).toBe('leo');
  });

  it('filters messages strictly by activeScopeSignature and drops empty/untagged entries', () => {
    const scopeA = buildChartScopeSignature({
      includedSources: ['UW Medicine', 'MultiCare Behavioral Health'],
      excludedSources: {}
    });
    const scopeB = buildChartScopeSignature({
      includedSources: ['UW Medicine'],
      excludedSources: { 'MultiCare Behavioral Health': true }
    });

    const filtered = filterMessagesForScope(
      [
        { role: 'user', content: 'Sensitive note?', scopeSignature: scopeA },
        { role: 'assistant', content: 'MultiCare counseling details', scopeSignature: scopeA },
        { role: 'user', content: 'Legacy untagged message' },
        { role: 'user', content: '   ', scopeSignature: scopeB },
        { role: 'user', content: 'Shareable summary please', scopeSignature: scopeB }
      ],
      scopeB
    );

    expect(filtered).toEqual([{ role: 'user', content: 'Shareable summary please' }]);
  });
});

describe('WAHSChat.svelte chart scope isolation & async masterPatient history restoration', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    mockDemoMode.value = false;
    window.localStorage.clear();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it('isolates conversation history when excluding and re-including a source', async () => {
    const chatRequests: Array<any> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/chat' && (!init?.method || init.method === 'GET')) {
        return new Response(JSON.stringify({ data: [{ id: 'wahs-12b' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      if (url.startsWith('/api/chat?mode=preview')) {
        return new Response(
          JSON.stringify({
            prefix_cache_key_hash: 'preview-hash-1',
            x_wahs: {
              condensation: { tier: 1, tier_name: 'Focused', actual_tokens: 90, budget_tokens: 2048 }
            }
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url === '/api/chat' && init?.method === 'POST') {
        const parsed = JSON.parse(String(init.body || '{}'));
        chatRequests.push(parsed);
        if (chatRequests.length === 1) {
          return makeSseResponse('Sensitive MultiCare counseling note [1]');
        }
        return makeSseResponse('UW Medicine blood pressure is stable.');
      }
      return new Response('{}', { status: 404 });
    }) as any;

    const fhirDataService = new FHIRDataService(fakeAuth());
    fhirDataService.setMasterPatient({
      resourceType: 'Patient',
      id: 'pat-scope-1',
      name: [{ given: ['Jordan'], family: 'Rivera' }]
    } as any);
    fhirDataService.addDatasetToUserResources(
      makeSourceCollection({
        patientId: 'ds-uw',
        sourceName: 'UW Medicine',
        sourceUri: 'uw-medicine',
        observationText: 'Hemoglobin A1c'
      })
    );
    fhirDataService.addDatasetToUserResources(
      makeSourceCollection({
        patientId: 'ds-multicare',
        sourceName: 'MultiCare Behavioral Health',
        sourceUri: 'multicare-bh',
        observationText: 'Counseling Followup'
      })
    );
    fhirDataService.loading.set(false);

    render(WAHSChat, { context: buildContext(fhirDataService) });

    const promptInput = await screen.findByPlaceholderText(
      "Ask a question about Jordan Rivera's health record..."
    );

    await fireEvent.input(promptInput, {
      target: { value: 'What behavioral health notes do I have?' }
    });
    await fireEvent.click(screen.getByRole('button', { name: /Send/i }));

    await waitFor(() => {
      expect(screen.getByText(/Sensitive MultiCare counseling note/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /MultiCare Behavioral Health/ })).not.toBeDisabled();
    });
    expect(chatRequests).toHaveLength(1);
    expect(chatRequests[0].messages).toEqual([
      { role: 'user', content: 'What behavioral health notes do I have?' }
    ]);

    // Exclude MultiCare Behavioral Health: prior Turn 1 must disappear and not be sent on Turn 2
    await fireEvent.click(screen.getByRole('button', { name: /MultiCare Behavioral Health/ }));

    await waitFor(() => {
      expect(screen.queryByText(/Sensitive MultiCare counseling note/)).not.toBeInTheDocument();
    });

    await fireEvent.input(promptInput, {
      target: { value: 'Summarize my remaining clinic records' }
    });
    await fireEvent.click(screen.getByRole('button', { name: /Send/i }));

    await waitFor(() => {
      expect(screen.getByText(/UW Medicine blood pressure is stable\./)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /MultiCare Behavioral Health/ })).not.toBeDisabled();
    });
    expect(chatRequests).toHaveLength(2);
    expect(chatRequests[1].wahs.chart_scope).toEqual({
      include_sources: ['UW Medicine']
    });
    expect(chatRequests[1].messages).toEqual([
      { role: 'user', content: 'Summarize my remaining clinic records' }
    ]);

    // Re-including MultiCare restores the original all-sources partition
    await fireEvent.click(screen.getByRole('button', { name: /MultiCare Behavioral Health/ }));
    await waitFor(() => {
      expect(screen.getByText(/Sensitive MultiCare counseling note/)).toBeInTheDocument();
    });
  });

  it('waits for async masterPatient resolution on reload before restoring saved history', async () => {
    const scopeSig = buildChartScopeSignature({
      includedSources: ['UW Medicine'],
      excludedSources: {}
    });
    const expectedStorageKey = getScopedHistoryStorageKey('master-patient-99', scopeSig);
    window.localStorage.setItem(
      expectedStorageKey,
      JSON.stringify([
        {
          id: 'user-prior-1',
          role: 'user',
          content: 'Prior reload question',
          timestamp: '09:00 AM',
          scopeSignature: scopeSig
        },
        {
          id: 'assistant-prior-1',
          role: 'assistant',
          content: 'Prior reload answer from saved history',
          timestamp: '09:00 AM',
          model: 'wahs-12b',
          scopeSignature: scopeSig
        }
      ])
    );

    const chatRequests: Array<any> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/chat' && (!init?.method || init.method === 'GET')) {
        return new Response(JSON.stringify({ data: [{ id: 'wahs-12b' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      if (url.startsWith('/api/chat?mode=preview')) {
        return new Response(
          JSON.stringify({
            prefix_cache_key_hash: 'preview-hash-reload',
            x_wahs: {
              condensation: { tier: 1, tier_name: 'Focused', actual_tokens: 80, budget_tokens: 2048 }
            }
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url === '/api/chat' && init?.method === 'POST') {
        chatRequests.push(JSON.parse(String(init.body || '{}')));
        return makeSseResponse('Follow-up response anchored on restored thread.');
      }
      return new Response('{}', { status: 404 });
    }) as any;

    const fhirDataService = new FHIRDataService(fakeAuth());
    fhirDataService.loading.set(true);

    render(WAHSChat, { context: buildContext(fhirDataService) });

    // Before masterPatient resolves: must stay in loading state and never touch 'authenticated' key
    const loadingInput = await screen.findByPlaceholderText('Loading your health summary...');
    expect(loadingInput).toBeDisabled();
    expect(
      Object.keys(window.localStorage).some((k) => k.includes('authenticated'))
    ).toBe(false);
    expect(screen.queryByText('Prior reload answer from saved history')).not.toBeInTheDocument();

    // Simulate layout's async loadUserData() finishing
    fhirDataService.addDatasetToUserResources(
      makeSourceCollection({
        patientId: 'ds-uw-99',
        sourceName: 'UW Medicine',
        sourceUri: 'uw-medicine',
        observationText: 'Lipid Panel'
      })
    );
    fhirDataService.setMasterPatient({
      resourceType: 'Patient',
      id: 'master-patient-99',
      name: [{ given: ['Taylor'], family: 'Chen' }]
    } as any);
    fhirDataService.loading.set(false);

    // Saved history under master-patient-99 restores automatically once loaded
    await waitFor(() => {
      expect(screen.getByText('Prior reload question')).toBeInTheDocument();
      expect(screen.getByText('Prior reload answer from saved history')).toBeInTheDocument();
    });

    const readyInput = await screen.findByPlaceholderText(
      "Ask a question about Taylor Chen's health record..."
    );
    expect(readyInput).not.toBeDisabled();

    // Follow-up turn sends the restored history and updates the same scoped storage partition
    await fireEvent.input(readyInput, { target: { value: 'Follow-up after reload' } });
    await fireEvent.click(screen.getByRole('button', { name: /Send/i }));

    await waitFor(() => {
      expect(
        screen.getByText('Follow-up response anchored on restored thread.')
      ).toBeInTheDocument();
      const storedAfter = JSON.parse(window.localStorage.getItem(expectedStorageKey) || '[]');
      expect(storedAfter).toHaveLength(4);
      expect(storedAfter[3].content).toBe('Follow-up response anchored on restored thread.');
    });
    expect(chatRequests).toHaveLength(1);
    expect(chatRequests[0].messages).toEqual([
      { role: 'user', content: 'Prior reload question' },
      { role: 'assistant', content: 'Prior reload answer from saved history' },
      { role: 'user', content: 'Follow-up after reload' }
    ]);

    expect(buildPartitionKey('master-patient-99', scopeSig)).toContain('master-patient-99');
  });

  it('retries POST /api/chat once with a renewed token when the first request returns 401', async () => {
    let chatPostAttempts = 0;
    const authHeadersSeen: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/chat' && (!init?.method || init.method === 'GET')) {
        return new Response(JSON.stringify({ data: [{ id: 'wahs-26b' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      if (url.startsWith('/api/chat?mode=preview')) {
        return new Response(JSON.stringify({ prefix_cache_key_hash: 'h1', x_wahs: {} }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      if (url === '/api/chat' && init?.method === 'POST') {
        chatPostAttempts += 1;
        authHeadersSeen.push(String((init.headers as Record<string, string>)?.Authorization || ''));
        if (chatPostAttempts === 1) {
          return new Response(JSON.stringify({ detail: 'Bearer JWT has expired.' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' }
          });
        }
        return makeSseResponse('Recovered smoothly after JWT refresh.');
      }
      return new Response('{}', { status: 404 });
    }) as any;

    let currentTok = 'expired-token-1';
    const authSpy = fakeAuth({
      getAccessToken: vi.fn(async () => currentTok),
      renewToken: vi.fn(async () => {
        currentTok = 'fresh-token-2';
        return { access_token: 'fresh-token-2' } as any;
      })
    });

    const fhirDataService = new FHIRDataService(authSpy);
    fhirDataService.addDatasetToUserResources(
      makeSourceCollection({
        patientId: 'ds-retry-1',
        sourceName: 'UW Medicine',
        sourceUri: 'uw-medicine',
        observationText: 'A1c'
      })
    );
    fhirDataService.setMasterPatient({
      resourceType: 'Patient',
      id: 'master-retry-1',
      name: [{ given: ['Jordan'], family: 'Retry' }]
    } as any);
    fhirDataService.loading.set(false);

    render(WAHSChat, {
      context: new Map<string, unknown>([
        ['fhirDataService', fhirDataService],
        ['authService', authSpy],
        ['colorMap', writable(buildColorMap(['UW Medicine']))]
      ])
    });

    const input = await screen.findByPlaceholderText(
      "Ask a question about Jordan Retry's health record..."
    );
    await fireEvent.input(input, { target: { value: 'Check my A1c' } });
    await fireEvent.click(screen.getByRole('button', { name: /Send/i }));

    await waitFor(() => {
      expect(screen.getByText('Recovered smoothly after JWT refresh.')).toBeInTheDocument();
    });
    expect(chatPostAttempts).toBe(2);
    expect(authSpy.renewToken).toHaveBeenCalledTimes(1);
    expect(authHeadersSeen).toEqual(['Bearer expired-token-1', 'Bearer fresh-token-2']);
  });

  it('defaults 3-part choice to wahs-26b + 16k + core-enriched and updates model, context size, and enrichment toggles', async () => {
    const chatRequests: Array<any> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/chat' && (!init?.method || init.method === 'GET')) {
        return new Response(
          JSON.stringify({
            default_model: 'wahs-26b',
            default_profile: 'core-enriched',
            default_target_budget_tokens: 16384,
            data: [{ id: 'wahs-26b' }, { id: 'wahs-12b' }, { id: 'wahs-e4b' }]
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.startsWith('/api/chat?mode=preview')) {
        return new Response(
          JSON.stringify({
            prefix_cache_key_hash: 'preview-hash-3part',
            x_wahs: {
              condensation: { tier: 1, tier_name: 'Focused', actual_tokens: 420, budget_effective: 16384 }
            }
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url === '/api/chat' && init?.method === 'POST') {
        chatRequests.push(JSON.parse(String(init.body || '{}')));
        return makeSseResponse('Grounded answer [1] with guideline [K1].');
      }
      return new Response('{}', { status: 404 });
    }) as any;

    const fhirDataService = new FHIRDataService(fakeAuth());
    fhirDataService.setMasterPatient({
      resourceType: 'Patient',
      id: 'pat-3part-1',
      name: [{ given: ['Casey'], family: 'Morgan' }]
    } as any);
    fhirDataService.addDatasetToUserResources(
      makeSourceCollection({
        patientId: 'ds-uw-3p',
        sourceName: 'UW Medicine',
        sourceUri: 'uw-medicine',
        observationText: 'Hemoglobin A1c'
      })
    );
    fhirDataService.loading.set(false);

    render(WAHSChat, { context: buildContext(fhirDataService) });

    const promptInput = await screen.findByPlaceholderText(
      "Ask a question about Casey Morgan's health record..."
    );

    // 1. Verify default 3-part selection: wahs-26b + 16k (16384) + Enrichers: 4/5 (Core)
    const enrichBtn = screen.getByRole('button', { name: 'Select enrichment options' });
    expect(enrichBtn).toHaveTextContent('Enrichers: 4/5 (Core)');

    await fireEvent.input(promptInput, { target: { value: 'Default 3-part check' } });
    await fireEvent.click(screen.getByRole('button', { name: /Send/i }));

    await waitFor(() => {
      expect(screen.getByText(/Grounded answer/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^\[K1\]$/ })).toBeInTheDocument();
    });
    expect(chatRequests[0].model).toBe('wahs-26b');
    expect(chatRequests[0].wahs.target_budget_tokens).toBe(16384);
    expect(chatRequests[0].wahs.profile).toBe('core-enriched');
    expect(chatRequests[0].wahs.enrichers).toEqual([
      'temporal',
      'terminology_kb',
      'note_rag',
      'overflow_lookup'
    ]);

    // 2. Open multi-select checkbox menu, check Public Guideline Snippets [K1] (-> 5/5 All / full-enriched)
    await fireEvent.change(screen.getByLabelText('Select clinical LLM'), {
      target: { value: 'wahs-12b' }
    });
    await fireEvent.change(screen.getByLabelText('Select chart token budget'), {
      target: { value: '32k' }
    });
    await fireEvent.click(enrichBtn);
    const guidelineCheckbox = screen.getByRole('checkbox', {
      name: /Public Guideline Snippets \[K1\]/i
    });
    expect(guidelineCheckbox).not.toBeChecked();
    await fireEvent.click(guidelineCheckbox);
    expect(enrichBtn).toHaveTextContent('Enrichers: 5/5 (All)');

    await fireEvent.input(promptInput, { target: { value: 'Updated 3-part check' } });
    await fireEvent.click(screen.getByRole('button', { name: /Send/i }));

    await waitFor(() => {
      expect(chatRequests).toHaveLength(2);
    });
    expect(chatRequests[1].model).toBe('wahs-12b');
    expect(chatRequests[1].wahs.target_budget_tokens).toBe(32768);
    expect(chatRequests[1].wahs.profile).toBe('full-enriched');
    expect(chatRequests[1].wahs.enrichers).toEqual([
      'temporal',
      'terminology_kb',
      'note_rag',
      'overflow_lookup',
      'guideline_kb'
    ]);

    // 3. Use Clear shortcut inside the checkbox menu (-> 0/5 None / baseline + enrichers: [])
    await fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(enrichBtn).toHaveTextContent('Enrichers: 0/5 (None)');

    await fireEvent.input(promptInput, { target: { value: 'Baseline verbatim check' } });
    await fireEvent.click(screen.getByRole('button', { name: /Send/i }));

    await waitFor(() => {
      expect(chatRequests).toHaveLength(3);
    });
    expect(chatRequests[2].wahs.profile).toBe('baseline');
    expect(chatRequests[2].wahs.enrichers).toEqual([]);
  });
});
