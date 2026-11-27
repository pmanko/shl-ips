import type { RequestHandler } from '@sveltejs/kit';
import { createHealthChatHandler } from '$lib/server/healthChat';
import { healthChatModel } from '$lib/server/healthChatBackend';

// Access is checked in hooks.server.ts, which requires a valid bearer token for /api/*.
// Instances can disable this endpoint with INSTANCE_CONFIG.disallowedEndpoints: ['health-chat'].

// The model is chosen per request because the wahs-engine backend needs the caller's own token
// (see healthChatBackend.ts). chatModel() targets the backend's /chat/completions endpoint.
export const POST: RequestHandler = (event) =>
  createHealthChatHandler({ model: () => healthChatModel(event.request) })(event);
