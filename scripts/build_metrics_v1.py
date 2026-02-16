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
        return float(g[value_col].mean())
    return float((g[value_col] * w).sum() / w.sum())


def month_key(dt) -> str:
    ts = pd.to_datetime(dt)
    return ts.strftime("%Y-%m-01")


def _coerce_int_series(s: pd.Series) -> pd.Series:
    # Keeps pandas nullable Int64 (so NaNs are preserved)
    return pd.to_numeric(s, errors="coerce").astype("Int64")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)

    if not ASKING_FILE.exists():
        raise FileNotFoundError(f"Missing asking file: {ASKING_FILE}")
    if not DIM_LOCALITY_FILE.exists():
        raise FileNotFoundError(f"Missing dim_locality file: {DIM_LOCALITY_FILE}")

    # ----------------------------
    # Load + clean dim_locality
    # ----------------------------
    dim_loc = pd.read_csv(DIM_LOCALITY_FILE, encoding="cp1252")

    # expected columns: LocalityID, MicroMarketID, CityID, LocalityName, Pincode
    for col in ["CityID", "LocalityID", "MicroMarketID"]:
        if col in dim_loc.columns:
            dim_loc[col] = _coerce_int_series(dim_loc[col])

    dim_loc = dim_loc[dim_loc["CityID"] == CITY_ID].copy()

    # A little hygiene: keep the first occurrence per LocalityID
    dim_loc = dim_loc.dropna(subset=["LocalityID", "LocalityName"])
    dim_loc = dim_loc.drop_duplicates(subset=["LocalityID"], keep="first")

    # ----------------------------
    # Load + clean asking sheet
    # ----------------------------
    asking = pd.read_excel(ASKING_FILE, sheet_name=0)

    for col in ["CityID", "LocalityID", "MicroMarketID"]:
        if col in asking.columns:
            asking[col] = _coerce_int_series(asking[col])

    asking = asking[asking["CityID"] == CITY_ID].copy()

    # V1 metric definition: Apartment, all BHK combined, MedianPricePSF weighted by SampleSize
    asking = asking[asking["AssetType"].astype(str).str.lower() == "apartment"].copy()
    asking["MonthKey"] = asking["Month"].apply(month_key)

    # ----------------------------
    # 1) Micromarket metric file
    # ----------------------------
    mm_rows = []
    for (mkey, mmid), grp in asking.groupby(["MonthKey", "MicroMarketID"], dropna=False):
        if pd.isna(mmid):
            continue
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
    # Join LocalityID -> LocalityName using dim_locality
    asking_loc = asking.merge(
        dim_loc[["LocalityID", "LocalityName"]],
        how="left",
        on="LocalityID",
        validate="m:1",
    )

    # Export unmapped rows BEFORE dropping them
    unmapped = asking_loc[asking_loc["LocalityName"].isna()].copy()
    unmapped_count = int(unmapped.shape[0])

    if unmapped_count > 0:
        # Aggregate for quick diagnosis
        summary = (
            unmapped.groupby("LocalityID", dropna=False)
            .size()
            .reset_index(name="rows")
            .sort_values("rows", ascending=False)
        )

        # Build a compact JSON artifact with examples
        examples = []
        # show up to 50 unmapped rows as examples (enough for debugging)
        sample_rows = unmapped.head(50)
        for _, r in sample_rows.iterrows():
            examples.append(
                {
                    "MonthKey": str(r.get("MonthKey")),
                    "LocalityID": None if pd.isna(r.get("LocalityID")) else int(r.get("LocalityID")),
                    "MicroMarketID": None if pd.isna(r.get("MicroMarketID")) else int(r.get("MicroMarketID")),
                    "MedianPricePSF": None if pd.isna(r.get("MedianPricePSF")) else float(r.get("MedianPricePSF")),
                    "SampleSize": None if pd.isna(r.get("SampleSize")) else int(pd.to_numeric(r.get("SampleSize"), errors="coerce") or 0),
                    "FreshnessDate": str(r.get("FreshnessDate")) if "FreshnessDate" in unmapped.columns else None,
                }
            )

        unmapped_out = {
            "cityId": CITY_ID,
            "reason": "LocalityID not found in dim_locality.csv (after dtype normalization)",
            "unmappedRowCount": unmapped_count,
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

        unmapped_path = OUT / "unmapped_locality_ids_city13.json"
        unmapped_path.write_text(json.dumps(unmapped_out, indent=2))
        print(f"[warn] {unmapped_count} asking rows could not map LocalityID -> LocalityName for CityID={CITY_ID}")
        print(f"Wrote: {unmapped_path}")
    else:
        print("All asking rows mapped LocalityID -> LocalityName successfully (CityID=13).")

    # Now drop unmapped rows for the localityName metric output
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
            "Locality tiles do not expose LocalityID, so runtime join should use (CityID + LocalityName) from tiles",
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