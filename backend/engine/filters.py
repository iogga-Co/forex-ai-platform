"""
Session and day-of-week filters.

Each function returns a boolean Series aligned to the OHLCV DatetimeIndex.
True = trading is allowed on this bar; False = skip this bar.

The filter mask is applied to the SHIFTED entry signals in runner.py, so
it correctly filters against the EXECUTION bar (bar N+1), not the signal bar.
"""

from collections.abc import Sequence

import pandas as pd

# London Open: 07:00–11:59 UTC
# New York Open: 13:00–17:59 UTC
# Asian Session: 00:00–06:59 UTC
_SESSION_HOURS_UTC: dict[str, set[int]] = {
    "london_open":   set(range(7, 12)),
    "new_york_open": set(range(13, 18)),
    "asian_session": set(range(0, 7)),
    "all":           set(range(0, 24)),
}

_DAY_NAME_TO_WEEKDAY: dict[str, int] = {
    "Monday": 0,
    "Tuesday": 1,
    "Wednesday": 2,
    "Thursday": 3,
    "Friday": 4,
    "Saturday": 5,
    "Sunday": 6,
}


def session_mask(index: pd.DatetimeIndex, session: str) -> pd.Series:
    """
    Boolean mask: True on bars whose UTC hour falls in the named session.

    Parameters
    ----------
    index   : UTC-aware DatetimeIndex from the OHLCV DataFrame
    session : one of "london_open", "new_york_open", "asian_session", "all"
    """
    allowed_hours = _SESSION_HOURS_UTC.get(session)
    if allowed_hours is None:
        raise ValueError(
            f"Unknown session '{session}'.  "
            f"Supported: {list(_SESSION_HOURS_UTC.keys())}"
        )
    if session == "all":
        return pd.Series(True, index=index, dtype=bool)

    hours = index.hour
    mask = pd.Series(
        [h in allowed_hours for h in hours],
        index=index,
        dtype=bool,
    )
    return mask


def day_of_week_mask(
    index: pd.DatetimeIndex,
    exclude_days: Sequence[str],
) -> pd.Series:
    """
    Boolean mask: True on bars whose day of week is NOT in exclude_days.

    Parameters
    ----------
    index        : UTC-aware DatetimeIndex
    exclude_days : list of day names to exclude, e.g. ["Monday", "Friday"]
    """
    if not exclude_days:
        return pd.Series(True, index=index, dtype=bool)

    excluded_weekdays = set()
    for day_name in exclude_days:
        weekday = _DAY_NAME_TO_WEEKDAY.get(day_name)
        if weekday is None:
            raise ValueError(
                f"Unknown day '{day_name}'.  "
                f"Supported: {list(_DAY_NAME_TO_WEEKDAY.keys())}"
            )
        excluded_weekdays.add(weekday)

    mask = pd.Series(
        [wd not in excluded_weekdays for wd in index.weekday],
        index=index,
        dtype=bool,
    )
    return mask


def combined_filter_mask(
    index: pd.DatetimeIndex,
    session: str = "all",
    exclude_days: Sequence[str] | None = None,
) -> pd.Series:
    """
    AND-combination of session and day-of-week masks.

    Parameters
    ----------
    index        : UTC-aware DatetimeIndex from the OHLCV DataFrame
    session      : session name or "all"
    exclude_days : list of day names to skip, or None/empty for no restriction
    """
    sess_mask = session_mask(index, session)
    dow_mask = day_of_week_mask(index, exclude_days or [])
    return sess_mask & dow_mask
