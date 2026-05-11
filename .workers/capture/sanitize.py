#!/usr/bin/env python3
"""Sanitize Hoverfly v5.x capture into a v5.2 simulation that the wenv
external-mocks runtime can replay deterministically.

Steps:
  - Decompress zstd-encoded response bodies, drop Content-Encoding.
  - Drop volatile / CDN / Hoverfly response headers.
  - Relax multipart request body matcher (random boundary -> glob).
  - Rewrite scheme matcher https -> http (the alpine guest doesn't trust
    hoverfly's CA, so workload curls proxy plaintext through HTTP_PROXY).
  - Redact presigned R2 URLs in document responses so smfs's rehydrate
    path can't try to GET unmocked external hosts.
  - Force schemaVersion to v5.2; sort pairs for byte-stable output.
"""
from __future__ import annotations

import base64
import json
import sys
from pathlib import Path

try:
    import zstandard as zstd
except ImportError:
    zstd = None

VOLATILE_RESP_HEADERS = {
    "Alt-Svc",
    "Cf-Placement",
    "Cf-Ray",
    "Connection",
    "Date",
    "Hoverfly",
    "Nel",
    "Report-To",
    "Server",
    "Speculation-Rules",
    "Vary",
    "Strict-Transport-Security",
    "Cf-Cache-Status",
    "Set-Cookie",
}

# Keep the captured scheme as-is. The .workers/hoverfly/ CA is shipped
# separately and installed into the in-guest trust store before smfs runs,
# so the rustls client can verify hoverfly's MITM certs.
FORCE_SCHEME = None

# Hostnames embedded in `url` fields of document responses. smfs's sync
# engine fetches these directly to rehydrate stub binary inodes; redact to
# keep the simulation hermetic.
REDACT_URL_HOSTS = (
    "r2.cloudflarestorage.com",
    "files.supermemory.ai",
)


def decode_body(pair_idx: int, resp: dict) -> None:
    """If body is base64+zstd, decode in place and drop Content-Encoding."""
    if not resp.get("encodedBody"):
        return
    headers = resp.setdefault("headers", {})
    enc = [v.lower() for v in headers.get("Content-Encoding", [])]
    if "zstd" in enc:
        if zstd is None:
            print(f"[warn] pair {pair_idx}: zstd body but `pip install zstandard` not installed; leaving as-is", file=sys.stderr)
            return
        raw = base64.b64decode(resp["body"])
        dctx = zstd.ZstdDecompressor()
        try:
            # streaming variant tolerates frames without size in the header
            decoded = b"".join(dctx.read_to_iter(__import__("io").BytesIO(raw)))
        except zstd.ZstdError as e:
            print(f"[warn] pair {pair_idx}: zstd decompress failed ({e}); leaving as-is", file=sys.stderr)
            return
        resp["body"] = decoded.decode("utf-8")
        resp["encodedBody"] = False
        del headers["Content-Encoding"]
    elif "gzip" in enc or "br" in enc or "deflate" in enc:
        print(f"[warn] pair {pair_idx}: unsupported encoding {enc}; leaving encoded", file=sys.stderr)


def strip_resp_headers(resp: dict) -> None:
    headers = resp.get("headers") or {}
    resp["headers"] = {k: v for k, v in headers.items() if k not in VOLATILE_RESP_HEADERS}


def force_scheme(req: dict) -> None:
    if FORCE_SCHEME is None:
        return
    if "scheme" in req:
        for entry in req["scheme"]:
            entry["value"] = FORCE_SCHEME


def redact_urls_in_response(resp: dict) -> None:
    """Walk the JSON response body and null out any `url` field that points
    to a host smfs would try to fetch directly."""
    if resp.get("encodedBody"):
        return
    body_str = resp.get("body") or ""
    if not body_str.strip().startswith(("{", "[")):
        return
    try:
        body = json.loads(body_str)
    except json.JSONDecodeError:
        return
    if _redact_walk(body):
        resp["body"] = json.dumps(body, separators=(",", ":"), ensure_ascii=False)


def _redact_walk(node) -> bool:
    """Returns True if any redaction was made in `node` (in place)."""
    changed = False
    if isinstance(node, dict):
        url = node.get("url")
        if isinstance(url, str) and any(h in url for h in REDACT_URL_HOSTS):
            node["url"] = None
            changed = True
        for v in node.values():
            if _redact_walk(v):
                changed = True
    elif isinstance(node, list):
        for v in node:
            if _redact_walk(v):
                changed = True
    return changed


def relax_multipart(req: dict) -> None:
    """reqwest generates a random multipart boundary. Match by path + method
    only — drop the brittle exact body matcher."""
    body = req.get("body") or []
    if not body:
        return
    val = body[0].get("value", "")
    if val.startswith("--") and "Content-Disposition: form-data" in val:
        # keep a permissive glob so the matcher still discriminates by
        # the form fields, not the boundary
        req["body"] = [{"matcher": "glob", "value": "*Content-Disposition: form-data*"}]


def main() -> int:
    src = Path(sys.argv[1])
    dst = Path(sys.argv[2])
    sim = json.loads(src.read_text())

    pairs = sim["data"]["pairs"]
    print(f"[info] {len(pairs)} captured pairs", file=sys.stderr)

    for i, p in enumerate(pairs):
        decode_body(i, p["response"])
        strip_resp_headers(p["response"])
        relax_multipart(p["request"])
        force_scheme(p["request"])
        redact_urls_in_response(p["response"])
        # ensure templated key exists with explicit false
        p["response"].setdefault("templated", False)
        p["response"].setdefault("encodedBody", False)

    # schemaVersion -> v5.2 (what wenv's external-mocks runtime parses)
    sim.setdefault("meta", {})["schemaVersion"] = "v5.2"
    sim["meta"].setdefault("hoverflyVersion", "v1.12.7")

    # stable sort: method, path, body matcher value
    def sort_key(p):
        r = p["request"]
        return (
            r["method"][0]["value"],
            r["path"][0]["value"],
            r.get("body", [{"value": ""}])[0].get("value", ""),
        )

    pairs.sort(key=sort_key)

    # byte-stable serialization
    dst.write_text(json.dumps(sim, indent=2, sort_keys=True, ensure_ascii=False) + "\n")
    print(f"[info] wrote {dst} ({dst.stat().st_size} bytes)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
