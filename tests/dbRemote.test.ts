import { afterEach, describe, expect, it } from "vitest";

import { hasDatabase, remoteDbEnabled } from "@/lib/db/remote";
import { smallFundSource } from "@/lib/backtest/load";

describe("远程库开关", () => {
  const prev = {
    ALLOW_DB: process.env.ALLOW_DB,
    NODE_ENV: process.env.NODE_ENV,
    VERCEL: process.env.VERCEL,
    DATABASE_URL: process.env.DATABASE_URL,
    SMALLFUND_SOURCE: process.env.SMALLFUND_SOURCE,
  };

  afterEach(() => {
    restore("ALLOW_DB", prev.ALLOW_DB);
    restore("NODE_ENV", prev.NODE_ENV);
    restore("VERCEL", prev.VERCEL);
    restore("DATABASE_URL", prev.DATABASE_URL);
    restore("SMALLFUND_SOURCE", prev.SMALLFUND_SOURCE);
  });

  it("任何环境都不连库", () => {
    process.env.ALLOW_DB = "1";
    process.env.VERCEL = "1";
    setEnv("NODE_ENV", "production");
    process.env.DATABASE_URL = "postgresql://example/db";
    expect(remoteDbEnabled()).toBe(false);
    expect(hasDatabase()).toBe(false);
  });

  it("Small Fund 只读 CSV / VPS", () => {
    delete process.env.SMALLFUND_SOURCE;
    expect(smallFundSource()).toBe("csv");

    process.env.SMALLFUND_SOURCE = "db";
    setEnv("NODE_ENV", "production");
    expect(smallFundSource()).toBe("csv");
  });
});

function setEnv(key: string, value: string) {
  process.env[key] = value;
}

function restore(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
