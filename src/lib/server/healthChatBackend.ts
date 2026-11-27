import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModelV1 } from 'ai';
import {
  LLM_API_BASE,
  LLM_API_KEY,
  LLM_MODEL,
  WAHS_DEFAULT_MODEL,
  WAHS_ENGINE_URL
} from '$lib/server/config';

// Picks the model that answers the health record chat (/api/health-chat), by the
// HEALTH_CHAT_BACKEND environment variable.
//
// 'gateway' (default): calls the LLM gateway directly with LLM_API_KEY.
//
// 'wahs-engine': the question goes to wahs-engine, which speaks the same OpenAI-compatible
// protocol as the gateway. The engine reads the patient's record itself, with the caller's own
// token, so that token is forwarded as the bearer in place of a shared API key. The engine
// ignores the record and tool definitions the chat sends along: it builds its own chart from
// FHIR and answers from that.

// Read per request rather than exported from $lib/server/config, so tests that mock that module
// with only the gateway settings keep working
function backend(): 'gateway' | 'wahs-engine' {
  return process.env.HEALTH_CHAT_BACKEND === 'wahs-engine' ? 'wahs-engine' : 'gateway';
}

// Placeholder token used in local demo mode; the engine cannot read a record with it
const LOCAL_DEMO_TOKEN = 'local-demo-token';

function engineV1Base(rawUrl: string): string {
  const trimmed = rawUrl.replace(/\/+$/, '');
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}

/** The caller's bearer token, already validated for /api/* by hooks.server.ts */
function callerToken(request: Request): string | undefined {
  const auth = request.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) return undefined;
  const token = auth.slice('Bearer '.length).trim();
  return token && token !== LOCAL_DEMO_TOKEN ? token : undefined;
}

/**
 * Returns the model for this request, or undefined when chat can't be served (no gateway key,
 * or no patient token to give the engine), in which case the handler responds 503.
 */
export function healthChatModel(request: Request): LanguageModelV1 | undefined {
  if (backend() === 'gateway') {
    // The generic OpenAI-compatible provider rather than @ai-sdk/openai: the latter treats any
    // model id starting with "o" (e.g. "ollama/mistral:7b") as an OpenAI reasoning model and
    // rewrites the request for it (system prompt sent as a "developer" message, sampling
    // settings dropped).
    if (!LLM_API_KEY) return undefined;
    return createOpenAICompatible({
      name: 'llm-gateway',
      baseURL: LLM_API_BASE,
      apiKey: LLM_API_KEY
    }).chatModel(LLM_MODEL);
  }

  const token = callerToken(request);
  if (!token) return undefined;
  return createOpenAICompatible({
    name: 'wahs-engine',
    baseURL: engineV1Base(WAHS_ENGINE_URL),
    apiKey: token
  }).chatModel(WAHS_DEFAULT_MODEL);
}
