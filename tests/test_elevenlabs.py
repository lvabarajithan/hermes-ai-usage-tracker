"""ElevenLabs quota probe — run with the Hermes runtime python:

    python -m unittest discover -s tests -p 'test_*.py' -v
"""

import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx

MODULE_PATH = Path(__file__).parents[1] / "dashboard" / "plugin_api.py"
spec = importlib.util.spec_from_file_location("ai_usage_tracker_plugin_api", MODULE_PATH)
assert spec is not None and spec.loader is not None
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

FAKE_KEY = "sk_test_not_a_real_key"

SUBSCRIPTION = {
    "tier": "creator",
    "status": "active",
    "character_count": 25_000,
    "character_limit": 100_000,
    "next_character_count_reset_unix": 1_798_761_600,  # 2027-01-01T00:00:00Z
    "character_refresh_period": "monthly_period",
    "voice_slots_used": 3,
    "voice_limit": 30,
}


class ElevenLabsProbeTests(unittest.TestCase):
    def _probe(self, payload=None, status=200, key=FAKE_KEY):
        captured = {}
        real_client = httpx.Client

        def handler(request):
            captured["url"] = str(request.url)
            captured["headers"] = dict(request.headers)
            return httpx.Response(status, json=payload)

        def fake_client(**kwargs):
            return real_client(transport=httpx.MockTransport(handler), **kwargs)

        with patch.object(module, "_elevenlabs_key", return_value=key), \
             patch.object(module.httpx, "Client", side_effect=fake_client):
            return module._probe_elevenlabs(), captured

    def test_characters_become_a_quota_window_with_reset_and_tier(self):
        result, captured = self._probe(SUBSCRIPTION)

        self.assertEqual(captured["url"], "https://api.elevenlabs.io/v1/user/subscription")
        self.assertEqual(captured["headers"]["xi-api-key"], FAKE_KEY)
        self.assertTrue(result["available"])
        self.assertEqual(result["plan"], "Creator")
        self.assertEqual(len(result["windows"]), 1)
        window = result["windows"][0]
        self.assertEqual(window["label"], "Credits (monthly)")
        self.assertAlmostEqual(window["used_percent"], 25.0)
        self.assertAlmostEqual(window["remaining_percent"], 75.0)
        self.assertEqual(window["reset_at"], "2027-01-01T00:00:00+00:00")
        self.assertEqual(window["detail"], "75,000 of 100,000 left")
        self.assertIn("Voice slots: 3 of 30 used", result["details"])

    def test_missing_reset_and_period_still_render(self):
        payload = dict(SUBSCRIPTION, next_character_count_reset_unix=None, character_refresh_period=None)
        result, _ = self._probe(payload)

        self.assertEqual(result["windows"][0]["label"], "Credits")
        self.assertIsNone(result["windows"][0]["reset_at"])

    def test_overage_clamps_the_bar_and_is_reported(self):
        result, _ = self._probe(dict(SUBSCRIPTION, character_count=110_000))

        self.assertEqual(result["windows"][0]["remaining_percent"], 0.0)
        self.assertIn("Over the included credits by 10,000", result["details"])

    def test_inactive_status_is_surfaced(self):
        result, _ = self._probe(dict(SUBSCRIPTION, status="past_due"))

        self.assertIn("Subscription status: past due", result["details"])

    def test_no_key_is_not_configured(self):
        result, captured = self._probe(SUBSCRIPTION, key=None)

        self.assertFalse(result["available"])
        self.assertIn("ELEVENLABS_API_KEY", result["unavailable_reason"])
        self.assertEqual(captured, {}, "no request without a key")

    def test_restricted_key_names_the_missing_permission(self):
        body = {"detail": {"status": "missing_permissions",
                           "message": "The API key you used is missing the permission user_read."}}
        result, _ = self._probe(body, status=401)

        self.assertFalse(result["available"])
        self.assertIn("user_read", result["unavailable_reason"])
        self.assertNotIn(FAKE_KEY, repr(result))

    def test_rejected_key_never_leaks_the_secret(self):
        result, _ = self._probe({"detail": {"status": "invalid_api_key"}}, status=401)

        self.assertFalse(result["available"])
        self.assertIn("rejected", result["unavailable_reason"])
        self.assertNotIn(FAKE_KEY, repr(result))

    def test_server_error_is_reported_plainly(self):
        result, _ = self._probe({}, status=503)

        self.assertFalse(result["available"])
        self.assertIn("HTTP 503", result["unavailable_reason"])

    def test_zero_limit_reports_no_quota(self):
        result, _ = self._probe(dict(SUBSCRIPTION, character_limit=0))

        self.assertFalse(result["available"])


class ElevenLabsWiringTests(unittest.TestCase):
    def test_registered_as_quota_capable_with_a_label(self):
        self.assertIn("elevenlabs", module._QUOTA_CAPABLE)
        self.assertIn("elevenlabs", module._PROBES)
        self.assertEqual(module._EXTRA_LABELS["elevenlabs"], "ElevenLabs")

    def test_configured_when_the_profile_has_a_key(self):
        with patch.object(module, "_provider_labels", return_value={}), \
             patch.object(module, "_elevenlabs_key", return_value=FAKE_KEY):
            self.assertIn("elevenlabs", module._configured_providers())
        with patch.object(module, "_provider_labels", return_value={}), \
             patch.object(module, "_elevenlabs_key", return_value=None):
            self.assertNotIn("elevenlabs", module._configured_providers())

    def test_key_is_read_from_the_bound_profile_env(self):
        try:
            import agent.secret_scope  # noqa: F401 - Hermes runtime only
        except ImportError:
            self.skipTest("needs the Hermes runtime (agent.secret_scope)")
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory) / ".env").write_text(f"ELEVENLABS_API_KEY={FAKE_KEY}\n")
            with patch.object(module, "_hermes_home", return_value=Path(directory)):
                self.assertEqual(module._elevenlabs_key(), FAKE_KEY)


if __name__ == "__main__":
    unittest.main()
