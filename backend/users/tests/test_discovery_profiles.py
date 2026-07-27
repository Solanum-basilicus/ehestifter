import importlib.util
import json
import unittest
from pathlib import Path


def load_discovery_filters_module():
    module_path = (
        Path(__file__).parents[1]
        / "helpers"
        / "discovery_filters.py"
    )
    spec = importlib.util.spec_from_file_location(
        "phase6_discovery_filters",
        module_path,
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


normalize_discovery_profile = (
    load_discovery_filters_module().normalize_discovery_profile
)


class DiscoveryProfileTests(unittest.TestCase):
    def test_normalizes_scanner_style_and_aliases(self):
        profile = normalize_discovery_profile(
            "filter-1",
            json.dumps(
                {
                    "title_filter": {
                        "positive": ["Product Manager", " product manager "],
                        "negative": ["Intern"],
                    },
                    "locationFilter": {
                        "always_allow": ["Germany"],
                        "allow": ["Europe"],
                        "block": ["US only"],
                    },
                    "company": {"include": ["Celonis"], "exclude": ["Agency"]},
                    "remote_types": ["Remote", "Hybrid"],
                }
            ),
        )
        self.assertEqual(profile["profileId"], "filter-1")
        self.assertEqual(profile["title"]["positive"], ["Product Manager"])
        self.assertEqual(profile["title"]["negative"], ["Intern"])
        self.assertEqual(profile["location"]["alwaysAllow"], ["Germany"])
        self.assertEqual(profile["company"]["allow"], ["Celonis"])
        self.assertEqual(profile["remoteTypes"], ["Remote", "Hybrid"])

    def test_rejects_invalid_or_constraint_free_saved_filters(self):
        self.assertIsNone(normalize_discovery_profile("x", "not-json"))
        self.assertIsNone(normalize_discovery_profile("x", "[]"))
        self.assertIsNone(normalize_discovery_profile("x", '{"unknown": true}'))

    def test_bounds_and_deduplicates_terms_case_insensitively(self):
        too_long = "x" * 121
        profile = normalize_discovery_profile(
            "x",
            {
                "title": {
                    "positive": ["Manager", "manager", too_long, None, ""],
                }
            },
        )
        self.assertEqual(profile["title"]["positive"], ["Manager"])


if __name__ == "__main__":
    unittest.main()
