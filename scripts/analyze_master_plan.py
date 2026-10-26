#!/usr/bin/env python3
"""
Master plan analysis for a project folder (public/projects/<slug>).

Reuses the Green Open Area Intelligence engine (image preprocessing, plan/legend
crops, OpenCV built-structure mask, Gemini JSON prompting) and adds a building-layout
extraction step: tower count, per-tower footprints, podium, north arrow and road
frontage. Footprints are georeferenced onto the plot polygon in project.json and
written back as towers[] so the map can render them.

Usage (run with the engine's virtualenv, which has OpenCV + google-genai):

  GOA_ENGINE_DIR=~/green-open-area-intelligence \
  ~/green-open-area-intelligence/.venv/bin/python scripts/analyze_master_plan.py \
      public/projects/godrej-horizon-wadala [--no-gemini] [--overwrite]

Outputs:
  <folder>/analysis/masterplan_analysis.json   full result (OpenCV candidates + Gemini layout + georeferenced towers)
  <folder>/analysis/*.png                      normalized image, plan/legend crops, built mask, candidate overlay
  <folder>/project.json                        towerCount / towers[] / podium / layout filled in (nulls only unless --overwrite)
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
from pathlib import Path
from typing import Any

ENGINE_DIR = Path(os.environ.get("GOA_ENGINE_DIR", Path.home() / "green-open-area-intelligence")).resolve()
if not (ENGINE_DIR / "app").is_dir():
    print(f"Green Open Area Intelligence engine not found at {ENGINE_DIR}; set GOA_ENGINE_DIR.", file=sys.stderr)
    sys.exit(2)
sys.path.insert(0, str(ENGINE_DIR))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(ENGINE_DIR / ".env")  # GEMINI_API_KEY, model names (engine)
load_dotenv(Path(__file__).resolve().parent.parent / ".env.local")  # ANTHROPIC_API_KEY (this repo, git-ignored)

import cv2  # noqa: E402
import numpy as np  # noqa: E402

from app.config import get_settings  # noqa: E402
from app.services.image_preprocessor import preprocess_master_plan_image  # noqa: E402
from app.services.master_plan_preprocessor import create_master_plan_preprocessing_artifacts  # noqa: E402
from app.services.segmentation_engine import (  # noqa: E402
    _create_built_mask,
    _create_green_mask,
    _create_water_mask,
)
from app.utils.llm_utils import extract_json_from_text, load_image_part_for_gemini  # noqa: E402


# ---------------------------------------------------------------------------
# OpenCV: candidate building footprints from the built-structure mask
# ---------------------------------------------------------------------------
def candidate_footprints(cleaned_plan_path: Path, out_dir: Path, slug: str) -> dict[str, Any]:
    bgr = cv2.imread(str(cleaned_plan_path), cv2.IMREAD_COLOR)
    if bgr is None:
        raise ValueError(f"cannot read {cleaned_plan_path}")
    h, w = bgr.shape[:2]
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)

    green = _create_green_mask(hsv)
    water = _create_water_mask(hsv)
    not_gw = cv2.bitwise_not(cv2.bitwise_or(green, water))

    # Strategy A (engine): dark / brown building blocks.
    dark = cv2.bitwise_and(_create_built_mask(bgr, hsv), not_gw)
    dark = cv2.morphologyEx(dark, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8), iterations=2)
    dark = cv2.morphologyEx(dark, cv2.MORPH_OPEN, np.ones((9, 9), np.uint8))

    # Strategy B (stylised developer plans): buildings drawn as light grey / white
    # blocks on a green or beige ground. Low saturation + high brightness, with a
    # wide opening so paths, driveways and outlines fall away and only blocks remain.
    light = cv2.inRange(hsv, np.array([0, 0, 165]), np.array([180, 45, 255]))
    light = cv2.bitwise_and(light, not_gw)
    k = max(9, int(min(w, h) * 0.012))
    light = cv2.morphologyEx(light, cv2.MORPH_OPEN, np.ones((k, k), np.uint8))
    light = cv2.morphologyEx(light, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))

    # Primary panel: plans with two side-by-side panels (ground level + podium top)
    # are very wide; use the left panel for footprints.
    panel = [0.0, 0.0, 1.0, 1.0]
    if w / float(h) > 2.2:
        panel = [0.0, 0.0, 0.5, 1.0]
    px0, py0, px1, py1 = int(panel[0] * w), int(panel[1] * h), int(panel[2] * w), int(panel[3] * h)
    panel_mask = np.zeros((h, w), np.uint8)
    panel_mask[py0:py1, px0:px1] = 255

    built = cv2.bitwise_or(dark, light)
    built = cv2.bitwise_and(built, panel_mask)

    contours, _ = cv2.findContours(built, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    total = float((px1 - px0) * (py1 - py0))
    cands: list[dict[str, Any]] = []
    for c in contours:
        area = cv2.contourArea(c)
        frac = area / total
        if frac < 0.002 or frac > 0.12:
            continue
        x, y, bw, bh = cv2.boundingRect(c)
        # Drop long thin strips (roads, podium edges) and blobs hugging the panel border.
        aspect = max(bw, bh) / max(1, min(bw, bh))
        if aspect > 6:
            continue
        if x <= px0 + 2 or y <= py0 + 2 or x + bw >= px1 - 2 or y + bh >= py1 - 2:
            continue
        x, y, bw, bh = cv2.boundingRect(c)
        rect = cv2.minAreaRect(c)
        (cx, cy), (rw, rh), ang = rect
        approx = cv2.approxPolyDP(c, 0.01 * cv2.arcLength(c, True), True)
        poly = [[round(float(p[0][0]) / w, 4), round(float(p[0][1]) / h, 4)] for p in approx]
        fill = area / max(1.0, bw * bh)
        cands.append(
            {
                "bbox": [round(x / w, 4), round(y / h, 4), round((x + bw) / w, 4), round((y + bh) / h, 4)],
                "area_fraction": round(frac, 5),
                "rect_fill_ratio": round(fill, 3),
                "min_area_rect": {"center": [round(cx / w, 4), round(cy / h, 4)], "size": [round(rw / w, 4), round(rh / h, 4)], "angle_deg": round(float(ang), 1)},
                "polygon": poly,
            }
        )
    cands.sort(key=lambda d: -d["area_fraction"])
    cands = cands[:40]

    overlay = bgr.copy()
    for i, cd in enumerate(cands):
        x0, y0, x1, y1 = cd["bbox"]
        cv2.rectangle(overlay, (int(x0 * w), int(y0 * h)), (int(x1 * w), int(y1 * h)), (0, 0, 255), 2)
        cv2.putText(overlay, str(i + 1), (int(x0 * w) + 4, int(y0 * h) + 18), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 255), 2)
    out_dir.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(out_dir / f"{slug}_built_mask.png"), built)
    cv2.imwrite(str(out_dir / f"{slug}_candidates_overlay.png"), overlay)

    return {"image_size": [w, h], "candidates": cands, "built_fraction": round(float(cv2.countNonZero(built)) / total, 4)}


# ---------------------------------------------------------------------------
# Gemini: building layout extraction (same JSON-only pattern as the engine)
# ---------------------------------------------------------------------------
def claude_layout(project: dict[str, Any], plan_path: Path, legend_path: Path | None, opencv: dict[str, Any]) -> dict[str, Any]:
    """Same extraction via the Claude API (official `anthropic` SDK, vision input)."""
    import base64

    from anthropic import Anthropic

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise ValueError("ANTHROPIC_API_KEY missing (add it to .env.local)")
    client = Anthropic(api_key=api_key)
    model = os.environ.get("ANTHROPIC_VISION_MODEL", "claude-opus-5-5")

    def image_block(p: Path) -> dict[str, Any]:
        media = "image/png" if p.suffix.lower() == ".png" else "image/jpeg"
        return {"type": "image", "source": {"type": "base64", "media_type": media, "data": base64.b64encode(p.read_bytes()).decode("ascii")}}

    content: list[dict[str, Any]] = [image_block(plan_path)]
    if legend_path and legend_path.exists():
        content.append(image_block(legend_path))
    content.append({"type": "text", "text": build_layout_prompt(project, opencv)})

    # Adaptive thinking is the default on this model; effort high for careful reading.
    # Server-side fallback routes a safety decline to another model inside the same call.
    resp = client.beta.messages.create(
        model=model,
        max_tokens=16000,
        betas=["server-side-fallback-2026-07-01"],
        messages=[{"role": "user", "content": content}],
        extra_body={"fallbacks": "default", "output_config": {"effort": "high"}},
    )
    if getattr(resp, "stop_reason", None) == "refusal":
        raise ValueError(f"model declined the request: {getattr(resp, 'stop_details', None)}")
    text = "".join(getattr(b, "text", "") for b in resp.content if getattr(b, "type", "") == "text")
    payload = extract_json_from_text(text)
    payload["_model"] = getattr(resp, "model", model)
    return payload


def gemini_layout(project: dict[str, Any], plan_path: Path, legend_path: Path | None, opencv: dict[str, Any]) -> dict[str, Any]:
    from google import genai

    settings = get_settings()
    if not settings.gemini_api_key:
        raise ValueError("GEMINI_API_KEY missing in the engine .env")
    client = genai.Client(api_key=settings.gemini_api_key)
    prompt = build_layout_prompt(project, opencv)
    contents: list[Any] = [prompt, load_image_part_for_gemini(plan_path)]
    if legend_path and legend_path.exists():
        contents.append(load_image_part_for_gemini(legend_path))
    resp = client.models.generate_content(
        model=settings.gemini_vision_model,
        contents=contents,
        config={"temperature": 0.1, "response_mime_type": "application/json"},
    )
    payload = extract_json_from_text(resp.text or "{}")
    payload["_model"] = settings.gemini_vision_model
    return payload


def build_layout_prompt(project: dict[str, Any], opencv: dict[str, Any]) -> str:
    seed = {
        "project_name": project.get("name"),
        "developer": project.get("developer"),
        "locality": project.get("locality"),
        "declared_tower_count": project.get("towerCount"),
        "declared_floors": project.get("floors"),
        "declared_units": project.get("units"),
        "opencv_candidate_blocks": [c["bbox"] for c in opencv["candidates"][:12]],
    }
    prompt = f"""
