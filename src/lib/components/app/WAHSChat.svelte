<script lang="ts">
  import { getContext, onMount, tick } from 'svelte';
  import type { Writable } from 'svelte/store';
  import {
    Alert,
    Badge,
    Button,
    Card,
    CardBody,
    CardHeader,
    Col,
    Icon,
    Input,
    Offcanvas,
    Row,
    Spinner
  } from '@sveltestrap/sveltestrap';
  import type FHIRDataService from '$lib/utils/FHIRDataService';
  import type { Patient } from 'fhir/r4';
  import type { IAuthService } from '$lib/utils/types';
  import { SOURCE_NAME_SYSTEM } from '$lib/config/config';
  import { isLocalDemoMode } from '$lib/utils/localDemoPersonas';
  import {
    getFriendlySourceName,
    isPatientCollection
  } from '$lib/utils/resourceCollectionUtils';
  import { download } from '$lib/utils/util';
  import {
    buildPartitionKey,
    buildPrivacyScopeSignature,
    filterMessagesForScope,
    getScopedHistoryStorageKey,
    resolveChatSessionKey,
    type SharingPosture
  } from '$lib/utils/wahsChatSession';

  let fhirDataService: FHIRDataService = getContext('fhirDataService');
  let authService: IAuthService = getContext('authService');
  let colorMap = getContext<Writable<Map<string, string>>>('colorMap');

  $: userResources = fhirDataService.userResources;
  $: masterPatient = fhirDataService.masterPatient;
  $: loadingData = fhirDataService.loading;

  interface CitationEntry {
    index?: number | string;
    resourceType?: string;
    id?: string;
    source?: string;
    section?: string;
    date?: string;
    display?: string;
    memberIds?: string[];
    sensitivity?: string;
  }

  interface ChatTurn {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    timestamp: string;
    model?: string;
    latencyMs?: number;
    citationMap?: Record<string, CitationEntry>;
    condensation?: any;
    scopeApplied?: any;
    aiProvenance?: any;
    privacyNotices?: string[];
    completenessManifest?: string;
    prefixHash?: string;
    scopeSignature?: string;
  }

  interface SourceSummary {
    sourceName: string;
    friendlyName: string;
    category: string;
    method: string;
    patientId: string;
    count: number;
    isPatientAuthored: boolean;
    color: string;
  }

  let availableModels: Array<{ id: string; label: string }> = [
    { id: 'wahs-12b-kb', label: 'WAHS Engine · Gemma 4 12B + 4-Layer KB (Recommended)' },
    { id: 'wahs-e4b-kb', label: 'WAHS Engine · Gemma 4 E4B + 4-Layer KB (Fast)' },
    { id: 'wahs-26b-kb', label: 'WAHS Engine · Gemma 4 26B + 4-Layer KB (Deep Synthesis)' },
    { id: 'gemma4:12b', label: 'CIRG GPU · Gemma 4 12B' },
    { id: 'gemma4:e4b', label: 'CIRG GPU · Gemma 4 E4B' }
  ];

  let selectedModel = 'wahs-12b-kb';
  let activePersona = 'alex';
  let sharingPosture: SharingPosture = 'patient_self';
  let targetBudgetTokens: number | null = null;
  let excludedSources: Record<string, boolean> = {};

  let inputPrompt = '';
  let isStreaming = false;
  let errorBanner = '';
  let showTelemetry = true;

  let componentMounted = false;
  let loadedPartitionKey: string | null = null;
  let lastAutoPreviewPartitionKey: string | null = null;

  let messages: ChatTurn[] = [];
  let latestXWahs: any = null;
  let latestPrefixHash = '';
  let chatScrollEl: HTMLElement | undefined;

  // Offcanvas Provenance Drawer state
  let provenanceOpen = false;
  let selectedCitationKey = '';
  let selectedCitationMeta: CitationEntry | null = null;
  let selectedCitationFhirJson = '';

  // Compute live pooled sources from FHIRDataService
  let pooledSources: SourceSummary[] = [];
  let totalPooledResources = 0;

  $: {
    const _ur = $userResources;
    const cols = fhirDataService ? fhirDataService.getAllResourceCollections() : [];
    const summaries: SourceSummary[] = [];
    let total = 0;
    for (const c of cols) {
      const tags = c.getTags();
      const friendly = getFriendlySourceName(tags);
      const patAuth = isPatientCollection(tags);
      const count = c.getResourceCount();
      total += count;
      const color = $colorMap?.get(friendly) ?? (patAuth ? '#6f42c1' : '#0d6efd');
      summaries.push({
        sourceName: tags.sourceName || tags.source,
        friendlyName: friendly,
        category: tags.category,
        method: tags.method,
        patientId: c.getSelectedPatient()?.id ?? '',
        count,
        isPatientAuthored: patAuth,
        color
      });
    }
    pooledSources = summaries;
    totalPooledResources = total;
  }

  $: activeIncludedSources = pooledSources
    .filter((s) => !excludedSources[s.sourceName])
    .map((s) => s.sourceName);

  $: hasSourceSubsetFilter =
    pooledSources.length > 0 && activeIncludedSources.length < pooledSources.length;

  const DEMO_MODE = isLocalDemoMode();

  $: patientDisplayName = (() => {
    const pat = $masterPatient?.resource as Patient | undefined;
    if (pat?.name?.[0]) {
      const given = (pat.name[0].given || []).join(' ');
      const family = pat.name[0].family || '';
      return `${given} ${family}`.trim();
    }
    return activePersona === 'leo' ? 'Leo Johnson' : 'Alex Johnson';
  })();

  $: patientBirthDate =
    ($masterPatient?.resource as Patient | undefined)?.birthDate ||
    (activePersona === 'leo' ? '2019-08-22' : '1962-03-14');

  $: resolvedSessionKey = resolveChatSessionKey({
    demoMode: DEMO_MODE,
    activePersona,
    masterPatientId: $masterPatient?.resource?.id
  });

  $: isSessionReady = resolvedSessionKey !== null && !$loadingData;

  $: activeScopeSignature = buildPrivacyScopeSignature({
    sharingPosture,
    includedSources: activeIncludedSources,
    excludedSources
  });

  function getCurrentIncludedSourceNames(excluded: Record<string, boolean> = excludedSources): string[] {
    const cols = fhirDataService ? fhirDataService.getAllResourceCollections() : [];
    const names: string[] = [];
    for (const col of cols) {
      const tags = col.getTags();
      const sourceName = tags.sourceName || tags.source;
      if (sourceName && !excluded[sourceName]) {
        names.push(sourceName);
      }
    }
    return names;
  }

  function closeProvenanceDrawer() {
    provenanceOpen = false;
    selectedCitationKey = '';
    selectedCitationMeta = null;
    selectedCitationFhirJson = '';
  }

  function syncActiveConversationPartition(
    sessionKey: string,
    scopeSignature: string,
    force = false
  ) {
    const nextPartitionKey = buildPartitionKey(sessionKey, scopeSignature);
    if (!force && loadedPartitionKey === nextPartitionKey) {
      return;
    }
    loadedPartitionKey = nextPartitionKey;
    closeProvenanceDrawer();
    if (typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem(
        getScopedHistoryStorageKey(sessionKey, scopeSignature)
      );
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          const scopedTurns: ChatTurn[] = parsed
            .filter((m) => m && (!m.scopeSignature || m.scopeSignature === scopeSignature))
            .map((m) => ({
              ...m,
              scopeSignature: m.scopeSignature ?? scopeSignature
            }));
          if (scopedTurns.length > 0) {
            messages = scopedTurns;
            const lastAssistant = [...scopedTurns]
              .reverse()
              .find((m) => m.role === 'assistant' && m.condensation);
            if (lastAssistant) {
              latestXWahs = {
                citation_map: lastAssistant.citationMap,
                condensation: lastAssistant.condensation,
                scope_applied: lastAssistant.scopeApplied,
                ai_provenance: lastAssistant.aiProvenance,
                privacy_notices: lastAssistant.privacyNotices,
                completeness_manifest: lastAssistant.completenessManifest
              };
              latestPrefixHash = lastAssistant.prefixHash || '';
            } else {
              latestXWahs = null;
              latestPrefixHash = '';
            }
            return;
          }
        }
      }
    } catch (e) {
      console.warn('Could not load saved chat history:', e);
    }
    messages = [];
    latestXWahs = null;
    latestPrefixHash = '';
  }

  function saveHistoryForPartition(sessionKey: string, scopeSignature: string, turns: ChatTurn[]) {
    if (typeof window === 'undefined') return;
    try {
      const scopedTurns = turns.filter((t) => t.scopeSignature === scopeSignature);
      window.localStorage.setItem(
        getScopedHistoryStorageKey(sessionKey, scopeSignature),
        JSON.stringify(scopedTurns)
      );
    } catch (e) {
      console.warn('Failed to persist chat history:', e);
    }
  }

  $: if (componentMounted && !isStreaming && isSessionReady && resolvedSessionKey) {
    const targetPartitionKey = buildPartitionKey(resolvedSessionKey, activeScopeSignature);
    if (loadedPartitionKey !== targetPartitionKey) {
      syncActiveConversationPartition(resolvedSessionKey, activeScopeSignature);
    }
    if (lastAutoPreviewPartitionKey !== targetPartitionKey) {
      lastAutoPreviewPartitionKey = targetPartitionKey;
      void refreshContextPreview();
    }
  }

  function buildChartScopePayload(): Record<string, any> {
    if (!hasSourceSubsetFilter) {
      return {};
    }
    return {
      include_sources: activeIncludedSources
    };
  }

  /**
   * In DEMO_MODE (when no HAPI/fhir-auth server is running), construct the inline
   * FHIR R4 Bundle from `fhirDataService` stamped with `wahealthsummary-source-name` tags
   * so `wahs-engine` applies identical `chart_scope` filtering and `[N]` citation mapping.
   * In live HAPI/fhir-auth mode, `/api/chat` omits `fhir_bundle` so `wahs-engine` fetches
   * directly from `fhir-auth` using the caller's Keycloak Bearer JWT.
   */
  function assembleLocalDemoBundleIfNeeded(): Record<string, any> | undefined {
    if (!DEMO_MODE) {
      return undefined;
    }
    const cols = fhirDataService.getAllResourceCollections();
    const bundleEntries: Array<{ resource: any }> = [];
    const canonicalPatientId = $masterPatient?.resource?.id || `demo-${activePersona}`;

    if ($masterPatient?.resource) {
      bundleEntries.push({ resource: structuredClone($masterPatient.resource) });
    }

    for (const c of cols) {
      const tags = c.getTags();
      const srcLabel = tags.sourceName || tags.source || 'WA Health Summary';
      for (const res of c.getFHIRResources()) {
        if (res.resourceType === 'Patient') continue;
        const cloned: any = structuredClone(res);
        cloned.meta = cloned.meta ? { ...cloned.meta } : {};
        const existingTags = Array.isArray(cloned.meta.tag) ? [...cloned.meta.tag] : [];
        if (!existingTags.some((t: any) => t?.system === SOURCE_NAME_SYSTEM)) {
          existingTags.push({ system: SOURCE_NAME_SYSTEM, code: srcLabel });
        }
        cloned.meta.tag = existingTags;
        if (cloned.subject?.reference?.startsWith('Patient/')) {
          cloned.subject = { ...cloned.subject, reference: `Patient/${canonicalPatientId}` };
        }
        if (cloned.patient?.reference?.startsWith('Patient/')) {
          cloned.patient = { ...cloned.patient, reference: `Patient/${canonicalPatientId}` };
        }
        bundleEntries.push({ resource: cloned });
      }
    }

    if (bundleEntries.length === 0) return undefined;
    return {
      resourceType: 'Bundle',
      id: `shl-ips-demo-${activePersona}`,
      type: 'collection',
      entry: bundleEntries
    };
  }

  async function buildAuthHeaders(): Promise<Record<string, string>> {
    const token = (await authService.getAccessToken()) || 'local-demo-token';
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    };
  }

  async function loadEngineModels() {
    try {
      const headers = await buildAuthHeaders();
      const resp = await fetch('/api/chat', { method: 'GET', headers });
      if (!resp.ok) return;
      const body = await resp.json();
      if (Array.isArray(body?.data) && body.data.length > 0) {
        const knownLabels = new Map(availableModels.map((m) => [m.id, m.label]));
        availableModels = body.data.map((m: any) => ({
          id: m.id,
          label: knownLabels.get(m.id) || `WAHS Engine · ${m.id}`
        }));
        if (!availableModels.some((m) => m.id === selectedModel)) {
          selectedModel = availableModels[0].id;
        }
      }
    } catch {
      // Keep default model list if engine is still starting
    }
  }

  async function refreshContextPreview() {
    try {
      const headers = await buildAuthHeaders();
      const fhirBundle = assembleLocalDemoBundleIfNeeded();
      const resp = await fetch('/api/chat?mode=preview', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: selectedModel,
          wahs: {
            ...(targetBudgetTokens != null ? { target_budget_tokens: targetBudgetTokens } : {}),
            sharing_posture: sharingPosture,
            chart_scope: buildChartScopePayload(),
            ...(fhirBundle ? { fhir_bundle: fhirBundle } : {})
          }
        })
      });
      if (resp.ok) {
        const preview = await resp.json();
        latestPrefixHash =
          resp.headers.get('X-WAHS-Prefix-Hash') || preview?.prefix_cache_key_hash || '';
        if (preview?.x_wahs) {
          latestXWahs = preview.x_wahs;
        }
      }
    } catch (e) {
      console.warn('Context preview error:', e);
    }
  }

  async function toggleSourceScope(sourceName: string) {
    if (isStreaming) return;
    const next = { ...excludedSources };
    if (next[sourceName]) {
      delete next[sourceName];
    } else {
      // Keep at least one source active so the record scope is non-empty
      if (activeIncludedSources.length <= 1) return;
      next[sourceName] = true;
    }
    excludedSources = next;
    errorBanner = '';
    const nextScope = buildPrivacyScopeSignature({
      sharingPosture,
      includedSources: getCurrentIncludedSourceNames(next),
      excludedSources: next
    });
    if (resolvedSessionKey) {
      lastAutoPreviewPartitionKey = buildPartitionKey(resolvedSessionKey, nextScope);
      syncActiveConversationPartition(resolvedSessionKey, nextScope);
    }
    await refreshContextPreview();
  }

  async function handleSharingPostureChange(event?: Event) {
    if (isStreaming) return;
    const rawValue = (event?.target as HTMLSelectElement | null)?.value ?? sharingPosture;
    const nextPosture: SharingPosture =
      rawValue === 'external_share' ? 'external_share' : 'patient_self';
    sharingPosture = nextPosture;
    errorBanner = '';
    const nextScope = buildPrivacyScopeSignature({
      sharingPosture: nextPosture,
      includedSources: getCurrentIncludedSourceNames(excludedSources),
      excludedSources
    });
    if (resolvedSessionKey) {
      lastAutoPreviewPartitionKey = buildPartitionKey(resolvedSessionKey, nextScope);
      syncActiveConversationPartition(resolvedSessionKey, nextScope);
    }
    await refreshContextPreview();
  }

  async function switchDemoPatient(persona: 'alex' | 'leo') {
    if (isStreaming || activePersona === persona) return;
    activePersona = persona;
    excludedSources = {};
    errorBanner = '';
    if ((fhirDataService as any).loadLocalDemoPersona) {
      await (fhirDataService as any).loadLocalDemoPersona(persona);
    }
    const nextScope = buildPrivacyScopeSignature({
      sharingPosture,
      includedSources: getCurrentIncludedSourceNames({}),
      excludedSources: {}
    });
    lastAutoPreviewPartitionKey = buildPartitionKey(persona, nextScope);
    syncActiveConversationPartition(persona, nextScope, true);
    await refreshContextPreview();
  }

  async function scrollToBottom() {
    await tick();
    if (chatScrollEl) {
      chatScrollEl.scrollTop = chatScrollEl.scrollHeight;
    }
  }

  async function sendQuestion(promptText?: string) {
    const question = (promptText ?? inputPrompt).trim();
    if (!question || isStreaming || !isSessionReady || !resolvedSessionKey) return;

    const requestSessionKey = resolvedSessionKey;
    const requestScopeSignature = activeScopeSignature;
    const requestSharingPosture = sharingPosture;
    const requestChartScope = buildChartScopePayload();
    const requestPartitionKey = buildPartitionKey(requestSessionKey, requestScopeSignature);

    errorBanner = '';
    inputPrompt = '';

    const userTurn: ChatTurn = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: question,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      scopeSignature: requestScopeSignature
    };

    const assistantTurn: ChatTurn = {
      id: `assistant-${Date.now() + 1}`,
      role: 'assistant',
      content: '',
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      model: selectedModel,
      scopeSignature: requestScopeSignature
    };

    const baseMessages = messages.filter((m) => m.scopeSignature === requestScopeSignature);
    messages = [...baseMessages, userTurn, assistantTurn];
    isStreaming = true;
    await scrollToBottom();

    const t0 = performance.now();
    try {
      const headers = await buildAuthHeaders();
      const fhirBundle = assembleLocalDemoBundleIfNeeded();
      const historyPayload = filterMessagesForScope(
        messages.slice(0, -1),
        requestScopeSignature
      );

      const response = await fetch('/api/chat', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: selectedModel,
          messages: historyPayload,
          stream: true,
          temperature: 0.1,
          max_tokens: 1024,
          wahs: {
            ...(targetBudgetTokens != null ? { target_budget_tokens: targetBudgetTokens } : {}),
            sharing_posture: requestSharingPosture,
            chart_scope: requestChartScope,
            ...(fhirBundle ? { fhir_bundle: fhirBundle } : {})
          }
        })
      });

      if (!response.ok || !response.body) {
        const errText = await response.text().catch(() => response.statusText);
        throw new Error(`BFF /api/chat returned ${response.status}: ${errText}`);
      }

      const headerHash = response.headers.get('X-WAHS-Prefix-Hash');
      if (headerHash) {
        latestPrefixHash = headerHash;
        assistantTurn.prefixHash = headerHash;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line.startsWith('data:')) continue;
          const dataStr = line.slice(5).trim();
          if (dataStr === '[DONE]') break;
          try {
            const parsed = JSON.parse(dataStr);
            const xw = parsed.x_wahs || parsed.wahs_metadata;
            if (xw) {
              latestXWahs = xw;
              assistantTurn.citationMap = xw.citation_map || xw.mappings || {};
              assistantTurn.condensation = xw.condensation;
              assistantTurn.scopeApplied = xw.scope_applied;
              assistantTurn.aiProvenance = xw.ai_provenance;
              assistantTurn.privacyNotices = xw.privacy_notices || [];
              assistantTurn.completenessManifest = xw.completeness_manifest || '';
              if (xw.condensation?.prefix_cache_key_hash) {
                latestPrefixHash = xw.condensation.prefix_cache_key_hash;
                assistantTurn.prefixHash = xw.condensation.prefix_cache_key_hash;
              }
            }
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) {
              assistantTurn.content += delta;
              if (loadedPartitionKey === requestPartitionKey) {
                messages = [...messages.slice(0, -1), { ...assistantTurn }];
                await scrollToBottom();
              }
            }
          } catch {
            // ignore partial SSE JSON fragment
          }
        }
      }

      assistantTurn.latencyMs = Math.round(performance.now() - t0);
      const finalMessages = [...baseMessages, userTurn, { ...assistantTurn }];
      if (loadedPartitionKey === requestPartitionKey) {
        messages = finalMessages;
      }
      saveHistoryForPartition(requestSessionKey, requestScopeSignature, finalMessages);
    } catch (err: any) {
      errorBanner = err?.message || 'Unable to reach WAHS Engine via /api/chat.';
      if (loadedPartitionKey === requestPartitionKey) {
        messages = messages.slice(0, -1);
      }
    } finally {
      isStreaming = false;
      await scrollToBottom();
    }
  }

  function clearHistory() {
    messages = [];
    latestXWahs = null;
    latestPrefixHash = '';
    if (typeof window !== 'undefined' && resolvedSessionKey) {
      window.localStorage.removeItem(
        getScopedHistoryStorageKey(resolvedSessionKey, activeScopeSignature)
      );
    }
  }

  function exportTranscript() {
    if (messages.length === 0) return;
    const lines: string[] = [
      `# WA Health Summary — Ask WAHS Conversation Export`,
      `- **Patient Profile:** ${patientDisplayName} (DOB: ${patientBirthDate})`,
      `- **Exported:** ${new Date().toISOString()}`,
      `- **Sharing Posture:** ${sharingPosture}`,
      `- **Scoped Sources:** ${activeIncludedSources.join(', ')}`,
      ''
    ];
    for (const m of messages) {
      const speaker =
        m.role === 'user' ? 'Patient / Caregiver' : `WAHS Assistant (${m.model || selectedModel})`;
      lines.push(`### ${speaker} (${m.timestamp})`);
      lines.push(m.content);
      lines.push('');
    }
    download(
      `wahs-chat-${resolvedSessionKey || 'session'}-${new Date().toISOString().slice(0, 10)}.md`,
      lines.join('\n')
    );
  }

  function openProvenanceDrawer(citeKey: string, turnCitationMap?: Record<string, CitationEntry>) {
    const mapSource = turnCitationMap || latestXWahs?.citation_map || {};
    const entry = mapSource[citeKey];
    selectedCitationKey = citeKey;
    selectedCitationMeta = entry || {
      resourceType: citeKey.startsWith('P') ? 'OverlayDraft' : 'FHIRResource',
      display: `Citation [${citeKey}]`
    };

    // Match against the live FHIR R4 resource in FHIRDataService
    let matchedFhir: any = null;
    const targetId = entry?.id || (entry as any)?.resourceUuid;
    if (targetId) {
      for (const col of fhirDataService.getAllResourceCollections()) {
        for (const r of col.getFHIRResources()) {
          if (r.id === targetId || `${r.resourceType}/${r.id}` === targetId) {
            matchedFhir = r;
            break;
          }
        }
        if (matchedFhir) break;
      }
    }
    selectedCitationFhirJson = JSON.stringify(matchedFhir || selectedCitationMeta, null, 2);
    provenanceOpen = true;
  }

  interface TokenPart {
    type: 'text' | 'cite';
    value: string;
    isPatient?: boolean;
  }

  function tokenizeCitations(text: string): TokenPart[] {
    if (!text) return [];
    const regex = /\[(P?\d+)\]/g;
    const parts: TokenPart[] = [];
    let lastIdx = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      if (match.index > lastIdx) {
        parts.push({ type: 'text', value: text.slice(lastIdx, match.index) });
      }
      const key = match[1];
      parts.push({
        type: 'cite',
        value: key,
        isPatient: key.startsWith('P')
      });
      lastIdx = regex.lastIndex;
    }
    if (lastIdx < text.length) {
      parts.push({ type: 'text', value: text.slice(lastIdx) });
    }
    return parts;
  }

  $: starterPrompts =
    activePersona === 'leo'
      ? [
          'What vaccines has Leo received and is he due for any boosters before kindergarten?',
          'Summarize Leo’s asthma action plan, inhaler instructions, and severe allergies for his school nurse.',
          'What caregiver notes and goals did we record for Leo in My Story?'
        ]
      : [
          'Have I had any labs for my diabetes recently, and how is my A1C trending?',
          'Could my evening lightheadedness or forearm bruising be related to any of my current medications across clinics?',
          'Summarize my active medications by clinic and highlight any interaction questions for my care team.',
          'How do my current lab trends align with my personal health goals in My Story?'
        ];

  onMount(async () => {
    if (DEMO_MODE && (authService as any).getDemoPersona) {
      activePersona = (authService as any).getDemoPersona();
    }
    await loadEngineModels();
    componentMounted = true;
  });
