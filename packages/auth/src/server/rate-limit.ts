import type { AuthRedis } from "./redis.js";

const PASSWORD_RATE_LIMIT_PREFIX = "auth:password-rate:";
const PASSWORD_RATE_LIMIT_MAX_ATTEMPTS = 5;
const PASSWORD_RATE_LIMIT_TTL_SECONDS = 15 * 60;

const PASSWORD_ACCOUNT_RATE_LIMIT_PREFIX = "auth:password-rate-account:";
const PASSWORD_ACCOUNT_RATE_LIMIT_MAX_ATTEMPTS = 10;
const PASSWORD_ACCOUNT_RATE_LIMIT_TTL_SECONDS = 60 * 60;

const PASSWORD_IP_RATE_LIMIT_PREFIX = "auth:password-rate-ip:";
const PASSWORD_IP_RATE_LIMIT_MAX_ATTEMPTS = 30;
const PASSWORD_IP_RATE_LIMIT_TTL_SECONDS = 60 * 60;

const PASSKEY_RATE_LIMIT_PREFIX = "auth:passkey-rate-ip:";
const PASSKEY_RATE_LIMIT_MAX_ATTEMPTS = 5;
const PASSKEY_RATE_LIMIT_TTL_SECONDS = 15 * 60;

function passwordRateLimitKey(ip: string, username: string) {
  return `${PASSWORD_RATE_LIMIT_PREFIX}${ip}:${username.toLowerCase()}`;
}

function passwordAccountRateLimitKey(username: string) {
  return `${PASSWORD_ACCOUNT_RATE_LIMIT_PREFIX}${username.toLowerCase()}`;
}

function passwordIpRateLimitKey(ip: string) {
  return `${PASSWORD_IP_RATE_LIMIT_PREFIX}${ip}`;
}

function passkeyRateLimitKey(ip: string) {
  return `${PASSKEY_RATE_LIMIT_PREFIX}${ip}`;
}

type PasswordRateLimitDimension = {
  key: string;
  max: number;
  ttlSeconds: number;
};

function passwordRateLimitDimensions(ip: string, username: string): PasswordRateLimitDimension[] {
  return [
    {
      key: passwordRateLimitKey(ip, username),
      max: PASSWORD_RATE_LIMIT_MAX_ATTEMPTS,
      ttlSeconds: PASSWORD_RATE_LIMIT_TTL_SECONDS
    },
    {
      key: passwordAccountRateLimitKey(username),
      max: PASSWORD_ACCOUNT_RATE_LIMIT_MAX_ATTEMPTS,
      ttlSeconds: PASSWORD_ACCOUNT_RATE_LIMIT_TTL_SECONDS
    },
    {
      key: passwordIpRateLimitKey(ip),
      max: PASSWORD_IP_RATE_LIMIT_MAX_ATTEMPTS,
      ttlSeconds: PASSWORD_IP_RATE_LIMIT_TTL_SECONDS
    }
  ];
}

export async function getPasswordRateLimit(redis: AuthRedis, ip: string, username: string) {
  const dimensions = passwordRateLimitDimensions(ip, username);
  const states = await Promise.all(
    dimensions.map(async (dimension) => {
      const [countRaw, ttl] = await Promise.all([redis.get(dimension.key), redis.ttl(dimension.key)]);
      const attempts = Number(countRaw ?? 0);
      return {
        attempts,
        blocked: attempts >= dimension.max,
        ttl: ttl > 0 ? ttl : 0
      };
    })
  );

  const blocked = states.some((state) => state.blocked);
  const retryAfterSeconds = states
    .filter((state) => state.blocked)
    .reduce((longest, state) => Math.max(longest, state.ttl), 0);

  const primary = states[0];
  return {
    attempts: primary?.attempts ?? 0,
    blocked,
    retryAfterSeconds
  };
}

export async function registerFailedPasswordAttempt(redis: AuthRedis, ip: string, username: string) {
  const dimensions = passwordRateLimitDimensions(ip, username);
  const states = await Promise.all(
    dimensions.map(async (dimension) => {
      const attempts = await redis.incr(dimension.key);
      if (attempts === 1) {
        await redis.expire(dimension.key, dimension.ttlSeconds);
      }

      const ttl = await redis.ttl(dimension.key);
      return {
        attempts,
        blocked: attempts >= dimension.max,
        retryAfterSeconds: ttl > 0 ? ttl : dimension.ttlSeconds
      };
    })
  );

  const blocked = states.some((state) => state.blocked);
  const retryAfterSeconds = states
    .filter((state) => state.blocked)
    .reduce((longest, state) => Math.max(longest, state.retryAfterSeconds), 0);

  const primary = states[0];
  return {
    attempts: primary?.attempts ?? 0,
    retryAfterSeconds: blocked ? retryAfterSeconds : (primary?.retryAfterSeconds ?? 0),
    blocked
  };
}

export async function clearPasswordAttempts(redis: AuthRedis, ip: string, username: string) {
  await Promise.all(
    passwordRateLimitDimensions(ip, username).map((dimension) => redis.del(dimension.key))
  );
}

export async function getPasskeyRateLimit(redis: AuthRedis, ip: string) {
  const key = passkeyRateLimitKey(ip);
  const [countRaw, ttl] = await Promise.all([redis.get(key), redis.ttl(key)]);
  const attempts = Number(countRaw ?? 0);
  const blocked = attempts >= PASSKEY_RATE_LIMIT_MAX_ATTEMPTS;

  return {
    attempts,
    blocked,
    retryAfterSeconds: blocked && ttl > 0 ? ttl : 0
  };
}

export async function registerFailedPasskeyAttempt(redis: AuthRedis, ip: string) {
  const key = passkeyRateLimitKey(ip);
  const attempts = await redis.incr(key);
  if (attempts === 1) {
    await redis.expire(key, PASSKEY_RATE_LIMIT_TTL_SECONDS);
  }

  const ttl = await redis.ttl(key);
  return {
    attempts,
    blocked: attempts >= PASSKEY_RATE_LIMIT_MAX_ATTEMPTS,
    retryAfterSeconds: ttl > 0 ? ttl : PASSKEY_RATE_LIMIT_TTL_SECONDS
  };
}

export async function clearPasskeyAttempts(redis: AuthRedis, ip: string) {
  await redis.del(passkeyRateLimitKey(ip));
}
