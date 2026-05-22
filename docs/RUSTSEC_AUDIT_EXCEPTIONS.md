# RustSec Audit Exceptions

Last reviewed: 2026-05-22

The `Investor CI` dependency scan remains blocking for new RustSec advisories. The workflow currently ignores the following known transitive advisories because they are pulled through `libp2p 0.53.2` and require a coordinated `libp2p` upgrade rather than a small direct dependency bump:

- `RUSTSEC-2025-0009` - `ring 0.16.20`, via `rcgen` / `libp2p-tls` / `libp2p-quic`.
- `RUSTSEC-2026-0098` - `rustls-webpki 0.101.7`, via `libp2p-tls`.
- `RUSTSEC-2026-0099` - `rustls-webpki 0.101.7`, via `libp2p-tls`.
- `RUSTSEC-2026-0104` - `rustls-webpki 0.101.7`, via `libp2p-tls`.
- `RUSTSEC-2026-0119` - `hickory-proto 0.24.4`, via `libp2p-dns` / `libp2p-mdns`.

Risk owner: Vryx engineering.

Mitigation until upgrade:

- Keep worker and daemon secrets mandatory in production.
- Keep public network data redacted and avoid exposing peer/IP internals.
- Prefer the authenticated HTTPS API path for customer traffic; P2P daemon exposure is limited to worker transport.
- Keep these advisories visible in CI logs so they are not forgotten.

Removal condition:

- Upgrade `libp2p` and its TLS/DNS stack so `ring`, `rustls-webpki`, and `hickory-proto` resolve to patched versions, then remove the `cargo audit --ignore` entries from `.github/workflows/investor-ci.yml`.
