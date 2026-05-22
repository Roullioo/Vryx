# RustSec Audit Status

Last reviewed: 2026-05-22

The `Investor CI` dependency scan is blocking and runs `cargo audit` without advisory ignores.

Previous transitive exceptions through `libp2p 0.53.2` have been removed:

- `ring 0.16.20` is no longer present in `Cargo.lock`.
- `rustls-webpki 0.101.7` is no longer present in `Cargo.lock`.
- `hickory-proto 0.24.4` is no longer present in `Cargo.lock`.

Current status:

- `libp2p` is pinned to an upstream commit that contains the patched 0.57 stack.
- DNS/mDNS discovery is not used by the daemon; Vryx production nodes use explicit IP multiaddrs.
- `cargo audit` exits successfully with no vulnerability errors. It may still print allowed non-blocking maintenance warnings from transitive crates.

Risk owner: Vryx engineering.

Reintroduction rule:

- Any future RustSec advisory ignore must be documented here with owner, mitigation, and removal condition before it can be added to CI.
