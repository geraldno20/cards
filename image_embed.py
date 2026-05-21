"""Load cached CLIP image embeddings and provide cosine-similarity scoring.

The cache is built by `embed_images.py`. If the cache is missing, all scores
return 0.0 — the rest of the recommender keeps working.
"""

import os
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE_PATH = os.path.join(HERE, "image_embeddings.npz")


def load_cache():
    if not os.path.isfile(CACHE_PATH):
        return None, None
    data = np.load(CACHE_PATH)
    ids = data["ids"].astype(int)
    vecs = data["vectors"].astype(np.float32)
    norms = np.linalg.norm(vecs, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    vecs = vecs / norms  # pre-normalize for cosine
    return ids, vecs


_IDS, _VECS = load_cache()
_INDEX = {int(c): i for i, c in enumerate(_IDS)} if _IDS is not None else {}


def reload():
    global _IDS, _VECS, _INDEX
    _IDS, _VECS = load_cache()
    _INDEX = {int(c): i for i, c in enumerate(_IDS)} if _IDS is not None else {}


def has_data():
    return _VECS is not None and len(_INDEX) > 0


def embedding(card_id):
    idx = _INDEX.get(card_id)
    if idx is None or _VECS is None:
        return None
    return _VECS[idx]


def similarity_to_seeds(card_id, seed_ids):
    """Mean cosine similarity of card_id's embedding vs each seed's. Returns 0 if missing."""
    if not has_data():
        return 0.0
    cand = embedding(card_id)
    if cand is None:
        return 0.0
    sims = []
    for sid in seed_ids:
        sv = embedding(sid)
        if sv is None:
            continue
        sims.append(float(np.dot(cand, sv)))  # vectors already normalized
    if not sims:
        return 0.0
    # CLIP cosines tend to live in [0.5, 0.9]; rescale to roughly [0, 1] for comparability.
    avg = sum(sims) / len(sims)
    return max(0.0, min(1.0, (avg - 0.5) / 0.5))
