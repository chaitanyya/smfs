# `.workers/` — deterministic-VM artifacts for smfs

Everything wenv's hosted-agent path needs to run the **actual smfs Rust
binary** against a captured Supermemory API simulation inside a
deterministic QEMU VM.

```
.workers/
├── README.md
├── workload.sh              # what wenv executes — installs CA, restarts hoverfly, runs smfs
├── build.sh                 # cross-compiles smfs for the alpine guest (linux x86_64 musl)
├── external-mocks.json      # Hoverfly v5.2 simulation, 30 pairs, scheme=https
├── hoverfly/                # pinned MITM CA so the guest trusts hoverfly
│   ├── cert.pem             # public CA cert; installed into /etc/ssl/certs in the guest
│   └── key.pem              # private key; needed by hoverfly to sign per-host certs
├── fault/net/               # ten netem fault models for `wenv explore` sweeps
│   ├── w1_baseline_jitter.json
│   ├── w2_high_latency_api.json
│   ├── w3_intermittent_loss.json
│   ├── w4_full_partition.json
│   ├── w5_bursty_loss.json
│   ├── w6_corrupt_pkts.json
│   ├── w7_bandwidth_pinch.json
│   ├── w8_reorder_storm.json
│   ├── w9_brownout.json
│   └── w10_mobile_3g.json
└── capture/                 # how external-mocks.json was generated
    ├── driver.py            # drives the real Supermemory API through hoverfly capture
    └── sanitize.py          # zstd-decode + header-strip + multipart-glob + url-redact + v5.2
```

## Why a vendored CA + a workspace patch?

`reqwest` defaults to `rustls-tls`, which only trusts the hardcoded
webpki-roots — **no way to inject a custom CA from the OS trust store**.
Running the smfs binary against an in-VM hoverfly that MITM's its own
self-signed CA would always fail TLS verification.

Two changes make it work:

1. **`Cargo.toml`** — switched the workspace `reqwest` feature from
   `rustls-tls` to `rustls-tls-native-roots`. Reqwest now reads the
   guest's `/etc/ssl/certs` (via `rustls-native-certs`), so any CA we
   install at runtime is honored.

2. **`.workers/hoverfly/`** — a pinned CA shipped with the repo.
   `workload.sh` installs `cert.pem` into
   `/usr/local/share/ca-certificates/wenv-smfs-mock.crt` and runs
   `update-ca-certificates`. It then kills the ephemeral hoverfly that
   wenv auto-started and replaces it with one that uses **this** CA, so
   smfs's TLS handshake to api.supermemory.ai (proxied to hoverfly)
   succeeds.

> The CA is self-signed and only used for in-VM MITM. Outside the wenv
> guest nobody trusts it, so committing it (key included) doesn't expose
> any real-world traffic. Regenerate with
> `(cd .workers/hoverfly && hoverfly -generate-ca-cert)`.

## Verified end-to-end

Local smoke against hoverfly v1.12.7 + the patched smfs binary:

```sh
# all 6 commands returned the captured responses
$ smfs login   --api-url https://api.supermemory.ai --key sm_replay_test_key
Validating API key... ok (org: Chaitanya's Organization)
Credentials saved.

$ smfs whoami
user:  Chaitanya Choudhary <chai@workers.io>
org:   Chaitanya's Organization
…

$ smfs grep "OAuth refresh tokens" --tag smfs_test_workload_v1
# supermemory semantic search — 1 results …
/notes/oauth.md:# OAuth refresh token rotation …
```

Plus three previous Python-driven replays of the full 30-pair surface
were bit-identical (sha256 `a599f47…`).

## Coverage of the captured simulation

`external-mocks.json` covers every endpoint smfs's `ApiClient`
([`crates/smfs-core/src/api/mod.rs`](../crates/smfs-core/src/api/mod.rs))
sends:

| Endpoint                                  | Pairs | Reachable from `workload.sh` today? |
| ----------------------------------------- | ----- | ----------------------------------- |
| `GET  /v3/session`                        | 1     | ✅ `smfs login`, `smfs whoami`      |
| `POST /v4/search`                         | 4     | ✅ `smfs grep` (×4 query variants)  |
| `POST /v4/profile`                        | 1     | ⏳ daemon-only (mount path)         |
| `POST /v3/documents/list`                 | 4     | ⏳ daemon                           |
| `GET  /v3/documents/processing`           | 1     | ⏳ daemon                           |
| `POST /v3/documents`                      | 10    | ⏳ daemon (per-file create)         |
| `POST /v3/documents/file`                 | 1     | ⏳ daemon (multipart)               |
| `PATCH /v3/container-tags/<tag>`          | 1     | ⏳ daemon                           |
| `GET  /v3/documents/<id>`                 | 2     | ⏳ daemon (rehydrate)               |
| `PATCH /v3/documents/<id>`                | 2     | ⏳ daemon (edit + rename)           |
| `DELETE /v3/documents/bulk`               | 3     | ⏳ daemon (3 deletion patterns)     |
| **Total pairs**                           | **30** | **5 endpoints reachable today**    |

`workload.sh` exercises the smfs binary via the no-mount commands
(`login`, `whoami`, `grep`). The mount-driven endpoints (the other 25
pairs) need either a FUSE/NFS-enabled guest plus root, or a separate
daemon-driven runner. The simulation already covers them — just point a
mount-equipped runner at it.

## Running on wenv

