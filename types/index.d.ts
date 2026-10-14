export interface RequestUsageItem {
  timestamp: number;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  durationMs: number;
}

export interface ProviderQuotaWindowItem {
  label: string;
  percent: number;
  resetAt?: number;
}

export interface ProviderQuotaState {
  provider: string;
  fiveHourPercent?: number;
  fiveHourResetAt?: number;
  weeklyPercent?: number;
  weeklyResetAt?: number;
  monthlyPercent?: number;
  monthlyResetAt?: number;
  customWindows?: ProviderQuotaWindowItem[];
  updatedAt?: number;
}

export interface OpenCodexSummary {
  activeModel: string;
  activeProvider: string;
  lastTurnTokens: number;
  lastTurnInputTokens: number;
  lastTurnOutputTokens: number;
  lastTurnCachedTokens: number;
  lastTurnReasoningTokens: number;
  lastTurnDurationMs: number;
  sessionTotalTokens: number;
  sessionInputTokens: number;
  sessionOutputTokens: number;
  sessionCachedTokens: number;
  sessionSavingsPercent: number;
  recentRequests: RequestUsageItem[];
  quotas: ProviderQuotaState[];
  port?: number;
  lastUpdated: number;
  error?: string;
}

declare module 'claude-code' {
  interface PluginState {
    'opencodex-limits': {
      summary: OpenCodexSummary | null;
      isPaneOpen: boolean;
      lastRefresh: number;
    }
  }
}
