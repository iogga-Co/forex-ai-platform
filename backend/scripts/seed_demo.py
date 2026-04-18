"""
Demo seed script — populates local DB with realistic strategies, OHLCV candles,
backtest runs, and trades for frontend demo purposes.

Run inside the fastapi container:
  docker exec forex-ai-platform-fastapi-1 python scripts/seed_demo.py
"""
import asyncio
import json
import math
import random
import uuid
from datetime import date, datetime, timedelta, timezone

import asyncpg

import os
DB_URL = os.environ.get("DATABASE_URL", "postgresql://forex_user:forex_password@timescaledb:5432/forex_db")

# ── OHLCV config ──────────────────────────────────────────────────────────────
PAIRS = ["EURUSD", "GBPUSD", "USDJPY", "EURGBP", "GBPJPY", "USDCHF"]
BASE_PRICES = {
    "EURUSD": 1.08500,
    "GBPUSD": 1.26500,
    "USDJPY": 149.500,
    "EURGBP": 0.85800,
    "GBPJPY": 189.200,
    "USDCHF": 0.90300,
}
CANDLE_START = datetime(2024, 1, 1, tzinfo=timezone.utc)
CANDLE_END   = datetime(2026, 5, 1, tzinfo=timezone.utc)

# ── Strategy SIR templates ────────────────────────────────────────────────────
STRATEGIES = [
    {
        "description": "RSI Momentum + EMA Trend Filter — EURUSD 1H",
        "pair": "EURUSD", "timeframe": "1H", "version": 1,
        "ir_json": {
            "entry_conditions": [
                {"indicator": "EMA", "period": 20, "operator": "price_above"},
                {"indicator": "RSI", "period": 14, "operator": ">", "value": 55},
            ],
            "exit_conditions": {
                "stop_loss":   {"type": "atr", "period": 14, "multiplier": 1.5},
                "take_profit": {"type": "atr", "period": 14, "multiplier": 3.0},
            },
            "filters": {"exclude_days": [], "session": "all"},
            "position_sizing": {"risk_per_trade_pct": 1.0, "max_size_units": 100000},
            "metadata": {"name": "RSI Momentum + EMA Trend", "description": "RSI Momentum + EMA Trend Filter — EURUSD 1H"},
        },
    },
    {
        "description": "MACD Crossover + ADX Strength — GBPUSD 1H",
        "pair": "GBPUSD", "timeframe": "1H", "version": 1,
        "ir_json": {
            "entry_conditions": [
                {"indicator": "MACD", "fast": 12, "slow": 26, "signal_period": 9, "operator": "cross_above"},
                {"indicator": "ADX", "period": 14, "operator": ">", "value": 25},
            ],
            "exit_conditions": {
                "stop_loss":   {"type": "atr", "period": 14, "multiplier": 2.0},
                "take_profit": {"type": "atr", "period": 14, "multiplier": 4.0},
            },
            "filters": {"exclude_days": ["monday"], "session": "all"},
            "position_sizing": {"risk_per_trade_pct": 1.5, "max_size_units": 100000},
            "metadata": {"name": "MACD Crossover ADX", "description": "MACD Crossover + ADX Strength — GBPUSD 1H"},
        },
    },
    {
        "description": "Bollinger Band Breakout + RSI Confirm — USDJPY 1H",
        "pair": "USDJPY", "timeframe": "1H", "version": 1,
        "ir_json": {
            "entry_conditions": [
                {"indicator": "BB", "period": 20, "std_dev": 2.0, "component": "upper", "operator": "price_above"},
                {"indicator": "RSI", "period": 14, "operator": ">", "value": 60},
            ],
            "exit_conditions": {
                "stop_loss":   {"type": "atr", "period": 14, "multiplier": 1.8},
                "take_profit": {"type": "atr", "period": 14, "multiplier": 3.5},
            },
            "filters": {"exclude_days": [], "session": "all"},
            "position_sizing": {"risk_per_trade_pct": 1.0, "max_size_units": 100000},
            "metadata": {"name": "BB Breakout RSI", "description": "Bollinger Band Breakout + RSI Confirm — USDJPY 1H"},
        },
    },
    {
        "description": "Stochastic Oversold + EMA Pullback — EURGBP 1H",
        "pair": "EURGBP", "timeframe": "1H", "version": 2,
        "ir_json": {
            "entry_conditions": [
                {"indicator": "EMA", "period": 50, "operator": "price_above"},
                {"indicator": "STOCH", "period": 14, "k_smooth": 3, "d_period": 3, "operator": "<", "value": 25},
            ],
            "exit_conditions": {
                "stop_loss":   {"type": "atr", "period": 14, "multiplier": 1.2},
                "take_profit": {"type": "atr", "period": 14, "multiplier": 2.5},
            },
            "filters": {"exclude_days": ["friday"], "session": "all"},
            "position_sizing": {"risk_per_trade_pct": 0.75, "max_size_units": 100000},
            "metadata": {"name": "Stoch Oversold EMA", "description": "Stochastic Oversold + EMA Pullback — EURGBP 1H"},
        },
    },
    {
        "description": "Triple EMA Trend + ATR Filter — GBPJPY 1H",
        "pair": "GBPJPY", "timeframe": "1H", "version": 1,
        "ir_json": {
            "entry_conditions": [
                {"indicator": "EMA", "period": 20, "operator": "price_above"},
                {"indicator": "EMA", "period": 50, "operator": "price_above"},
                {"indicator": "ATR", "period": 14, "operator": ">", "value": 0.5},
            ],
            "exit_conditions": {
                "stop_loss":   {"type": "atr", "period": 14, "multiplier": 2.0},
                "take_profit": {"type": "atr", "period": 14, "multiplier": 5.0},
            },
            "filters": {"exclude_days": [], "session": "all"},
            "position_sizing": {"risk_per_trade_pct": 1.0, "max_size_units": 100000},
            "metadata": {"name": "Triple EMA Trend", "description": "Triple EMA Trend + ATR Filter — GBPJPY 1H"},
        },
    },
]

