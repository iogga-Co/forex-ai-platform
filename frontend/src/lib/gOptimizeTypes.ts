export interface GOptimizeRun {
  id: string;
  status: string; // 'pending' | 'running' | 'done' | 'stopped' | 'failed'
  pairs: string[];
  timeframe: string;
  period_start: string | null;
  period_end: string | null;
  n_configs: number;
  store_trades: string;
  entry_config: Record<string, unknown>;
  exit_config: Record<string, unknown>;
  threshold_sharpe: number | null;
  threshold_win_rate: number | null;
  threshold_max_dd: number | null;
  threshold_min_trades: number;
  auto_rag: boolean;
  configs_total: number;
  configs_done: number;
  configs_passed: number;
  configs_failed: number;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string | null;
}

export interface GOptimizeStrategy {
  backtest_run_id: string;
  pair: string;
  sharpe: number | null;
  win_rate: number | null;
  max_dd: number | null;
  trade_count: number | null;
  ir: Record<string, unknown>;
  rag_status: string; // 'in_rag' | 'pending' | 'none'
  passed_threshold: boolean;
  run_id: string;
}

export interface GOptimizeRecommendation {
  rank: number;
  backtest_run_id: string;
  summary: string;
  rationale: string;
  suggested_refinement: string;
}

export interface GOptimizeAnalysis {
  recommendations: GOptimizeRecommendation[];
  skipped: string[];
  skipped_reason: string;
}
