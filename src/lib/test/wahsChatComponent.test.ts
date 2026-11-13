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
  buildPartitionKey,
  buildPrivacyScopeSignature,
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
        ai_provenance: { engine: 'wahs-engine', recorded_model: 'wahs-12b-kb' }
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
  it('builds collision-free privacy scope signatures across postures and source lists', () => {
    const s1 = buildPrivacyScopeSignature({
      sharingPosture: 'patient_self',
      includedSources: ['B Clinic', 'A Clinic'],
      excludedSources: { 'C, Inc | Behavioral': true, 'Unused Clinic': false }
    });
    const s2 = buildPrivacyScopeSignature({
      sharingPosture: 'patient_self',
      includedSources: ['A Clinic', 'B Clinic'],
      excludedSources: { 'C, Inc | Behavioral': true }
    });
    const sExternal = buildPrivacyScopeSignature({
      sharingPosture: 'external_share',
      includedSources: ['A Clinic', 'B Clinic'],
      excludedSources: { 'C, Inc | Behavioral': true }
    });
    const sSplitCollisionTest = buildPrivacyScopeSignature({
      sharingPosture: 'patient_self',
      includedSources: ['A Clinic'],
      excludedSources: { 'B Clinic': true, 'C, Inc | Behavioral': true }
    });

    expect(s1).toBe(s2);
    expect(s1).not.toBe(sExternal);
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
    const scopeA = buildPrivacyScopeSignature({
      sharingPosture: 'patient_self',
      includedSources: ['UW Medicine', 'MultiCare Behavioral Health'],
      excludedSources: {}
    });
    const scopeB = buildPrivacyScopeSignature({
      sharingPosture: 'external_share',
      includedSources: ['UW Medicine', 'MultiCare Behavioral Health'],
      excludedSources: {}
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

describe('WAHSChat.svelte privacy scope isolation & async masterPatient history restoration', () => {
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

  it('isolates conversation history when excluding a source or switching to external_share', async () => {
    const chatRequests: Array<any> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/chat' && (!init?.method || init.method === 'GET')) {
        return new Response(JSON.stringify({ data: [{ id: 'wahs-12b-kb' }] }), {
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
        if (chatRequests.length === 2) {
          return makeSseResponse('UW Medicine blood pressure is stable.');
        }
        return makeSseResponse('External share summary with SDOH redacted.');
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

    // Turn 1 under patient_self with both sources enabled
    await fireEvent.input(promptInput, {
      target: { value: 'What behavioral health notes do I have?' }
    });
    await fireEvent.click(screen.getByRole('button', { name: /Send/i }));

    await waitFor(() => {
      expect(screen.getByText(/Sensitive MultiCare counseling note/)).toBeInTheDocument();
    });
    expect(chatRequests).toHaveLength(1);
    expect(chatRequests[0].messages).toEqual([
      { role: 'user', content: 'What behavioral health notes do I have?' }
    ]);

    // Exclude MultiCare Behavioral Health: prior Turn 1 must disappear and not be sent on Turn 2
    const multicarePill = screen.getByRole('button', { name: /MultiCare Behavioral Health/ });
    await fireEvent.click(multicarePill);

    await waitFor(() => {
      expect(screen.queryByText(/Sensitive MultiCare counseling note/)).not.toBeInTheDocument();
    });

    await fireEvent.input(promptInput, {
      target: { value: 'Summarize my remaining clinic records' }
    });
    await fireEvent.click(screen.getByRole('button', { name: /Send/i }));

    await waitFor(() => {
      expect(screen.getByText(/UW Medicine blood pressure is stable\./)).toBeInTheDocument();
    });
    expect(chatRequests).toHaveLength(2);
    expect(chatRequests[1].wahs.chart_scope).toEqual({
      include_sources: ['UW Medicine']
    });
    expect(chatRequests[1].messages).toEqual([
      { role: 'user', content: 'Summarize my remaining clinic records' }
    ]);

    // Re-including MultiCare restores the original patient_self all-sources partition
    await fireEvent.click(multicarePill);
    await waitFor(() => {
      expect(screen.getByText(/Sensitive MultiCare counseling note/)).toBeInTheDocument();
    });

    // Switching posture to external_share resets view to a clean partition and sends zero prior turns
    const postureSelect = screen.getByLabelText('Privacy sharing posture') as HTMLSelectElement;
    await fireEvent.change(postureSelect, { target: { value: 'external_share' } });

    await waitFor(() => {
      expect(screen.queryByText(/Sensitive MultiCare counseling note/)).not.toBeInTheDocument();
    });

    await fireEvent.input(promptInput, { target: { value: 'Prepare an external summary' } });
    await fireEvent.click(screen.getByRole('button', { name: /Send/i }));

    await waitFor(() => {
      expect(screen.getByText(/External share summary with SDOH redacted\./)).toBeInTheDocument();
    });
    expect(chatRequests).toHaveLength(3);
    expect(chatRequests[2].wahs.sharing_posture).toBe('external_share');
    expect(chatRequests[2].messages).toEqual([
      { role: 'user', content: 'Prepare an external summary' }
    ]);
  });

  it('waits for async masterPatient resolution on reload before restoring saved history', async () => {
    const scopeSig = buildPrivacyScopeSignature({
      sharingPosture: 'patient_self',
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
          model: 'wahs-12b-kb',
          scopeSignature: scopeSig
        }
      ])
    );

    const chatRequests: Array<any> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/chat' && (!init?.method || init.method === 'GET')) {
        return new Response(JSON.stringify({ data: [{ id: 'wahs-12b-kb' }] }), {
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
    });
    expect(chatRequests).toHaveLength(1);
    expect(chatRequests[0].messages).toEqual([
      { role: 'user', content: 'Prior reload question' },
      { role: 'assistant', content: 'Prior reload answer from saved history' },
      { role: 'user', content: 'Follow-up after reload' }
    ]);

    const storedAfter = JSON.parse(window.localStorage.getItem(expectedStorageKey) || '[]');
    expect(storedAfter).toHaveLength(4);
    expect(storedAfter[3].content).toBe('Follow-up response anchored on restored thread.');
    expect(buildPartitionKey('master-patient-99', scopeSig)).toContain('master-patient-99');
  });
});