# ── Optimization run configs ──────────────────────────────────────────────────
# Each entry: (strategy_idx, pair, timeframe, period_start, period_end, model, max_iter, target_sharpe, target_win_rate, stop_reason, iterations)
# iterations: list of (sharpe, win_rate, max_dd, total_pnl, trade_count, ai_analysis, ai_changes, ir_patch)
OPT_RUNS = [
    {
        "strategy_idx": 0, "pair": "EURUSD", "timeframe": "1H",
        "period_start": "2024-01-01", "period_end": "2024-06-30",
        "model": "claude-sonnet-4-6", "max_iterations": 10, "target_sharpe": 1.8, "target_win_rate": 0.62,
        "stop_reason": "target_sharpe",
        "iterations": [
            (0.89, 0.521, -0.124, 2140.80, 201,
             "Win rate is below target. RSI threshold at 55 is generating too many low-quality signals during ranging markets. Recommend tightening entry criteria.",
             "Raised RSI entry threshold from 55 → 60. Added ADX > 20 filter to avoid ranging market entries.",
             {"entry_conditions": [{"indicator": "EMA", "period": 20, "operator": "price_above"}, {"indicator": "RSI", "period": 14, "operator": ">", "value": 60}, {"indicator": "ADX", "period": 14, "operator": ">", "value": 20}]}),
            (1.12, 0.554, -0.103, 3210.40, 178,
             "ADX filter improved signal quality. Sharpe improved significantly. Win rate trending upward. TP multiplier may be too conservative — leaving money on the table.",
             "Increased TP multiplier from 3.0 → 3.5. Tightened SL from 1.5 → 1.3 ATR.",
             {"entry_conditions": [{"indicator": "EMA", "period": 20, "operator": "price_above"}, {"indicator": "RSI", "period": 14, "operator": ">", "value": 60}, {"indicator": "ADX", "period": 14, "operator": ">", "value": 20}], "exit_conditions": {"stop_loss": {"type": "atr", "period": 14, "multiplier": 1.3}, "take_profit": {"type": "atr", "period": 14, "multiplier": 3.5}}}),
            (1.38, 0.571, -0.091, 4180.60, 162,
             "Continued improvement. EMA period of 20 may be too short — reacting to noise. Testing EMA 50 for smoother trend confirmation.",
             "Changed EMA trend filter from period 20 → 50 for stronger trend alignment.",
             {"entry_conditions": [{"indicator": "EMA", "period": 50, "operator": "price_above"}, {"indicator": "RSI", "period": 14, "operator": ">", "value": 60}, {"indicator": "ADX", "period": 14, "operator": ">", "value": 20}], "exit_conditions": {"stop_loss": {"type": "atr", "period": 14, "multiplier": 1.3}, "take_profit": {"type": "atr", "period": 14, "multiplier": 3.5}}}),
            (1.61, 0.589, -0.079, 5340.20, 148,
             "EMA 50 reduced trade count but dramatically improved quality. Near target Sharpe. Excluding Monday could reduce noise further.",
             "Added Monday exclusion filter to avoid low-liquidity session entries.",
             {"entry_conditions": [{"indicator": "EMA", "period": 50, "operator": "price_above"}, {"indicator": "RSI", "period": 14, "operator": ">", "value": 60}, {"indicator": "ADX", "period": 14, "operator": ">", "value": 20}], "exit_conditions": {"stop_loss": {"type": "atr", "period": 14, "multiplier": 1.3}, "take_profit": {"type": "atr", "period": 14, "multiplier": 3.5}}, "filters": {"exclude_days": ["monday"], "session": "all"}}),
            (1.83, 0.604, -0.068, 6120.80, 139,
             "Target Sharpe of 1.8 exceeded. Strategy is now consistent with high win rate and controlled drawdown. Optimization complete.",
             "No further changes. Target achieved.",
             {"entry_conditions": [{"indicator": "EMA", "period": 50, "operator": "price_above"}, {"indicator": "RSI", "period": 14, "operator": ">", "value": 60}, {"indicator": "ADX", "period": 14, "operator": ">", "value": 20}], "exit_conditions": {"stop_loss": {"type": "atr", "period": 14, "multiplier": 1.3}, "take_profit": {"type": "atr", "period": 14, "multiplier": 3.5}}, "filters": {"exclude_days": ["monday"], "session": "all"}}),
        ],
    },
    {
        "strategy_idx": 1, "pair": "GBPUSD", "timeframe": "1H",
        "period_start": "2024-01-01", "period_end": "2024-12-31",
        "model": "claude-opus-4-6", "max_iterations": 15, "target_sharpe": 2.2, "target_win_rate": 0.65,
        "stop_reason": "max_iterations",
        "iterations": [
            (1.87, 0.623, -0.063, 7350.20, 142,
             "Strong baseline. MACD crossover with ADX filter performing well. Main weakness: large drawdown spikes during news events. Consider session filtering.",
             "Added London-only session filter to focus on highest-liquidity period.",
             {"entry_conditions": [{"indicator": "MACD", "fast": 12, "slow": 26, "signal_period": 9, "operator": "cross_above"}, {"indicator": "ADX", "period": 14, "operator": ">", "value": 25}], "filters": {"exclude_days": ["monday"], "session": "london"}}),
            (1.94, 0.631, -0.058, 7820.40, 121,
             "Session filter reduced trade count by 15% but improved Sharpe. Win rate climbing. ADX threshold of 25 may be filtering good trades — testing 20.",
             "Lowered ADX threshold from 25 → 20 to capture more valid trend setups.",
             {"entry_conditions": [{"indicator": "MACD", "fast": 12, "slow": 26, "signal_period": 9, "operator": "cross_above"}, {"indicator": "ADX", "period": 14, "operator": ">", "value": 20}], "filters": {"exclude_days": ["monday"], "session": "london"}}),
            (2.08, 0.641, -0.054, 8940.60, 134,
             "ADX at 20 recovered some good trades. MACD signal period of 9 may lag — faster signal could reduce whipsaws.",
             "Reduced MACD signal period from 9 → 7 for faster crossover detection.",
             {"entry_conditions": [{"indicator": "MACD", "fast": 12, "slow": 26, "signal_period": 7, "operator": "cross_above"}, {"indicator": "ADX", "period": 14, "operator": ">", "value": 20}], "filters": {"exclude_days": ["monday"], "session": "london"}}),
            (2.11, 0.648, -0.051, 9280.30, 128,
             "Marginal improvement with faster signal. Near target but not there yet. Risk per trade at 1.5% may be too aggressive given current volatility.",
             "Reduced risk per trade from 1.5% → 1.0% to lower position risk during volatile periods.",
             {"entry_conditions": [{"indicator": "MACD", "fast": 12, "slow": 26, "signal_period": 7, "operator": "cross_above"}, {"indicator": "ADX", "period": 14, "operator": ">", "value": 20}], "filters": {"exclude_days": ["monday"], "session": "london"}, "position_sizing": {"risk_per_trade_pct": 1.0, "max_size_units": 100000}}),
            (2.09, 0.643, -0.055, 8740.10, 130,
             "Lower risk slightly reduced PnL without significant Sharpe improvement. Reverting to 1.5% risk. Max iterations reached.",
             "Reverted risk to 1.5%. Strategy at local optimum — further gains require new indicators.",
             {"entry_conditions": [{"indicator": "MACD", "fast": 12, "slow": 26, "signal_period": 7, "operator": "cross_above"}, {"indicator": "ADX", "period": 14, "operator": ">", "value": 20}], "filters": {"exclude_days": ["monday"], "session": "london"}, "position_sizing": {"risk_per_trade_pct": 1.5, "max_size_units": 100000}}),
        ],
    },
    {
        "strategy_idx": 3, "pair": "EURGBP", "timeframe": "1H",
        "period_start": "2024-01-01", "period_end": "2024-12-31",
        "model": "gemini-2.5-pro", "max_iterations": 8, "target_sharpe": 2.5, "target_win_rate": 0.68,
        "stop_reason": "user_stopped",
        "iterations": [
            (2.14, 0.651, -0.051, 9820.40, 97,
             "Excellent baseline. Stochastic oversold + EMA pullback is a proven mean-reversion setup. Friday exclusion is smart. Consider also excluding high-impact news hours.",
             "No changes this iteration — confirming baseline stability across extended sample.",
             {"entry_conditions": [{"indicator": "EMA", "period": 50, "operator": "price_above"}, {"indicator": "STOCH", "period": 14, "k_smooth": 3, "d_period": 3, "operator": "<", "value": 25}], "exit_conditions": {"stop_loss": {"type": "atr", "period": 14, "multiplier": 1.2}, "take_profit": {"type": "atr", "period": 14, "multiplier": 2.5}}, "filters": {"exclude_days": ["friday"], "session": "all"}}),
            (2.28, 0.664, -0.046, 10940.20, 89,
             "Tightening STOCH oversold threshold from 25 → 20 reduced false signals in ranging markets noticeably.",
             "Tightened STOCH threshold from < 25 → < 20 for stronger oversold confirmation.",
             {"entry_conditions": [{"indicator": "EMA", "period": 50, "operator": "price_above"}, {"indicator": "STOCH", "period": 14, "k_smooth": 3, "d_period": 3, "operator": "<", "value": 20}], "exit_conditions": {"stop_loss": {"type": "atr", "period": 14, "multiplier": 1.2}, "take_profit": {"type": "atr", "period": 14, "multiplier": 2.5}}, "filters": {"exclude_days": ["friday"], "session": "all"}}),
            (2.41, 0.672, -0.042, 11820.60, 83,
             "Consistent improvement. User stopped run early — strategy performing near target. Best iteration saved.",
             "User stopped optimization. Iteration 3 selected as best.",
             {"entry_conditions": [{"indicator": "EMA", "period": 50, "operator": "price_above"}, {"indicator": "STOCH", "period": 14, "k_smooth": 3, "d_period": 3, "operator": "<", "value": 20}], "exit_conditions": {"stop_loss": {"type": "atr", "period": 14, "multiplier": 1.2}, "take_profit": {"type": "atr", "period": 14, "multiplier": 2.8}}, "filters": {"exclude_days": ["friday"], "session": "all"}}),
        ],
    },
    {
        "strategy_idx": 2, "pair": "USDJPY", "timeframe": "1H",
        "period_start": "2024-03-01", "period_end": "2024-12-31",
        "model": "gpt-4o", "max_iterations": 12, "target_sharpe": 1.5, "target_win_rate": 0.58,
        "stop_reason": "target_win_rate",
        "iterations": [
            (0.73, 0.489, -0.159, 1250.30, 219,
             "Baseline is weak. Bollinger Band breakout strategy is suffering from many false breakouts on USDJPY. RSI threshold of 60 is too permissive — many entries are happening into extended moves.",
             "Raised RSI threshold from 60 → 65. Tightened BB std_dev from 2.0 → 2.5 to only catch stronger breakouts.",
             {"entry_conditions": [{"indicator": "BB", "period": 20, "std_dev": 2.5, "component": "upper", "operator": "price_above"}, {"indicator": "RSI", "period": 14, "operator": ">", "value": 65}], "exit_conditions": {"stop_loss": {"type": "atr", "period": 14, "multiplier": 1.8}, "take_profit": {"type": "atr", "period": 14, "multiplier": 3.5}}}),
            (0.91, 0.503, -0.138, 1840.50, 187,
             "Fewer but higher-quality signals. Win rate improving. The SL at 1.8 ATR is being hit too often intraday — USDJPY is volatile and needs more room.",
             "Widened SL from 1.8 → 2.2 ATR to accommodate USDJPY volatility.",
             {"entry_conditions": [{"indicator": "BB", "period": 20, "std_dev": 2.5, "component": "upper", "operator": "price_above"}, {"indicator": "RSI", "period": 14, "operator": ">", "value": 65}], "exit_conditions": {"stop_loss": {"type": "atr", "period": 14, "multiplier": 2.2}, "take_profit": {"type": "atr", "period": 14, "multiplier": 3.5}}}),
            (1.08, 0.524, -0.119, 2640.80, 164,
             "SL adjustment helped significantly. Now adding EMA trend filter to ensure we only take breakouts in the direction of the broader trend.",
             "Added EMA 100 trend filter — only trade BB breakouts when price is above EMA 100.",
             {"entry_conditions": [{"indicator": "BB", "period": 20, "std_dev": 2.5, "component": "upper", "operator": "price_above"}, {"indicator": "RSI", "period": 14, "operator": ">", "value": 65}, {"indicator": "EMA", "period": 100, "operator": "price_above"}], "exit_conditions": {"stop_loss": {"type": "atr", "period": 14, "multiplier": 2.2}, "take_profit": {"type": "atr", "period": 14, "multiplier": 3.5}}}),
            (1.24, 0.541, -0.104, 3480.60, 143,
             "EMA trend filter dramatically reduced false breakouts. Strategy is now consistently profitable. Excluding Asian session could further reduce noise.",
             "Added Asian session exclusion — USDJPY ranging behavior during Tokyo hours produces low-quality signals.",
             {"entry_conditions": [{"indicator": "BB", "period": 20, "std_dev": 2.5, "component": "upper", "operator": "price_above"}, {"indicator": "RSI", "period": 14, "operator": ">", "value": 65}, {"indicator": "EMA", "period": 100, "operator": "price_above"}], "exit_conditions": {"stop_loss": {"type": "atr", "period": 14, "multiplier": 2.2}, "take_profit": {"type": "atr", "period": 14, "multiplier": 3.5}}, "filters": {"exclude_days": [], "session": "london"}}),
            (1.39, 0.558, -0.091, 4210.40, 118,
             "London-only session filter is working well. Strategy now approaching target win rate. TP at 3.5 may be overly optimistic — reducing to capture more completed trades.",
             "Reduced TP from 3.5 → 3.0 ATR to improve completion rate.",
             {"entry_conditions": [{"indicator": "BB", "period": 20, "std_dev": 2.5, "component": "upper", "operator": "price_above"}, {"indicator": "RSI", "period": 14, "operator": ">", "value": 65}, {"indicator": "EMA", "period": 100, "operator": "price_above"}], "exit_conditions": {"stop_loss": {"type": "atr", "period": 14, "multiplier": 2.2}, "take_profit": {"type": "atr", "period": 14, "multiplier": 3.0}}, "filters": {"exclude_days": [], "session": "london"}}),
            (1.51, 0.581, -0.083, 4980.20, 112,
             "Target win rate of 58% achieved. Sharpe above 1.5. Strategy is now robust with clear edge on USDJPY London breakouts.",
             "Target win rate reached. Optimization complete.",
             {"entry_conditions": [{"indicator": "BB", "period": 20, "std_dev": 2.5, "component": "upper", "operator": "price_above"}, {"indicator": "RSI", "period": 14, "operator": ">", "value": 65}, {"indicator": "EMA", "period": 100, "operator": "price_above"}], "exit_conditions": {"stop_loss": {"type": "atr", "period": 14, "multiplier": 2.2}, "take_profit": {"type": "atr", "period": 14, "multiplier": 3.0}}, "filters": {"exclude_days": [], "session": "london"}}),
        ],
    },
    {
        "strategy_idx": 4, "pair": "GBPJPY", "timeframe": "1H",
        "period_start": "2024-01-01", "period_end": "2024-12-31",
        "model": "claude-sonnet-4-6", "max_iterations": 20, "target_sharpe": 2.0, "target_win_rate": 0.60,
        "stop_reason": "time_limit",
        "iterations": [
            (1.31, 0.558, -0.094, 3640.70, 164,
             "Solid baseline but Triple EMA is lagging on GBPJPY high volatility. ATR filter at 0.5 is too low — catching many low-volatility periods with poor R:R.",
             "Raised ATR minimum threshold from 0.5 → 1.2 to ensure sufficient volatility for the strategy to work.",
             {"entry_conditions": [{"indicator": "EMA", "period": 20, "operator": "price_above"}, {"indicator": "EMA", "period": 50, "operator": "price_above"}, {"indicator": "ATR", "period": 14, "operator": ">", "value": 1.2}]}),
            (1.47, 0.572, -0.086, 4380.90, 141,
             "Higher ATR threshold filtered out poor setups. GBPJPY often has strong directional moves — the EMA 20/50 separation may be worth adding as an explicit condition.",
             "No additional indicator this iteration — testing RSI > 50 as momentum confirmation instead.",
             {"entry_conditions": [{"indicator": "EMA", "period": 20, "operator": "price_above"}, {"indicator": "EMA", "period": 50, "operator": "price_above"}, {"indicator": "ATR", "period": 14, "operator": ">", "value": 1.2}, {"indicator": "RSI", "period": 14, "operator": ">", "value": 50}]}),
            (1.58, 0.581, -0.079, 5120.40, 129,
             "RSI momentum filter added value. Friday exclusion already in place. Consider excluding Monday as well — GBPJPY gap risk at week open is significant.",
             "Added Monday to exclusion days to avoid gap risk.",
             {"entry_conditions": [{"indicator": "EMA", "period": 20, "operator": "price_above"}, {"indicator": "EMA", "period": 50, "operator": "price_above"}, {"indicator": "ATR", "period": 14, "operator": ">", "value": 1.2}, {"indicator": "RSI", "period": 14, "operator": ">", "value": 50}], "filters": {"exclude_days": ["monday"], "session": "all"}}),
            (1.67, 0.589, -0.073, 5740.80, 118,
             "Monday exclusion helped. TP at 5.0 ATR is rarely being hit on GBPJPY — consider splitting into two partial targets or reducing to 4.0.",
             "Reduced TP from 5.0 → 4.0 ATR. More realistic target given GBPJPY intraday ranges.",
             {"entry_conditions": [{"indicator": "EMA", "period": 20, "operator": "price_above"}, {"indicator": "EMA", "period": 50, "operator": "price_above"}, {"indicator": "ATR", "period": 14, "operator": ">", "value": 1.2}, {"indicator": "RSI", "period": 14, "operator": ">", "value": 50}], "exit_conditions": {"stop_loss": {"type": "atr", "period": 14, "multiplier": 2.0}, "take_profit": {"type": "atr", "period": 14, "multiplier": 4.0}}, "filters": {"exclude_days": ["monday"], "session": "all"}}),
            (1.74, 0.594, -0.068, 6280.30, 112,
             "TP reduction improved completion rate notably. Strategy is converging. Time limit approaching — locking in current best configuration.",
             "Time limit reached. Best iteration at iteration 5 with Sharpe 1.74.",
             {"entry_conditions": [{"indicator": "EMA", "period": 20, "operator": "price_above"}, {"indicator": "EMA", "period": 50, "operator": "price_above"}, {"indicator": "ATR", "period": 14, "operator": ">", "value": 1.2}, {"indicator": "RSI", "period": 14, "operator": ">", "value": 50}], "exit_conditions": {"stop_loss": {"type": "atr", "period": 14, "multiplier": 2.0}, "take_profit": {"type": "atr", "period": 14, "multiplier": 4.0}}, "filters": {"exclude_days": ["monday"], "session": "all"}}),
        ],
    },
    {
        "strategy_idx": 0, "pair": "EURUSD", "timeframe": "1H",
        "period_start": "2024-07-01", "period_end": "2024-12-31",
        "model": "gemini-2.0-flash", "max_iterations": 6, "target_sharpe": 1.2, "target_win_rate": 0.55,
        "stop_reason": "target_win_rate",
        "iterations": [
            (0.89, 0.521, -0.124, 2140.80, 201,
             "Second half of 2024 showed weaker performance. RSI at 55 generating too many entries in choppy conditions. Strategy needs tighter entry criteria for this period.",
             "Raised RSI from 55 → 58. Added session filter to London open for better signal quality.",
             {"entry_conditions": [{"indicator": "EMA", "period": 20, "operator": "price_above"}, {"indicator": "RSI", "period": 14, "operator": ">", "value": 58}], "filters": {"exclude_days": [], "session": "london"}}),
            (1.04, 0.537, -0.108, 2840.60, 174,
             "Session filter improved results. RSI at 58 still generating some marginal entries — trying 60 with tighter SL.",
             "Raised RSI to 60, tightened SL from 1.5 → 1.2 ATR.",
             {"entry_conditions": [{"indicator": "EMA", "period": 20, "operator": "price_above"}, {"indicator": "RSI", "period": 14, "operator": ">", "value": 60}], "exit_conditions": {"stop_loss": {"type": "atr", "period": 14, "multiplier": 1.2}, "take_profit": {"type": "atr", "period": 14, "multiplier": 3.0}}, "filters": {"exclude_days": [], "session": "london"}}),
            (1.19, 0.552, -0.094, 3480.20, 156,
             "Win rate approaching target. Strategy is stabilising in the second-half market conditions. Target win rate achieved on this iteration.",
             "Target win rate of 55% reached. Optimization complete.",
             {"entry_conditions": [{"indicator": "EMA", "period": 20, "operator": "price_above"}, {"indicator": "RSI", "period": 14, "operator": ">", "value": 60}], "exit_conditions": {"stop_loss": {"type": "atr", "period": 14, "multiplier": 1.2}, "take_profit": {"type": "atr", "period": 14, "multiplier": 3.0}}, "filters": {"exclude_days": [], "session": "london"}}),
        ],
    },
]

