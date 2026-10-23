export interface Env {
  DB: D1Database;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  GITHUB_WEBHOOK_SECRET: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  CURSEFORGE_API_KEY?: string;
  URLHAUS_KEY?: string;
  SCANNER_HMAC_SECRET: string;
  SCANNER_DISPATCH_TOKEN: string;
  TOKEN_ENCRYPTION_KEY: string;
  VISITOR_SALT: string;
  TURNSTILE_SECRET?: string;
  ADMIN_GITHUB_IDS?: string;
  RL_READ: RateLimit;
  RL_WRITE: RateLimit;
  RL_UPLOAD: RateLimit;
  RL_DOWNLOAD: RateLimit;
  RL_AUTH: RateLimit;
}

export function adminIds(env: Env): number[] {
  return (env.ADMIN_GITHUB_IDS ?? '')
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isSafeInteger(n) && n > 0);
}
