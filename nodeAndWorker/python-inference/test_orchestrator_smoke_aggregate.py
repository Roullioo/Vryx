#!/usr/bin/env python3
"""
Smoke / régression sans serveur :
  • motifs attendus dans distributed_llm_orchestrator.py (boucle while, micro-batch) ;
  • logique agrégée identique à « pick_accepted_emitted » (copie alignée avec l’orchestrateur).

Lancer depuis ce répertoire :
  python3 test_orchestrator_smoke_aggregate.py

CI / qualité locale :
  PYTHONPATH=. python3 -m unittest test_orchestrator_smoke_aggregate -v   # équivalent unittest
"""

from __future__ import annotations

import pathlib
import unittest


def pick_accepted_ids(
    response: dict,
    *,
    speculative_heads_is_off: bool,
) -> list[int]:
    """Règles synchronisées sur distributed_llm_orchestrator (run_pipeline_chat)."""
    accepted_ids: list[int] = []
    cand = response.get("candidate_token_ids")
    ac_raw = response.get("accepted_token_count")
    dmicro = response.get("decode_microbatch") is True
    if isinstance(cand, list) and len(cand) > 0:
        try:
            ac = int(ac_raw) if isinstance(ac_raw, (int, float)) else len(cand)
        except (TypeError, ValueError, OverflowError):
            ac = len(cand)
        ac = max(0, min(ac, len(cand)))
        if dmicro or ac >= 2:
            accepted_ids = [int(x) for x in cand[:ac] if isinstance(x, (int, float))]
        elif not speculative_heads_is_off and ac > 0:
            accepted_ids = [int(x) for x in cand[:ac] if isinstance(x, (int, float))]
    return accepted_ids


def emitted_ids_from_response(response: dict, *, speculative_heads_is_off: bool) -> list[int]:
    accepted = pick_accepted_ids(response, speculative_heads_is_off=speculative_heads_is_off)
    next_token_id = response.get("next_token_id")
    if not accepted:
        if next_token_id is None:
            raise ValueError("missing next_token_id")
        return [int(next_token_id)]
    return accepted[:]


def apply_emitted_trim(
    generated_ids: list[int],
    emitted_ids: list[int],
    *,
    stop_ids: set[int],
    eos_id: int | None,
    decode_cap: int,
) -> tuple[list[int], str | None, bool]:
    """Applique stop / eos / borne decode_cap comme la boucle while de l’orchestrateur."""
    stop_idx = next((idx for idx, token_id in enumerate(emitted_ids) if token_id in stop_ids), None)
    if stop_idx is not None:
        generated_ids.extend(emitted_ids[:stop_idx])
        return generated_ids, f"stop_token:{emitted_ids[stop_idx]}", True

    eos_pos = None
    if eos_id is not None:
        eos_pos = next((idx for idx, token_id in enumerate(emitted_ids) if token_id == eos_id), None)
    if eos_pos is not None:
        generated_ids.extend(emitted_ids[: eos_pos + 1])
        return generated_ids, f"eos:{eos_id}", True

    generated_ids.extend(emitted_ids)
    if len(generated_ids) >= decode_cap:
        generated_ids = generated_ids[:decode_cap]
        return generated_ids, None, True
    return generated_ids, None, False


class OrchestratorPatternTests(unittest.TestCase):
    def test_source_patterns(self) -> None:
        here = pathlib.Path(__file__).resolve().parent / "distributed_llm_orchestrator.py"
        t = here.read_text(encoding="utf-8")
        needles = (
            "while len(generated_ids) < decode_cap:",
            '"micro_decode_budget"',
            "_relay_try_http_keepalive",
            'decode_microbatch") is True',
            "relay_iteration_guard",
        )
        for n in needles:
            with self.subTest(fragment=n):
                self.assertIn(n, t, f"motif manquant dans {here.name}")

    def test_microbatch_acceptance(self) -> None:
        r = {"candidate_token_ids": [10, 20, 30], "accepted_token_count": 3, "decode_microbatch": True}
        self.assertEqual(emitted_ids_from_response(r, speculative_heads_is_off=True), [10, 20, 30])

    def test_spec_single_token_when_heads_offIgnored(self) -> None:
        r = {"candidate_token_ids": [7], "accepted_token_count": 1, "decode_microbatch": False, "next_token_id": 99}
        self.assertEqual(emitted_ids_from_response(r, speculative_heads_is_off=True), [99])

    def test_spec_single_token_when_heads_on(self) -> None:
        r = {"candidate_token_ids": [7], "accepted_token_count": 1, "decode_microbatch": False, "next_token_id": 99}
        self.assertEqual(emitted_ids_from_response(r, speculative_heads_is_off=False), [7])

    def test_eos_truncates_microbatch_tail(self) -> None:
        g: list[int] = [1, 2]
        out, reason, done = apply_emitted_trim(
            g, [50, -1, 60], stop_ids=set(), eos_id=-1, decode_cap=100
        )
        self.assertEqual(out, [1, 2, 50, -1])
        self.assertEqual(reason, "eos:-1")
        self.assertTrue(done)

    def test_decode_cap_truncate(self) -> None:
        g: list[int] = []
        out, _, done = apply_emitted_trim(
            g, [1, 2, 3, 4], stop_ids=set(), eos_id=None, decode_cap=3
        )
        self.assertEqual(out, [1, 2, 3])
        self.assertTrue(done)


class ImportSmoke(unittest.TestCase):
    def test_module_import(self) -> None:
        import os

        os.environ.setdefault("VRYX_P2P_RELAY_URL", "http://127.0.0.1:3031")
        import distributed_llm_orchestrator as m

        self.assertIsNotNone(getattr(m, "DECODE_MICROBATCH", None))


if __name__ == "__main__":
    unittest.main()