You extract the BUILDING LAYOUT of a real-estate master plan image for 3D rendering.
Return only JSON. Never invent measurements that are not visible or declared.

The image may contain more than one panel (e.g. "Ground level master plan" and "Podium top master plan").
Identify the panels, pick the one that shows the building footprints best (primary), and report every
TOWER / residential building block in that panel. Coordinates are normalized to the WHOLE provided image:
[x0, y0, x1, y1] with 0,0 at the top-left and 1,1 at the bottom-right.

Also report: the north arrow direction (degrees clockwise from image-up; 0 = north is up),
which side of the primary panel the access road / frontage is on, whether towers sit on a shared podium,
visible floor counts or heights if written anywhere, and legend items.

Seed facts (may be null):
{json.dumps(seed, ensure_ascii=False)}

Return JSON schema:
{{
  "panels": [{{"panel_id": "p1", "title": "Ground level master plan", "bbox": [0.02, 0.1, 0.48, 0.9], "is_primary_for_towers": true}}],
  "north": {{"visible": true, "angle_deg_from_image_up": 0, "confidence": "High|Medium|Low"}},
  "road_frontage": {{"side": "north|south|east|west|unknown", "road_name": "name or null"}},
  "tower_count": 3,
  "towers": [{{"tower_id": "T1", "label": "west tower", "bbox": [0.1, 0.3, 0.2, 0.42], "shape": "rectangle|L|H|U|irregular", "long_axis_deg_from_image_up": 90, "floors": null, "height_m": null, "confidence": "High|Medium|Low"}}],
  "podium": {{"present": true, "levels": null, "covers_towers": true, "notes": "short note"}},
  "entries": [{{"label": "Entry/Exit", "side": "north"}}],
  "legend_items": [{{"code": "1", "label": "Entry/ Exit", "panel": "p1"}}],
  "scale": {{"visible": false, "notes": "no scale bar"}},
  "warnings": [],
  "notes": []
}}

