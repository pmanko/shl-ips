export const AUTOCODER_API_KEY = process.env.AUTOCODER_API_KEY;

// OpenAI-compatible LLM gateway used by the health record chat (/api/health-chat)
export const LLM_API_KEY = process.env.LLM_API_KEY;
export const LLM_API_BASE = process.env.LLM_API_BASE || 'https://llm.co.dev.cirg.uw.edu/v1';
export const LLM_MODEL = process.env.LLM_MODEL || 'ollama/mistral:7b';

export const API_BASE = process.env.SERVER_API_BASE || process.env.VITE_API_BASE;

export const REDIRECT_URI = process.env.REDIRECT_URI;

export const SERVER_API_BASE = process.env.SERVER_API_BASE || process.env.VITE_API_BASE;

export const WAHS_ENGINE_URL =
  process.env.WAHS_ENGINE_URL ||
  process.env.VITE_WAHS_ENGINE_URL ||
  'http://wahs-engine:8080/v1';

export const WAHS_DEFAULT_MODEL =
  (process.env.WAHS_DEFAULT_MODEL || 'wahs-26b').trim() || 'wahs-26b';

export const WAHS_DEFAULT_PROFILE =
  (process.env.WAHS_DEFAULT_PROFILE || 'core-enriched').trim() || 'core-enriched';

const rawDefaultTargetBudget = Number(
  process.env.WAHS_DEFAULT_TARGET_BUDGET_TOKENS || '16384'
);
export const WAHS_DEFAULT_TARGET_BUDGET_TOKENS =
  Number.isFinite(rawDefaultTargetBudget) && rawDefaultTargetBudget > 0
    ? Math.trunc(rawDefaultTargetBudget)
    : 16384;

export const SERVER_LOCAL_DEMO_MODE = Boolean(
  process.env.SERVER_LOCAL_DEMO_MODE === '1' ||
  process.env.SERVER_LOCAL_DEMO_MODE === 'true' ||
  (process.env.SERVER_LOCAL_DEMO_MODE !== 'false' &&
    (process.env.VITE_LOCAL_DEMO === '1' || process.env.VITE_LOCAL_DEMO === 'true'))
);

export const PUBLIC_AUTH_URL =
  process.env.VITE_AUTH_URL || 'http://localhost:8088/realms/wahs';

export const SERVER_AUTH_CLIENT_ID =
  process.env.VITE_AUTH_CLIENT_ID || 'shl_creator';

export const SEEDED_PROFILES_ENABLED =
  process.env.WAHS_ENABLE_SEEDED_PROFILES !== 'false';

export const SEEDED_DEMO_PASSWORD =
  process.env.WAHS_SEEDED_DEMO_PASSWORD || 'wahs-demo-2026';

export function resolveInternalKeycloakRealmUrl(): string {
  const explicit = (
    process.env.KEYCLOAK_INTERNAL_URL ||
    process.env.SERVER_AUTH_URL ||
    ''
  )
    .trim()
    .replace(/\/+$/, '');
  if (explicit) {
    return explicit;
  }
  try {
    const pub = new URL(PUBLIC_AUTH_URL);
    return `http://keycloak:8080${pub.pathname.replace(/\/+$/, '')}`;
  } catch {
    return 'http://keycloak:8080/realms/wahs';
  }
}

export const CONFIDENTIAL_HOSTS: Record<string, any> = {
  aetna: {
    tokenEndpoint: process.env.AETNA_TOKEN_ENDPOINT,
    clientId: process.env.VITE_AETNA_CLIENT_ID,
    clientSecret: process.env.AETNA_CLIENT_SECRET,
  },
  acentra: {
    tokenEndpoint: process.env.ACENTRA_TOKEN_ENDPOINT,
    clientId: process.env.VITE_ACENTRA_CLIENT_ID,
    clientSecret: process.env.ACENTRA_CLIENT_SECRET,
  },
  bluebutton: {
    tokenEndpoint: process.env.BLUE_BUTTON_TOKEN_ENDPOINT,
    clientId: process.env.VITE_BLUE_BUTTON_CLIENT_ID,
    clientSecret: process.env.BLUE_BUTTON_CLIENT_SECRET,
  },
  carefirst: {
    tokenEndpoint: process.env.CAREFIRST_TOKEN_ENDPOINT,
    clientId: process.env.VITE_CAREFIRST_CLIENT_ID,
    clientSecret: process.env.CAREFIRST_CLIENT_SECRET,
  },
  cpcds: {
    tokenEndpoint: process.env.CPCDS_TOKEN_ENDPOINT,
    clientId: process.env.VITE_CPCDS_CLIENT_ID,
    clientSecret: process.env.CPCDS_CLIENT_SECRET,
  },
  deloitte: {
    tokenEndpoint: process.env.DELOITTE_TOKEN_ENDPOINT,
    clientId: process.env.VITE_DELOITTE_CLIENT_ID,
    clientSecret: process.env.DELOITTE_CLIENT_SECRET,
  },
  humana: {
    tokenEndpoint: process.env.HUMANA_TOKEN_ENDPOINT,
    clientId: process.env.VITE_HUMANA_CLIENT_ID,
    clientSecret: process.env.HUMANA_CLIENT_SECRET,
  },
  inferno: {
    tokenEndpoint: process.env.INFERNO_TOKEN_ENDPOINT,
    clientId: process.env.VITE_INFERNO_CLIENT_ID,
    clientSecret: process.env.INFERNO_CLIENT_SECRET,
  },
  molina: {
    tokenEndpoint: process.env.MOLINA_TOKEN_ENDPOINT,
    clientId: process.env.VITE_MOLINA_CLIENT_ID,
    clientSecret: process.env.MOLINA_CLIENT_SECRET,
  },
  onyx: {
    tokenEndpoint: process.env.ONYX_TOKEN_ENDPOINT,
    clientId: process.env.VITE_ONYX_CLIENT_ID,
    clientSecret: process.env.ONYX_CLIENT_SECRET,
  },
  smilecarinbb: {
    tokenEndpoint: process.env.SMILECARINBB_TOKEN_ENDPOINT,
    clientId: process.env.VITE_SMILECARINBB_CLIENT_ID,
    clientSecret: process.env.SMILECARINBB_CLIENT_SECRET,
  },
  united: {
    tokenEndpoint: process.env.UNITED_TOKEN_ENDPOINT,
    clientId: process.env.VITE_UNITED_CLIENT_ID,
    clientSecret: process.env.UNITED_CLIENT_SECRET,
  },
  meditech: {
      tokenEndpoint: process.env.MEDITECH_TOKEN_ENDPOINT,
      clientId: process.env.VITE_MEDITECH_CLIENT_ID,
      clientSecret: process.env.MEDITECH_CLIENT_SECRET,
    },
}

export const URL_BEARER_HOSTS: Record<string, any> = {
  meditech: {
    token: process.env.MEDITECH_BEARER_TOKEN
  },
  epic: {
    token: process.env.EPIC_BEARER_TOKEN
  },
  epicihe: {
    credentials: {
      tokenEndpoint: process.env.EPIC_IHE_TOKEN_ENDPOINT,
      clientId: process.env.EPIC_IHE_CLIENT_ID,
      clientSecret: process.env.EPIC_IHE_CLIENT_SECRET
    }
  }
}