# ── Backtest run configs (strategy index, sharpe target, win_rate target) ─────
BACKTEST_CONFIGS = [
    # (strategy_idx, start, end, sharpe, sortino, max_dd, win_rate, avg_r, trade_count, total_pnl)
    (0, "2024-01-01", "2024-06-30", 1.42,  2.18, -0.0821, 0.587, 0.72, 183, 4820.50),
    (0, "2024-07-01", "2024-12-31", 0.89,  1.34, -0.1243, 0.521, 0.48, 201, 2140.80),
    (1, "2024-01-01", "2024-12-31", 1.87,  2.91, -0.0634, 0.623, 0.91, 142, 7350.20),
    (1, "2024-01-01", "2024-06-30", 1.61,  2.44, -0.0758, 0.601, 0.82, 78,  3980.60),
    (2, "2024-03-01", "2024-12-31", 0.73,  1.12, -0.1587, 0.489, 0.31, 219, 1250.30),
    (3, "2024-01-01", "2024-12-31", 2.14,  3.22, -0.0512, 0.651, 1.12, 97,  9820.40),
    (4, "2024-01-01", "2024-12-31", 1.31,  1.98, -0.0943, 0.558, 0.61, 164, 3640.70),
    (4, "2024-06-01", "2024-12-31", -0.22, -0.31, -0.2341, 0.423, -0.18, 88, -1840.20),
]