Rules:
- Towers are the large building blocks, not amenities, pools or parking rows.
- Order towers from west to east (left to right in the primary panel) and name them by position.
- If floors or heights are not written on the plan, return null for them.
- Mention in warnings if the plan is stylized, not to scale, or if panels overlap.
"""
    return prompt


# ---------------------------------------------------------------------------
# Georeferencing: panel-relative image coordinates -> lng/lat inside the plot
# ---------------------------------------------------------------------------
def ring_bbox(ring: list[list[float]]) -> tuple[float, float, float, float]:
    xs = [p[0] for p in ring]
    ys = [p[1] for p in ring]
    return min(xs), min(ys), max(xs), max(ys)


def georeference_towers(project: dict[str, Any], layout: dict[str, Any]) -> list[dict[str, Any]]:
    ring = project.get("plot", {}).get("coordinates", [[]])[0]
    if not ring or len(ring) < 4:
        return []
    min_lng, min_lat, max_lng, max_lat = ring_bbox(ring)
    plot_w = max_lng - min_lng
    plot_h = max_lat - min_lat

    panels = layout.get("panels") or []
    primary = next((p for p in panels if p.get("is_primary_for_towers")), panels[0] if panels else None)
    pb = primary.get("bbox") if primary else [0, 0, 1, 1]
    if not pb or len(pb) != 4:
        pb = [0, 0, 1, 1]
    px0, py0, px1, py1 = pb
    pw = max(1e-6, px1 - px0)
    ph = max(1e-6, py1 - py0)

    north_deg = float((layout.get("north") or {}).get("angle_deg_from_image_up") or 0.0)
    theta = math.radians(north_deg)  # rotate image-up onto north

    def to_lnglat(u: float, v: float) -> list[float]:
        # panel-relative (u right, v down) -> centred, y up
        x = u - 0.5
        y = 0.5 - v
        # rotate so that image-up becomes north (clockwise angle -> rotate by -theta)
        xr = x * math.cos(theta) - y * math.sin(theta)
        yr = x * math.sin(theta) + y * math.cos(theta)
        return [round(min_lng + (xr + 0.5) * plot_w, 6), round(min_lat + (yr + 0.5) * plot_h, 6)]

    towers: list[dict[str, Any]] = []
    for i, t in enumerate(layout.get("towers") or []):
        bb = t.get("bbox")
        if not bb or len(bb) != 4:
            continue
        # tower bbox normalized to the whole image -> primary panel coordinates
        u0 = (bb[0] - px0) / pw
        v0 = (bb[1] - py0) / ph
        u1 = (bb[2] - px0) / pw
        v1 = (bb[3] - py0) / ph
        foot = [to_lnglat(u0, v0), to_lnglat(u1, v0), to_lnglat(u1, v1), to_lnglat(u0, v1)]
        foot.append(foot[0])
        long_axis = t.get("long_axis_deg_from_image_up")
        heading = None if long_axis is None else round((float(long_axis) + north_deg) % 360, 1)
        towers.append(
            {
                "name": t.get("label") or t.get("tower_id") or f"Tower {i + 1}",
                "floors": t.get("floors"),
                "heightM": t.get("height_m"),
                "footprint": [foot],
                "headingDeg": heading,
                "shape": t.get("shape"),
                "confidence": t.get("confidence"),
                "source": "masterplan_analysis",
                "note": "footprint georeferenced from the master plan onto the plot bbox; approximate",
            }
        )
    return towers


# ---------------------------------------------------------------------------
def main() -> None:
    ap = argparse.ArgumentParser(description="Analyze a project master plan into towers/footprints/podium/orientation.")
    ap.add_argument("folder", help="public/projects/<slug>")
    ap.add_argument("--no-gemini", action="store_true", help="OpenCV candidates only (no vision model)")
    ap.add_argument("--provider", choices=["auto", "claude", "gemini", "none"], default="auto", help="vision model provider (auto: Claude if ANTHROPIC_API_KEY, else Gemini, else none)")
    ap.add_argument("--overwrite", action="store_true", help="replace already-filled project.json fields")
    args = ap.parse_args()

    folder = Path(args.folder).resolve()
    pj = folder / "project.json"
    project = json.loads(pj.read_text())
    slug = project.get("slug") or folder.name
    image = folder / (project.get("masterPlan", {}).get("image") or "masterplan.jpg")
    if not image.exists():
        print(f"master plan image not found: {image}", file=sys.stderr)
        sys.exit(1)
    analysis_dir = folder / "analysis"
    analysis_dir.mkdir(parents=True, exist_ok=True)

    # Keep the engine's output inside this project folder.
    settings = get_settings()
    settings.data_output_overlays_dir = analysis_dir

    meta = preprocess_master_plan_image(str(image))
    artifacts = create_master_plan_preprocessing_artifacts(image_metadata=meta, project_id=slug, output_dir=analysis_dir)
    cleaned = Path(next(a.path for a in artifacts if a.artifact_type == "cleaned_master_plan_input"))
    legend = next((Path(a.path) for a in artifacts if a.artifact_type == "legend_region_crop"), None)

    opencv = candidate_footprints(cleaned, analysis_dir, slug)
    print(f"[opencv] {len(opencv['candidates'])} candidate blocks, built fraction {opencv['built_fraction']}")

    # Vision provider: Claude (ANTHROPIC_API_KEY in .env.local) first, then the engine's
    # Gemini key, else OpenCV only. --provider forces one; --no-gemini means none.
    provider = args.provider
    if args.no_gemini and provider == "auto":
        provider = "none"
    if provider == "auto":
        provider = "claude" if os.environ.get("ANTHROPIC_API_KEY") else ("gemini" if get_settings().gemini_api_key else "none")

    layout: dict[str, Any] = {}
    vision_error = None
    if provider in ("claude", "gemini"):
        try:
            layout = claude_layout(project, cleaned, legend, opencv) if provider == "claude" else gemini_layout(project, cleaned, legend, opencv)
            print(f"[{provider}] tower_count={layout.get('tower_count')} towers={len(layout.get('towers') or [])} north={(layout.get('north') or {}).get('angle_deg_from_image_up')} road={(layout.get('road_frontage') or {}).get('side')} model={layout.get('_model')}")
        except Exception as exc:  # noqa: BLE001
            vision_error = str(exc)
            print(f"[{provider}] failed: {exc}", file=sys.stderr)

    if not layout.get("towers"):
        # Fallback: treat the largest OpenCV blocks as towers (up to the declared count or 3).
        n = project.get("towerCount") or 3
        layout.setdefault("towers", [])
        for i, c in enumerate(opencv["candidates"][:n]):
            layout["towers"].append({"tower_id": f"T{i + 1}", "label": f"Block {i + 1} (OpenCV)", "bbox": c["bbox"], "shape": "rectangle", "long_axis_deg_from_image_up": 90 if c["min_area_rect"]["size"][0] >= c["min_area_rect"]["size"][1] else 0, "floors": None, "height_m": None, "confidence": "Low"})
        layout.setdefault("tower_count", len(layout["towers"]))
        layout.setdefault("warnings", []).append("towers derived from OpenCV blocks only")

    towers = georeference_towers(project, layout)

    result = {
        "slug": slug,
        "image": str(image.relative_to(folder)),
        "image_quality": meta.quality.model_dump(mode="json"),
        "artifacts": [a.model_dump(mode="json") for a in artifacts],
        "opencv": opencv,
        "layout": layout,
        "vision": {"provider": provider, "model": layout.get("_model"), "error": vision_error},
        "georeferenced_towers": towers,
        "plot_is_placeholder": bool(project.get("plot", {}).get("placeholder")),
    }
    (analysis_dir / "masterplan_analysis.json").write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n")

    # ---- write back into project.json (fill nulls; --overwrite replaces) ----
    def put(key: str, value: Any) -> None:
        if value is None:
            return
        if args.overwrite or project.get(key) in (None, [], {}):
            project[key] = value

    put("towerCount", layout.get("tower_count") or (len(towers) or None))
    existing = project.get("towers") or []
    placeholder_towers = all((t.get("footprint") is None and t.get("floors") is None) for t in existing)
    if towers and (args.overwrite or placeholder_towers):
        project["towers"] = towers
    podium = layout.get("podium") or {}
    if podium.get("present"):
        put("podiumLevels", podium.get("levels"))
    lay = project.get("layout") or {}
    north = (layout.get("north") or {}).get("angle_deg_from_image_up")
    if north is not None:
        lay["northDeg"] = north
    road = (layout.get("road_frontage") or {}).get("side")
    if road and road != "unknown":
        lay["roadSide"] = road
    lay["source"] = f"scripts/analyze_master_plan.py (Green Open Area Intelligence engine + {provider}:{layout.get('_model') or 'opencv'})"
    notes = [n for n in (layout.get("notes") or []) if isinstance(n, str)]
    podium_note = (layout.get("podium") or {}).get("notes")
    if podium_note:
        notes.append(str(podium_note))
    if notes and (args.overwrite or not lay.get("description")):
        lay["description"] = " ".join(notes)
    if layout.get("warnings"):
        lay["warnings"] = layout["warnings"]
    project["layout"] = lay
    mp = project.get("masterPlan") or {}
    mp["analysis"] = "analysis/masterplan_analysis.json"
    mp["attached"] = True
    project["masterPlan"] = mp
    pj.write_text(json.dumps(project, indent=2, ensure_ascii=False) + "\n")

    print(f"[done] towers={len(towers)} -> {pj}")
    for t in towers:
        print(f"   - {t['name']}: heading={t['headingDeg']} floors={t['floors']} conf={t.get('confidence')}")


if __name__ == "__main__":
    main()
