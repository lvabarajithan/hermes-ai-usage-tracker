"""Static contract tests for the web dashboard bundle.

The bundle is a plain JS IIFE loaded by the Hermes web dashboard SPA; these
tests pin the manifest wiring, the SDK contract it relies on, and the absence
of desktop-only APIs or secret material.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "dashboard" / "manifest.json"
BUNDLE = ROOT / "dashboard" / "dist" / "index.js"
STYLES = ROOT / "dashboard" / "dist" / "style.css"


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


class ManifestWiringTests(unittest.TestCase):
    def test_manifest_declares_web_entry_and_css(self) -> None:
        manifest = json.loads(_read(MANIFEST))

        self.assertEqual(manifest["name"], "ai-usage-tracker")
        self.assertEqual(manifest["tab"]["path"], "/ai-usage")
        self.assertEqual(manifest["entry"], "dist/index.js")
        self.assertEqual(manifest["css"], "dist/style.css")
        self.assertEqual(manifest["api"], "plugin_api.py")
        self.assertTrue(BUNDLE.is_file(), "manifest entry must exist on disk")
        self.assertTrue(STYLES.is_file(), "manifest css must exist on disk")


class BundleContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.bundle = _read(BUNDLE)

    def test_registers_with_web_plugin_sdk(self) -> None:
        self.assertIn('var ID = "ai-usage-tracker";', self.bundle)
        self.assertIn("window.__HERMES_PLUGINS__.register(ID, UsagePage);", self.bundle)
        self.assertIn("window.__HERMES_PLUGIN_SDK__", self.bundle)

    def test_fetches_usage_through_sdk_helper(self) -> None:
        self.assertIn('var API = "/api/plugins/" + ID;', self.bundle)
        self.assertIn('API + "/usage"', self.bundle)
        self.assertIn("SDK.fetchJSON(url)", self.bundle)

    def test_persists_ui_prefs_to_local_storage(self) -> None:
        self.assertIn('"ai-usage-tracker:hidden-v1"', self.bundle)
        self.assertIn('"ai-usage-tracker:profile-v1"', self.bundle)
        self.assertIn("window.localStorage.getItem", self.bundle)
        self.assertIn("window.localStorage.setItem", self.bundle)

    def test_web_sdk_badge_uses_tone_prop(self) -> None:
        self.assertIn("tone:", self.bundle)
        self.assertNotIn("variant:", self.bundle)

    def test_badge_tones_match_web_sdk_contract(self) -> None:
        tones = set(re.findall(r'tone: "([^"]+)"', self.bundle))
        self.assertTrue(tones, "expected at least one literal Badge tone in the bundle")
        self.assertLessEqual(tones, {"success", "secondary", "warning", "destructive"})

    def test_profile_switch_drops_stale_responses(self) -> None:
        self.assertIn("var requestRef = useRef(0);", self.bundle)
        self.assertIn("var profileAtRequest = profileRef.current;", self.bundle)
        self.assertIn("requestId !== requestRef.current || profileAtRequest !== profileRef.current", self.bundle)

    def test_no_desktop_only_apis_left_in_web_bundle(self) -> None:
        for marker in (
            "ctx.rest(",
            "ctx.storage",
            "useQuery",
            "host.navigate",
            "Codicon",
            "EmptyState",
            "haptic(",
            "ReactDOM",
            "require(",
            "import ",
        ):
            self.assertNotIn(marker, self.bundle)

    def test_no_html_injection_or_secret_material(self) -> None:
        self.assertNotIn("innerHTML", self.bundle)
        for marker in ("Authorization", "Bearer ", "api_key", "apiKey", "sk-", "ghp_", "xoxb-"):
            self.assertNotIn(marker, self.bundle)

    @unittest.skipUnless(shutil.which("node"), "node is required for a syntax check")
    def test_bundle_parses_as_javascript(self) -> None:
        result = subprocess.run(
            ["node", "--check", str(BUNDLE)],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    @unittest.skipUnless(shutil.which("node"), "node is required for the SDK smoke test")
    def test_bundle_registers_against_mocked_web_sdk(self) -> None:
        harness = """
const fs = require("fs");
const vm = require("vm");
global.window = {
  localStorage: { getItem: () => null, setItem: () => {} },
  __HERMES_PLUGIN_SDK__: {
    React: { createElement: (...args) => ({ args }) },
    hooks: {
      useState: (v) => [typeof v === "function" ? v() : v, () => {}],
      useEffect: () => {},
      useRef: (v) => ({ current: v }),
      useCallback: (fn) => fn,
      useMemo: (fn) => fn()
    },
    components: {},
    fetchJSON: () => Promise.resolve({})
  },
  __HERMES_PLUGINS__: {
    register: (id, page) => { global.__registered = { id, pageType: typeof page }; }
  }
};
vm.runInThisContext(fs.readFileSync(%s, "utf8"), { filename: "dist/index.js" });
if (!global.__registered || global.__registered.id !== "ai-usage-tracker" || global.__registered.pageType !== "function") {
  console.error("bundle did not register the page component", global.__registered);
  process.exit(1);
}
""" % json.dumps(str(BUNDLE))
        result = subprocess.run(["node", "-e", harness], capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)


class StylesContractTests(unittest.TestCase):
    def test_styles_use_dashboard_theme_variables(self) -> None:
        styles = _read(STYLES)
        for token in ("--color-border", "--color-card", "--color-muted-foreground", "--color-destructive"):
            self.assertIn(token, styles)
        self.assertNotIn("@apply", styles)


if __name__ == "__main__":
    unittest.main()
