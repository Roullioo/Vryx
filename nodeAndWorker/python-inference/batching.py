"""Continuous Batching pour la future pool Velocity."""
from __future__ import annotations

import queue
import threading
import time
from dataclasses import dataclass
from typing import Any


@dataclass
class BatchItem:
    session_id: str
    payload: dict[str, Any]
    created_ms: int
    future: "BatchFuture | None" = None


class BatchFuture:
    def __init__(self) -> None:
        self._event = threading.Event()
        self._result: Any = None
        self._error: BaseException | None = None

    def set_result(self, result: Any) -> None:
        self._result = result
        self._event.set()

    def set_error(self, error: BaseException) -> None:
        self._error = error
        self._event.set()

    def result(self, timeout: float | None = None) -> Any:
        if not self._event.wait(timeout):
            raise TimeoutError("batch result timeout")
        if self._error is not None:
            raise self._error
        return self._result


class BatchQueue:
    def __init__(self, max_batch_size: int = 8, window_ms: int = 10):
        self.max_batch_size = max(1, max_batch_size)
        self.window_ms = max(1, window_ms)
        self._q: "queue.Queue[BatchItem]" = queue.Queue()

    def submit(self, session_id: str, payload: dict[str, Any]) -> BatchFuture:
        future = BatchFuture()
        self._q.put(BatchItem(session_id=session_id, payload=payload, created_ms=_now_ms(), future=future))
        return future

    def drain(self) -> tuple[list[BatchItem], dict[str, Any]]:
        first = self._q.get(timeout=self.window_ms / 1000.0)
        items = [first]
        deadline = time.perf_counter() + self.window_ms / 1000.0
        while len(items) < self.max_batch_size and time.perf_counter() < deadline:
            try:
                items.append(self._q.get_nowait())
            except queue.Empty:
                time.sleep(0.001)
        now = _now_ms()
        waits = [max(0, now - item.created_ms) for item in items]
        return items, {
            "batch_size": len(items),
            "queue_wait_ms": int(sum(waits) / len(waits)) if waits else 0,
            "active_sessions": len({item.session_id for item in items}),
            "batch_efficiency_pct": round((len(items) / self.max_batch_size) * 100, 2),
        }

    def empty(self) -> bool:
        return self._q.empty()


def _now_ms() -> int:
    return int(time.time() * 1000)


def batching_trace(enabled: bool, batch_size: int = 1) -> dict[str, Any]:
    return {
        "enabled": bool(enabled),
        "batch_size": int(batch_size),
        "queue_wait_ms": 0,
        "decode_batch_ms": 0,
        "active_sessions": int(batch_size),
        "batch_efficiency_pct": 100.0 if batch_size > 1 else 12.5,
    }
