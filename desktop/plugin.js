/**
 * AI Usage Tracker — live subscription quota for every AI provider Hermes can
 * route to, per profile, in the Hermes desktop.
 *
 * Scope (deliberately narrow): subscription quota windows only — provider,
 * plan, window, % remaining, reset countdown. No token counting, no cost
 * estimates, no time-window filters.
 *
 * Backend: ~/.hermes/plugins/ai-usage-tracker/dashboard/plugin_api.py
 * Read-only. No secrets ever reach the UI.
 */
import {
  Badge,
  Button,
  Codicon,
  EmptyState,
  ErrorState,
  ROUTES_AREA,
  STATUSBAR_AREAS,
  SIDEBAR_NAV_AREA,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Separator,
  Skeleton,
  atom,
  cn,
  haptic,
  host,
  useQuery,
  useValue
} from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useState } from 'react'

const ID = 'ai-usage-tracker'
const ROUTE = '/ai-usage'
const REFRESH_PAGE_MS = 120_000
const REFRESH_CHIP_MS = 300_000

let rest = null
let storage = null
let pendingRefresh = false

// Providers the user has hidden — plugin-scoped, shared by page and chip.
const HIDDEN_KEY = 'hidden-providers-v1'
const $hidden = atom([])

// Selected profile — plugin-scoped, shared by page and chip. Empty means
// "whatever this backend runs as".
const PROFILE_KEY = 'selected-profile-v1'
const $profile = atom('')

// Which provider the status-bar chip watches. Empty = AUTO: the worst remaining
// window across every visible provider (the historical default). A provider id
// pins the chip to that provider's own worst window; the page writes it.
const CHIP_KEY = 'chip-provider-v1'
const AUTO_CHIP = 'auto'
const $chipProvider = atom('')

function selectChipProvider(id) {
  const value = String(id || '')
  $chipProvider.set(value)
  try {
    storage?.set(CHIP_KEY, value)
  } catch {
    /* in-memory selection still works for this session */
  }
}

function persistHidden(ids) {
  $hidden.set(ids)
  try {
    storage?.set(HIDDEN_KEY, ids)
  } catch {
    /* keep the in-memory list when storage is unavailable */
  }
}

function hideProvider(id) {
  const current = $hidden.get()
  if (!current.includes(id)) persistHidden([...current, id])
}

function unhideProvider(id) {
  persistHidden($hidden.get().filter(value => value !== id))
}

function unhideAll() {
  persistHidden([])
}

function selectProfile(name) {
  const value = String(name || '')
  $profile.set(value)
  try {
    storage?.set(PROFILE_KEY, value)
  } catch {
    /* in-memory selection still works for this session */
  }
}

// ---------------------------------------------------------------- formatters

// Timestamps render in the profile's Hermes timezone (the backend's `timezone`
// field), never a hardcoded one. An empty/missing zone means "this machine's own
// zone", which is what a browser left to its defaults already gives us.
const _stampFormats = new Map()

function stampFormat(tz) {
  const key = typeof tz === 'string' ? tz.trim() : ''
  const cached = _stampFormats.get(key)
  if (cached) return cached
  const options = {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
    timeZoneName: 'short'
  }
  let formatter
  try {
    formatter = new Intl.DateTimeFormat(undefined, key ? { ...options, timeZone: key } : options)
  } catch {
    // A stale or unsupported IANA name must not sink the page — use the local zone.
    formatter = new Intl.DateTimeFormat(undefined, options)
  }
  _stampFormats.set(key, formatter)
  return formatter
}

/** `08 Nov, 02:49 pm AEDT` — the locale's own date/time order plus the zone
 *  abbreviation, so the label never claims a zone it isn't showing. */
function fmtWhen(iso, tz) {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const parts = stampFormat(tz).formatToParts(d)
  const zone = parts.find(part => part.type === 'timeZoneName')?.value || ''
  const stamp = parts
    .filter(part => part.type !== 'timeZoneName')
    .map(part => part.value)
    .join('')
    .trim()
    .replace(/[,\s]+$/, '')
  return zone ? `${stamp} ${zone}` : stamp
}

