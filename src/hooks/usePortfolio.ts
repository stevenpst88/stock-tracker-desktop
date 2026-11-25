import { useState, useEffect, useCallback } from 'react';
import type { PortfolioSummary } from '../../shared/types';

const REFRESH_INTERVAL = 60_000;

export function usePortfolio() {
  const [data, setData] = useState<PortfolioSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetch = useCallback(async () => {
    try {
      const result = await window.electronAPI.portfolio.summary();
      setData(result);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  /** 強制刷新：先清股價快取，再重新抓取 */
  const forceRefresh = useCallback(async () => {
    try {
      await window.electronAPI.prices.invalidate();
    } catch {/* ignore */}
    await fetch();
  }, [fetch]);

  useEffect(() => {
    fetch();
    const id = setInterval(fetch, REFRESH_INTERVAL);
    return () => clearInterval(id);
  }, [fetch]);

  return { data, loading, error, refresh: fetch, forceRefresh };
}
