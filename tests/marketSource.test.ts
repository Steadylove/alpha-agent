import { afterEach, describe, expect, it } from "vitest";

import { smallFundSource } from "@/lib/backtest/load";

describe("文件行情数据源", () => {
  const prev = {
    NODE_ENV: process.env.NODE_ENV,
    SMALLFUND_SOURCE: process.env.SMALLFUND_SOURCE,
  };

  afterEach(() => {
    restore("NODE_ENV", prev.NODE_ENV);
    restore("SMALLFUND_SOURCE", prev.SMALLFUND_SOURCE);
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
