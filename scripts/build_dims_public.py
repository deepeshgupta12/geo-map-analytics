#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"
OUT = ROOT / "public" / "dim"


def _coerce_int_series(s: pd.Series) -> pd.Series:
    return pd.to_numeric(s, errors="coerce").astype("Int64")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--city-id", type=int, default=13)
    ap.add_argument("--dim-locality", type=str, default="dim_locality.csv")
    ap.add_argument("--dim-micromarket", type=str, default="dim_micro_market.csv")
    args = ap.parse_args()

    city_id = int(args.city_id)

    loc = pd.read_csv(RAW / args.dim_locality, encoding="cp1252")
    mm = pd.read_csv(RAW / args.dim_micromarket, encoding="cp1252")

    for df in [loc, mm]:
        for col in ["CityID", "LocalityID", "MicroMarketID"]:
            if col in df.columns:
                df[col] = _coerce_int_series(df[col])

    loc = loc[loc["CityID"] == city_id].dropna(subset=["LocalityID", "LocalityName"]).copy()
    loc = loc.drop_duplicates(subset=["LocalityID"], keep="first")

    mm = mm[mm["CityID"] == city_id].dropna(subset=["MicroMarketID"]).copy()
    # Try common name columns
    mm_name_col = None
    for c in ["MicroMarketName", "MicromarketName", "Micromarket", "Name"]:
        if c in mm.columns:
            mm_name_col = c
            break
    if mm_name_col is None:
        raise KeyError("dim_micro_market missing a micromarket name column (expected MicroMarketName/MicromarketName/...)")

    mm = mm.drop_duplicates(subset=["MicroMarketID"], keep="first")

    OUT.mkdir(parents=True, exist_ok=True)

    loc_out = []
    for _, r in loc.iterrows():
        loc_out.append(
            {
                "id": int(r["LocalityID"]),
                "name": str(r["LocalityName"]),
                "micromarketId": None if pd.isna(r.get("MicroMarketID")) else int(r.get("MicroMarketID")),
                "pincode": None if pd.isna(r.get("Pincode")) else str(r.get("Pincode")),
            }
        )

    mm_out = []
    for _, r in mm.iterrows():
        mm_out.append(
            {
                "id": int(r["MicroMarketID"]),
                "name": str(r[mm_name_col]),
            }
        )

    (OUT / f"localities_city{city_id}.json").write_text(json.dumps({"cityId": city_id, "items": loc_out}, indent=2))
    (OUT / f"micromarkets_city{city_id}.json").write_text(json.dumps({"cityId": city_id, "items": mm_out}, indent=2))

    print(f"Wrote: {OUT / f'localities_city{city_id}.json'}")
    print(f"Wrote: {OUT / f'micromarkets_city{city_id}.json'}")


if __name__ == "__main__":
    main()