</script>

<!-- Offcanvas Drawer for Citation Provenance & Raw FHIR R4 Inspection -->
<Offcanvas
  isOpen={provenanceOpen}
  toggle={() => (provenanceOpen = !provenanceOpen)}
  header={`FHIR Provenance Inspector — Citation [${selectedCitationKey}]`}
  placement="end"
  scroll
  style="width: min(540px, 94vw);"
>
  {#if selectedCitationMeta}
    <div class="d-flex flex-wrap gap-2 mb-3">
      <Badge color={selectedCitationKey.startsWith('P') ? 'warning' : 'primary'}>
        [{selectedCitationKey}] {selectedCitationMeta.source || (selectedCitationKey.startsWith('P') ? 'Overlay Draft' : 'Pooled FHIR Record')}
      </Badge>
      {#if selectedCitationMeta.resourceType}
        <Badge color="secondary">{selectedCitationMeta.resourceType}</Badge>
      {/if}
      {#if selectedCitationMeta.date}
        <Badge color="light" class="text-dark border">{selectedCitationMeta.date}</Badge>
      {/if}
    </div>

    {#if selectedCitationMeta.display}
      <Card class="mb-3 border-0 bg-light">
        <CardBody class="py-2 px-3">
          <small class="text-muted d-block fw-bold mb-1">Condensed Evidence Item</small>
          <div style="font-size: 0.9rem;">{selectedCitationMeta.display}</div>
        </CardBody>
      </Card>
    {/if}

    {#if latestXWahs?.ai_provenance}
      <Card class="mb-3 border-0" style="background: #eff6ff;">
        <CardBody class="py-2 px-3" style="font-size: 0.78rem;">
          <div class="fw-bold text-primary mb-1">
            <Icon name="patch-check-fill" class="me-1" />HL7 AI-Provenance Envelope
          </div>
          <div><strong>Profile:</strong> <code>{latestXWahs.ai_provenance.profile}</code></div>
          <div>
            <strong>Engine &amp; Model:</strong> {latestXWahs.ai_provenance.engine} · {latestXWahs.ai_provenance.recorded_model}
          </div>
        </CardBody>
      </Card>
    {/if}

    <small class="text-muted d-block fw-bold mb-1">Underlying FHIR R4 Resource</small>
    <pre
      class="bg-dark text-light p-3 rounded"
      style="font-size: 0.78rem; max-height: 58vh; overflow: auto;"><code>{selectedCitationFhirJson}</code></pre>
  {/if}
</Offcanvas>

<Row class="mb-3 align-items-center justify-content-between">
  <Col md="7">
    <h4 class="mb-1 d-flex align-items-center gap-2 flex-wrap">
      <Icon name="stars" class="text-primary" />
      <span>Ask WA Health Summary</span>
      <Badge color="info" pill class="fw-normal" style="font-size: 0.74rem;">
        FHIR R4 Grounded · Server BFF
      </Badge>
      {#if latestXWahs?.ai_provenance}
        <Badge color="success" pill class="fw-normal" style="font-size: 0.72rem;" title={latestXWahs.ai_provenance.profile}>
          <Icon name="patch-check" class="me-1" />HL7 AI-Provenance
        </Badge>
      {/if}
    </h4>
    <p class="text-secondary mb-0" style="font-size: 0.92rem;">
      Ask plain-language questions across your pooled clinical records and personal WAHS story &amp; goals. Toggle sources below to scope what the AI sees.
    </p>
  </Col>
  <Col md="5" class="d-flex justify-content-md-end align-items-center gap-2 mt-2 mt-md-0 flex-wrap">
    {#if DEMO_MODE}
      <div class="btn-group btn-group-sm" role="group" aria-label="Demo patient switcher">
        <button
          type="button"
          class="btn {activePersona === 'alex' ? 'btn-primary' : 'btn-outline-primary'}"
          disabled={isStreaming || $loadingData}
          on:click={() => switchDemoPatient('alex')}
        >
          <Icon name="person-badge" class="me-1" />Alex (Adult · 4 Sources)
        </button>
        <button
          type="button"
          class="btn {activePersona === 'leo' ? 'btn-primary' : 'btn-outline-primary'}"
          disabled={isStreaming || $loadingData}
          on:click={() => switchDemoPatient('leo')}
        >
          <Icon name="people" class="me-1" />Leo (Child · 3 Sources)
        </button>
      </div>
    {/if}
  </Col>
</Row>

<!-- Interactive Chart Scope & Model Controls Bar -->
<Card class="mb-3 shadow-sm border-0" style="background: #f8fafc;">
  <CardBody class="py-2 px-3">
    <Row class="align-items-center g-2">
      <Col lg="7" class="d-flex align-items-center flex-wrap gap-2">
        <span class="fw-bold text-secondary" style="font-size: 0.8rem;">
          <Icon name="sliders" class="text-primary me-1" />
          Chart Scope ({activeIncludedSources.length}/{pooledSources.length} sources · {totalPooledResources} items):
        </span>
        {#if $loadingData}
          <Spinner size="sm" color="primary" />
        {:else if pooledSources.length === 0}
          <Badge color="secondary">No datasets loaded — import or add data in Add Data tab</Badge>
        {:else}
          {#each pooledSources as src}
            {@const isIncluded = !excludedSources[src.sourceName]}
            <button
              type="button"
              class="btn btn-sm rounded-pill d-inline-flex align-items-center gap-1 py-0 px-2"
              style="font-size: 0.76rem; font-weight: 500; border: 1px solid {src.color}; background-color: {isIncluded ? src.color : 'transparent'}; color: {isIncluded ? '#fff' : '#64748b'}; opacity: {isIncluded ? 1 : 0.65};"
              disabled={isStreaming}
              title={isIncluded
                ? `Included in AI scope (Patient/${src.patientId}) — click to exclude`
                : `Excluded from AI scope — click to include`}
              on:click={() => toggleSourceScope(src.sourceName)}
            >
              <Icon name={isIncluded ? (src.isPatientAuthored ? 'journal-check' : 'check2-circle') : 'slash-circle'} />
              {src.sourceName} ({src.count})
            </button>
          {/each}
        {/if}
      </Col>

      <Col lg="5" class="d-flex justify-content-lg-end align-items-center gap-2 flex-wrap">
        <Input
          type="select"
          bsSize="sm"
          bind:value={sharingPosture}
          disabled={isStreaming || !isSessionReady}
          on:change={handleSharingPostureChange}
          style="width: auto; font-size: 0.78rem;"
          aria-label="Privacy sharing posture"
          title="Privacy redaction posture"
        >
          <option value="patient_self">Posture: Patient Self</option>
          <option value="external_share">Posture: External Share (Redact SDOH)</option>
        </Input>

        <Input
          type="select"
          bsSize="sm"
          bind:value={selectedModel}
          disabled={isStreaming}
          style="width: auto; max-width: 230px; font-size: 0.78rem;"
          aria-label="Select clinical LLM"
        >
          {#each availableModels as m}
            <option value={m.id}>{m.label}</option>
          {/each}
        </Input>

        <Button
          size="sm"
          color="outline-secondary"
          on:click={() => (showTelemetry = !showTelemetry)}
          title="Toggle FHIR Condensation & AI-Provenance Telemetry"
        >
          <Icon name="speedometer2" />
        </Button>
        <Button
          size="sm"
          color="outline-secondary"
          disabled={messages.length === 0}
          on:click={exportTranscript}
          title="Export conversation as Markdown"
        >
          <Icon name="download" />
        </Button>
        <Button
          size="sm"
          color="outline-danger"
          disabled={messages.length === 0 || isStreaming}
          on:click={clearHistory}
          title="Clear conversation history"
        >
          <Icon name="trash" />
        </Button>
      </Col>
    </Row>

    {#if showTelemetry && latestXWahs?.condensation}
      <div class="mt-2 pt-2 border-top d-flex flex-wrap align-items-center gap-3" style="font-size: 0.75rem; color: #475569;">
        <span>
          <strong>Condensation:</strong> Tier {latestXWahs.condensation.tier} ({latestXWahs.condensation.tier_name})
        </span>
        <span>
          <strong>Tokens:</strong> {latestXWahs.condensation.actual_tokens} / {latestXWahs.condensation.budget_effective ?? latestXWahs.condensation.budget_tokens ?? latestXWahs.condensation.target_tokens}
        </span>
        <span>
          <strong>Omitted Items:</strong> {latestXWahs.condensation.omitted_clinical_items ?? 0}
          {#if latestXWahs.condensation.overflow_recovered}
            (recovered {latestXWahs.condensation.overflow_recovered} via Tier-0)
          {/if}
        </span>
        {#if latestXWahs.ai_provenance}
          <span class="text-primary">
            <Icon name="cpu" />
            <strong>Engine:</strong> {latestXWahs.ai_provenance.engine}
            {#if latestXWahs.ai_provenance.kb_enabled}
              · 4-Layer KB Active
            {/if}
          </span>
        {/if}
        {#if latestPrefixHash}
          <span class="font-monospace text-muted">
            KV-Prefix: #{latestPrefixHash.slice(0, 10)}
          </span>
        {/if}
      </div>
      {#if latestXWahs.privacy_notices?.length > 0}
        <div class="mt-1 text-warning-emphasis" style="font-size: 0.74rem;">
          <Icon name="shield-lock" class="me-1" />
          {latestXWahs.privacy_notices.join(' · ')}
        </div>
      {/if}
    {/if}
  </CardBody>
</Card>

{#if errorBanner}
  <Alert color="danger" dismissible toggle={() => (errorBanner = '')} class="py-2">
    <Icon name="exclamation-triangle-fill" class="me-2" />
    {errorBanner}
  </Alert>
{/if}

<!-- Main Chat Card -->
<Card class="shadow-sm mb-4" style="min-height: 520px; display: flex; flex-direction: column;">
  <div
    bind:this={chatScrollEl}
    class="p-3 flex-grow-1"
    style="max-height: 540px; min-height: 380px; overflow-y: auto; background: #ffffff;"
  >
    {#if messages.length === 0}
      <div class="text-center my-4 px-2">
        <div
          class="d-inline-flex align-items-center justify-content-center rounded-circle mb-2"
          style="width: 48px; height: 48px; background: #eff6ff; color: #1d4ed8;"
        >
          <Icon name="chat-heart" class="fs-4" />
        </div>
        <h6 class="fw-bold mb-1">Ask about {patientDisplayName}’s Health Summary</h6>
        <p class="text-muted mx-auto mb-3" style="max-width: 580px; font-size: 0.86rem;">
          Responses stream through the WAHS server BFF and cite exact FHIR R4 resources (<Badge color="primary">[1]</Badge>) and draft notes (<Badge color="warning" class="text-dark">[P1]</Badge>). Click any citation pill to inspect its source record and HL7 <code>AI-Provenance</code> metadata.
        </p>
        <div class="d-flex flex-wrap justify-content-center gap-2 mx-auto" style="max-width: 680px;">
          {#each starterPrompts as prompt}
            <button
              type="button"
              class="btn btn-outline-primary btn-sm text-start rounded-3 px-3 py-2"
              style="font-size: 0.82rem; max-width: 320px;"
              disabled={isStreaming || !isSessionReady}
              on:click={() => sendQuestion(prompt)}
            >
              <Icon name="arrow-up-right-circle" class="me-1" />{prompt}
            </button>
          {/each}
        </div>
      </div>
    {:else}
      {#each messages as turn (turn.id)}
        <div class="d-flex mb-3 {turn.role === 'user' ? 'justify-content-end' : 'justify-content-start'}">
          <div
            class="p-3 rounded-4 shadow-sm"
            style="max-width: 85%; {turn.role === 'user'
              ? 'background: #0d6efd; color: #ffffff;'
              : 'background: #f8fafc; color: #1e293b; border: 1px solid #e2e8f0;'}"
          >
            <div class="d-flex align-items-center justify-content-between gap-3 mb-1" style="font-size: 0.72rem; opacity: 0.82;">
              <span class="fw-bold">
                {turn.role === 'user' ? patientDisplayName : `WAHS Clinical Assistant (${turn.model || selectedModel})`}
              </span>
              <span>
                {turn.timestamp}
                {#if turn.latencyMs}
                  · {(turn.latencyMs / 1000).toFixed(1)}s
                {/if}
              </span>
            </div>

            {#if turn.role === 'assistant' && !turn.content && isStreaming}
              <div class="d-flex align-items-center gap-2 py-1 text-secondary" style="font-size: 0.88rem;">
                <Spinner size="sm" color="primary" />
                <span>Assembling scoped FHIR record &amp; streaming via /api/chat ({selectedModel})...</span>
              </div>
            {:else}
              <div style="white-space: pre-wrap; font-size: 0.92rem; line-height: 1.55;">
                {#each tokenizeCitations(turn.content) as part}
                  {#if part.type === 'text'}
                    {part.value}
                  {:else}
                    {@const citeEntry = turn.citationMap?.[part.value] || latestXWahs?.citation_map?.[part.value]}
                    <button
                      type="button"
                      class="btn btn-sm py-0 px-1 mx-1 align-baseline fw-bold"
                      style="font-size: 0.74rem; line-height: 1.3; border-radius: 6px; {part.isPatient
                        ? 'background: #fef3c7; color: #92400e; border: 1px solid #f59e0b;'
                        : 'background: #dbeafe; color: #1e40af; border: 1px solid #93c5fd;'}"
                      title={citeEntry
                        ? `[${part.value}] ${citeEntry.source || ''} · ${citeEntry.resourceType || ''} — ${citeEntry.display || 'Click to inspect FHIR resource'}`
                        : `Click to inspect citation [${part.value}]`}
                      on:click={() => openProvenanceDrawer(part.value, turn.citationMap)}
                    >
                      [{part.value}]{citeEntry?.source ? ` ${citeEntry.source.split(' ')[0]}` : ''}
                    </button>
                  {/if}
                {/each}
              </div>

              {#if turn.role === 'assistant' && turn.aiProvenance}
                <div class="mt-2 pt-2 border-top d-flex flex-wrap align-items-center justify-content-between gap-2" style="font-size: 0.71rem; color: #64748b;">
                  <span>
                    <Icon name="patch-check" class="text-success me-1" />
                    AI-Provenance: <code>{turn.aiProvenance.recorded_model}</code> via <code>{turn.aiProvenance.engine}</code>
                  </span>
                  {#if turn.citationMap && Object.keys(turn.citationMap).length > 0}
                    <span>{Object.keys(turn.citationMap).length} indexed record items</span>
                  {/if}
                </div>
              {/if}
            {/if}
          </div>
        </div>
      {/each}
    {/if}
  </div>

  <CardHeader class="bg-light border-top py-3">
    <form
      class="d-flex gap-2 align-items-center"
      on:submit|preventDefault={() => sendQuestion()}
    >
      <Input
        type="text"
        placeholder={!isSessionReady
          ? 'Loading your health summary...'
          : `Ask a question about ${patientDisplayName}'s health record...`}
        bind:value={inputPrompt}
        disabled={isStreaming || !isSessionReady}
        class="rounded-pill px-3"
      />
      <Button
        type="submit"
        color="primary"
        class="rounded-pill px-4 d-flex align-items-center gap-1 text-nowrap"
        disabled={isStreaming || !isSessionReady || !inputPrompt.trim()}
      >
        {#if isStreaming}
          <Spinner size="sm" />
        {:else}
          <Icon name="send-fill" />
          <span>Send</span>
        {/if}
      </Button>
    </form>
    <div class="d-flex justify-content-between align-items-center mt-2 px-1" style="font-size: 0.74rem; color: #64748b;">
      <span>
        <Icon name="info-circle" class="me-1" />
        Tip: Update <strong>My Story</strong> or <strong>My Care Needs</strong> under <a href="/data">Add Data</a> and ask how those changes interact with your clinic records.
      </span>
      <span>Informational only · Review with your clinician</span>
    </div>
  </CardHeader>
</Card>