def gbm_path(start_price: float, n: int, mu: float = 0.0, sigma: float = 0.0015) -> list[float]:
    """Geometric Brownian Motion price path."""
    prices = [start_price]
    for _ in range(n - 1):
        ret = random.gauss(mu, sigma)
        prices.append(prices[-1] * math.exp(ret))
    return prices


def make_candles(pair: str, timeframe: str) -> list[tuple]:
    """Generate realistic OHLCV candles for a pair/timeframe between CANDLE_START and CANDLE_END."""
    step = timedelta(hours=1) if timeframe == "1H" else timedelta(minutes=1)
    base = BASE_PRICES[pair]
    is_jpy = "JPY" in pair
    pip = 0.01 if is_jpy else 0.0001
    spread = pip * (3 if is_jpy else 2)

    candles = []
    ts = CANDLE_START
    close = base

    while ts < CANDLE_END:
        # Skip weekends
        if ts.weekday() >= 5:
            ts += step
            continue

        sigma = 0.003 if timeframe == "1H" else 0.0008
        ret = random.gauss(0, sigma)
        o = close
        c = o * math.exp(ret)
        hi = max(o, c) * (1 + abs(random.gauss(0, sigma * 0.5)))
        lo = min(o, c) * (1 - abs(random.gauss(0, sigma * 0.5)))
        vol = random.uniform(500, 5000)

        candles.append((pair, timeframe, ts, round(o, 8), round(hi, 8), round(lo, 8), round(c, 8), round(vol, 2)))
        close = c
        ts += step

    return candles


