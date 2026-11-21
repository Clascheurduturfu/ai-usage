import { APP_DISPLAY_VERSION, displayVersion } from '../../../shared/version'
import { useEffect, useRef, useState } from 'react'
import { Check, FolderOpen, Plus, RefreshCw, RotateCcw, Save, ShieldCheck, Smartphone, Trash2 } from 'lucide-react'
import type { ModelPrice, PriceCatalogEntry, Settings } from '../../../shared/types'
import { PROVIDER_IDS, PROVIDER_NAMES } from '../../../shared/types'
import { useApp } from '../App'
import { api } from '../lib/ipc'
import { fmtUsd } from '../lib/format'
import { Btn, Field, Panel, Table } from '../components/ui'
import { UpdatesPanel } from '../components/UpdatesPanel'

const TABS = ['General', 'Plans', 'Data sources', 'Android sync', 'Pricing'] as const
type Tab = typeof TABS[number]
export default function SettingsPage(): React.ReactElement | null {
  const { settings } = useApp()
  return settings ? <SettingsForm initial={settings} /> : <div className="page"><div className="skeleton h-80" /></div>
}
function SettingsForm({ initial }: { initial: Settings }): React.ReactElement {
  const { meta, busy, runAction, overview } = useApp()
  const [draft, setDraft] = useState<Settings>(initial)
  const [tab, setTab] = useState<Tab>('General')
  const [catalog, setCatalog] = useState<PriceCatalogEntry[]>([])
  const [catalogError, setCatalogError] = useState<string | null>(null)
  const [priceSearch, setPriceSearch] = useState('')
  const [confirmRebuild, setConfirmRebuild] = useState(false)
  const [newPrice, setNewPrice] = useState({ model: '', input: '', output: '', cacheRead: '', cacheWrite: '' })
  const [priceError, setPriceError] = useState<string | null>(null)
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial)
  const priceLabel = (value: number | undefined): string => value === undefined ? '—' : `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`
  const filteredCatalog = catalog.filter(c => `${c.label} ${c.note ?? ''}`.toLowerCase().includes(priceSearch.trim().toLowerCase()))
  const previousSettings = useRef(initial)
  useEffect(() => {
    const previous = previousSettings.current
    previousSettings.current = initial
    setDraft((current) => JSON.stringify(current) === JSON.stringify(previous) ? initial : current)
  }, [initial])
  useEffect(() => {
    void api().getPriceCatalog().then(setCatalog).catch((e) => setCatalogError(String(e)))
  }, [])
  const patch = (p: Partial<Settings>): void => setDraft((d) => ({ ...d, ...p }))
  const save = (): void => { void runAction('save', async () => { setDraft(await api().setSettings(draft)) }, 'Settings saved.') }
  const addPrice = (): void => {
    if (!newPrice.model.trim() || newPrice.input === '' || newPrice.output === '') { setPriceError('Add a model ID and input/output prices.'); return }
    const price: Partial<ModelPrice> = {}
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) {
      if (!newPrice[key]) continue
      const value = Number(newPrice[key])
      if (!Number.isFinite(value) || value < 0) { setPriceError('Prices must be positive numbers or zero.'); return }
      price[key] = value
    }
    patch({ pricingOverrides: { ...draft.pricingOverrides, [newPrice.model.trim()]: price } })
    setNewPrice({ model: '', input: '', output: '', cacheRead: '', cacheWrite: '' }); setPriceError(null)
  }
  return <div className="page" style={{ maxWidth: 1200 }}>
    <div className="page-heading"><div><div className="eyebrow">MAKE IT WORK FOR YOU</div><h1>Settings<span className="brand-dot">.</span></h1><p>Adjust your workspace, plans and data connections.</p></div><span className="muted text-[11px]">AI Usage · v{meta?.version ? displayVersion(meta.version) : APP_DISPLAY_VERSION}</span></div>
    <nav className="settings-tabs" aria-label="Settings sections">{TABS.map((t) => <button key={t} aria-current={tab === t ? 'page' : undefined} className={tab === t ? 'selected' : ''} onClick={() => setTab(t)}>{t}</button>)}</nav>
    {tab === 'General' && <>
      <UpdatesPanel />
      <Panel className="settings-panel"><h2>Your workspace</h2><p>Choose how AI Usage looks and when it starts.</p>
        <div className="setting-row"><div><strong>Appearance</strong><p>Dark, light, or follow your system preference.</p></div><select aria-label="Theme" value={draft.theme} onChange={(e) => patch({ theme: e.target.value as Settings['theme'] })}><option value="dark">Dark</option><option value="light">Light</option><option value="system">Follow system</option></select></div>
        <label className="setting-row"><div><strong>Launch at login</strong><p>Start monitoring automatically when you sign in to your computer.</p></div><input type="checkbox" checked={draft.launchAtLogin} onChange={(e) => patch({ launchAtLogin: e.target.checked })} /></label>
        <label className="setting-row"><div><strong>Start in the system tray</strong><p>Keep the dashboard out of the way on startup.</p></div><input type="checkbox" checked={draft.startMinimized} onChange={(e) => patch({ startMinimized: e.target.checked })} /></label>
      </Panel><Panel className="settings-panel"><h2 className="flex items-center gap-2"><ShieldCheck size={17} />Your data, explained</h2><p>Usage history is read from local tool logs and stored on this device. Quotas use existing tool sign-ins to fetch provider data. Android sync shares a compact quota snapshot only when you enable it. No telemetry.</p><div className="privacy-note">Subscription usage has no per-call bill. Costs shown are API-equivalent estimates, except provider-recorded amounts where available. Closing the window keeps monitoring in the tray; choose Quit from the tray menu to stop it.</div></Panel>
    </>}
    {tab === 'Plans' && <>
      <Panel className="settings-panel"><h2>Claude Code estimates</h2><p>Claude does not report an exact balance here. These community token limits provide an estimate; actual capacity can differ. Pin the estimate on Overview using Customize.</p><div className="settings-form">
        <Field label="Claude plan"><select value={draft.claudePlan} onChange={(e) => { const plan = e.target.value as Settings['claudePlan']; patch({ claudePlan: plan, claude5hLimit: { pro: 45000, max5: 160000, max20: 400000, custom: draft.claude5hLimit }[plan] }) }}><option value="pro">Pro</option><option value="max5">Max 5x</option><option value="max20">Max 20x</option><option value="custom">Custom</option></select></Field>
        <Field label="5-hour token limit" hint="Zero disables the estimate"><input type="number" min="0" value={draft.claude5hLimit} onChange={(e) => patch({ claude5hLimit: Number(e.target.value) })} /></Field>
        <Field label="Weekly token limit" hint="Optional; leave empty to hide"><input type="number" min="0" value={draft.claudeWeeklyLimit ?? ''} onChange={(e) => patch({ claudeWeeklyLimit: e.target.value === '' ? null : Number(e.target.value) })} /></Field>
      </div></Panel><Panel className="settings-panel"><h2>OpenRouter monthly allowance</h2><p>Set your BYOK allowance for the month. Spend is fetched from OpenRouter; this limit is configured by you.</p><div className="settings-form"><Field label="Monthly allowance (USD)" hint="Zero disables the allowance card’s balance"><input type="number" min="0" step="0.01" value={draft.openrouterByokMonthlyAllowance} onChange={(e) => patch({ openrouterByokMonthlyAllowance: Number(e.target.value) })} /></Field></div></Panel>
      <OpenRouterKeyPanel />
    </>}
    {tab === 'Data sources' && <>
      <Panel className="settings-panel"><h2>Local tool folders</h2><p>Leave a folder empty to use its default location. Saving a changed folder updates monitoring and starts a scan.</p>{PROVIDER_IDS.map((id) => <div className="source-editor" key={id}><label htmlFor={`path-${id}`}>{PROVIDER_NAMES[id]}</label><div><input id={`path-${id}`} placeholder="Auto-detected default" value={draft.paths[id] ?? ''} onChange={(e) => patch({ paths: { ...draft.paths, [id]: e.target.value } })} /><Btn disabled={!!busy} onClick={() => void runAction('browse', async () => { const folder = await api().pickFolder(); if (folder) setDraft((d) => ({ ...d, paths: { ...d.paths, [id]: folder } })) })}>Browse</Btn><Btn title="Use default folder" disabled={!draft.paths[id]} onClick={() => patch({ paths: { ...draft.paths, [id]: '' } })}><RotateCcw size={13} /></Btn></div></div>)}</Panel>
      <Panel className="settings-panel"><h2>Local index</h2><p>Scans import new usage without changing your tools’ logs. A rebuild clears only the derived index and reads your source logs again.</p><div className="flex flex-wrap gap-3"><Btn disabled={!!busy || overview?.scan.scanning} onClick={() => void runAction('scan', () => api().fullRescan(), 'Local usage refreshed.')}><RefreshCw size={14} />Scan now</Btn><Btn disabled={!!busy} onClick={() => setConfirmRebuild((v) => !v)}><RotateCcw size={14} />Rebuild index</Btn><Btn disabled={!!busy || !meta} onClick={() => void runAction('folder', async () => { const error = await api().openPath(meta!.userDataPath); if (error) throw new Error(error) })}><FolderOpen size={14} />App data folder</Btn></div>{confirmRebuild && <div className="danger-confirm"><span>This may take a few minutes. Settings and source logs are kept.</span><Btn disabled={!!busy} onClick={() => setConfirmRebuild(false)}>Cancel</Btn><Btn disabled={!!busy} onClick={() => void runAction('rebuild', async () => { await api().reindex(); setConfirmRebuild(false) }, 'Usage index rebuilt.')} variant="primary">Rebuild now</Btn></div>}<p className="privacy-note mt-5 break-all">{meta?.appDbPath}</p></Panel>
    </>}
    {tab === 'Android sync' && <Panel className="settings-panel"><h2 className="flex items-center gap-2"><Smartphone size={17} />Take your quotas with you</h2><p>Publish a compact quota snapshot after each quota refresh, about every 30 minutes. Use the same server and topic in the Android companion’s settings. Leave the topic empty to keep sync off.</p><div className="settings-form">
      <Field label="ntfy server"><input value={draft.ntfyServer} placeholder="https://ntfy.sh" onChange={(e) => patch({ ntfyServer: e.target.value })} /></Field>
      <Field label="Topic" hint="Choose an unguessable topic; empty means disabled"><input value={draft.ntfyTopic} placeholder="ai-usage-your-private-topic" onChange={(e) => patch({ ntfyTopic: e.target.value.trim() })} /></Field>
      <Field label="Access token (optional)"><input type="password" autoComplete="off" value={draft.ntfyToken} onChange={(e) => patch({ ntfyToken: e.target.value.trim() })} /></Field>
    </div><div className="setting-row"><div><strong>{initial.ntfyTopic ? 'Sync enabled' : 'Sync disabled'}</strong><p>Save your configuration before publishing a snapshot.</p></div><Btn disabled={dirty || !!busy || !initial.ntfyTopic} onClick={() => void runAction('sync', () => api().refreshQuota(), 'Quota refresh finished. Sync publishing is best effort.')}>Refresh & publish</Btn></div><p className="privacy-note">A snapshot includes plan names, remaining quotas and reset times. A public ntfy topic can be read by anyone who knows its name; use an authenticated server for private sync.</p></Panel>}
    {tab === 'Pricing' && <>
      <Panel className="settings-panel"><h2>Model price overrides</h2><p>USD per million tokens. Exact model IDs override the built-in catalog. Overrides affect estimates, not provider-recorded costs.</p><Table rows={Object.keys(draft.pricingOverrides)} empty="No overrides yet. The built-in catalog is used." columns={[
        { key: 'model', label: 'Model', render: (m: string) => m },
        ...(['input', 'output', 'cacheRead', 'cacheWrite'] as const).map((key) => ({ key, label: { input: 'Input', output: 'Output', cacheRead: 'Cache read', cacheWrite: 'Cache write' }[key], align: 'right' as const, render: (m: string) => draft.pricingOverrides[m][key] !== undefined ? priceLabel(draft.pricingOverrides[m][key]!) : 'Catalog' })),
        { key: 'remove', label: '', render: (m: string) => <button className="icon-btn" aria-label={`Remove ${m} override`} onClick={() => { const next = { ...draft.pricingOverrides }; delete next[m]; patch({ pricingOverrides: next }) }}><Trash2 size={14} /></button> }
      ]} /><div className="settings-form mt-6"><Field label="Exact model ID"><input value={newPrice.model} placeholder="e.g. claude-sonnet-4-5" onChange={(e) => setNewPrice((p) => ({ ...p, model: e.target.value }))} /></Field>{(['input', 'output', 'cacheRead', 'cacheWrite'] as const).map((key) => <Field key={key} label={{ input: 'Input', output: 'Output', cacheRead: 'Cache read (optional)', cacheWrite: 'Cache write (optional)' }[key]}><input type="number" min="0" step="0.01" value={newPrice[key]} placeholder="USD per 1M tokens" onChange={(e) => setNewPrice((p) => ({ ...p, [key]: e.target.value }))} /></Field>)}</div>{priceError && <p role="alert" className="mt-4" style={{ color: 'var(--bad)' }}>{priceError}</p>}<div className="mt-4"><Btn onClick={addPrice}><Plus size={14} />Add override to draft</Btn></div></Panel>
      <Panel className="settings-panel"><h2>Model price catalog</h2><p>USD per million tokens at standard text rates. OpenAI and Gemini sources checked Oct 13, 2026; announced Google price changes apply on their effective dates. Estimates use current API-equivalent prices, including for historical usage. Long-context, tool, cache-storage and service-tier charges can differ. Models without a verified rate remain unpriced.</p><Field label={`Search ${catalog.length} catalog entries`}><input value={priceSearch} placeholder="GPT, Gemini, Argon…" onChange={e => setPriceSearch(e.target.value)} /></Field>{catalogError ? <p role="alert">{catalogError}</p> : <Table rows={filteredCatalog} empty="No matching models." columns={[
        { key: 'name', label: 'Model', render: (c: PriceCatalogEntry) => <div className="price-model"><strong>{c.label}</strong>{c.note && <small>{c.note}</small>}{c.sourceUrl ? <button type="button" className="price-source" disabled={!!busy} onClick={() => void runAction('pricing-source', () => api().openPriceSource(c.sourceUrl!))}>Official source · {c.verifiedAt}</button> : <small>{c.price ? 'App estimate · not verified in this release' : 'Unknown rate'}</small>}</div> },
        { key: 'in', label: 'Input / 1M', align: 'right', render: (c: PriceCatalogEntry) => priceLabel(c.price?.input) },
        { key: 'out', label: 'Output / 1M', align: 'right', render: (c: PriceCatalogEntry) => priceLabel(c.price?.output) },
        { key: 'cache', label: 'Cache read / 1M', align: 'right', render: (c: PriceCatalogEntry) => priceLabel(c.price?.cacheRead) },
        { key: 'write', label: 'Cache write est. / 1M', align: 'right', render: (c: PriceCatalogEntry) => priceLabel(c.price?.cacheWrite) }
      ]} />}</Panel>
    </>}
    <div className="save-bar"><span className="flex items-center gap-2">{dirty ? 'Unsaved changes · save before leaving this page' : <><Check size={14} />All changes saved</>}</span><Btn disabled={!dirty || !!busy} onClick={() => setDraft(initial)}>Discard changes</Btn><Btn disabled={!dirty || !!busy} variant="primary" onClick={save}><Save size={14} />{busy === 'save' ? 'Saving…' : 'Save changes'}</Btn></div>
  </div>
}

