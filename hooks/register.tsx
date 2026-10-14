import { atom, read, update } from 'claude-code';
import type { Register } from 'claude-code';
import type {
  OpenCodexSummary,
  RequestUsageItem,
  ProviderQuotaState,
  ProviderQuotaWindowItem,
} from '../types';

const PANE_ID = 'opencodex-limits';
const COLOR_PRIMARY = '#d97757'; // Signature Claude terracotta
const COLOR_BG_LINE = '#555555'; // Distinct background line

const summaryAtom = atom(
  { plugin: 'opencodex-limits', key: 'summary' } as const,
  null as OpenCodexSummary | null,
);
const isPaneOpenAtom = atom(
  { plugin: 'opencodex-limits', key: 'isPaneOpen' } as const,
  false,
);
const lastRefreshAtom = atom(
  { plugin: 'opencodex-limits', key: 'lastRefresh' } as const,
  0,
);

function formatNumber(num: number): string {
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + 'M';
  if (num >= 1_000) return Math.round(num / 1_000) + 'k';
  return Math.round(num).toString();
}

function formatResetRu(resetAt?: number): string {
  if (!resetAt) return '';
  const diffSec = Math.max(0, Math.floor((resetAt - Date.now()) / 1000));
  const hours = Math.floor(diffSec / 3600);
  const mins = Math.floor((diffSec % 3600) / 60);
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    return `${days}д`;
  }
  if (hours > 0) return `${hours}ч`;
  return `${mins}м`;
}

interface ActiveQuotaInfo {
  fiveHourRemaining: number;
  fiveHourReset: string;
  weeklyRemaining?: number;
  weeklyReset?: string;
}

function getActiveQuota(summary: OpenCodexSummary): ActiveQuotaInfo | null {
  // Prefer google-antigravity quota (which holds Antigravity 5h and weekly limits)
  const quotaProvider =
    summary.quotas.find((q) => q.provider === 'google-antigravity') ||
    summary.quotas.find((q) => q.provider === summary.activeProvider) ||
    summary.quotas[0];

  if (!quotaProvider) return null;

  if (quotaProvider.customWindows && quotaProvider.customWindows.length > 0) {
    const gem5h = quotaProvider.customWindows.find((w) => w.label === 'Gem');
    const gemWeek = quotaProvider.customWindows.find((w) => w.label === 'Gem (Weekly)');
    const cla5h = quotaProvider.customWindows.find((w) => w.label === 'Cla');
    const claWeek = quotaProvider.customWindows.find((w) => w.label === 'Cla (Weekly)');

    const modelLower = summary.activeModel.toLowerCase();
    const isAntigravityClaude =
      summary.activeProvider === 'google-antigravity' &&
      (modelLower.includes('claude') ||
        modelLower.includes('sonnet') ||
        modelLower.includes('opus'));

    // If explicitly running Claude on google-antigravity and it has quota
    if (isAntigravityClaude && (cla5h || claWeek)) {
      return {
        fiveHourRemaining: cla5h
          ? Math.max(0, Math.min(100, Math.round(100 - cla5h.percent)))
          : 100,
        fiveHourReset: formatResetRu(cla5h?.resetAt),
        weeklyRemaining: claWeek
          ? Math.max(0, Math.min(100, Math.round(100 - claWeek.percent)))
          : undefined,
        weeklyReset: formatResetRu(claWeek?.resetAt),
      };
    }

    // Default to Gemini Antigravity quota
    if (gem5h || gemWeek) {
      return {
        fiveHourRemaining: gem5h
          ? Math.max(0, Math.min(100, Math.round(100 - gem5h.percent)))
          : 100,
        fiveHourReset: formatResetRu(gem5h?.resetAt),
        weeklyRemaining: gemWeek
          ? Math.max(0, Math.min(100, Math.round(100 - gemWeek.percent)))
          : undefined,
        weeklyReset: formatResetRu(gemWeek?.resetAt),
      };
    }
  }

  if (quotaProvider.fiveHourPercent !== undefined) {
    return {
      fiveHourRemaining: Math.max(
        0,
        Math.min(100, Math.round(100 - quotaProvider.fiveHourPercent)),
      ),
      fiveHourReset: formatResetRu(quotaProvider.fiveHourResetAt),
      weeklyRemaining:
        quotaProvider.weeklyPercent !== undefined
          ? Math.max(0, Math.min(100, Math.round(100 - quotaProvider.weeklyPercent)))
          : undefined,
      weeklyReset: formatResetRu(quotaProvider.weeklyResetAt),
    };
  }

  return null;
}

