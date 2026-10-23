import { z } from 'zod';
import type { Dot, ModelConnection } from '../shared/types.js';
import type { PlatformConfig } from './platform-config.js';

export const modelSelectionSchema = z
  .object({
    modelConnectionId: z.string().min(1).max(80).nullable(),
    modelId: z.string().trim().min(1).max(200).nullable(),
  })
  .strict()
  .refine((value) => !!value.modelConnectionId === !!value.modelId);
const connectionSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,80}$/)
      .refine((id) => id !== 'default'),
    name: z.string().trim().min(1).max(80),
    location: z.enum(['local', 'remote']),
    baseUrl: z
      .string()
      .url()
      .refine((value) => {
        const url = new URL(value);
        return (
          ['http:', 'https:'].includes(url.protocol) &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash
        );
      }),
    models: z.array(z.string().trim().min(1).max(200)).min(1).max(200),
    apiKeyEnv: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*$/)
      .optional(),
  })
  .strict();
export interface ModelProfile extends ModelConnection {
  baseUrl: string;
  apiKey?: string;
}
export function modelProfilesFromEnv(
  env: Record<string, string | undefined>,
): ModelProfile[] {
  if (!env.OPENDOTS_MODEL_CONNECTIONS?.trim()) return [];
  try {
    const profiles = z
      .array(connectionSchema)
      .max(30)
      .parse(JSON.parse(env.OPENDOTS_MODEL_CONNECTIONS));
    if (new Set(profiles.map((profile) => profile.id)).size !== profiles.length)
      throw new Error();
    return profiles.map(({ apiKeyEnv, ...profile }) => ({
      ...profile,
      apiKey: apiKeyEnv ? env[apiKeyEnv]?.trim() : 'not-required',
      ready: !apiKeyEnv || !!env[apiKeyEnv]?.trim(),
    }));
  } catch {
    throw new Error('Invalid OPENDOTS_MODEL_CONNECTIONS configuration.');
  }
}
export function modelConnections(config: PlatformConfig): ModelConnection[] {
  return [
    {
      id: 'default',
      name: 'Workspace connection',
      location: 'default',
      models: config.model ? [config.model] : [],
      ready: !!(config.model && config.apiKey),
    },
    ...(config.modelProfiles ?? []).map(
      ({ id, name, location, models, ready }) => ({
        id,
        name,
        location,
        models,
        ready,
      }),
    ),
  ];
}
export function resolveDotModel(
  config: PlatformConfig,
  dot: Pick<Dot, 'modelConnectionId' | 'modelId'>,
) {
  if (!dot.modelConnectionId) {
    if (!config.apiKey || !config.model)
      throw new Error('Workspace model is not configured.');
    return {
      model: config.model,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
    };
  }
  const connection = modelConnections(config).find(
    (item) => item.id === dot.modelConnectionId,
  );
  if (
    !connection?.ready ||
    !dot.modelId ||
    !connection.models.includes(dot.modelId)
  )
    throw new Error(
      'Selected model is unavailable. Update this specialist’s model settings.',
    );
  if (connection.id === 'default')
    return {
      model: dot.modelId,
      apiKey: config.apiKey!,
      baseUrl: config.baseUrl,
    };
  const profile = config.modelProfiles!.find(
    (item) => item.id === connection.id,
  )!;
  return {
    model: dot.modelId,
    apiKey: profile.apiKey!,
    baseUrl: profile.baseUrl,
  };
}
