from __future__ import annotations

import unittest
from unittest.mock import Mock

import requests

from app.inference_resilience import (
    InferenceFatal,
    run_with_outage_recovery,
)


def http_error(status: int) -> requests.HTTPError:
    response = requests.Response()
    response.status_code = status
    exc = requests.HTTPError(response=response)
    return exc


class InferenceResilienceTests(unittest.TestCase):
    def test_connection_outage_requeues_waits_and_releases_no_sb_delivery(self):
        calls = iter([
            requests.ConnectionError("down"),
            requests.ConnectionError("still down"),
            requests.ConnectionError("still down"),
            {"ok": True},
        ])
        release = Mock()
        reacquire = Mock(return_value="lease-2")
        health = Mock(side_effect=[False, False, True])
        sleeps: list[float] = []

        def invoke():
            value = next(calls)
            if isinstance(value, BaseException):
                raise value
            return value

        result = run_with_outage_recovery(
            initial_lease_token="lease-1",
            primary_call=invoke,
            fallback_call=invoke,
            release_unavailable=release,
            reacquire_lease=reacquire,
            health_check=health,
            retry_delays_seconds=(10, 30),
            outage_cooldown_seconds=600,
            sleep=sleeps.append,
        )

        self.assertEqual(result.raw, {"ok": True})
        self.assertEqual(result.lease_token, "lease-2")
        self.assertEqual(result.recovery_cycles, 1)
        self.assertEqual(result.attempts, 4)
        release.assert_called_once_with(
            "lease-1", "Inference service temporarily unavailable (connection_error)"
        )
        reacquire.assert_called_once_with()
        self.assertEqual(sleeps, [10.0, 30.0, 600.0, 600.0, 600.0])

    def test_503_is_temporary_and_requeued(self):
        calls = iter([http_error(503), http_error(503), http_error(503), {"ok": True}])
        releases: list[tuple[str, str]] = []

        def invoke():
            value = next(calls)
            if isinstance(value, BaseException):
                raise value
            return value

        result = run_with_outage_recovery(
            initial_lease_token="lease-1",
            primary_call=invoke,
            fallback_call=invoke,
            release_unavailable=lambda token, message: releases.append((token, message)),
            reacquire_lease=lambda: "lease-2",
            health_check=lambda: True,
            retry_delays_seconds=(0, 0),
            outage_cooldown_seconds=0,
            sleep=lambda _: None,
        )

        self.assertEqual(result.lease_token, "lease-2")
        self.assertEqual(releases, [("lease-1", "Inference service temporarily unavailable (HTTP 503)")])

    def test_repeated_400_is_terminal_not_an_outage_loop(self):
        calls = iter([http_error(400), http_error(400)])
        release = Mock()

        def invoke():
            value = next(calls)
            raise value

        with self.assertRaises(InferenceFatal) as caught:
            run_with_outage_recovery(
                initial_lease_token="lease-1",
                primary_call=invoke,
                fallback_call=invoke,
                release_unavailable=release,
                reacquire_lease=lambda: "unused",
                health_check=lambda: True,
                retry_delays_seconds=(0, 0),
                outage_cooldown_seconds=0,
                sleep=lambda _: None,
            )

        self.assertEqual(caught.exception.lease_token, "lease-1")
        self.assertEqual(caught.exception.code, "INFERENCE_REQUEST_FAILED")
        release.assert_not_called()

    def test_401_is_terminal_without_retry(self):
        attempts = 0

        def invoke():
            nonlocal attempts
            attempts += 1
            raise http_error(401)

        with self.assertRaises(InferenceFatal):
            run_with_outage_recovery(
                initial_lease_token="lease-1",
                primary_call=invoke,
                fallback_call=invoke,
                release_unavailable=lambda *_: None,
                reacquire_lease=lambda: "unused",
                health_check=lambda: True,
                retry_delays_seconds=(10, 30),
                outage_cooldown_seconds=600,
                sleep=lambda _: None,
            )
        self.assertEqual(attempts, 1)

    def test_release_failure_escapes_before_health_wait(self):
        sleeps: list[float] = []

        def unavailable():
            raise requests.ConnectionError("down")

        with self.assertRaises(RuntimeError):
            run_with_outage_recovery(
                initial_lease_token="lease-1",
                primary_call=unavailable,
                fallback_call=unavailable,
                release_unavailable=lambda *_: (_ for _ in ()).throw(RuntimeError("gateway down")),
                reacquire_lease=lambda: "unused",
                health_check=lambda: True,
                retry_delays_seconds=(),
                outage_cooldown_seconds=600,
                sleep=sleeps.append,
            )
        self.assertEqual(sleeps, [])

    def test_timeout_recovers_after_health_probe(self):
        calls = iter([requests.Timeout("slow"), {"ok": True}])

        def invoke():
            value = next(calls)
            if isinstance(value, BaseException):
                raise value
            return value

        result = run_with_outage_recovery(
            initial_lease_token="lease-1",
            primary_call=invoke,
            fallback_call=invoke,
            release_unavailable=lambda *_: None,
            reacquire_lease=lambda: "lease-2",
            health_check=lambda: True,
            retry_delays_seconds=(),
            outage_cooldown_seconds=0,
            sleep=lambda _: None,
        )
        self.assertEqual(result.raw, {"ok": True})
        self.assertEqual(result.recovery_cycles, 1)


if __name__ == "__main__":
    unittest.main()
