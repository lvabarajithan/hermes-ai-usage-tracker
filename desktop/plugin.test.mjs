import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

// Exercise the registered chip with SDK/React stubs, not provider credentials or
// the Python backend. These are rendering tests, not polling/lifecycle tests.
async function chipHarness(initialQuery, saved = {}) {
  let query = initialQuery
  const contributions = []
  const navigations = []
  const context = vm.createContext({ Date, Math, Number, String, encodeURIComponent })
  const source = readFileSync(new URL('./plugin.js', import.meta.url), 'utf8')
  const module = new vm.SourceTextModule(source, { context })
  const atom = initial => {
    let value = initial
    return { get: () => value, set: next => { value = next } }
  }
  const sdk = {
    atom,
    cn: (...values) => values.filter(Boolean).join(' '),
    haptic() {},
    host: { state: { profile: atom('default') }, navigate: route => navigations.push(route) },
    useQuery: () => query,
    useValue: value => value.get(),
    ROUTES_AREA: 'routes',
    SIDEBAR_NAV_AREA: 'sidebar.nav',
    STATUSBAR_AREAS: { right: 'statusBar.right' }
  }
  for (const name of ['Badge', 'Button', 'Codicon', 'EmptyState', 'ErrorState', 'ScrollArea', 'Select',
    'SelectContent', 'SelectItem', 'SelectTrigger', 'SelectValue', 'Separator', 'Skeleton']) {
    sdk[name] = name
  }
  const jsx = (type, props) => typeof type === 'function' ? type(props) : { type, props }
  const imports = {
    '@hermes/plugin-sdk': sdk,
    'react/jsx-runtime': { jsx, jsxs: jsx },
    react: { useState: initial => [initial, () => {}] }
  }
  await module.link(specifier => {
    assert.ok(Object.hasOwn(imports, specifier), `Unexpected import: ${specifier}`)
    const values = imports[specifier]
    return new vm.SyntheticModule(Object.keys(values), function () {
      for (const [key, value] of Object.entries(values)) this.setExport(key, value)
    }, { context })
  })
  await module.evaluate()
  module.namespace.default.register({
    register: contribution => contributions.push(contribution),
    rest: async () => { throw new Error('The rendering harness must not call a backend') },
    storage: { get: (key, fallback) => saved[key] ?? fallback }
  })
  const chip = contributions.find(c => c.area === 'statusBar.right')
  assert.ok(chip, 'Plugin must register a status-bar chip')
  return { render: () => chip.render(), setQuery: next => { query = next }, navigations }
}

const provider = (id, remaining) => ({
  id, label: id === 'anthropic' ? 'Claude' : 'Codex',
  quota: { available: true, windows: [{ label: 'Weekly', remaining_percent: remaining }] }
})
const payload = (...providers) => ({ providers })
const labelOf = tree => tree.props.children.props.children[1].props.children
const dotColor = tree => tree.props.children.props.children[0].props.style.background

 test('successful chip retains numeric allowance, including a reached limit', async () => {
  const harness = await chipHarness({ data: payload(provider('anthropic', 25)) })
  assert.equal(labelOf(harness.render()), '25% · Claude')
  harness.setQuery({ data: payload(provider('anthropic', 0)) })
  assert.equal(labelOf(harness.render()), '0% · Claude')
})

test('initial loading keeps its existing label', async () => {
  const harness = await chipHarness({ data: undefined, error: null })
  assert.equal(labelOf(harness.render()), 'AI usage…')
})

test('failed initial read reports unavailable rather than loading indefinitely', async () => {
  const harness = await chipHarness({ data: undefined, error: new Error('offline') })
  const tree = harness.render()
  assert.equal(labelOf(tree), 'AI usage unavailable')
  assert.match(tree.props.title, /refresh failed/i)
  assert.match(tree.props['aria-label'], /unavailable/i)
})

test('failed refresh labels retained percentages stale in text, tooltip and accessibility label', async () => {
  const harness = await chipHarness({ data: payload(provider('anthropic', 25)), error: new Error('offline') })
  const tree = harness.render()
  assert.equal(labelOf(tree), '25% · Claude (stale)')
  assert.match(tree.props.title, /stale.*refresh failed/i)
  assert.match(tree.props['aria-label'], /stale.*refresh failed/i)
  assert.equal(dotColor(tree), 'var(--ui-text-quaternary)')
})

test('failed refresh with retained empty data has no fabricated percentage', async () => {
  const harness = await chipHarness({ data: payload(), error: new Error('offline') })
  const tree = harness.render()
  assert.equal(labelOf(tree), 'AI usage unavailable')
  assert.doesNotMatch(labelOf(tree), /\d+%/)
  assert.match(tree.props.title, /refresh failed/i)
})

test('a later successful read removes stale state without re-registering', async () => {
  const data = payload(provider('anthropic', 25))
  const harness = await chipHarness({ data })
  assert.equal(labelOf(harness.render()), '25% · Claude')
  harness.setQuery({ data, error: new Error('offline') })
  assert.match(labelOf(harness.render()), /stale/)
  harness.setQuery({ data: payload(provider('anthropic', 60)), error: null })
  const recovered = harness.render()
  assert.equal(labelOf(recovered), '60% · Claude')
  assert.doesNotMatch(recovered.props.title, /stale|refresh failed/i)
  assert.doesNotMatch(recovered.props['aria-label'], /stale|refresh failed/i)
})

test('stale display preserves pin, hidden providers and navigation', async () => {
  const data = payload(provider('anthropic', 5), provider('openai-codex', 80))
  const harness = await chipHarness({ data, error: new Error('offline') }, {
    'chip-provider-v1': 'openai-codex',
    'hidden-providers-v1': ['anthropic']
  })
  const tree = harness.render()
  assert.equal(labelOf(tree), '80% · Codex (stale)')
  assert.match(tree.props.title, /pinned/i)
  tree.props.onClick()
  assert.deepEqual(harness.navigations, ['/ai-usage'])
})
