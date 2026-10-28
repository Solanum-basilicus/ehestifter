"""Check the Azure Functions normal-mode telemetry policy."""

import json
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[2]


@pytest.mark.parametrize("service", ["jobs", "users", "enrichers"])
def test_function_hosts_keep_failures_and_aggregate_success(service):
    config = json.loads((ROOT / "backend" / service / "host.json").read_text())
    assert config["version"] == "2.0"
    levels = config["logging"]["logLevel"]
    assert levels == {
        "default": "Warning",
        "Function": "Warning",
        "Host.Results": "Error",
        "Host.Aggregator": "Information",
    }
    assert config["aggregator"] == {
        "batchSize": 1000,
        "flushTimeout": "00:05:00",
    }
    insights = config["logging"]["applicationInsights"]
    assert insights["samplingSettings"]["isEnabled"] is True
    assert insights["samplingSettings"]["excludedTypes"] == "Request;Exception"
    assert insights["samplingSettings"]["maxTelemetryItemsPerSecond"] == 5
    assert insights["enablePerformanceCountersCollection"] is False
    if service in ("jobs", "users"):
        assert config["extensionBundle"]["id"] == "Microsoft.Azure.Functions.ExtensionBundle"
