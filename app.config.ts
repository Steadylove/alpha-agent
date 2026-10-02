/** 仓库内统一的公开配置；这里不能填写 API Key、Token 或 webhook。 */
export const appConfig = {
  marketDataUrl: "http://192.210.241.6:8787",
  siteUrl: "https://alpha-agent-eight.vercel.app",
  aiModel: "deepseek-v4-pro",
  screenerSkipAi: true,
  optionFlow: { minPremiumUsd: 500_000, pollMs: 3000, dropAds: true, dropPaid: true },
  intraday: { maxSignalAgeMs: 120_000, maxFutureSkewMs: 30_000, maxDeliveryAgeMs: 180_000, maxAttempts: 5, maxBodyBytes: 16_384 },
  intradayResearch: {
    version: "offline-1.0.0", initialCash: 10000, riskFraction: 0.0025,
    maxPositionFraction: 0.2, maxPositions: 2, dailyLossFraction: 0.01,
    minPrice: 1, maxPrice: 20, minGainPct: 20, minVolumeRatio: 5, maxFloat: 20000000,
    warmupBars: 500, stopLookback: 8, feePerShare: 0.005, minimumFee: 1,
    slippageFraction: 0.001, minimumSlippage: 0.01, participation: 0.01,
    quoteMaxAgeMs: 5000, latencyMs: 2000, maxSpreadFraction: 0.01, limitProtection: 0.005, entryExpiryMs: 30000,
  },
  runtimeConfig: { path: "/telegram/runtime-config", cacheMs: 300_000, timeoutMs: 10_000 },
  vercelIdentity: {
    team: "steady1ove", project: "alpha-agent", environment: "production",
    relayPublicKey: "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAh0DUbnTosHKSexhyDyp2\nOLsmo/U9R6/UK2b8zuuI6bB3ervalp0WpvVlCFm09056BX+laXyP5oPgRpfjCRPF\nibMjDb7uz2hIz4KoEmNdCc3Lk2e/CXu88vPCwwaBHFkRkXaFFoLUjjasU9ds8W4f\njngS7NJPhMPpo/hlKjWYXFRGvR++IEmyHVz0HxVQWyO/UdHJ0j8rmYxEDwrRrWBM\nj0cMXoZa69QuV1OF7VZI6KzsKrszMsaAJ6ysfH3kav6iwtp2Iat9v9UmazVhDfvJ\nznaGD0fIy/9vqPGmaRAyqtniFkJf0qHN2DtcynykivYBBWOvGoUFtr0CStqWVujN\nXwIDAQAB\n-----END PUBLIC KEY-----\n",
  },
} as const;

// VPS 只允许下发这些服务端凭据，禁止用私有文件改变进程选项或数据地址。
export const WEB_SECRET_KEYS = [
  "CRON_SECRET", "DESK_STORE_SECRET", "FMP_API_KEY", "DEEPSEEK_API_KEY",
  "DISCORD_WEBHOOK_URL", "DISCORD_SIGNAL_WEBHOOK_URL", "DISCORD_BOT_TOKEN",
  "DISCORD_MIRROR_4H_WEBHOOK_URL", "DISCORD_MIRROR_2H_WEBHOOK_URL",
  "DISCORD_MIRROR_BOOK_WEBHOOK_URL", "DISCORD_MIRROR_GEX_WEBHOOK_URL",
] as const;
