import type { ModelProfile } from './models.js';
import type { WebConfig } from './parallel.js';
import type { SetupStatus } from '../shared/types.js';

// `copilotkit project select` writes the CLI name and deletes the template name.
const INTELLIGENCE_API_KEY_ENV_NAMES = [
  'CPK_INTELLIGENCE_API_KEY',
  'INTELLIGENCE_API_KEY',
] as const;
export const INTELLIGENCE_KEY_MISSING_LABEL = `${INTELLIGENCE_API_KEY_ENV_NAMES[1]} (or ${INTELLIGENCE_API_KEY_ENV_NAMES[0]})`;
export const DEFAULT_AGENT_RUN_TIMEOUT_MS = 90_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export function intelligenceApiKeyFromEnv(
  env: Record<string, string | undefined>,
): string | undefined {
  return firstNonEmptyEnvValue(env, INTELLIGENCE_API_KEY_ENV_NAMES);
}

export function intelligenceWsUrlFromEnv(
  env: Record<string, string | undefined>,
): string | undefined {
  return firstNonEmptyEnvValue(env, [
    'INTELLIGENCE_GATEWAY_WS_URL',
    'INTELLIGENCE_WS_URL',
  ]);
}

export function agentRunTimeoutMsFromEnv(
  env: Record<string, string | undefined>,
): number {
  const raw = env.AGENT_RUN_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_AGENT_RUN_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_TIMER_DELAY_MS)
    throw new Error(
      `AGENT_RUN_TIMEOUT_MS must be an integer between 1 and ${MAX_TIMER_DELAY_MS}.`,
    );
  return value;
}

function firstNonEmptyEnvValue(
  env: Record<string, string | undefined>,
  names: readonly string[],
): string | undefined {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

export type ConversationBackend = 'local' | 'intelligence';
export function conversationBackend(
  config: Pick<PlatformConfig, 'conversationBackend'>,
): ConversationBackend {
  return config.conversationBackend ?? 'intelligence';
}
export function localRuntimeSettingsFromEnv(
  env: Record<string, string | undefined>,
) {
  const integer = (key: string, fallback: number, maximum: number) => {
    const value = Number(env[key] ?? fallback);
    if (!Number.isInteger(value) || value < 1 || value > maximum)
      throw new Error(`Invalid ${key}.`);
    return value;
  };
  const mode =
    env.CONVERSATION_BACKEND ??
    (intelligenceApiKeyFromEnv(env) ? 'intelligence' : 'local');
  if (mode !== 'local' && mode !== 'intelligence')
    throw new Error('Invalid CONVERSATION_BACKEND.');
  return {
    conversationBackend: mode,
    localContextMessages: integer('LOCAL_CONTEXT_MESSAGES', 100, 2000),
    localMaxHistoryBytes: integer(
      'LOCAL_MAX_HISTORY_BYTES',
      16777216,
      268435456,
    ),
    localMaxEventsPerRun: integer('LOCAL_MAX_EVENTS_PER_RUN', 10000, 100000),
  } as const;
}
export interface PlatformConfig extends WebConfig {
  modelProfiles?: ModelProfile[];
  conversationBackend?: ConversationBackend;
  localContextMessages?: number;
  localMaxHistoryBytes?: number;
  localMaxEventsPerRun?: number;
  intelligenceKey?: string;
  intelligenceApiUrl?: string;
  intelligenceWsUrl?: string;
  model?: string;
  apiKey?: string;
  baseUrl: string;
  agentRunTimeoutMs?: number;
  computerSupervisorUrl?: string;
  computerSupervisorToken?: string;
  computerToken?: string;
  computerNamespace?: string;
  browserUrl?: string;
  browserSecret?: string;
  composioApiKey?: string;
  voiceKey?: string;
  voiceModel?: string;
  voiceName: string;
  slackChannel?: string;
  slackTeam?: string;
  slackUsers: string[];
  slackDotId?: string;
  runtimeUrl: string;
  ownerToken?: string;
}
export function setupStatus(
  config: PlatformConfig,
  slack = 'not_configured',
  activationFailed = false,
): SetupStatus {
  const configuredProfile =
    config.modelProfiles?.some((profile) => profile.ready) ?? false;
  const missing = [
    conversationBackend(config) === 'intelligence' &&
      !config.intelligenceKey &&
      INTELLIGENCE_KEY_MISSING_LABEL,
    !configuredProfile && !config.apiKey && 'OPENAI_API_KEY',
    !configuredProfile && !config.model && 'OPENAI_MODEL',
  ].filter((item): item is string => !!item);
  const declaredSlack = !!(
    config.slackChannel &&
    config.slackTeam &&
    config.slackUsers.length
  );
  slack = declaredSlack
    ? activationFailed && slack !== 'online'
      ? 'activation_failed'
      : slack
    : config.slackChannel || config.slackTeam || config.slackUsers.length
      ? 'setup_required'
      : 'not_configured';
  return {
    conversationStorage: conversationBackend(config),
    intelligence:
      conversationBackend(config) === 'intelligence' &&
      !!config.intelligenceKey,
    model: configuredProfile || !!(config.apiKey && config.model),
    browser: !!(config.browserUrl && config.browserSecret),
    voice: !!(config.voiceKey && config.voiceModel && !missing.length),
    composio: !!config.composioApiKey,
    slack,
    missing,
  };
}
