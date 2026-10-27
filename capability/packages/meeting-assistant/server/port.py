"""Step A defines the platform port; live adapters are deliberately not installed yet."""
from typing import Protocol

from capability.sdk.python.yimi_receipt import unknown, unknown_fact


class PlatformPort(Protocol):
    def invoke(self, tool: str, arguments: dict) -> dict: ...


class UnwiredPlatform:
    def invoke(self, tool, arguments):
        return unknown(status={'reason_code': 'MEETING_ADAPTER_NOT_WIRED'},
                       unknowns=[unknown_fact(arguments['target_id'], 'Live platform adapter is not wired.')],
                       next={'retry': 'after_check', 'check_with': 'edit_status', 'waiting_on': 'external', 'waiting_detail': 'device'})