def make_trades(run_id: str, pair: str, period_start: str, period_end: str,
                win_rate: float, avg_r: float, trade_count: int, total_pnl: float) -> list[dict]:
    """Generate realistic trades for a backtest run."""
    rng = random.Random(run_id)
    base = BASE_PRICES[pair]
    is_jpy = "JPY" in pair
    pip_val = 0.01 if is_jpy else 0.0001

    start_dt = datetime.fromisoformat(period_start).replace(tzinfo=timezone.utc)
    end_dt   = datetime.fromisoformat(period_end).replace(tzinfo=timezone.utc)
    total_secs = int((end_dt - start_dt).total_seconds())

    # Distribute pnl: winners get positive, losers negative, sum ≈ total_pnl
    winners_count = int(trade_count * win_rate)
    losers_count  = trade_count - winners_count
    avg_win  = (total_pnl / winners_count * 1.4) if winners_count else 0
    avg_loss = (total_pnl - avg_win * winners_count) / losers_count if losers_count else 0

    outcomes = [True] * winners_count + [False] * losers_count
    rng.shuffle(outcomes)

    trades = []
    for i, is_win in enumerate(outcomes):
        offset = rng.randint(0, total_secs - 7200)
        entry_dt = start_dt + timedelta(seconds=offset)
        # Skip weekends
        while entry_dt.weekday() >= 5:
            entry_dt += timedelta(hours=24)

        duration_min = rng.randint(30, 480) if is_win else rng.randint(15, 240)
        exit_dt = entry_dt + timedelta(minutes=duration_min)

        direction = rng.choice(["long", "short"])
        entry_price = base * rng.uniform(0.995, 1.005)

        if is_win:
            pnl = max(10, rng.gauss(avg_win, abs(avg_win) * 0.4))
            r   = rng.gauss(max(0.5, avg_r), 0.3)
            move = pnl / 10000 * pip_val
            exit_price = entry_price + move if direction == "long" else entry_price - move
            mae = -abs(rng.gauss(0.0003, 0.0001))
            mfe = abs(rng.gauss(0.0008, 0.0003))
        else:
            pnl = min(-10, rng.gauss(avg_loss, abs(avg_loss) * 0.4))
            r   = rng.gauss(min(-0.5, avg_r - 1.0), 0.3)
            move = abs(pnl) / 10000 * pip_val
            exit_price = entry_price - move if direction == "long" else entry_price + move
            mae = -abs(rng.gauss(0.0008, 0.0003))
            mfe = abs(rng.gauss(0.0002, 0.0001))

        trades.append({
            "id": str(uuid.uuid4()),
            "backtest_run_id": run_id,
            "entry_time": entry_dt.isoformat(),
            "exit_time": exit_dt.isoformat(),
            "direction": direction,
            "entry_price": round(entry_price, 8),
            "exit_price": round(max(0.0001, exit_price), 8),
            "pnl": round(pnl, 4),
            "r_multiple": round(r, 4),
            "mae": round(mae, 8),
            "mfe": round(mfe, 8),
        })

    return trades


