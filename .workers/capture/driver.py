#!/usr/bin/env python3
"""
Drives Supermemory API through the Hoverfly capture proxy.

Mirrors the request shapes that smfs's ApiClient sends so the captured
simulation is byte-compatible with what the Rust client will replay against
in a deterministic VM.
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path
from typing import Any

import requests

API = "https://api.supermemory.ai"
KEY = os.environ["SM_API_KEY"]
TAG = os.environ.get("SM_CONTAINER_TAG", "smfs_test_workload_v1")

PROXY = {"http": "http://localhost:8500", "https": "http://localhost:8500"}
CA = "/tmp/smfs-capture/cert.pem"

H = {
    "Authorization": f"Bearer {KEY}",
    "Content-Type": "application/json",
}


def _send(method: str, path: str, *, json_body: Any = None, **kw) -> requests.Response:
    url = f"{API}{path}"
    r = requests.request(
        method,
        url,
        headers=H if "headers" not in kw else {**H, **kw.pop("headers")},
        json=json_body,
        proxies=PROXY,
        verify=CA,
        timeout=30,
        **kw,
    )
    print(f"  -> {method} {path} :: {r.status_code}", file=sys.stderr)
    return r


def session() -> dict:
    r = _send("GET", "/v3/session")
    r.raise_for_status()
    return r.json()


def profile() -> dict:
    r = _send("POST", "/v4/profile", json_body={"containerTag": TAG})
    r.raise_for_status()
    return r.json()


def update_memory_paths(paths: list[str]) -> None:
    r = _send(
        "PATCH",
        f"/v3/container-tags/{TAG}",
        json_body={"memoryFilesystemPaths": paths},
    )
    r.raise_for_status()


def list_docs(filepath: str | None = None, page: int = 1, limit: int = 100) -> dict:
    body: dict = {
        "containerTags": [TAG],
        "limit": limit,
        "page": page,
        "includeContent": True,
    }
    if filepath is not None:
        body["filepath"] = filepath
    r = _send("POST", "/v3/documents/list", json_body=body)
    r.raise_for_status()
    return r.json()


def create_doc(filepath: str, content: str, *, with_user_stamp: str | None = None) -> dict:
    metadata: dict = {"source": "supermemoryfs"}
    if with_user_stamp:
        metadata["lastEditedBy"] = with_user_stamp
    body = {
        "content": content,
        "filepath": filepath,
        "containerTag": TAG,
        "metadata": metadata,
    }
    r = _send("POST", "/v3/documents", json_body=body)
    r.raise_for_status()
    return r.json()


def get_doc(doc_id: str) -> dict:
    r = _send("GET", f"/v3/documents/{doc_id}")
    r.raise_for_status()
    return r.json()


def get_processing() -> dict:
    r = _send("GET", f"/v3/documents/processing?containerTag={TAG}")
    r.raise_for_status()
    return r.json()


def update_doc(
    doc_id: str,
    *,
    content: str | None = None,
    filepath: str | None = None,
    user_stamp: str | None = None,
) -> None:
    metadata: dict = {"source": "supermemoryfs"}
    if user_stamp:
        metadata["lastEditedBy"] = user_stamp
    body: dict = {"metadata": metadata}
    if content is not None:
        body["content"] = content
    if filepath is not None:
        body["filepath"] = filepath
    r = _send("PATCH", f"/v3/documents/{doc_id}", json_body=body)
    r.raise_for_status()


def delete_by_filepath(filepath: str) -> dict:
    r = _send(
        "DELETE",
        "/v3/documents/bulk",
        json_body={"containerTags": [TAG], "filepath": filepath},
    )
    r.raise_for_status()
    return r.json()


def delete_by_ids(ids: list[str]) -> dict:
    r = _send(
        "DELETE",
        "/v3/documents/bulk",
        json_body={"ids": ids, "containerTags": [TAG]},
    )
    r.raise_for_status()
    return r.json()


def search(q: str, filepath: str | None = None) -> dict:
    body: dict = {
        "q": q,
        "containerTag": TAG,
        "searchMode": "hybrid",
        "include": {"documents": True},
    }
    if filepath is not None:
        body["filepath"] = filepath
    r = _send("POST", "/v4/search", json_body=body)
    r.raise_for_status()
    return r.json()


def upload_multipart(filepath: str, mime: str, filename: str, content: bytes, user_stamp: str | None) -> dict:
    metadata: dict = {"source": "supermemoryfs"}
    if user_stamp:
        metadata["lastEditedBy"] = user_stamp
    files = {"file": (filename, content, mime)}
    data = {
        "containerTag": TAG,
        "filepath": filepath,
        "metadata": json.dumps(metadata),
    }
    headers = {"Authorization": f"Bearer {KEY}"}
    r = requests.post(
        f"{API}/v3/documents/file",
        headers=headers,
        data=data,
        files=files,
        proxies=PROXY,
        verify=CA,
        timeout=30,
    )
    print(f"  -> POST /v3/documents/file :: {r.status_code}", file=sys.stderr)
    r.raise_for_status()
    return r.json()


# -------- Realistic content fixtures --------

NOTES = {
    "/notes/oauth.md": (
        "# OAuth refresh token rotation\n\n"
        "Refresh tokens are rotated on every use. The server issues a new "
        "refresh token alongside each new access token and revokes the old one.\n"
    ),
    "/notes/design-review-2026q1.md": (
        "# Design review notes — 2026 Q1\n\n"
        "- Replication lag budget: 250ms p99\n"
        "- Failover drill cadence: weekly\n"
    ),
    "/notes/postgres-tuning.md": (
        "# Postgres tuning crib\n\n"
        "shared_buffers = 25% of RAM. effective_cache_size ~ 75%. random_page_cost=1.1 on SSD.\n"
    ),
    "/notes/standup-2026-05-09.md": (
        "Standup 2026-05-09: shipped capture pipeline, blocked on simulation export, plan to "
        "merge fault model PR by EOW.\n"
    ),
    "/journal/2026-05-09.md": (
        "Journal — Friday. Long day on capture proxies. mTLS still annoying. "
        "Snowball lights tonight if we land.\n"
    ),
    "/journal/2026-05-10.md": (
        "Journal — Saturday. Got hoverfly capturing. Wrote driver. "
        "Want to sleep at a sane hour.\n"
    ),
    "/work/sprint-plan.md": (
        "# Sprint plan\n\n"
        "1. Mocks captured for smfs deterministic VM\n"
        "2. Workload variants for additions, deletions, mixed\n"
        "3. Fault models: latency, loss, partition\n"
    ),
    "/work/incidents/2026-05-04-cache-stampede.md": (
        "Incident: cache stampede on cold start. Mitigation: jittered refresh window.\n"
    ),
    "/work/incidents/2026-05-07-fuse-deadlock.md": (
        "Incident: FUSE deadlock when push queue back-pressured the writer thread. Fix: bounded channel + drop-oldest.\n"
    ),
    "/scratch/todo.md": (
        "TODO: rebuild qemu cache marker, double-check pin SHA, validate external mocks json.\n"
    ),
}

# Scenarios applied later
RENAME_SRC = "/scratch/todo.md"
RENAME_DST = "/work/todo.md"
EDIT_TARGET = "/notes/oauth.md"
EDIT_NEW_CONTENT = (
    "# OAuth refresh token rotation\n\n"
    "Refresh tokens are rotated on every use. The server issues a new "
    "refresh token alongside each new access token and revokes the old one. "
    "If the old token is presented after rotation, the entire token family is revoked.\n"
)

BINARY_FILEPATH = "/work/diagrams/network.png"
BINARY_BYTES = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64  # tiny synthetic PNG header
BINARY_MIME = "image/png"
BINARY_FILENAME = "network.png"


def main() -> int:
    print(f"=== driver against tag={TAG} ===", file=sys.stderr)

    # --- 0. preflight ---
    sess = session()
    user_id = sess["user"]["id"]
    print(f"  user_id = {user_id}", file=sys.stderr)

    profile()

    # --- 1. cold-start list (may be empty if fresh tag, may be populated otherwise) ---
    list_docs()
    list_docs(page=2)  # captures pagination shape too

    # --- 2. processing-doc poll (used by inflight poller after creates) ---
    get_processing()

    # --- 3. write all the seed files (heavy additions) ---
    created: dict[str, str] = {}  # filepath -> id
    for path, content in NOTES.items():
        resp = create_doc(path, content, with_user_stamp=user_id)
        created[path] = resp["id"]

    # PATCH container-tag now that the tag exists (post-create path)
    try:
        update_memory_paths(["/notes/", "/journal/", "/work/"])
    except requests.HTTPError as e:
        print(f"  (ignoring memory-paths PATCH error: {e})", file=sys.stderr)

    # binary upload exercises multipart path
    bin_resp = upload_multipart(BINARY_FILEPATH, BINARY_MIME, BINARY_FILENAME, BINARY_BYTES, user_id)
    created[BINARY_FILEPATH] = bin_resp["id"]

    # --- 4. settle: poll processing then list ---
    get_processing()
    list_docs()

    # filtered list (sync engine often filters by prefix)
    list_docs(filepath="/notes/")
    list_docs(filepath="/work/")

    # --- 5. fetch a couple of docs by id (cache rehydrate path) ---
    get_doc(created["/notes/oauth.md"])
    get_doc(created["/journal/2026-05-09.md"])

    # --- 6. searches (semantic grep) ---
    search("OAuth refresh tokens")
    search("postgres tuning shared_buffers")
    search("incident cache stampede")
    search("design review notes", filepath="/notes/")

    # --- 7. updates (edit + rename) ---
    update_doc(created[EDIT_TARGET], content=EDIT_NEW_CONTENT, user_stamp=user_id)
    update_doc(created[RENAME_SRC], filepath=RENAME_DST, user_stamp=user_id)

    # --- 8. list again to capture post-mutation state ---
    list_docs()

    # --- 9. deletions ---
    # 9a. delete by filepath prefix (drops journal/)
    delete_by_filepath("/journal/")

    # 9b. delete by ids (drop incidents)
    incident_ids = [
        created["/work/incidents/2026-05-04-cache-stampede.md"],
        created["/work/incidents/2026-05-07-fuse-deadlock.md"],
    ]
    delete_by_ids(incident_ids)

    # 9c. delete one specific file by exact path
    delete_by_filepath("/notes/standup-2026-05-09.md")

    # --- 10. terminal list (post-cleanup) ---
    list_docs()

    print("=== driver done ===", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