```sh
# 1. Pre-build the smfs binary for the alpine guest
.workers/build.sh
# -> .workers/bin/smfs (statically linked, x86_64-unknown-linux-musl)

# 2. Boot the deterministic VM
wenv create \
    --command 'bash /projects/smfs/.workers/workload.sh' \
    --project-image <smfs.squashfs> --project-dir smfs \
    --external-mocks /projects/smfs/.workers/external-mocks.json \
    --netem          /projects/smfs/.workers/fault/net/w2_high_latency_api.json \
    --seed 0xbeef --timeout 180s --follow
```

`workload.sh`:

1. Locates the smfs binary (`.workers/bin/smfs` first, then build
   artifacts, then `cargo build --release` if cargo is on PATH).
2. Stops the ephemeral hoverfly wenv started (kill `$WENV_HOVERFLY_PID`,
   wait for the proxy port to free).
3. Installs `.workers/hoverfly/cert.pem` into the guest trust store
   (`/usr/local/share/ca-certificates/`, then `update-ca-certificates`).
   Sets `SSL_CERT_FILE` for redundancy.
4. Restarts hoverfly with `-cert .workers/hoverfly/cert.pem -key
   .workers/hoverfly/key.pem -import .workers/external-mocks.json`,
   waits for the proxy port to open.
5. Re-exports `http_proxy`/`https_proxy`, points `$HOME` at `/tmp` so
   smfs's credential writes go to a writable path, then runs `smfs
   login` → `whoami` → 4 `grep` variants.

## Sweep

```sh
# All 10 fault models, fixed seed
for f in .workers/fault/net/*.json; do
  wenv create --seed 0xbeef --command 'bash /projects/smfs/.workers/workload.sh' \
      --external-mocks .workers/external-mocks.json --netem "$f" \
      --project-image <smfs.squashfs> --project-dir smfs \
      --timeout 180s --json | jq -r '"\(.id)  \(.exit_code)  \(.fault)"'
done

# Or via the built-in explorer
wenv explore --workload .workers/workload.sh \
    --external-mocks .workers/external-mocks.json \
    --netem-dir      .workers/fault/net
```

## Re-capturing against the live API

```sh
cd .workers/capture

nohup hoverfly -capture \
    -cert ../hoverfly/cert.pem -key ../hoverfly/key.pem \
    -ap 8888 -pp 8500 > /tmp/hoverfly.log 2>&1 &

SM_API_KEY="sm_..." SM_CONTAINER_TAG=smfs_test_workload_v1 python3 driver.py
curl -sS http://localhost:8888/api/v2/simulation > /tmp/sim-raw.json
python3 sanitize.py /tmp/sim-raw.json ../external-mocks.json

wenv external-mocks validate ../external-mocks.json   # ok: 30 pair(s)
```

The sanitizer:

- Decompresses zstd response bodies (Cloudflare returned `Content-Encoding: zstd`).
- Strips volatile/CDN headers (`Date`, `Cf-*`, `Hoverfly`, `Server`, …).
- Pins `schemaVersion: v5.2` (raw capture is v5.3; mock runtime expects v5.2).
- Relaxes the multipart body matcher to
  `glob *Content-Disposition: form-data*` (random boundary).
- Redacts `url` fields whose host is `r2.cloudflarestorage.com` /
  `files.supermemory.ai` to null — these would trigger
  `crates/smfs-core/src/sync/pull.rs:rehydrate_if_possible` to try a
  direct GET against an unmocked host.
- Stable-sorts pairs and serializes `sort_keys=True` for byte-identical output.

## Fault models

Each file in `fault/net/` is a `wenv` netem v1 spec applied on `lo`,
matched against TCP traffic to the mock runtime port (`127.0.0.1:8500`,
`bidirectional: true` so both directions are shaped).

| File                          | What it models                             |
| ----------------------------- | ------------------------------------------ |
| `w1_baseline_jitter.json`     | 5 ms ±2 ms loopback jitter                 |
| `w2_high_latency_api.json`    | 250 ms ±50 ms latency                      |
| `w3_intermittent_loss.json`   | 5 % random loss, ρ=0.1                     |
| `w4_full_partition.json`      | 100 % loss                                 |
| `w5_bursty_loss.json`         | Gilbert–Elliott bursty loss                |
| `w6_corrupt_pkts.json`        | 1 % bit corruption                         |
| `w7_bandwidth_pinch.json`     | 64 kbps + 80 ms latency                    |
| `w8_reorder_storm.json`       | 25 % reorder, gap 5                        |
| `w9_brownout.json`            | 800 ms latency, 30 % loss, Pareto          |
| `w10_mobile_3g.json`          | 120 ms ±30 ms, 0.5 % loss, 384 kbps        |

All ten validate via `wenv netem validate`.

## Limitations / next steps

1. **Mount-path endpoints aren't reachable from `workload.sh`.** The
   `smfs mount` flow needs FUSE (or NFS) in the alpine guest plus the
   ability to background a daemon process across the wenv stdout
   contract. The simulation already covers all 30 pairs — wire mount up
   and the only knob to flip is which workload command runs.
2. **Only happy-path responses captured.** A second capture pass against
   401/404/409/429/5xx would let the fault models exercise the retry
   ladder in `RetryableRequest::send_with_retry`.
3. **`build.sh` assumes you have `rustup` and a musl cross-compiler.**
   On macOS that's `brew install FiloSottile/musl-cross/musl-cross`. On
   Linux, `apt install musl-tools` (or your distro's equivalent). If
   neither is available, `workload.sh` will `cargo build --release` at
   workload time provided cargo is on the guest PATH — but the alpine
   image wenv ships does not include rust by default.
