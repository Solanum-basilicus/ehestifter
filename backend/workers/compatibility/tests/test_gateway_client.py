from __future__ import annotations

import unittest
from unittest.mock import Mock

from app.gateway import GatewayClient


class GatewayClientTests(unittest.TestCase):
    def test_complete_error_uses_existing_gateway_error_contract(self):
        client = GatewayClient("https://gateway.example", "secret")
        response = Mock()
        response.raise_for_status.return_value = None
        response.json.return_value = {"ok": True}
        client.session.post = Mock(return_value=response)

        result = client.complete_error(
            "run-1",
            "lease-1",
            code="INFERENCE_UNAVAILABLE",
            message="Inference service temporarily unavailable",
        )

        self.assertEqual(result, {"ok": True})
        client.session.post.assert_called_once_with(
            "https://gateway.example/work/complete",
            json={
                "runId": "run-1",
                "leaseToken": "lease-1",
                "error": {
                    "code": "INFERENCE_UNAVAILABLE",
                    "message": "Inference service temporarily unavailable",
                },
            },
            timeout=30,
        )


if __name__ == "__main__":
    unittest.main()
