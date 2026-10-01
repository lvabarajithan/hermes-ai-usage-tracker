/**
 * AI Usage Tracker — live subscription quota for every AI provider Hermes can
 * route to, per profile. Web dashboard bundle (port of desktop/plugin.js).
 *
 * Scope (deliberately narrow): subscription quota windows only — provider,
 * plan, window, % remaining, reset countdown. No token counting, no cost
 * estimates, no time-window filters. The web dashboard has no status-bar
 * area, so the desktop status chip is not ported; provider hiding and the
 * profile picker are kept and persisted to localStorage.
 *
 * Backend: ../plugin_api.py, mounted at /api/plugins/ai-usage-tracker/.
 * Read-only. No secrets ever reach the UI.
 */
(function () {
  "use strict";

  var SDK = window.__HERMES_PLUGIN_SDK__;
  if (!SDK || !window.__HERMES_PLUGINS__) return;

  var React = SDK.React;
  var h = React.createElement;
  var hooks = SDK.hooks;
  var useState = hooks.useState;
  var useEffect = hooks.useEffect;
  var useRef = hooks.useRef;
  var useCallback = hooks.useCallback;
  var C = SDK.components || {};
  var Button = C.Button;
  var Badge = C.Badge;
  var Select = C.Select;
  var SelectOption = C.SelectOption;

  var ID = "ai-usage-tracker";
  var API = "/api/plugins/" + ID;
  var REFRESH_PAGE_MS = 120000;

  var HIDDEN_KEY = "ai-usage-tracker:hidden-v1";
  var PROFILE_KEY = "ai-usage-tracker:profile-v1";

  // ------------------------------------------------------------- storage

  function storageGet(key, fallback) {
    try {
      var raw = window.localStorage.getItem(key);
      if (raw === null) return fallback;
      return JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  }

  function storageSet(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      /* in-memory state still works for this session */
    }
  }

  // ------------------------------------------------------------ formatters

  function fmtTime(iso) {
    if (!iso) return null;
    var d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString(undefined, {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    });
  }

  function resetLabel(iso) {
    if (!iso) return null;
    var d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    var seconds = Math.round((d.getTime() - Date.now()) / 1000);
    if (seconds <= 0) return "resets now";
    var days = Math.floor(seconds / 86400);
    var hours = Math.floor((seconds % 86400) / 3600);
    var minutes = Math.floor((seconds % 3600) / 60);
    var rel = days
      ? "in " + days + "d " + hours + "h"
      : hours
        ? "in " + hours + "h " + minutes + "m"
        : "in " + minutes + "m";
    return "resets " + rel + " · " + fmtTime(iso);
  }

  function pct(value) {
    if (value === null || value === undefined) return "—";
    return Math.round(Number(value)) + "%";
  }

  function toneFor(remaining) {
    if (remaining === null || remaining === undefined) return "muted";
    if (remaining <= 5) return "bad";
    if (remaining <= 25) return "warn";
    return "good";
  }

  function statusOf(provider) {
    if (provider.quota && provider.quota.available) return { tone: "success", label: "live quota" };
    if (provider.quota && provider.quota.unavailable_reason) return { tone: "secondary", label: "no quota" };
    return { tone: "secondary", label: "unavailable" };
  }

  function profileLabel(row) {
    if (!row) return "profile";
    return row.name + (row.is_default ? " · default" : "") + (row.gateway_running ? " · up" : "");
  }

  // The SDK's Select fires onValueChange(value) directly (shadcn-style popup),
  // older code expects onChange({target:{value}}) — wire both (kanban #20879).
  function selectChangeHandler(setter) {
    return {
      onValueChange: function (v) { setter(v == null ? "" : v); },
      onChange: function (e) {
        var v = e && e.target ? e.target.value : e;
        setter(v == null ? "" : v);
      }
    };
  }

  // ------------------------------------------------------------ data hook

  function useUsage(selectedProfile) {
    var dataState = useState(null);
    var data = dataState[0];
    var setData = dataState[1];
    var errorState = useState(null);
    var error = errorState[0];
    var setError = errorState[1];
    var fetchingState = useState(false);
    var fetching = fetchingState[0];
    var setFetching = fetchingState[1];

    var profileRef = useRef(selectedProfile);
    profileRef.current = selectedProfile;
    // Drop stale responses: a slow fetch for the previous profile must not
    // overwrite the newly selected profile's data when it resolves late.
    var requestRef = useRef(0);
    // Latest-good payload survives a failed refresh and a profile switch
    // (the desktop version used react-query placeholderData for this).
    var load = useCallback(function (forceRefresh) {
      setFetching(true);
      var requestId = ++requestRef.current;
      var profileAtRequest = profileRef.current;
      var params = [];
      if (profileAtRequest) params.push("profile=" + encodeURIComponent(profileAtRequest));
      if (forceRefresh) params.push("refresh=1");
      var url = API + "/usage" + (params.length ? "?" + params.join("&") : "");
      return SDK.fetchJSON(url).then(function (payload) {
        if (requestId !== requestRef.current || profileAtRequest !== profileRef.current) return;
        setData(payload);
        setError(null);
        setFetching(false);
      }).catch(function (err) {
        if (requestId !== requestRef.current || profileAtRequest !== profileRef.current) return;
        setError(err && err.message ? err.message : String(err));
        setFetching(false);
      });
    }, []);

    useEffect(function () {
      load(false);
      var timer = setInterval(function () { load(false); }, REFRESH_PAGE_MS);
      return function () { clearInterval(timer); };
    }, [selectedProfile, load]);

    var refresh = useCallback(function () {
      return load(true);
    }, [load]);

    return { data: data, error: error, fetching: fetching, refresh: refresh };
  }

  // ------------------------------------------------------------ components

  function QuotaBar(props) {
    var win = props.window;
    var remaining = win.remaining_percent;
    var reset = resetLabel(win.reset_at);
    if (remaining === null || remaining === undefined) {
      return h("div", { className: "aut-quota-row" },
        h("span", { className: "aut-quota-label" }, win.label),
        h("span", { className: "aut-quota-dim" }, win.detail || "unlimited")
      );
    }
    var tone = toneFor(remaining);
    return h("div", { className: "aut-quota" },
      h("div", { className: "aut-quota-row" },
        h("span", { className: "aut-quota-label" }, win.label),
        h("span", { className: "aut-quota-pct aut-text-" + (remaining <= 25 ? "strong" : "normal") },
          pct(remaining) + " left"),
        win.detail ? h("span", { className: "aut-quota-dim" }, win.detail) : null,
        reset ? h("span", { className: "aut-quota-dim" }, reset) : null,
        tone === "bad" || tone === "warn"
          ? h(Badge, { tone: tone === "bad" ? "destructive" : "warning" }, tone === "bad" ? "low" : "watch")
          : null
      ),
      h("div", { className: "aut-bar" },
        h("div", {
          className: "aut-bar-fill aut-bar-" + tone,
          style: { width: Math.max(1, Math.min(100, remaining)) + "%" }
        })
      )
    );
  }

  function ProviderCard(props) {
    var provider = props.provider;
    var isHidden = !!props.isHidden;
    var status = statusOf(provider);
    var quota = provider.quota || {};
    var windows = quota.windows || [];
    var details = quota.details || [];

    return h("div", { className: "aut-card" + (isHidden ? " aut-card-hidden" : "") },
      h("div", { className: "aut-card-head" },
        h("span", { className: "aut-card-name" }, provider.label),
        quota.plan ? h(Badge, { tone: "secondary" }, quota.plan) : null,
        h(Badge, { tone: status.tone }, status.label),
        provider.active ? h("span", { className: "aut-quota-dim" }, "used recently") : null,
        h("span", { className: "aut-spacer" }),
        h("button", {
          type: "button",
          className: "aut-hide-btn",
          title: isHidden ? "Show this provider again" : "Hide this provider",
          "aria-label": (isHidden ? "Unhide " : "Hide ") + provider.label,
          onClick: function () {
            if (isHidden) props.onUnhide(provider.id);
            else props.onHide(provider.id);
          }
        }, isHidden ? "👁" : "✕")
      ),
      windows.map(function (win, index) {
        return h(QuotaBar, { key: index, window: win });
      }),
      !quota.available && quota.unavailable_reason
        ? h("div", { className: "aut-quota-dim" }, quota.unavailable_reason)
        : null,
      details.map(function (detail, index) {
        return h("div", { key: "d" + index, className: "aut-quota-dim" }, detail);
      })
    );
  }

  function ProfilePicker(props) {
    if (!props.profiles || !props.profiles.length) return null;
    return h(Select, Object.assign({ value: props.value || "", className: "aut-select" },
      selectChangeHandler(props.onSelect)),
      h(SelectOption, { value: "" }, "(server profile)"),
      props.profiles.map(function (row) {
        return h(SelectOption, { key: row.name, value: row.name }, profileLabel(row));
      })
    );
  }

  function UsagePage() {
    var hiddenState = useState(function () {
      var saved = storageGet(HIDDEN_KEY, []);
      return Array.isArray(saved) ? saved.filter(function (v) { return typeof v === "string"; }) : [];
    });
    var hiddenIds = hiddenState[0];
    var setHiddenIds = hiddenState[1];
    var profileState = useState(function () {
      var saved = storageGet(PROFILE_KEY, "");
      return typeof saved === "string" ? saved : "";
    });
    var selected = profileState[0];
    var setSelected = profileState[1];
    var showHiddenState = useState(false);
    var showHidden = showHiddenState[0];
    var setShowHidden = showHiddenState[1];

    var usage = useUsage(selected);
    var data = usage.data;
    var error = usage.error;
    var fetching = usage.fetching;

    function setHidden(next) {
      setHiddenIds(next);
      storageSet(HIDDEN_KEY, next);
    }
    function hideProvider(id) {
      if (hiddenIds.indexOf(id) < 0) setHidden(hiddenIds.concat([id]));
    }
    function unhideProvider(id) {
      setHidden(hiddenIds.filter(function (v) { return v !== id; }));
    }
    function unhideAll() { setHidden([]); }
    function selectProfile(name) {
      var value = String(name || "");
      setSelected(value);
      storageSet(PROFILE_KEY, value);
    }

    var profiles = (data && data.profiles) || [];
    var shownProfile = selected || (data && data.profile) || "";
    var meta = data
      ? "fetched " + (fmtTime(data.generated_at) || "?") +
        " · probed in " + data.probe_seconds + "s" +
        (data.cached ? " · cached " + Math.round(data.cache_age_seconds || 0) + "s ago" : "")
      : "";

    var header = h("div", { className: "aut-header" },
      h("span", { className: "aut-title" }, "AI usage"),
      h("span", { className: "aut-quota-dim" }, meta),
      h("span", { className: "aut-spacer" }),
      hiddenIds.length > 0
        ? h(Button, {
            size: "sm",
            title: showHidden ? "Hide the hidden providers again" : "Show " + hiddenIds.length + " hidden provider(s)",
            onClick: function () { setShowHidden(!showHidden); }
          }, showHidden ? "Showing hidden " + hiddenIds.length : "Hidden " + hiddenIds.length)
        : null,
      showHidden && hiddenIds.length > 0
        ? h(Button, { size: "sm", onClick: unhideAll }, "Unhide all")
        : null,
      h(ProfilePicker, { profiles: profiles, value: selected, onSelect: selectProfile }),
      h(Button, {
        size: "sm",
        disabled: fetching,
        onClick: function () { usage.refresh(); }
      }, fetching ? "Refreshing…" : "Refresh")
    );

    // The header (profile picker + refresh) renders in EVERY state.
    if (error && !data) {
      return h("div", { className: "aut-page" },
        header,
        h("div", { className: "aut-error" },
          h("div", { className: "aut-error-title" }, "Could not load usage"),
          h("div", { className: "aut-quota-dim" },
            String(error) +
            " — a \"Plugin not found\" here means the backend is not enabled for this profile " +
            "(hermes plugins enable ai-usage-tracker, then restart the dashboard)."),
          h("div", null,
            h(Button, { size: "sm", onClick: function () { usage.refresh(); } }, "Retry")
          )
        )
      );
    }

    if (!data) {
      return h("div", { className: "aut-page" },
        header,
        h("div", { className: "aut-skeleton aut-skel-line" }),
        h("div", { className: "aut-skeleton aut-skel-card" }),
        h("div", { className: "aut-skeleton aut-skel-card" })
      );
    }

    var providers = data.providers || [];
    var visible = providers.filter(function (p) { return hiddenIds.indexOf(p.id) < 0; });
    var hiddenProviders = providers.filter(function (p) { return hiddenIds.indexOf(p.id) >= 0; });
    var live = visible.filter(function (p) { return p.quota && p.quota.available; }).length;

    return h("div", { className: "aut-page" },
      header,
      error && data
        ? h("div", { className: "aut-quota-dim" },
            "Showing the last good response — the refresh failed: " + String(error))
        : null,
      data.profiles
        ? null
        : h("div", { className: "aut-quota-dim" },
            "This backend is running an older copy of the plugin (no per-profile data), " +
            "so the profile picker is hidden — restart the dashboard to load the current backend."),
      h("div", { className: "aut-quota-dim" },
        profiles.length > 1
          ? providers.length + " provider(s) in " + (shownProfile || "this profile") +
            " · " + live + " reporting live quota · switch profile above to inspect another"
          : providers.length + " provider(s) · " + live + " reporting live quota"),
      h("div", { className: "aut-grid" },
        visible.map(function (provider) {
          return h(ProviderCard, {
            key: provider.id,
            provider: provider,
            onHide: hideProvider,
            onUnhide: unhideProvider
          });
        }),
        showHidden
          ? hiddenProviders.map(function (provider) {
              return h(ProviderCard, {
                key: "hidden-" + provider.id,
                provider: provider,
                isHidden: true,
                onHide: hideProvider,
                onUnhide: unhideProvider
              });
            })
          : null,
        visible.length === 0
          ? h("div", { className: "aut-empty" },
              h("div", { className: "aut-error-title" },
                providers.length ? "Every provider is hidden" : "No providers to show"),
              h("div", { className: "aut-quota-dim" },
                providers.length
                  ? "Use \"Hidden " + hiddenProviders.length + "\" above to bring them back."
                  : "This profile has no provider credentials and no recent usage.")
            )
          : null
      ),
      h("div", { className: "aut-quota-dim" },
        "✕ on a card hides that provider (persisted locally) · quota comes from each provider's " +
        "own API using this profile's credentials — no secrets leave the backend.")
    );
  }

  window.__HERMES_PLUGINS__.register(ID, UsagePage);
})();
