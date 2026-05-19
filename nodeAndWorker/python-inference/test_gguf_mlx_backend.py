#!/usr/bin/env python3
from __future__ import annotations

import os
import tempfile
import unittest
from types import SimpleNamespace

import numpy as np

from gguf_mlx_backend import LazyGgufWeights, _map_gguf_name


class FakeMx:
    float16 = np.float16

    def array(self, value, dtype=None):
        return np.asarray(value, dtype=dtype)

    def eval(self, *values):
        return None


class GgufLazyBackendTests(unittest.TestCase):
    def test_name_mapping_uses_local_layer_index(self) -> None:
        self.assertEqual(_map_gguf_name("token_embd.weight", 10), "embed_tokens.weight")
        self.assertEqual(_map_gguf_name("output_norm.weight", 10), "norm.weight")
        self.assertEqual(_map_gguf_name("output.weight", 10), "lm_head.weight")
        self.assertEqual(_map_gguf_name("blk.12.attn_q.weight", 10), "layers.2.self_attn.q_proj.weight")
        self.assertEqual(_map_gguf_name("blk.12.ffn_down.weight", 10), "layers.2.mlp.down_proj.weight")

    def test_lazy_weight_reads_local_range_and_aliases_lm_head(self) -> None:
        arr = np.arange(12, dtype=np.float16).reshape(3, 4)
        with tempfile.NamedTemporaryFile(delete=False) as fp:
            fp.write(arr.tobytes())
            path = fp.name
        try:
            shard = SimpleNamespace(
                layer_start=0,
                weight_file_path=path,
                gguf_tensor_index=[
                    {
                        "name": "token_embd.weight",
                        "shape": [3, 4],
                        "ggml_type": 1,
                        "offset": 0,
                        "nbytes": arr.nbytes,
                    }
                ],
            )
            weights = LazyGgufWeights(shard, FakeMx(), max_cache_bytes=1024 * 1024)
            got = weights.get("embed_tokens.weight")
            np.testing.assert_array_equal(got, arr.T)
            np.testing.assert_array_equal(weights.get("lm_head.weight"), arr.T)
            self.assertEqual(len(weights), 2)
        finally:
            os.unlink(path)


if __name__ == "__main__":
    unittest.main()
