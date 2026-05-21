"""eBay sold-listings popularity. Reads a JSON cache populated by fetch_popularity.py.

Cache shape:
{
  "<cardId>": {"soldCount": 12, "medianPrice": 35.0, "fetchedAt": "2026-05-20T..."},
  ...
}
"""

import json
import os
import math

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE_PATH = os.path.join(HERE, "popularity_cache.json")


def load_cache():
    if not os.path.isfile(CACHE_PATH):
        return {}
    try:
        with open(CACHE_PATH) as f:
            raw = json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}
    return {int(k): v for k, v in raw.items()}


_CACHE = load_cache()
_MAX_LOG_SOLD = max(
    (math.log1p(entry.get("soldCount", 0)) for entry in _CACHE.values()),
    default=1.0,
) or 1.0


def reload():
    """Re-read the cache from disk (so you can fetch new data without restarting)."""
    global _CACHE, _MAX_LOG_SOLD
    _CACHE = load_cache()
    _MAX_LOG_SOLD = max(
        (math.log1p(entry.get("soldCount", 0)) for entry in _CACHE.values()),
        default=1.0,
    ) or 1.0


def has_data():
    return bool(_CACHE)


def raw(card_id):
    return _CACHE.get(card_id)


def score(card_id):
    """Popularity score in [0, 1]. Log-scaled sold count, normalized against the most-sold card."""
    entry = _CACHE.get(card_id)
    if not entry:
        return 0.0
    sold = entry.get("soldCount", 0) or 0
    if sold <= 0:
        return 0.0
    return math.log1p(sold) / _MAX_LOG_SOLD
