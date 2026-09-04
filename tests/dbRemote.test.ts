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

  it("本地默认不连", () => {
    delete process.env.ALLOW_DB;
    delete process.env.VERCEL;
    process.env.NODE_ENV = "development";
    process.env.DATABASE_URL = "postgresql://neon.example/db";
    expect(remoteDbEnabled()).toBe(false);
    expect(hasDatabase()).toBe(false);
  });

  it("ALLOW_DB=1 才放开本地", () => {
    process.env.ALLOW_DB = "1";
    process.env.NODE_ENV = "development";
    delete process.env.VERCEL;
    process.env.DATABASE_URL = "postgresql://neon.example/db";
    expect(remoteDbEnabled()).toBe(true);
    expect(hasDatabase()).toBe(true);
  });

  it("生产或 Vercel 默认连", () => {
    delete process.env.ALLOW_DB;
    process.env.NODE_ENV = "production";
    delete process.env.VERCEL;
    process.env.DATABASE_URL = "postgresql://neon.example/db";
    expect(remoteDbEnabled()).toBe(true);

    process.env.NODE_ENV = "development";
    process.env.VERCEL = "1";
    expect(remoteDbEnabled()).toBe(true);
  });

  it("本地 Small Fund 默认读 CSV，不回落数据库", () => {
    delete process.env.SMALLFUND_SOURCE;
    delete process.env.ALLOW_DB;
    delete process.env.VERCEL;
    process.env.NODE_ENV = "development";
    expect(smallFundSource()).toBe("csv");
  });

  it("生产 Small Fund 默认读库", () => {
    delete process.env.SMALLFUND_SOURCE;
    process.env.NODE_ENV = "production";
    expect(smallFundSource()).toBe("db");
  });
});

function restore(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
