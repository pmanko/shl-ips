export type SharingPosture = 'patient_self' | 'external_share';

export interface ScopedChatMessageLike {
  role: 'user' | 'assistant';
  content: string;
  scopeSignature?: string;
}

/** Normalize, deduplicate, and sort source names into a canonical order. */
export function normalizeSourceNames(names: Iterable<string>): string[] {
  const unique = new Set<string>();
  for (const name of names) {
    const trimmed = typeof name === 'string' ? name.trim() : '';
    if (trimmed) {
      unique.add(trimmed);
    }
  }
  return Array.from(unique).sort();
}

/** Build a collision-free privacy scope signature for sharing posture and active sources. */
export function buildPrivacyScopeSignature(params: {
  sharingPosture: SharingPosture;
  includedSources?: Iterable<string>;
  excludedSources?: Record<string, boolean>;
}): string {
  const posture: SharingPosture =
    params.sharingPosture === 'external_share' ? 'external_share' : 'patient_self';
  const included = normalizeSourceNames(params.includedSources ?? []);
  const excluded = normalizeSourceNames(
    Object.entries(params.excludedSources ?? {})
      .filter(([, value]) => Boolean(value))
      .map(([key]) => key)
  );
  return `${posture}|inc:${JSON.stringify(included)}|exc:${JSON.stringify(excluded)}`;
}

/** Resolve the persistent session key once identity is ready, returning null while loading. */
export function resolveChatSessionKey(params: {
  demoMode: boolean;
  activePersona: string;
  masterPatientId?: string | null;
}): string | null {
  if (params.demoMode) {
    return (params.activePersona || '').trim() || 'alex';
  }
  const trimmedPatientId = (params.masterPatientId ?? '').trim();
  return trimmedPatientId.length > 0 ? trimmedPatientId : null;
}

/** Build the localStorage key for a given session and privacy scope partition. */
export function getScopedHistoryStorageKey(sessionKey: string, scopeSignature: string): string {
  return `wahs:sveltekit:chatHistory:v4:${sessionKey}:${scopeSignature}`;
}

/** Build an in-memory partition identifier combining session identity and privacy scope. */
export function buildPartitionKey(sessionKey: string, scopeSignature: string): string {
  return `${sessionKey}::${scopeSignature}`;
}

/** Filter conversation turns strictly to those created under the active privacy scope. */
export function filterMessagesForScope<T extends ScopedChatMessageLike>(
  messages: readonly T[],
  activeScopeSignature: string
): Array<{ role: 'user' | 'assistant'; content: string }> {
  return messages
    .filter((m) => m.scopeSignature === activeScopeSignature && m.content.trim().length > 0)
    .map((m) => ({ role: m.role, content: m.content }));
}
