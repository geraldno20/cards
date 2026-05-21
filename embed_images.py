"""One-time embedder: encode every card image with CLIP ViT-B/32 and cache to image_embeddings.npz.

Usage:
    python3 embed_images.py            # embed missing only
    python3 embed_images.py --refresh  # re-embed everything
    python3 embed_images.py --model ViT-B-32 --pretrained openai

First run downloads the CLIP weights (~150MB) into your torch cache.
On CPU, embedding 162 images takes a couple minutes.
"""

import argparse
import os
import sys

import numpy as np
import pandas as pd
from PIL import Image
import torch
import open_clip

HERE = os.path.dirname(os.path.abspath(__file__))
CARDS_CSV = os.path.join(HERE, "SCI 500 card data.csv")
IMAGES_DIR = os.path.join(HERE, "SCI 500 ")  # source folder name has trailing space
CACHE_PATH = os.path.join(HERE, "image_embeddings.npz")
PLACEHOLDER_NAME = "Randy Moss RC 1998 Topps Chrome #35 Refractor"


def load_card_ids():
    df = pd.read_csv(CARDS_CSV)
    df = df.loc[:, ~df.columns.str.startswith("Unnamed")]
    df = df.dropna(subset=["cardId", "cardName"])
    df["cardId"] = df["cardId"].astype(int)
    df = df[df["cardName"] != PLACEHOLDER_NAME]
    return df["cardId"].tolist()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="ViT-B-32")
    parser.add_argument("--pretrained", default="openai")
    parser.add_argument("--refresh", action="store_true")
    parser.add_argument("--batch", type=int, default=16)
    args = parser.parse_args()

    print(f"Loading CLIP {args.model} / {args.pretrained} ...")
    model, _, preprocess = open_clip.create_model_and_transforms(args.model, pretrained=args.pretrained)
    model.eval()

    existing_ids, existing_vecs = np.array([], dtype=int), np.zeros((0, 0), dtype=np.float32)
    if os.path.isfile(CACHE_PATH) and not args.refresh:
        cached = np.load(CACHE_PATH)
        existing_ids = cached["ids"].astype(int)
        existing_vecs = cached["vectors"].astype(np.float32)
        print(f"Loaded {len(existing_ids)} cached embeddings (will skip those).")

    skip = set(existing_ids.tolist())
    todo = []
    for cid in load_card_ids():
        if cid in skip:
            continue
        path = os.path.join(IMAGES_DIR, f"SCI_{cid}.jpeg")
        if os.path.isfile(path):
            todo.append((cid, path))
        else:
            print(f"  ! missing image for cardId={cid}")

    if not todo:
        print("Nothing to embed.")
        return 0

    print(f"Embedding {len(todo)} images (batch={args.batch}) ...")
    new_ids, new_vecs = [], []
    with torch.no_grad():
        for i in range(0, len(todo), args.batch):
            batch = todo[i:i + args.batch]
            tensors = []
            ok_ids = []
            for cid, path in batch:
                try:
                    img = Image.open(path).convert("RGB")
                    tensors.append(preprocess(img))
                    ok_ids.append(cid)
                except Exception as e:
                    print(f"  ! failed cardId={cid}: {e}")
            if not tensors:
                continue
            stack = torch.stack(tensors)
            feats = model.encode_image(stack)
            feats = feats / feats.norm(dim=-1, keepdim=True)
            new_ids.extend(ok_ids)
            new_vecs.append(feats.cpu().numpy().astype(np.float32))
            print(f"  [{min(i + args.batch, len(todo))}/{len(todo)}]")

    new_vecs = np.vstack(new_vecs) if new_vecs else np.zeros((0, existing_vecs.shape[1] or 1), dtype=np.float32)
    if existing_vecs.size:
        all_ids = np.concatenate([existing_ids, np.array(new_ids, dtype=int)])
        all_vecs = np.vstack([existing_vecs, new_vecs])
    else:
        all_ids = np.array(new_ids, dtype=int)
        all_vecs = new_vecs

    np.savez_compressed(CACHE_PATH, ids=all_ids, vectors=all_vecs,
                        model=np.array(args.model), pretrained=np.array(args.pretrained))
    print(f"\nDone. {len(all_ids)} embeddings saved to {CACHE_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
