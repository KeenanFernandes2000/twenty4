import { expect, test } from "bun:test";
import { findPlaceholderSecrets, parseEnv, safeParseEnv } from "./index.ts";

const base: Record<string, string> = {
  DATABASE_URL: "postgres://u:p@localhost:5433/db",
  REDIS_URL: "redis://localhost:6380",
  S3_ENDPOINT: "http://localhost:9000",
  S3_ACCESS_KEY: "ak",
  S3_SECRET_KEY: "sk",
  S3_REGION: "us-east-1",
  S3_BUCKET_RAW: "raw",
  S3_BUCKET_MONTAGES: "montages",
  S3_BUCKET_THUMBNAILS: "thumbnails",
};

test("parseEnv applies defaults", () => {
  const env = parseEnv(base);
  expect(env.NODE_ENV).toBe("development");
  expect(env.API_HOST).toBe("0.0.0.0");
  expect(env.API_PORT).toBe(3000);
});

test("parseEnv coerces API_PORT", () => {
  const env = parseEnv({ ...base, API_PORT: "4000" });
  expect(env.API_PORT).toBe(4000);
});

test("safeParseEnv fails on missing required var", () => {
  const { DATABASE_URL: _omit, ...rest } = base;
  void _omit;
  expect(safeParseEnv(rest).success).toBe(false);
});

test("prod-secret guard flags placeholder secrets only in production", () => {
  const dev = parseEnv({ ...base, S3_ACCESS_KEY: "minioadmin" });
  expect(findPlaceholderSecrets(dev)).toEqual([]);

  const prod = parseEnv({
    ...base,
    NODE_ENV: "production",
    S3_ACCESS_KEY: "minioadmin",
    S3_SECRET_KEY: "Kp9xQ2vL7mNw",
    DATABASE_URL: "postgres://app:Kp9xQ2vL7mNw@db.prod/app",
  });
  expect(findPlaceholderSecrets(prod)).toEqual(["S3_ACCESS_KEY"]);
});

test("prod-secret guard flags dev DATABASE_URL with 'twenty4'", () => {
  const prod = parseEnv({ ...base, NODE_ENV: "production" });
  // base DATABASE_URL has no placeholder, but creds are 'u:p'; force a dev one:
  const prodDev = parseEnv({
    ...base,
    NODE_ENV: "production",
    DATABASE_URL: "postgres://twenty4:twenty4@localhost:5433/twenty4",
    S3_ACCESS_KEY: "realstrong",
    S3_SECRET_KEY: "realstrong2",
  });
  expect(findPlaceholderSecrets(prod)).not.toContain("S3_ACCESS_KEY");
  expect(findPlaceholderSecrets(prodDev)).toContain("DATABASE_URL");
});
