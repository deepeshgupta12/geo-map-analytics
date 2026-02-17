#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any, Optional

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"
OUT = ROOT / "public" / "metrics"


def _coerce_int_series(s: pd.Series) -> pd.Series:
    return pd.to_numeric(s, errors="coerce").astype("Int64")


def weighted_avg(group: pd.DataFrame, value_col: str, weight_col: str) -> float | None:
    g = group.copy()
    g[value_col] = pd.to_numeric(g[value_col], errors="coerce")
    g[weight_col] = pd.to_numeric(g[weight_col], errors="coerce").fillna(0)
    g = g.dropna(subset=[value_col])
    if g.empty:
        return None
    w = g[weight_col].clip(lower=0)
    if w.sum() == 0:
        return float(g[value_col].mean())
    return float((g[value_col] * w).sum() / w.sum())


def month_key(v: Any) -> str:
    """
    Supports:
      - datetime/date
      - strings like "Jan-25"
      - strings like "2025-01-01" / "01/01/2025" etc.
    Output: "YYYY-MM-01"
    """
    if v is None:
        return ""
    s = str(v).strip()
    if re.match(r"^[A-Za-z]{3}-\d{2}$", s):
        ts = pd.to_datetime(s, format="%b-%y", errors="coerce")
    else:
        ts = pd.to_datetime(v, errors="coerce")

    if pd.isna(ts):
        return s  # fallback, but ideally never happens
    return ts.strftime("%Y-%m-01")


def _read_table(path: Path) -> pd.DataFrame:
    if not path.exists():
        raise FileNotFoundError(f"Missing file: {path}")
    if path.suffix.lower() in [".xlsx", ".xls"]:
        return pd.read_excel(path, sheet_name=0)
    if path.suffix.lower() == ".csv":
        return pd.read_csv(path)
    raise ValueError(f"Unsupported file type: {path}")


