// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The health chat route answers through the LLM gateway or, with HEALTH_CHAT_BACKEND=wahs-engine,
// through wahs-engine. These tests replace fetch, so they check what the route sends to the
// backend (address, bearer, model) and that it can read a stream shaped like the engine's,
// without a network call.

const config = vi.hoisted(() => ({
  LLM_API_KEY: undefined as string | undefined,
  LLM_API_BASE: 'http://gateway.test/v1',
  LLM_MODEL: 'ollama/mistral:7b',
  WAHS_ENGINE_URL: 'http://engine.test:8080',
  WAHS_DEFAULT_MODEL: 'wahs-26b'
}));
vi.mock('$lib/server/config', () => config);

import { POST } from '../../routes/(common)/api/health-chat/+server';

function chunk(delta: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return (
    'data: ' +
    JSON.stringify({
      id: 'chatcmpl-wahs-test',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'wahs-26b',
      choices: [{ index: 0, delta, finish_reason: null }],
      ...extra
    }) +
    '\n\n'
  );
}

// What wahs-engine streams: a role chunk carrying its own context event, comment-line
// keepalives while the model warms up, text deltas, and a final chunk carrying provenance
const ENGINE_STREAM =
  chunk({ role: 'assistant', content: '' }, { x_wahs_stream: { event: 'context_ready' } }) +
  ': keepalive\n\n' +
  chunk({ content: 'You take metformin ' }) +
  chunk({ content: '[3].' }) +
  'data: ' +
  JSON.stringify({
    id: 'chatcmpl-wahs-test',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'wahs-26b',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    x_wahs: { citations: [{ n: 3 }] }
  }) +
  '\n\ndata: [DONE]\n\n';

interface BackendCall {
  url: string;
  authorization: string | null;
  body: any;
}

function stubBackend() {
  const calls: BackendCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        authorization: new Headers(init?.headers).get('Authorization'),
        body: JSON.parse(String(init?.body))
      });
      return new Response(ENGINE_STREAM, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' }
      });
    })
  );
  return calls;
}

function ask(authorization?: string) {
  const request = new Request('http://localhost/api/health-chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(authorization ? { Authorization: authorization } : {})
    },
    body: JSON.stringify({
      mode: 'record',
      record: '## Condition\n{"resourceType":"Condition"}',
      messages: [{ role: 'user', content: 'What medications am I taking?' }]
    })
  });
  return POST({ request, url: new URL(request.url) } as any);
}

// Text parts of an AI SDK data stream are lines of the form 0:"..."
function answerText(stream: string) {
  return stream
    .split('\n')
    .filter((line) => line.startsWith('0:'))
    .map((line) => JSON.parse(line.slice(2)))
    .join('');
}

describe('/api/health-chat backend selection', () => {
  beforeEach(() => {
    vi.stubEnv('HEALTH_CHAT_BACKEND', 'wahs-engine');
    config.LLM_API_KEY = undefined;
    config.WAHS_ENGINE_URL = 'http://engine.test:8080';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("sends the question to wahs-engine with the caller's own token", async () => {
    const calls = stubBackend();

    const response = await ask('Bearer patient-jwt');
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://engine.test:8080/v1/chat/completions');
    expect(calls[0].authorization).toBe('Bearer patient-jwt');
    expect(calls[0].body.model).toBe('wahs-26b');
    expect(calls[0].body.stream).toBe(true);
    expect(answerText(text)).toBe('You take metformin [3].');
  });

  it('accepts an engine address that already ends in /v1', async () => {
    config.WAHS_ENGINE_URL = 'http://engine.test:8080/v1/';
    const calls = stubBackend();

    await (await ask('Bearer patient-jwt')).text();

    expect(calls[0].url).toBe('http://engine.test:8080/v1/chat/completions');
  });

  it('responds 503 without calling the engine when there is no patient token to forward', async () => {
    const calls = stubBackend();

    // local-demo-token is the placeholder used in local demo mode; the engine can't use it
    const response = await ask('Bearer local-demo-token');

    expect(response.status).toBe(503);
    expect(calls).toHaveLength(0);
  });

  it('calls the LLM gateway with its API key when no backend is chosen', async () => {
    vi.unstubAllEnvs();
    config.LLM_API_KEY = 'gateway-key';
    const calls = stubBackend();

    const response = await ask('Bearer patient-jwt');
    await response.text();

    expect(response.status).toBe(200);
    expect(calls[0].url).toBe('http://gateway.test/v1/chat/completions');
    expect(calls[0].authorization).toBe('Bearer gateway-key');
    expect(calls[0].body.model).toBe('ollama/mistral:7b');
  });

  it('responds 503 in gateway mode until an API key is set', async () => {
    vi.stubEnv('HEALTH_CHAT_BACKEND', 'gateway');
    const calls = stubBackend();

    const response = await ask('Bearer patient-jwt');

    expect(response.status).toBe(503);
    expect(calls).toHaveLength(0);
  });
});
