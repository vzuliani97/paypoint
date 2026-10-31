import { z } from 'zod';

export const APP_CONFIG = Symbol('APP_CONFIG');

const booleanFlag = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32, 'must be at least 32 characters'),
  JWT_EXPIRES_IN_SECONDS: z.coerce.number().int().positive().default(3600),
  CORS_ORIGIN: z.string().default('http://localhost:8081'),
  // Number of reverse proxies in front of the API (nginx = 1). Needed so req.ip is the real client.
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  PARTNER_SIGNATURE_TOLERANCE_SECONDS: z.coerce.number().int().positive().default(300),
  PROVIDER_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  SEED_DEMO_DATA: booleanFlag,
  DEMO_PASSWORD: z.string().min(8).default('paypoint-demo'),
  // Live betting: a simulated odds feed keeps a board of fictitious matches moving. Tests turn it off.
  BETTING_FEED_ENABLED: z.enum(['true', 'false']).default('true').transform((value) => value === 'true'),
  BETTING_FEED_INTERVAL_MS: z.coerce.number().int().min(250).default(3000),
  BET_MIN_STAKE: z.coerce.number().int().positive().default(1000),
  BET_MAX_STAKE: z.coerce.number().int().positive().default(500000),
  // Shared secret of the (simulated) casino game provider that calls the seamless-wallet endpoints.
  CASINO_PROVIDER_SECRET: z.string().min(16).default('demo-casino-provider-secret-change-me'),
  DEMO_PARTNER_SECRET: z.string().min(16).default('demo-partner-secret-change-me'),
  DEMO_PARTNER_ALLOWED_IPS: z.string().default('127.0.0.1,::1,172.16.0.0/12,192.168.0.0/16'),
});

export type AppConfig = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);

  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid configuration: ${problems}`);
  }

  return parsed.data;
}