def _export_metric(
    *,
    city_id: int,
    metric_key: str,
    df: pd.DataFrame,
    value_col: str,
    dim_loc: pd.DataFrame,
) -> None:
    """
    Writes:
      - {metric_key}_micromarket.json (keys: MicroMarketID)
      - {metric_key}_localityname.json (keys: LocalityName)
    """
    OUT.mkdir(parents=True, exist_ok=True)

    # Normalize dtypes
    for col in ["CityID", "LocalityID", "MicroMarketID"]:
        if col in df.columns:
            df[col] = _coerce_int_series(df[col])

    df = df[df["CityID"] == city_id].copy()

    # Keep parity with V1: Apartment only (all BHK combined)
    if "AssetType" in df.columns:
        df = df[df["AssetType"].astype(str).str.lower() == "apartment"].copy()

    df["MonthKey"] = df["Month"].apply(month_key)

    # ----------------------------
    # 1) Micromarket output
    # ----------------------------
    mm_rows = []
    for (mkey, mmid), grp in df.groupby(["MonthKey", "MicroMarketID"], dropna=False):
        if pd.isna(mmid):
            continue
        v = weighted_avg(grp, value_col, "SampleSize")
        sample = int(pd.to_numeric(grp["SampleSize"], errors="coerce").fillna(0).sum())
        if v is None:
            continue
        mm_rows.append((mkey, int(mmid), v, sample))

    mm_df = pd.DataFrame(mm_rows, columns=["MonthKey", "MicroMarketID", "value", "sample"])
    months = sorted(mm_df["MonthKey"].dropna().unique().tolist())

    mm_out = {
        "cityId": city_id,
        "metric": metric_key,
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

    mm_path = OUT / f"{metric_key}_micromarket.json"
    mm_path.write_text(json.dumps(mm_out, indent=2))
    print(f"Wrote: {mm_path}")

    # ----------------------------
    # 2) LocalityName output
    # ----------------------------
    df_loc = df.merge(
        dim_loc[["LocalityID", "LocalityName"]],
        how="left",
        on="LocalityID",
        validate="m:1",
    )

    unmapped = df_loc[df_loc["LocalityName"].isna()].copy()
    if not unmapped.empty:
        summary = (
            unmapped.groupby("LocalityID", dropna=False)
            .size()
            .reset_index(name="rows")
            .sort_values("rows", ascending=False)
        )
        examples = []
        for _, r in unmapped.head(50).iterrows():
            examples.append(
                {
                    "MonthKey": str(r.get("MonthKey")),
                    "LocalityID": None if pd.isna(r.get("LocalityID")) else int(r.get("LocalityID")),
                    "MicroMarketID": None if pd.isna(r.get("MicroMarketID")) else int(r.get("MicroMarketID")),
                    value_col: None if pd.isna(r.get(value_col)) else float(r.get(value_col)),
                    "SampleSize": None
                    if pd.isna(r.get("SampleSize"))
                    else int(pd.to_numeric(r.get("SampleSize"), errors="coerce") or 0),
                    "FreshnessDate": str(r.get("FreshnessDate")) if "FreshnessDate" in unmapped.columns else None,
                }
            )

        unmapped_out = {
            "cityId": city_id,
            "metric": metric_key,
            "reason": "LocalityID not found in dim_locality.csv (after dtype normalization)",
            "unmappedRowCount": int(unmapped.shape[0]),
            "uniqueUnmappedLocalityIdCount": int(summary["LocalityID"].notna().sum()),
            "topUnmappedLocalityIds": [
                {
                    "LocalityID": None if pd.isna(row["LocalityID"]) else int(row["LocalityID"]),
                    "rows": int(row["rows"]),
                }
                for _, row in summary.head(50).iterrows()
            ],
            "examples": examples,
        }

        unmapped_path = OUT / f"unmapped_locality_ids_city{city_id}_{metric_key}.json"
        unmapped_path.write_text(json.dumps(unmapped_out, indent=2))
        print(f"[warn] {int(unmapped.shape[0])} rows unmapped for {metric_key} (CityID={city_id})")
        print(f"Wrote: {unmapped_path}")

    df_loc = df_loc.dropna(subset=["LocalityName"]).copy()

    loc_rows = []
    for (mkey, lname), grp in df_loc.groupby(["MonthKey", "LocalityName"], dropna=False):
        v = weighted_avg(grp, value_col, "SampleSize")
        sample = int(pd.to_numeric(grp["SampleSize"], errors="coerce").fillna(0).sum())
        if v is None:
            continue
        loc_rows.append((mkey, str(lname), v, sample))

    loc_df = pd.DataFrame(loc_rows, columns=["MonthKey", "LocalityName", "value", "sample"])
    months2 = sorted(loc_df["MonthKey"].dropna().unique().tolist())

    loc_out = {
        "cityId": city_id,
        "metric": metric_key,
        "level": "localityName",
        "months": months2,
        "byMonth": {},
        "notes": [
            "Joined LocalityID -> LocalityName using dim_locality.csv",
            "If multiple LocalityID share same LocalityName within a city, values are aggregated into one bucket",
            "Locality tiles do not expose LocalityID, so runtime join uses (CityID + LocalityName) from tiles",
        ],
    }

    for m in months2:
        sub = loc_df[loc_df["MonthKey"] == m]
        loc_out["byMonth"][m] = {
            str(row["LocalityName"]): {"v": float(row["value"]), "n": int(row["sample"])}
            for _, row in sub.iterrows()
        }

    loc_path = OUT / f"{metric_key}_localityname.json"
    loc_path.write_text(json.dumps(loc_out, indent=2))
    print(f"Wrote: {loc_path}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--city-id", type=int, default=13)
    ap.add_argument("--asking-file", type=str, default="metric_asking_monthly(New) (2).xlsx")
    ap.add_argument("--rent-file", type=str, default="metric_rent_monthly(New) (2).xlsx")
    ap.add_argument("--dim-locality", type=str, default="dim_locality.csv")
    args = ap.parse_args()

    city_id = int(args.city_id)

    dim_loc_path = RAW / args.dim_locality
    dim_loc = pd.read_csv(dim_loc_path, encoding="cp1252")

    for col in ["CityID", "LocalityID", "MicroMarketID"]:
        if col in dim_loc.columns:
            dim_loc[col] = _coerce_int_series(dim_loc[col])

    dim_loc = dim_loc[dim_loc["CityID"] == city_id].copy()
    dim_loc = dim_loc.dropna(subset=["LocalityID", "LocalityName"])
    dim_loc = dim_loc.drop_duplicates(subset=["LocalityID"], keep="first")

    asking_path = RAW / args.asking_file
    rent_path = RAW / args.rent_file

    asking = _read_table(asking_path)
    rent = _read_table(rent_path)

    # Asking: MedianPricePSF
    if "MedianPricePSF" not in asking.columns:
        raise KeyError("Asking file missing column: MedianPricePSF")
    _export_metric(city_id=city_id, metric_key="asking_psf", df=asking, value_col="MedianPricePSF", dim_loc=dim_loc)

    # Rent: two metrics
    if "MedianRentPSF" in rent.columns:
        _export_metric(city_id=city_id, metric_key="rent_psf", df=rent, value_col="MedianRentPSF", dim_loc=dim_loc)
    else:
        print("[warn] Rent file missing MedianRentPSF, skipping rent_psf")

    if "MedianMonthlyRent" in rent.columns:
        _export_metric(city_id=city_id, metric_key="rent_monthly", df=rent, value_col="MedianMonthlyRent", dim_loc=dim_loc)
    else:
        print("[warn] Rent file missing MedianMonthlyRent, skipping rent_monthly")


if __name__ == "__main__":
    main()