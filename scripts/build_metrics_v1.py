#!/usr/bin/env python3
from __future__ import annotations

import json
from pathlib import Path
import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"
OUT = ROOT / "public" / "metrics"

CITY_ID = 13  # Mumbai
ASKING_FILE = RAW / "metric_asking_monthly(New) (2).xlsx"
DIM_LOCALITY_FILE = RAW / "dim_locality.csv"


def weighted_avg(group: pd.DataFrame, value_col: str, weight_col: str) -> float | None:
    g = group.copy()
    g[value_col] = pd.to_numeric(g[value_col], errors="coerce")
    g[weight_col] = pd.to_numeric(g[weight_col], errors="coerce").fillna(0)
    g = g.dropna(subset=[value_col])
    if g.empty:
        return None
    w = g[weight_col].clip(lower=0)
    if w.sum() == 0:
        # fallback to simple mean if weights missing
        return float(g[value_col].mean())
    return float((g[value_col] * w).sum() / w.sum())


def month_key(dt) -> str:
    # normalize to YYYY-MM-01 string
    ts = pd.to_datetime(dt)
    return ts.strftime("%Y-%m-01")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)

    if not ASKING_FILE.exists():
        raise FileNotFoundError(f"Missing asking file: {ASKING_FILE}")
    if not DIM_LOCALITY_FILE.exists():
        raise FileNotFoundError(f"Missing dim_locality file: {DIM_LOCALITY_FILE}")

    dim_loc = pd.read_csv(DIM_LOCALITY_FILE, encoding="cp1252")
    # expected columns: LocalityID, MicroMarketID, CityID, LocalityName, Pincode
    dim_loc = dim_loc[dim_loc["CityID"] == CITY_ID].copy()

    asking = pd.read_excel(ASKING_FILE, sheet_name=0)
    # expected columns:
    # Month, CityID, MicroMarketID, LocalityID, BHK, AssetType, MedianAskingPrice, MedianPricePSF, SampleSize, FreshnessDate
    asking = asking[asking["CityID"] == CITY_ID].copy()

    # ---- Choose V1 metric definition (simple + explicit) ----
    # We start with: Apartment + all BHK combined (weighted by SampleSize), using MedianPricePSF.
    asking = asking[asking["AssetType"].astype(str).str.lower() == "apartment"].copy()

    asking["MonthKey"] = asking["Month"].apply(month_key)

    # ----------------------------
    # 1) Micromarket metric file
    # ----------------------------
    mm_rows = []
    for (mkey, mmid), grp in asking.groupby(["MonthKey", "MicroMarketID"], dropna=False):
        v = weighted_avg(grp, "MedianPricePSF", "SampleSize")
        sample = int(pd.to_numeric(grp["SampleSize"], errors="coerce").fillna(0).sum())
        if v is None:
            continue
        mm_rows.append((mkey, int(mmid), v, sample))

    mm_df = pd.DataFrame(mm_rows, columns=["MonthKey", "MicroMarketID", "value", "sample"])
    months = sorted(mm_df["MonthKey"].unique().tolist())

    mm_out = {
        "cityId": CITY_ID,
        "metric": "asking_psf",
        "level": "micromarket",
        "months": months,
        "byMonth": {},
    }

    for m in months:
        sub = mm_df[mm_df["MonthKey"] == m]
        mm_out["byMonth"][m] = {
            str(int(row["MicroMarketID"])): {"v": float(row["value"]), "n": int(row["sample"])}
            for _, row in sub.iterrows()
        }

    (OUT / "asking_psf_micromarket.json").write_text(json.dumps(mm_out, indent=2))
    print(f"Wrote: {OUT / 'asking_psf_micromarket.json'}")

    # -----------------------------------------
    # 2) LocalityName metric file (lookup join)
    # -----------------------------------------
    # Join LocalityID -> LocalityName via dim_locality
    asking_loc = asking.merge(
        dim_loc[["LocalityID", "LocalityName"]],
        how="left",
        on="LocalityID",
        validate="m:1",
    )

    missing_names = int(asking_loc["LocalityName"].isna().sum())
    if missing_names > 0:
        print(f"[warn] {missing_names} asking rows could not map LocalityID -> LocalityName for CityID={CITY_ID}")

    asking_loc = asking_loc.dropna(subset=["LocalityName"]).copy()

    loc_rows = []
    for (mkey, lname), grp in asking_loc.groupby(["MonthKey", "LocalityName"], dropna=False):
        v = weighted_avg(grp, "MedianPricePSF", "SampleSize")
        sample = int(pd.to_numeric(grp["SampleSize"], errors="coerce").fillna(0).sum())
        if v is None:
            continue
        loc_rows.append((mkey, str(lname), v, sample))

    loc_df = pd.DataFrame(loc_rows, columns=["MonthKey", "LocalityName", "value", "sample"])
    months2 = sorted(loc_df["MonthKey"].unique().tolist())

    loc_out = {
        "cityId": CITY_ID,
        "metric": "asking_psf",
        "level": "localityName",
        "months": months2,
        "byMonth": {},
        "notes": [
            "Joined LocalityID -> LocalityName using dim_locality.csv",
            "If multiple LocalityID share same LocalityName within a city, values are aggregated into one bucket",
        ],
    }

    for m in months2:
        sub = loc_df[loc_df["MonthKey"] == m]
        loc_out["byMonth"][m] = {
            str(row["LocalityName"]): {"v": float(row["value"]), "n": int(row["sample"])}
            for _, row in sub.iterrows()
        }

    (OUT / "asking_psf_localityname.json").write_text(json.dumps(loc_out, indent=2))
    print(f"Wrote: {OUT / 'asking_psf_localityname.json'}")


if __name__ == "__main__":
    main()