"""Allocation paginée des états récurrents MLX par session."""
from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any


@dataclass
class StatePage:
    page_id: int
    session_id: str | None = None
    state: Any | None = None
    updated_ms: int = 0


class StatePageAllocator:
    def __init__(self, max_sessions: int = 32):
        self.pages = [StatePage(page_id=i) for i in range(max_sessions)]
        self.evictions = 0

    def acquire(self, session_id: str) -> StatePage:
        for page in self.pages:
            if page.session_id == session_id:
                page.updated_ms = _now_ms()
                return page
        for page in self.pages:
            if page.session_id is None:
                page.session_id = session_id
                page.updated_ms = _now_ms()
                return page
        victim = min(self.pages, key=lambda p: p.updated_ms)
        victim.session_id = session_id
        victim.state = None
        victim.updated_ms = _now_ms()
        self.evictions += 1
        return victim

    def release(self, session_id: str) -> bool:
        for page in self.pages:
            if page.session_id == session_id:
                page.session_id = None
                page.state = None
                page.updated_ms = 0
                return True
        return False

    def status(self) -> dict[str, int]:
        used = sum(1 for p in self.pages if p.session_id is not None)
        return {
            "state_pages_used": used,
            "state_pages_free": len(self.pages) - used,
            "state_evictions": self.evictions,
        }


def _now_ms() -> int:
    return int(time.time() * 1000)