async function fetchOpenCodexData($: any): Promise<OpenCodexSummary> {
  const ocxHome = (await $.env.get('OPENCODEX_HOME'))?.trim();
  const homeDir =
    ocxHome ||
    (await $.env.get('USERPROFILE'))?.trim() ||
    (await $.env.get('HOME'))?.trim() ||
    '';
  const ocxDir = ocxHome || (homeDir ? `${homeDir}/.opencodex` : '.opencodex');

  let port = 10100;
  try {
    const portContent = await $.fs.read(`${ocxDir}/runtime-port.json`);
    const portData = JSON.parse(portContent);
    if (portData?.port) port = portData.port;
  } catch {}

  let adminToken = '';
  try {
    adminToken = (await $.fs.read(`${ocxDir}/admin-api-token`)).trim();
  } catch {}

  let activeModel = 'gemini-3.8-flash';
  let activeProvider = 'google-antigravity';
  try {
    const configContent = await $.fs.read(`${ocxDir}/config.json`);
    const cfg = JSON.parse(configContent);
    if (cfg?.defaultProvider) activeProvider = cfg.defaultProvider;
    if (cfg?.providers?.[activeProvider]?.defaultModel) {
      activeModel = cfg.providers[activeProvider].defaultModel;
    }
  } catch {}

  const recentRequests: RequestUsageItem[] = [];
  let sessionTotalTokens = 0;
  let sessionInputTokens = 0;
  let sessionOutputTokens = 0;
  let sessionCachedTokens = 0;
  let lastTurnTokens = 0;
  let lastTurnInputTokens = 0;
  let lastTurnOutputTokens = 0;
  let lastTurnCachedTokens = 0;
  let lastTurnReasoningTokens = 0;
  let lastTurnDurationMs = 0;

  try {
    const usageContent = await $.fs.read(`${ocxDir}/usage.jsonl`);
    const lines = usageContent.trim().split('\n').filter(Boolean);

    const slice = lines.slice(-50);
    for (let i = slice.length - 1; i >= 0; i--) {
      try {
        const row = JSON.parse(slice[i].trim());
        const req: RequestUsageItem = {
          timestamp: row.timestamp || Date.now(),
          model: row.servedModel || row.model || activeModel,
          provider: row.provider || activeProvider,
          inputTokens: row.usage?.inputTokens || 0,
          outputTokens: row.usage?.outputTokens || 0,
          cachedInputTokens: row.usage?.cachedInputTokens || 0,
          reasoningOutputTokens: row.usage?.reasoningOutputTokens || 0,
          totalTokens:
            row.totalTokens ||
            (row.usage?.inputTokens || 0) + (row.usage?.outputTokens || 0),
          durationMs: row.durationMs || 0,
        };
        recentRequests.push(req);
        sessionTotalTokens += req.totalTokens;
        sessionInputTokens += req.inputTokens;
        sessionOutputTokens += req.outputTokens;
        sessionCachedTokens += req.cachedInputTokens;
      } catch {}
    }

    if (recentRequests.length > 0) {
      const latest = recentRequests[0];
      lastTurnTokens = latest.totalTokens;
      lastTurnInputTokens = latest.inputTokens;
      lastTurnOutputTokens = latest.outputTokens;
      lastTurnCachedTokens = latest.cachedInputTokens;
      lastTurnReasoningTokens = latest.reasoningOutputTokens;
      lastTurnDurationMs = latest.durationMs;
      activeModel = latest.model;
      activeProvider = latest.provider;
    }
  } catch {}

  const sessionSavingsPercent =
    sessionInputTokens > 0
      ? Math.round((sessionCachedTokens / sessionInputTokens) * 100)
      : 0;

  const quotas: ProviderQuotaState[] = [];

  if (adminToken && port) {
    try {
      const res = await $.http.fetch(
        `http://127.0.0.1:${port}/api/oauth/accounts?provider=google-antigravity&quota=1`,
        {
          headers: {
            Authorization: `Bearer ${adminToken}`,
          },
        },
      );
      if (res.ok && res.text) {
        const data = JSON.parse(res.text);
        if (Array.isArray(data.accounts)) {
          for (const acc of data.accounts) {
            if (acc.quota && !quotas.some((q) => q.provider === 'google-antigravity')) {
              const q = acc.quota;
              const windows: ProviderQuotaWindowItem[] = [];
              if (Array.isArray(q.customWindows)) {
                for (const cw of q.customWindows) {
                  windows.push({
                    label: cw.label,
                    percent: cw.percent !== undefined ? cw.percent : 0,
                    resetAt: cw.resetAt,
                  });
                }
              }
              quotas.push({
                provider: 'google-antigravity',
                fiveHourPercent: q.fiveHourPercent,
                fiveHourResetAt: q.fiveHourResetAt,
                weeklyPercent: q.weeklyPercent,
                weeklyResetAt: q.weeklyResetAt,
                customWindows: windows,
                updatedAt: q.updatedAt || Date.now(),
              });
            }
          }
        }
      }
    } catch {}

    if (quotas.length === 0) {
      try {
        const res = await $.http.fetch(`http://127.0.0.1:${port}/api/provider-quotas`, {
          headers: {
            Authorization: `Bearer ${adminToken}`,
          },
        });
        if (res.ok && res.text) {
          const data = JSON.parse(res.text);
          if (Array.isArray(data.reports)) {
            for (const rep of data.reports) {
              const q = rep.quota;
              if (q) {
                const windows: ProviderQuotaWindowItem[] = [];
                if (Array.isArray(q.customWindows)) {
                  for (const cw of q.customWindows) {
                    windows.push({
                      label: cw.label,
                      percent: cw.percent !== undefined ? cw.percent : 0,
                      resetAt: cw.resetAt,
                    });
                  }
                }
                quotas.push({
                  provider: rep.provider,
                  fiveHourPercent: q.fiveHourPercent,
                  fiveHourResetAt: q.fiveHourResetAt,
                  weeklyPercent: q.weeklyPercent,
                  weeklyResetAt: q.weeklyResetAt,
                  customWindows: windows,
                  updatedAt: q.updatedAt || Date.now(),
                });
              }
            }
          }
        }
      } catch {}
    }
  }

  if (quotas.length === 0) {
    try {
      const diskContent = await $.fs.read(
        `${ocxDir}/provider-account-quota-cache.json`,
      );
      const diskData = JSON.parse(diskContent);
      if (diskData?.rows) {
        for (const [key, q] of Object.entries(diskData.rows)) {
          const prov = key.split('\u0000')[0] || 'google-antigravity';
          const typedQ = q as any;
          const windows: ProviderQuotaWindowItem[] = [];
          if (Array.isArray(typedQ.customWindows)) {
            for (const cw of typedQ.customWindows) {
              windows.push({
                label: cw.label,
                percent: cw.percent !== undefined ? cw.percent : 0,
                resetAt: cw.resetAt,
              });
            }
          }
          quotas.push({
            provider: prov,
            fiveHourPercent:
              typedQ.fiveHourPercent !== undefined
                ? Math.round(typedQ.fiveHourPercent)
                : undefined,
            fiveHourResetAt: typedQ.fiveHourResetAt,
            weeklyPercent:
              typedQ.weeklyPercent !== undefined
                ? Math.round(typedQ.weeklyPercent)
                : undefined,
            weeklyResetAt: typedQ.weeklyResetAt,
            customWindows: windows,
            updatedAt: typedQ.updatedAt,
          });
        }
      }
    } catch {}
  }

  return {
    activeModel,
    activeProvider,
    lastTurnTokens,
    lastTurnInputTokens,
    lastTurnOutputTokens,
    lastTurnCachedTokens,
    lastTurnReasoningTokens,
    lastTurnDurationMs,
    sessionTotalTokens,
    sessionInputTokens,
    sessionOutputTokens,
    sessionCachedTokens,
    sessionSavingsPercent,
    recentRequests: recentRequests.slice(0, 10),
    quotas,
    port,
    lastUpdated: Date.now(),
  };
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    try {
      $.ui.status(undefined);
      await $.command.register({
        name: 'limits',
        description: 'Показать лимиты и расход токенов OpenCodex',
      });

      const initial = await fetchOpenCodexData($);
      await update($, summaryAtom, () => initial);

      // Periodic background refresh every 30 seconds
      $.clock.every(30000, async () => {
        try {
          const fresh = await fetchOpenCodexData($);
          await update($, summaryAtom, () => fresh);
          $.ui.invalidate('ui.render');
        } catch {}
      });
    } catch {}

    return next(e);
  });

  on('command.run', { command: 'limits' }, async ($) => {
    await $.ui.open({ id: PANE_ID, title: 'OpenCodex' });
    const fresh = await fetchOpenCodexData($);
    await update($, summaryAtom, () => fresh);
    $.ui.invalidate('ui.render');

    return { text: 'Панель лимитов OpenCodex открыта.' };
  });

  on('turn.complete', async ($, e, next) => {
    try {
      $.ui.status(undefined);
      const fresh = await fetchOpenCodexData($);
      await update($, summaryAtom, () => fresh);
      $.ui.invalidate('ui.render');
    } catch {}

    return next(e);
  });

  on('prompt.submit', async ($, e, next) => {
    $.ui.status(undefined);
    return next(e);
  });

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const summary = await read($, summaryAtom);
    if (!summary || e.props.hasSurvey) {
      return next(e);
    }

    const { Box, Text, Button } = $.ui.resolve(e);
    const q = getActiveQuota(summary);

    const colorForRemaining = (rem: number) => {
      if (rem <= 15) return 'red';
      if (rem <= 30) return 'yellow';
      return COLOR_PRIMARY;
    };

    const renderBar = (rem: number, width = 8) => {
      const clamped = Math.max(0, Math.min(100, Math.round(rem)));
      const filled = Math.round((clamped / 100) * width);
      const empty = width - filled;
      const barColor = colorForRemaining(clamped);

      return (
        <Text>
          <Text color={barColor}>{'━'.repeat(filled)}</Text>
          <Text color={COLOR_BG_LINE}>{'─'.repeat(empty)}</Text>
        </Text>
      );
    };

    return (
      <Box flexDirection="row" justifyContent="space-between">
        <Text dimColor>
          {q ? (
            <Text>
              <Text>5ч: </Text>
              <Text color={colorForRemaining(q.fiveHourRemaining)}>
                {q.fiveHourRemaining}%{' '}
              </Text>
              {renderBar(q.fiveHourRemaining, 8)}
              {q.fiveHourReset && <Text dimColor> ({q.fiveHourReset})</Text>}
              {q.weeklyRemaining !== undefined && (
                <Text>
                  <Text dimColor> · </Text>
                  <Text>Неделя: </Text>
                  <Text color={colorForRemaining(q.weeklyRemaining)}>
                    {q.weeklyRemaining}%{' '}
                  </Text>
                  {renderBar(q.weeklyRemaining, 8)}
                  {q.weeklyReset && <Text dimColor> ({q.weeklyReset})</Text>}
                </Text>
              )}
            </Text>
          ) : (
            <Text dimColor>Лимиты не загружены</Text>
          )}
        </Text>
        <Button
          key="btn-details"
          plain
          label="детали"
          onPress={async () => {
            await $.ui.open({ id: PANE_ID, title: 'OpenCodex' });
          }}
        />
      </Box>
    );
  });

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e);
    const summary = await read($, summaryAtom);

    if (!summary) {
      return (
        <Box flexDirection="column" padding={1}>
          <Text dimColor>Загрузка данных...</Text>
        </Box>
      );
    }

    const primary =
      summary.quotas.find((q) => q.provider === 'google-antigravity') ||
      summary.quotas.find((q) => q.provider === summary.activeProvider) ||
      summary.quotas[0];

    const gem5h = primary?.customWindows?.find((w) => w.label === 'Gem');
    const gemWeek = primary?.customWindows?.find((w) => w.label === 'Gem (Weekly)');
    const cla5h = primary?.customWindows?.find((w) => w.label === 'Cla');
    const claWeek = primary?.customWindows?.find((w) => w.label === 'Cla (Weekly)');

    const gem5hRem = gem5h ? Math.round(100 - gem5h.percent) : undefined;
    const gemWeekRem = gemWeek ? Math.round(100 - gemWeek.percent) : undefined;
    const cla5hRem = cla5h ? Math.round(100 - cla5h.percent) : undefined;
    const claWeekRem = claWeek ? Math.round(100 - claWeek.percent) : undefined;

    const renderPaneBar = (rem: number, width = 8) => {
      const clamped = Math.max(0, Math.min(100, Math.round(rem)));
      const filled = Math.round((clamped / 100) * width);
      const empty = width - filled;
      const barColor = clamped <= 15 ? 'red' : clamped <= 30 ? 'yellow' : COLOR_PRIMARY;

      return (
        <Text>
          <Text color={barColor}>{'━'.repeat(filled)}</Text>
          <Text color={COLOR_BG_LINE}>{'─'.repeat(empty)}</Text>
        </Text>
      );
    };

    return (
      <Box flexDirection="column" padding={1}>
        <Box flexDirection="row">
          <Text bold>{summary.activeModel}</Text>
          <Text dimColor> · {summary.activeProvider}</Text>
        </Box>
        <Text> </Text>

        {/* Gemini Group */}
        {(gem5hRem !== undefined || gemWeekRem !== undefined) && (
          <Box flexDirection="column">
            <Text bold dimColor>
              МОДЕЛИ GEMINI
            </Text>
            {gem5hRem !== undefined && (
              <Box flexDirection="row">
                <Text dimColor>5 часов:  </Text>
                <Text bold color={gem5hRem <= 20 ? 'red' : COLOR_PRIMARY}>
                  {gem5hRem}%{' '}
                </Text>
                {renderPaneBar(gem5hRem, 8)}
                {gem5h?.resetAt && (
                  <Text dimColor> ({formatResetRu(gem5h.resetAt)})</Text>
                )}
              </Box>
            )}
            {gemWeekRem !== undefined && (
              <Box flexDirection="row">
                <Text dimColor>Неделя:   </Text>
                <Text bold color={gemWeekRem <= 20 ? 'red' : COLOR_PRIMARY}>
                  {gemWeekRem}%{' '}
                </Text>
                {renderPaneBar(gemWeekRem, 8)}
                {gemWeek?.resetAt && (
                  <Text dimColor> ({formatResetRu(gemWeek.resetAt)})</Text>
                )}
              </Box>
            )}
            <Text> </Text>
          </Box>
        )}

        {/* Claude Group */}
        {(cla5hRem !== undefined || claWeekRem !== undefined) && (
          <Box flexDirection="column">
            <Text bold dimColor>
              МОДЕЛИ CLAUDE (3P)
            </Text>
            {cla5hRem !== undefined && (
              <Box flexDirection="row">
                <Text dimColor>5 часов:  </Text>
                <Text bold color={cla5hRem <= 20 ? 'red' : COLOR_PRIMARY}>
                  {cla5hRem}%{' '}
                </Text>
                {renderPaneBar(cla5hRem, 8)}
                {cla5h?.resetAt && (
                  <Text dimColor> ({formatResetRu(cla5h.resetAt)})</Text>
                )}
              </Box>
            )}
            {claWeekRem !== undefined && (
              <Box flexDirection="row">
                <Text dimColor>Неделя:   </Text>
                <Text bold color={claWeekRem <= 20 ? 'red' : COLOR_PRIMARY}>
                  {claWeekRem}%{' '}
                </Text>
                {renderPaneBar(claWeekRem, 8)}
                {claWeek?.resetAt && (
                  <Text dimColor> ({formatResetRu(claWeek.resetAt)})</Text>
                )}
              </Box>
            )}
            <Text> </Text>
          </Box>
        )}

        {/* Generic Provider Limits fallback */}
        {!gem5h && !cla5h && primary?.fiveHourPercent !== undefined && (
          <Box flexDirection="column">
            <Text bold dimColor>
              ОСТАТОК ЛИМИТОВ
            </Text>
            <Box flexDirection="row">
              <Text dimColor>5 часов:  </Text>
              <Text bold color={COLOR_PRIMARY}>
                {Math.round(100 - primary.fiveHourPercent)}%{' '}
              </Text>
              {renderPaneBar(Math.round(100 - primary.fiveHourPercent), 10)}
              {primary.fiveHourResetAt && (
                <Text dimColor> ({formatResetRu(primary.fiveHourResetAt)})</Text>
              )}
            </Box>
            {primary.weeklyPercent !== undefined && (
              <Box flexDirection="row">
                <Text dimColor>Неделя:   </Text>
                <Text bold color={COLOR_PRIMARY}>
                  {Math.round(100 - primary.weeklyPercent)}%{' '}
                </Text>
                {renderPaneBar(Math.round(100 - primary.weeklyPercent), 10)}
                {primary.weeklyResetAt && (
                  <Text dimColor> ({formatResetRu(primary.weeklyResetAt)})</Text>
                )}
              </Box>
            )}
            <Text> </Text>
          </Box>
        )}

        {/* Token stats */}
        <Text bold dimColor>
          РАСХОД ТОКЕНОВ В СЕССИИ
        </Text>
        <Box flexDirection="row">
          <Text dimColor>Всего:    </Text>
          <Text>{formatNumber(summary.sessionTotalTokens)}</Text>
          <Text dimColor>
            {' '}(in: {formatNumber(summary.sessionInputTokens)}, out:{' '}
            {formatNumber(summary.sessionOutputTokens)})
          </Text>
        </Box>
        <Box flexDirection="row">
          <Text dimColor>Кэш:      </Text>
          <Text color={COLOR_PRIMARY}>
            {formatNumber(summary.sessionCachedTokens)}
          </Text>
          <Text dimColor> ({summary.sessionSavingsPercent}% попадание)</Text>
        </Box>
        <Text> </Text>

        {/* Recent activity */}
        <Text bold dimColor>
          ПОСЛЕДНИЕ ЗАПРОСЫ
        </Text>
        {summary.recentRequests.length === 0 ? (
          <Text dimColor>Нет записей</Text>
        ) : (
          summary.recentRequests.slice(0, 5).map((req, idx) => {
            const timeStr = new Date(req.timestamp).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            });
            const cacheRatio =
              req.inputTokens > 0
                ? Math.round((req.cachedInputTokens / req.inputTokens) * 100)
                : 0;
            return (
              <Box flexDirection="row" key={String(req.timestamp) + '-' + idx}>
                <Text dimColor>{timeStr}  </Text>
                <Text>{formatNumber(req.totalTokens)} tok</Text>
                <Text dimColor>
                  {' '}· {cacheRatio}% кэш · {(req.durationMs / 1000).toFixed(1)}с
                </Text>
              </Box>
            );
          })
        )}
        <Text> </Text>

        <Box flexDirection="row">
          <Button
            key="refresh-pane-btn"
            plain
            label="обновить"
            onPress={async () => {
              const fresh = await fetchOpenCodexData($);
              await update($, summaryAtom, () => fresh);
              $.ui.invalidate('ui.render');
            }}
          />
        </Box>
      </Box>
    );
  });
};