function resetLabel(iso, tz) {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const seconds = Math.round((d.getTime() - Date.now()) / 1000)
  if (seconds <= 0) return 'resets now'
  const days = Math.floor(seconds / 86_400)
  const hours = Math.floor((seconds % 86_400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rel = days ? `in ${days}d ${hours}h` : hours ? `in ${hours}h ${minutes}m` : `in ${minutes}m`
  return `resets ${rel} · ${fmtWhen(iso, tz)}`
}

function pct(value) {
  if (value === null || value === undefined) return '—'
  return `${Math.round(Number(value))}%`
}

function toneFor(remaining) {
  if (remaining === null || remaining === undefined) return 'muted'
  if (remaining <= 5) return 'bad'
  if (remaining <= 25) return 'warn'
  return 'good'
}

function statusOf(provider) {
  if (provider.quota?.available) return { variant: 'success', label: 'live quota' }
  if (provider.quota?.unavailable_reason) return { variant: 'muted', label: 'no quota' }
  return { variant: 'muted', label: 'unavailable' }
}

function profileLabel(row) {
  if (!row) return 'profile'
  return `${row.name}${row.is_default ? ' · default' : ''}${row.gateway_running ? ' · up' : ''}`
}

/** Worst (lowest) remaining percent across visible providers' windows — drives the chip. */
/** One provider's tightest numeric window, or null when it reports none. */
function worstWindowOf(provider) {
  let worst = null
  for (const window of provider?.quota?.windows || []) {
    const remaining = window.remaining_percent
    if (remaining === null || remaining === undefined) continue
    if (worst === null || remaining < worst.remaining) {
      worst = {
        remaining,
        provider: provider.label,
        window: window.label,
        reset_at: window.reset_at || null
      }
    }
  }
  return worst
}

/** AUTO pick: the tightest window across every provider that isn't hidden. */
function worstRemaining(payload, hiddenIds) {
  const hidden = hiddenIds || []
  let worst = null
  for (const provider of payload?.providers || []) {
    if (hidden.includes(provider.id)) continue
    const candidate = worstWindowOf(provider)
    if (candidate && (worst === null || candidate.remaining < worst.remaining)) worst = candidate
  }
  return worst
}

// ---------------------------------------------------------------- data hooks

function usagePath(profile, refresh) {
  const params = []
  if (profile) params.push(`profile=${encodeURIComponent(profile)}`)
  if (refresh) params.push('refresh=1')
  return params.length ? `/usage?${params.join('&')}` : '/usage'
}

function useUsage(profile, intervalMs) {
  return useQuery({
    queryKey: ['ai-usage-tracker', 'usage', profile || 'server'],
    queryFn: () => {
      const refresh = pendingRefresh
      pendingRefresh = false
      return rest(usagePath(profile, refresh))
    },
    refetchInterval: intervalMs,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
    staleTime: 30_000,
    retry: 1,
    // Switching profile must never blank the page or drop the picker.
    placeholderData: previous => previous
  })
}

// ---------------------------------------------------------------- components

function QuotaBar({ window, tz }) {
  const remaining = window.remaining_percent
  if (remaining === null || remaining === undefined) {
    return jsxs('div', {
      className: 'flex items-baseline gap-2 text-xs',
      children: [
        jsx('span', { className: 'w-28 shrink-0 text-(--ui-text-tertiary)', children: window.label }),
        jsx('span', { className: 'text-(--ui-text-quaternary)', children: window.detail || 'unlimited' })
      ]
    })
  }
  const tone = toneFor(remaining)
  return jsxs('div', {
    className: 'flex flex-col gap-1',
    children: [
      jsxs('div', {
        className: 'flex flex-wrap items-baseline gap-2 text-xs',
        children: [
          jsx('span', { className: 'w-28 shrink-0 text-(--ui-text-tertiary)', children: window.label }),
          jsx('span', {
            className: cn('font-medium tabular-nums', remaining <= 25 ? 'text-(--ui-text-primary)' : 'text-(--ui-text-secondary)'),
            children: `${pct(remaining)} left`
          }),
          window.detail ? jsx('span', { className: 'text-(--ui-text-quaternary)', children: window.detail }) : null,
          resetLabel(window.reset_at, tz)
            ? jsx('span', { className: 'text-(--ui-text-quaternary)', children: resetLabel(window.reset_at, tz) })
            : null,
          tone === 'bad' || tone === 'warn'
            ? jsx(Badge, { variant: tone === 'bad' ? 'destructive' : 'warn', size: 'xs', children: tone === 'bad' ? 'low' : 'watch' })
            : null
        ]
      }),
      jsx('div', {
        className: 'h-1.5 w-full overflow-hidden rounded-[2px]',
        style: { background: 'var(--ui-stroke-secondary)' },
        children: jsx('div', {
          className: 'h-full rounded-[2px]',
          style: { width: `${Math.max(1, Math.min(100, remaining))}%`, background: 'var(--ui-accent)' }
        })
      })
    ]
  })
}

function ProviderCard({ provider, isHidden, tz }) {
  const status = statusOf(provider)
  const windows = provider.quota?.windows || []
  const details = provider.quota?.details || []

  return jsxs('div', {
    className: cn(
      'flex flex-col gap-2 rounded-[5px] border border-(--ui-stroke-secondary) p-3',
      isHidden && 'opacity-60'
    ),
    children: [
      jsxs('div', {
        className: 'flex items-center gap-2',
        children: [
          jsx('span', { className: 'text-sm font-medium', children: provider.label }),
          provider.quota?.plan
            ? jsx(Badge, { variant: 'muted', size: 'xs', children: provider.quota.plan })
            : null,
          jsx(Badge, { variant: status.variant, size: 'xs', children: status.label }),
          provider.active
            ? jsx('span', { className: 'text-[0.6875rem] text-(--ui-text-quaternary)', children: 'used recently' })
            : null,
          jsx('span', { className: 'flex-1' }),
          jsx('button', {
            type: 'button',
            title: isHidden ? 'Show this provider again' : 'Hide this provider',
            'aria-label': isHidden ? `Unhide ${provider.label}` : `Hide ${provider.label}`,
            className: 'shrink-0 px-1 text-(--ui-text-quaternary) hover:text-(--ui-text-secondary)',
            onClick: () => {
              haptic('tap')
              if (isHidden) unhideProvider(provider.id)
              else hideProvider(provider.id)
            },
            children: jsx(Codicon, { name: isHidden ? 'eye' : 'close' })
          })
        ]
      }),
      windows.map((window, index) => jsx(QuotaBar, { window, tz }, index)),
      !provider.quota?.available && provider.quota?.unavailable_reason
        ? jsx('div', { className: 'text-[0.6875rem] text-(--ui-text-quaternary)', children: provider.quota.unavailable_reason })
        : null,
      details.map((detail, index) =>
        jsx('div', { className: 'text-[0.6875rem] text-(--ui-text-quaternary)', children: detail }, index)
      )
    ]
  })
}

function ProfilePicker({ profiles, value, onSelect }) {
  if (!profiles.length) return null
  return jsxs(Select, {
    value: value || undefined,
    onValueChange: onSelect,
    children: [
      jsx(SelectTrigger, {
        className: 'h-6 w-44 text-[0.6875rem]',
        'aria-label': 'Hermes profile',
        children: jsx(SelectValue, { placeholder: 'profile…' })
      }),
      jsx(SelectContent, {
        children: profiles.map(row => jsx(SelectItem, { value: row.name, children: profileLabel(row) }, row.name))
      })
    ]
  })
}

/** Picks which provider the status-bar chip watches. AUTO_CHIP keeps the
 *  historical behaviour (worst window across all visible providers); hidden
 *  providers aren't offered because the chip skips them either way. */
function ChipPicker({ providers, value, onSelect }) {
  return jsxs(Select, {
    value: value || AUTO_CHIP,
    onValueChange: next => {
      haptic('tap')
      onSelect(next === AUTO_CHIP ? '' : next)
    },
    children: [
      jsx(SelectTrigger, {
        className: 'h-6 w-56 text-[0.6875rem]',
        title: 'Which provider the status-bar chip shows',
        'aria-label': 'Status bar chip provider',
        children: jsx(SelectValue, {})
      }),
      jsx(SelectContent, {
        children: [
          jsx(SelectItem, { value: AUTO_CHIP, children: 'Auto (Lowest %)' }, AUTO_CHIP),
          ...providers.map(provider =>
            jsx(SelectItem, { value: provider.id, children: provider.label }, provider.id)
          )
        ]
      })
    ]
  })
}

function PageHeader({ profiles, profile, setProfile, chipProviders, chipProvider, setChipProvider, isFetching, refetch, meta, hiddenCount, showHidden, setShowHidden }) {
  return jsxs('div', {
    className: 'flex flex-wrap items-center gap-2',
    children: [
      jsx('span', { className: 'text-sm font-medium', children: 'AI usage' }),
      jsx('span', {
        className: 'text-[0.6875rem] text-(--ui-text-quaternary)',
        children: meta || ''
      }),
      jsx('span', { className: 'flex-1' }),
      hiddenCount > 0
        ? jsxs(Button, {
            variant: 'ghost',
            title: showHidden ? 'Hide the hidden providers again' : `Show ${hiddenCount} hidden provider(s)`,
            onClick: () => {
              haptic('tap')
              setShowHidden(!showHidden)
            },
            children: [
              jsx(Codicon, { name: 'eye' }),
              jsx('span', { children: showHidden ? `Showing hidden ${hiddenCount}` : `Hidden ${hiddenCount}` })
            ]
          })
        : null,
      showHidden && hiddenCount > 0
        ? jsx(Button, {
            variant: 'text',
            onClick: () => {
              haptic('tap')
              unhideAll()
            },
            children: 'Unhide all'
          })
        : null,
      jsx('span', { className: 'text-[0.6875rem] text-(--ui-text-quaternary)', children: 'Status Bar:' }),
      jsx(ChipPicker, { providers: chipProviders, value: chipProvider, onSelect: setChipProvider }),
      jsx(ProfilePicker, { profiles, value: profile, onSelect: setProfile }),
      jsxs(Button, {
        variant: 'secondary',
        onClick: () => {
          haptic('tap')
          pendingRefresh = true
          refetch()
        },
        disabled: isFetching,
        children: [jsx(Codicon, { name: 'refresh' }), jsx('span', { children: isFetching ? 'Refreshing…' : 'Refresh' })]
      })
    ]
  })
}

function UsagePage() {
  const [showHidden, setShowHidden] = useState(false)
  const hiddenIds = useValue($hidden)
  const selected = useValue($profile)
  const { data, error, isFetching, refetch } = useUsage(selected, REFRESH_PAGE_MS)

  const chipProvider = useValue($chipProvider)
  const profiles = data?.profiles || []
  const tz = data?.timezone || ''
  const shownProfile = selected || data?.profile || ''
  const header = jsx(PageHeader, {
    profiles,
    profile: shownProfile,
    setProfile: selectProfile,
    chipProviders: (data?.providers || []).filter(provider => !hiddenIds.includes(provider.id)),
    chipProvider,
    setChipProvider: selectChipProvider,
    isFetching,
    refetch,
    hiddenCount: hiddenIds.length,
    showHidden,
    setShowHidden,
    meta: data ? `fetched ${fmtWhen(data.generated_at, tz)} · probed in ${data.probe_seconds}s` : null
  })

  // The header (profile picker + refresh) renders in EVERY state.
  if (error && !data) {
    return jsxs('div', {
      className: 'flex flex-col gap-3 p-4',
      children: [
        header,
        jsx(ErrorState, {
          title: 'Could not load usage',
          description: `${error?.message || error} — a "Plugin not found" here means the backend is not enabled for this profile (hermes --profile <name> plugins enable ai-usage-tracker, then relaunch the app).`,
          children: jsx(Button, { variant: 'secondary', onClick: () => refetch(), children: 'Retry' })
        })
      ]
    })
  }
  if (!data) {
    return jsxs('div', {
      className: 'flex flex-col gap-3 p-4',
      children: [
        header,
        jsx(Skeleton, { className: 'h-6 w-48' }),
        jsx(Skeleton, { className: 'h-24 w-full' }),
        jsx(Skeleton, { className: 'h-24 w-full' })
      ]
    })
  }

  const providers = data.providers || []
  const visible = providers.filter(provider => !hiddenIds.includes(provider.id))
  const hiddenProviders = providers.filter(provider => hiddenIds.includes(provider.id))
  const live = visible.filter(provider => provider.quota?.available).length

  return jsxs(ScrollArea, {
    className: 'h-full',
    children: jsxs('div', {
      className: 'flex flex-col gap-3 p-4',
      children: [
        header,
        error && data
          ? jsx('div', {
              className: 'text-[0.6875rem] text-(--ui-text-quaternary)',
              children: `Showing the last good response — the refresh failed: ${error?.message || error}`
            })
          : null,
        // A backend started before this plugin version still serves the old
        // payload shape (no per-profile data) — say so instead of silently
        // rendering a page with no picker.
        data.profiles
          ? null
          : jsx('div', {
              className: 'text-[0.6875rem] text-(--ui-text-quaternary)',
              children: 'This backend is running an older copy of the plugin (no per-profile data), so the profile picker is hidden — quit and relaunch the Hermes desktop app to load the current backend.'
            }),
        jsx('div', {
          className: 'text-[0.6875rem] text-(--ui-text-quaternary)',
          children: profiles.length > 1
            ? `${providers.length} provider(s) in ${shownProfile || 'this profile'} · ${live} reporting live quota · switch profile above to inspect another`
            : `${providers.length} provider(s) · ${live} reporting live quota`
        }),
        jsx(Separator, {}),
        jsxs('div', {
          className: 'flex flex-col gap-2',
          children: [
            visible.map((provider, index) => jsx(ProviderCard, { provider, tz }, index)),
            showHidden
              ? hiddenProviders.map((provider, index) => jsx(ProviderCard, { provider, isHidden: true, tz }, `hidden-${index}`))
              : null,
            visible.length === 0
              ? jsx(EmptyState, {
                  title: providers.length ? 'Every provider is hidden' : 'No providers to show',
                  description: providers.length
                    ? `Use "Hidden ${hiddenProviders.length}" above to bring them back.`
                    : 'This profile has no provider credentials and no recent usage.'
                })
              : null
          ]
        }),
        jsx('div', {
          className: 'text-[0.6875rem] text-(--ui-text-quaternary)',
          children: '✕ on a card hides that provider (persisted, and excluded from the status-bar chip) · quota comes from each provider\'s own API using this profile\'s credentials.'
        })
      ]
    })
  })
}

function UsageChip() {
  const hiddenIds = useValue($hidden)
  const selected = useValue($profile)
  const pinnedId = useValue($chipProvider)
  const { data } = useUsage(selected, REFRESH_CHIP_MS)

  // A pin only wins while it resolves to a visible provider with a numeric
  // window; hidden, absent for this profile, or quota-less falls back to AUTO
  // instead of blanking the chip.
  const visible = (data?.providers || []).filter(provider => !(hiddenIds || []).includes(provider.id))
  const pinned = pinnedId ? visible.find(provider => provider.id === pinnedId) : null
  const worst = (pinned ? worstWindowOf(pinned) : null) || worstRemaining(data, hiddenIds)
  const tone = toneFor(worst ? worst.remaining : null)
  const detail = worst
    ? [worst.provider, worst.window ? `${worst.window} window` : null, resetLabel(worst.reset_at, data?.timezone)]
        .filter(Boolean)
        .join(' · ')
    : 'AI usage'

  return jsx('button', {
    type: 'button',
    title: `${detail}${pinned ? ' (pinned on the AI usage page)' : ''}`,
    'aria-label': `AI usage: ${detail}`,
    className: 'px-1.5 text-[0.6875rem] text-(--ui-text-tertiary) hover:text-(--ui-text-secondary)',
    onClick: () => {
      haptic('tap')
      host.navigate(ROUTE)
    },
    children: jsxs('span', {
      className: 'inline-flex items-center gap-1.5',
      children: [
        jsx('span', {
          'aria-hidden': true,
          className: 'inline-block size-1.5 rounded-full',
          style: {
            background:
              tone === 'bad'
                ? 'var(--ui-accent)'
                : tone === 'warn'
                  ? 'var(--ui-text-secondary)'
                  : 'var(--ui-text-quaternary)'
          }
        }),
        jsx('span', { children: worst ? `${pct(worst.remaining)} · ${worst.provider}` : data ? 'AI usage' : 'AI usage…' })
      ]
    })
  })
}

export default {
  id: ID,
  name: 'AI Usage Tracker',
  register(ctx) {
    rest = ctx.rest
    storage = ctx.storage
    try {
      const saved = storage?.get(HIDDEN_KEY, [])
      if (Array.isArray(saved)) $hidden.set(saved.filter(value => typeof value === 'string'))
    } catch {
      /* a malformed stored list must not block the plugin from loading */
    }
    try {
      const savedChip = storage?.get(CHIP_KEY, '')
      if (typeof savedChip === 'string') $chipProvider.set(savedChip)
    } catch {
      /* fall through to AUTO */
    }
    try {
      const savedProfile = storage?.get(PROFILE_KEY, '')
      if (typeof savedProfile === 'string' && savedProfile) {
        $profile.set(savedProfile)
      } else {
        // First run: default to the profile the app itself is on.
        const active = host.state.profile?.get?.()
        if (typeof active === 'string' && active) $profile.set(active)
      }
    } catch {
      /* fall through to the backend's own profile */
    }

    ctx.register({
      id: 'page',
      area: ROUTES_AREA,
      data: { path: ROUTE },
      render: () => jsx(UsagePage, {})
    })

    ctx.register({
      id: 'nav',
      area: SIDEBAR_NAV_AREA,
      data: { path: ROUTE, label: 'AI usage', codicon: 'graph' }
    })

    ctx.register({
      id: 'chip',
      area: STATUSBAR_AREAS.right,
      order: 125,
      render: () => jsx(UsageChip, {})
    })
  }
}
