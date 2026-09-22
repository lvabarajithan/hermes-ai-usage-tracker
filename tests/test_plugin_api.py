import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


MODULE_PATH = Path(__file__).parents[1] / "dashboard" / "plugin_api.py"
spec = importlib.util.spec_from_file_location("ai_usage_tracker_plugin_api", MODULE_PATH)
assert spec is not None and spec.loader is not None
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ProfileScopeTests(unittest.TestCase):
    def test_profile_callback_runs_with_hydrated_secret_scope(self):
        home = Path.home() / ".hermes/cache/scratch/hermes-profile"
        with patch("hermes_constants.set_hermes_home_override", return_value="home-token") as set_home, \
             patch("hermes_constants.reset_hermes_home_override") as reset_home, \
             patch("hermes_cli.env_loader.hydrate_profile_secret_sources") as hydrate, \
             patch("agent.secret_scope.build_profile_secret_scope", return_value={"OPENROUTER_API_KEY": "fake-key"}) as build_scope, \
             patch("agent.secret_scope.set_secret_scope", return_value="secret-token") as set_scope, \
             patch("agent.secret_scope.reset_secret_scope") as reset_scope:
            result = module._run_in_home(home, lambda: "callback-result")

        self.assertEqual(result, "callback-result")
        hydrate.assert_called_once_with(home)
        build_scope.assert_called_once_with(home)
        set_scope.assert_called_once_with({"OPENROUTER_API_KEY": "fake-key"})
        reset_scope.assert_called_once_with("secret-token")
        set_home.assert_called_once_with(home)
        reset_home.assert_called_once_with("home-token")

    def test_openrouter_runtime_resolves_scoped_env_credential(self):
        home = Path.home() / ".hermes/cache/scratch/hermes-profile"
        with patch("hermes_cli.env_loader.hydrate_profile_secret_sources"), \
             patch("agent.secret_scope.build_profile_secret_scope", return_value={"OPENROUTER_API_KEY": "fake-key"}):
            key = module._run_in_home(home, lambda: module._runtime_key("openrouter"))

        self.assertEqual(key, "fake-key")


class OpenCodeUsageTests(unittest.TestCase):
    def test_local_auth_key_is_read_for_requested_provider(self):
        with tempfile.TemporaryDirectory() as directory:
            auth_path = Path(directory) / "auth.json"
            auth_path.write_text(json.dumps({
                "opencode-go": {"type": "api", "key": "go-secret"},
                "opencode": {"type": "api", "key": "zen-secret"},
            }))

            self.assertEqual(module._opencode_local_auth_key("opencode-go", auth_path), "go-secret")
            self.assertEqual(module._opencode_local_auth_key("opencode-zen", auth_path), "zen-secret")

    def test_local_auth_key_does_not_cross_provider(self):
        with tempfile.TemporaryDirectory() as directory:
            auth_path = Path(directory) / "auth.json"
            auth_path.write_text(json.dumps({"opencode": {"type": "api", "key": "zen-secret"}}))

            self.assertIsNone(module._opencode_local_auth_key("opencode-go", auth_path))

    def test_opencode_usage_probe_sends_browser_like_user_agent(self):
        captured = {}

        def fake_get_json(url, headers):
            captured["url"] = url
            captured["headers"] = headers
            return {"usage": {"rolling": {"percent": 1}}}

        with patch.object(module, "_runtime_key", return_value="go-secret"), \
             patch.object(module, "_get_json", side_effect=fake_get_json):
            result = module._probe_opencode_go()

        self.assertTrue(result["available"])
        self.assertEqual(captured["url"], "https://opencode.ai/zen/go/v1/usage")
        self.assertTrue(captured["headers"]["User-Agent"])


if __name__ == "__main__":
    unittest.main()