async def main():
    conn = await asyncpg.connect(DB_URL)
    print("Connected to DB")

    # ── Clear existing demo data ───────────────────────────────────────────────
    print("Clearing existing data...")
    await conn.execute("DELETE FROM optimization_iterations")
    await conn.execute("DELETE FROM optimization_runs")
    await conn.execute("DELETE FROM trades")
    await conn.execute("DELETE FROM backtest_runs")
    await conn.execute("DELETE FROM strategies")
    await conn.execute("DELETE FROM ohlcv_candles")

    # ── Insert OHLCV candles (1H only for speed, all 6 pairs) ─────────────────
    print("Generating OHLCV candles (1H, all 6 pairs)...")
    for pair in PAIRS:
        print(f"  {pair} 1H...")
        candles = make_candles(pair, "1H")
        await conn.executemany(
            """INSERT INTO ohlcv_candles (pair, timeframe, timestamp, open, high, low, close, volume)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
               ON CONFLICT DO NOTHING""",
            candles,
        )
        print(f"    {len(candles)} candles inserted")

    # ── Insert strategies ──────────────────────────────────────────────────────
    print("Inserting strategies...")
    strategy_ids = []
    for s in STRATEGIES:
        sid = str(uuid.uuid4())
        strategy_ids.append(sid)
        await conn.execute(
            """INSERT INTO strategies (id, version, ir_json, description, pair, timeframe, created_at)
               VALUES ($1, $2, $3, $4, $5, $6, now())""",
            sid, s["version"], json.dumps(s["ir_json"]), s["description"], s["pair"], s["timeframe"],
        )
    print(f"  {len(strategy_ids)} strategies inserted")

    # ── Insert backtest runs + trades ──────────────────────────────────────────
    print("Inserting backtest runs and trades...")
    for cfg in BACKTEST_CONFIGS:
        sidx, ps, pe, sharpe, sortino, max_dd, win_rate, avg_r, trade_count, total_pnl = cfg
        strategy_id = strategy_ids[sidx]
        pair = STRATEGIES[sidx]["pair"]
        timeframe = STRATEGIES[sidx]["timeframe"]
        run_id = str(uuid.uuid4())

        summary = (
            f"Backtest of {STRATEGIES[sidx]['description']} on {pair} {timeframe} "
            f"from {ps} to {pe}. "
            f"Sharpe: {sharpe:.2f}, Win rate: {win_rate*100:.1f}%, "
            f"Total PnL: ${total_pnl:,.2f}, Max DD: {max_dd*100:.1f}%."
        )

        await conn.execute(
            """INSERT INTO backtest_runs
               (id, strategy_id, period_start, period_end, pair, timeframe,
                sharpe, sortino, max_dd, win_rate, avg_r, trade_count, total_pnl,
                summary_text, celery_task_id, created_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now())""",
            run_id, strategy_id, date.fromisoformat(ps), date.fromisoformat(pe), pair, timeframe,
            sharpe, sortino, max_dd, win_rate, avg_r, trade_count, total_pnl,
            summary, str(uuid.uuid4()),
        )

        trades = make_trades(run_id, pair, ps, pe, win_rate, avg_r, trade_count, total_pnl)
        await conn.executemany(
            """INSERT INTO trades
               (id, backtest_run_id, entry_time, exit_time, direction,
                entry_price, exit_price, pnl, r_multiple, mae, mfe, signal_context)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'{}')""",
            [(t["id"], t["backtest_run_id"],
              datetime.fromisoformat(t["entry_time"]),
              datetime.fromisoformat(t["exit_time"]),
              t["direction"], t["entry_price"], t["exit_price"],
              t["pnl"], t["r_multiple"], t["mae"], t["mfe"]) for t in trades],
        )
        print(f"  Run {run_id[:8]}… → {len(trades)} trades, Sharpe {sharpe:.2f}")

    # ── Insert optimization runs + iterations ──────────────────────────────────
    print("Inserting optimization runs and iterations...")
    await conn.execute("DELETE FROM optimization_iterations")
    await conn.execute("DELETE FROM optimization_runs")

    for opt in OPT_RUNS:
        sidx = opt["strategy_idx"]
        strategy_id = strategy_ids[sidx]
        iters = opt["iterations"]
        best_iter = max(range(len(iters)), key=lambda i: iters[i][0])
        best_sharpe = iters[best_iter][0]
        best_win_rate = iters[best_iter][1]

        run_id = str(uuid.uuid4())
        started_at = datetime(2024, 6, 1, 9, 0, tzinfo=timezone.utc)
        completed_at = started_at + timedelta(minutes=len(iters) * 18)

        await conn.execute(
            """INSERT INTO optimization_runs
               (id, user_id, pair, timeframe, period_start, period_end, initial_strategy_id,
                model, max_iterations, target_sharpe, target_win_rate,
                status, current_iteration, stop_reason,
                best_iteration, best_sharpe, best_win_rate,
                created_at, started_at, completed_at)
               VALUES ($1,'operator',$2,$3,$4,$5,$6,$7,$8,$9,$10,'completed',$11,$12,$13,$14,$15,now(),$16,$17)""",
            run_id, opt["pair"], opt["timeframe"],
            date.fromisoformat(opt["period_start"]), date.fromisoformat(opt["period_end"]),
            strategy_id, opt["model"], opt["max_iterations"],
            opt["target_sharpe"], opt["target_win_rate"],
            len(iters), opt["stop_reason"],
            best_iter + 1, best_sharpe, best_win_rate,
            started_at, completed_at,
        )

        for i, (sharpe, win_rate, max_dd, total_pnl, trade_count, ai_analysis, ai_changes, ir_patch) in enumerate(iters):
            iter_ir = dict(STRATEGIES[sidx]["ir_json"])
            iter_ir.update(ir_patch)
            iter_created = started_at + timedelta(minutes=i * 18)
            await conn.execute(
                """INSERT INTO optimization_iterations
                   (id, run_id, iteration_number, strategy_ir,
                    sharpe, win_rate, max_dd, total_pnl, trade_count,
                    ai_analysis, ai_changes, created_at)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)""",
                str(uuid.uuid4()), run_id, i + 1, json.dumps(iter_ir),
                sharpe, win_rate, max_dd, total_pnl, trade_count,
                ai_analysis, ai_changes, iter_created,
            )

        print(f"  Run {run_id[:8]}… → {len(iters)} iterations, best Sharpe {best_sharpe:.2f} ({opt['stop_reason']})")

    await conn.close()
    print("\nDone! Demo data seeded successfully.")
    print("→ Strategies: 5")
    print(f"→ Backtest runs: {len(BACKTEST_CONFIGS)}")
    print(f"→ Optimization runs: {len(OPT_RUNS)}")
    print("→ OHLCV candles: ~8,500 per pair (1H, 2024)")


if __name__ == "__main__":
    asyncio.run(main())