/** The OpenRouter key AI Usage uses for spend: saved here (encrypted, checked with OpenRouter first) or found in ZCode. */
function OpenRouterKeyPanel(): React.ReactElement {
  const { busy, runAction } = useApp()
  const [status, setStatus] = useState<{ saved: boolean; zcode: boolean; label?: string } | null>(null)
  const [key, setKey] = useState('')
  useEffect(() => { void api().openRouterKey().then(setStatus).catch(() => setStatus(null)) }, [])
  const save = (): void => { void runAction('openrouter-key', async () => { setStatus(await api().openRouterKey(key.trim())); setKey('') }, 'OpenRouter key saved. Refreshing spend…') }
  const remove = (): void => { void runAction('openrouter-key', async () => setStatus(await api().openRouterKey(null)), 'Saved OpenRouter key removed.') }
  const using = status?.saved ? `Using the key saved in AI Usage${status.label ? ` (“${status.label}”)` : ''}.` : status?.zcode ? 'Using the key found in ZCode. Paste one here to use it instead.' : 'No key yet: AI Usage cannot read your spend.'
  return <Panel className="settings-panel"><h2>OpenRouter key</h2>
    <p>Used only to read your spend from OpenRouter. It is checked with OpenRouter before it is saved, kept encrypted on this device, and included in encrypted Sharing. {using}</p>
    <div className="settings-form"><Field label="API key" hint="Starts with sk-or-. Create one at openrouter.ai/settings/keys"><input type="password" autoComplete="off" spellCheck={false} placeholder={status?.saved ? 'Saved · paste a new key to replace it' : 'sk-or-…'} value={key} onChange={(e) => setKey(e.target.value)} /></Field></div>
    <div className="flex flex-wrap gap-3"><Btn variant="primary" disabled={!!busy || !key.trim()} onClick={save}><ShieldCheck size={14} />Check and save</Btn>{status?.saved && <Btn disabled={!!busy} onClick={remove}><Trash2 size={14} />Remove saved key</Btn>}</div>
  </Panel>
}
