from __future__ import annotations

import json

from ehjobs_proxy.settings import load_settings


def test_load_tls_config_without_runtime_file_validation(tmp_path):
    config = {
        "server": {
            "host": "0.0.0.0",
            "port": 8787,
            "tls": {
                "enabled": True,
                "certFile": "/run/secrets/tls.crt",
                "keyFile": "/run/secrets/tls.key",
            },
        },
        "agentAuth": {"bearerToken": "secret"},
        "ehestifter": {
            "jobsBaseUrl": "https://ehestifter-jobs.azurewebsites.net/api",
            "jobsFunctionKey": "key",
            "userId": "00000000-0000-0000-0000-000000000001",
        },
    }
    path = tmp_path / "config.json"
    path.write_text(json.dumps(config), encoding="utf-8")
    settings = load_settings(path, validate_runtime_files=False)
    assert settings.server.tls.enabled is True
    assert settings.server.tls.certFile == "/run/secrets/tls.crt"
