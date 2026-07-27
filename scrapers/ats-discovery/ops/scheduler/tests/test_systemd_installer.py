from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

INSTALLER_PATH = Path(__file__).resolve().parents[2] / "systemd" / "install_systemd.py"
SPEC = importlib.util.spec_from_file_location("install_systemd", INSTALLER_PATH)
assert SPEC and SPEC.loader
installer = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = installer
SPEC.loader.exec_module(installer)


class InstallerTests(unittest.TestCase):
    def test_render_uses_operator_schedule_and_retry_policy(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "scanner"
            template_source = INSTALLER_PATH.parent
            target_templates = root / "ops/systemd"
            target_templates.mkdir(parents=True)
            for name in installer.UNIT_NAMES:
                source = template_source / (name + ".in")
                if not source.exists():
                    source = template_source / name
                (target_templates / source.name).write_text(source.read_text(encoding="utf-8"), encoding="utf-8")
            output = Path(temp) / "rendered"
            config = {
                "timezone": "Europe/Berlin",
                "retry": {"maxRetries": 2, "retryIntervalMinutes": 17, "retryWindowMinutes": 95},
                "dailyDiscovery": {"schedule": "09:15"},
                "catalogRefresh": {"schedule": "06:45", "weekday": "Saturday"},
            }
            with unittest.mock.patch.object(installer, "__file__", str(target_templates / "install_systemd.py")):
                installer.render_templates(root, output, "alice", "users", Path("/usr/bin/python3"), config)
            discovery = (output / "ehestifter-ats-discovery.service").read_text()
            timer = (output / "ehestifter-ats-discovery.timer").read_text()
            catalog_timer = (output / "ehestifter-ats-catalog-refresh.timer").read_text()
            self.assertIn("StartLimitIntervalSec=95min", discovery)
            self.assertIn("StartLimitBurst=3", discovery)
            self.assertIn("RestartSec=17min", discovery)
            self.assertIn("OnCalendar=*-*-* 09:15:00 Europe/Berlin", timer)
            self.assertIn("OnCalendar=Sat *-*-* 06:45:00 Europe/Berlin", catalog_timer)
            self.assertNotIn("@", discovery + timer + catalog_timer)

    def test_catalog_service_does_not_block_discovery_retry_chain(self):
        text = (INSTALLER_PATH.parent / "ehestifter-ats-catalog-refresh.service.in").read_text()
        self.assertNotIn("Before=ehestifter-ats-discovery.service", text)
        self.assertNotIn("Requires=docker.service", text)
        self.assertIn("Restart=on-failure", text)


if __name__ == "__main__":
    unittest.main()
