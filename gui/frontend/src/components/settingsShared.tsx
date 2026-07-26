import {
    ActionIcon,
    Button,
    PasswordInput,
    SegmentedControl,
    Tabs,
    Textarea,
    TextInput,
} from '@mantine/core'
import { useCallback, useEffect, useState } from 'react'
import { readSettings, revealSecret, type SettingField, writeSetting } from '../lib/ipc'

// Shared building blocks for the settings-style panels (Settings + Accounts). Both
// read the same merged settings view; each renders a filtered slice of the fields.

// Per-field local edit state: the value being typed and the chosen tier.
export interface Draft {
    value: string
    tier: 'project' | 'local'
}

// Loads the merged settings view and owns the per-field draft + save state. Both
// panels use one instance each (over their own field slice, but the hook loads all
// fields so a save re-reads the whole view consistently).
export function useSettings() {
    const [fields, setFields] = useState<SettingField[]>([])
    const [drafts, setDrafts] = useState<Record<string, Draft>>({})
    const [hasIdentity, setHasIdentity] = useState(false)
    const [error, setError] = useState('')
    const [savedKey, setSavedKey] = useState('')

    const load = useCallback(async () => {
        try {
            const view = await readSettings()
            setFields(view.fields)
            setHasIdentity(view.hasIdentity)
            // Seed drafts from current non-secret values; secrets start blank.
            const next: Record<string, Draft> = {}
            for (const f of view.fields) {
                // Local-only fields (Jira) can never be project — always seed local.
                const tier = f.localOnly || f.tier === 'local' ? 'local' : 'project'
                next[f.key] = { value: f.secret ? '' : f.value, tier }
            }
            setDrafts(next)
        } catch (e) {
            setError((e as Error).message)
        }
    }, [])

    useEffect(() => {
        void load()
    }, [load])

    const setDraft = (key: string, patch: Partial<Draft>) =>
        setDrafts(d => ({ ...d, [key]: { ...d[key], ...patch } }))

    const save = async (f: SettingField) => {
        setError('')
        setSavedKey('')
        const draft = drafts[f.key]
        try {
            await writeSetting(f.key, draft.value, draft.tier)
            setSavedKey(f.key)
            await load()
        } catch (e) {
            setError((e as Error).message)
        }
    }

    const rowProps: RowProps = { drafts, setDraft, save, savedKey, hasIdentity }
    return { fields, hasIdentity, error, setError, rowProps }
}

// Group the fields of one account into its plain (non-env) fields plus one entry
// per env-tabbed SECTION (e.g. "Account", "Results private key"). Each section
// carries its envs in order, each env its fields — so one env tab can hold several
// inputs (the Account section's email + password + MFA code + seed).
export interface EnvTab {
    env: string
    fields: SettingField[]
}
export interface GroupCard {
    group: string
    plain: SettingField[]
    sections: { section: string; envs: EnvTab[] }[]
}
export function toGroupCards(fields: SettingField[]): GroupCard[] {
    const groups = [...new Set(fields.filter(f => f.group).map(f => f.group))]
    return groups.map(group => {
        const groupFields = fields.filter(f => f.group === group)
        const plain = groupFields.filter(f => !f.env)
        const sectionLabels = [...new Set(groupFields.filter(f => f.env).map(f => f.section))]
        return {
            group,
            plain,
            sections: sectionLabels.map(section => {
                const sectionFields = groupFields.filter(f => f.env && f.section === section)
                const envs = [...new Set(sectionFields.map(f => f.env))]
                return {
                    section,
                    envs: envs.map(env => ({
                        env,
                        fields: sectionFields.filter(f => f.env === env),
                    })),
                }
            }),
        }
    })
}

export interface RowProps {
    drafts: Record<string, Draft>
    setDraft: (key: string, patch: Partial<Draft>) => void
    save: (f: SettingField) => void
    savedKey: string
    hasIdentity: boolean
}

// One account's per-env sub-section (e.g. "Account" or "Results private key"): a
// single label with a tab per env. Each tab holds every field for that env — the
// four Account inputs, or one PEM key. A tab shows ✓ if any of its fields is set.
export function EnvTabbedSection({
    label,
    envs,
    ...rowProps
}: { label: string; envs: EnvTab[] } & RowProps) {
    const [tab, setTab] = useState(envs[0]?.env ?? 'qa')
    return (
        <div style={{ borderTop: '1px solid var(--line)', paddingTop: 12, marginTop: 12 }}>
            <span style={{ fontWeight: 600 }}>{label}</span>
            <Tabs value={tab} onChange={v => setTab(v ?? envs[0]?.env ?? 'qa')} mt={6}>
                <Tabs.List>
                    {envs.map(e => (
                        <Tabs.Tab key={e.env} value={e.env}>
                            {e.env}
                            {e.fields.some(f => f.set) ? ' ✓' : ''}
                        </Tabs.Tab>
                    ))}
                </Tabs.List>
                {envs.map(e => (
                    <Tabs.Panel key={e.env} value={e.env} pt={10}>
                        {e.fields.map(f => (
                            <FieldRow
                                key={f.key}
                                field={f}
                                {...rowProps}
                                hideLabel={e.fields.length === 1}
                            />
                        ))}
                    </Tabs.Panel>
                ))}
            </Tabs>
        </div>
    )
}

export function FieldRow({
    field: f,
    drafts,
    setDraft,
    save,
    savedKey,
    hasIdentity,
    hideLabel,
}: { field: SettingField; hideLabel?: boolean } & RowProps) {
    const draft: Draft = drafts[f.key] ?? {
        value: '',
        tier: f.localOnly ? 'local' : 'project',
    }
    // Reveal (eye) state for secret fields: the fetched plaintext of the STORED
    // value (null = hidden). Separate from `draft.value` (a pending replacement) so
    // revealing never clobbers what the user is typing. `revealErr` surfaces a
    // decrypt/identity failure inline.
    const [revealed, setRevealed] = useState<string | null>(null)
    const [revealErr, setRevealErr] = useState('')
    const toggleReveal = async () => {
        if (revealed !== null) {
            setRevealed(null)
            setRevealErr('')
            return
        }
        try {
            setRevealErr('')
            setRevealed(await revealSecret(f.key))
        } catch (e) {
            setRevealErr((e as Error).message)
        }
    }
    // Only offer reveal for a secret that actually has a stored value.
    const canReveal = f.secret && f.set
    const revealButton = canReveal ? (
        <ActionIcon
            variant="subtle"
            color="gray"
            size="sm"
            aria-label={revealed !== null ? 'Hide value' : 'Reveal value'}
            title={revealed !== null ? 'Hide value' : 'Reveal current value'}
            onClick={toggleReveal}
        >
            {revealed !== null ? '🙈' : '👁'}
        </ActionIcon>
    ) : null

    const blocked = f.secret && draft.tier === 'project' && !hasIdentity
    // The per-env results private keys hold a multi-line PEM — render those in a
    // textarea. Short env-tagged secrets (email, password, MFA code/seed) stay one-liners.
    const isPem = f.multiline
    // Local-only fields (Jira config) can never be committed/encrypted, so drop the
    // tier selector and show a fixed "Local only" label instead.
    const tierControl = f.localOnly ? (
        <span className="kicker" style={{ whiteSpace: 'nowrap' }}>
            Local only
        </span>
    ) : (
        <SegmentedControl
            value={draft.tier}
            onChange={v => setDraft(f.key, { tier: v as Draft['tier'] })}
            data={[
                { label: f.secret ? 'Project (encrypted)' : 'Project', value: 'project' },
                { label: 'Local', value: 'local' },
            ]}
            size="xs"
        />
    )
    const saveButton = (
        <Button
            onClick={() => save(f)}
            disabled={blocked || draft.value === ''}
            color="teal"
            variant={savedKey === f.key ? 'filled' : 'light'}
        >
            {savedKey === f.key ? 'Saved' : 'Save'}
        </Button>
    )
    return (
        <div
            style={
                hideLabel
                    ? undefined
                    : { borderTop: '1px solid var(--line)', paddingTop: 12, marginTop: 12 }
            }
        >
            <div
                style={{
                    display: 'flex',
                    justifyContent: hideLabel ? 'flex-end' : 'space-between',
                    alignItems: 'baseline',
                }}
            >
                {hideLabel ? null : <span style={{ fontWeight: 600 }}>{f.label}</span>}
                <span
                    className="kicker"
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                >
                    {f.set ? `current: ${tierLabel(f.tier, f.localOnly)}` : 'not set'}
                    {f.secret ? ' · secret' : ''}
                    {revealButton}
                </span>
            </div>
            {isPem ? (
                <div style={{ marginTop: 8 }}>
                    <Textarea
                        value={revealed !== null ? revealed : draft.value}
                        onChange={e => setDraft(f.key, { value: e.currentTarget.value })}
                        readOnly={revealed !== null}
                        placeholder={
                            f.set
                                ? 'set — paste a new PEM to replace'
                                : '-----BEGIN PRIVATE KEY-----\n…'
                        }
                        autosize
                        minRows={4}
                        maxRows={12}
                        styles={{ input: { fontFamily: 'var(--mono, monospace)', fontSize: 12 } }}
                    />
                    <div
                        style={{
                            display: 'flex',
                            gap: 12,
                            alignItems: 'center',
                            justifyContent: 'flex-end',
                            marginTop: 8,
                        }}
                    >
                        {tierControl}
                        {saveButton}
                    </div>
                </div>
            ) : (
                <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', marginTop: 8 }}>
                    {revealed !== null ? (
                        // Show the decrypted stored value read-only; the eye toggles it off.
                        <TextInput style={{ flex: 1 }} value={revealed} readOnly />
                    ) : f.secret ? (
                        <PasswordInput
                            style={{ flex: 1 }}
                            value={draft.value}
                            onChange={e => setDraft(f.key, { value: e.currentTarget.value })}
                            placeholder={f.set ? '•••••• (set — type to replace)' : 'enter a value'}
                        />
                    ) : (
                        <TextInput
                            style={{ flex: 1 }}
                            value={draft.value}
                            onChange={e => setDraft(f.key, { value: e.currentTarget.value })}
                            placeholder="enter a value"
                        />
                    )}
                    {tierControl}
                    {saveButton}
                </div>
            )}
            {revealErr ? (
                <div className="kicker" style={{ marginTop: 6, color: '#b04a3a' }}>
                    {revealErr}
                </div>
            ) : null}
            {blocked ? (
                <div className="kicker" style={{ marginTop: 6, color: '#b04a3a' }}>
                    request access (Settings ▸ Request access) to get an identity before committing
                    project secrets
                </div>
            ) : null}
        </div>
    )
}

export function Section({
    title,
    subtitle,
    children,
}: {
    title: string
    subtitle?: string
    children: React.ReactNode
}) {
    return (
        <Card mt="md">
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <h3
                    style={{
                        margin: 0,
                        fontFamily: '"Fraunces", serif',
                        fontWeight: 600,
                        fontSize: 18,
                    }}
                >
                    {title}
                </h3>
                {subtitle ? <span className="kicker">{subtitle}</span> : null}
            </div>
            {children}
        </Card>
    )
}

function tierLabel(tier: string, localOnly = false): string {
    if (tier === 'project') return 'project (committed)'
    if (tier === 'secrets') return 'project (encrypted)'
    // A local-only field has no project tier to override, so it's just "local".
    if (tier === 'local') return localOnly ? 'local' : 'local override'
    return tier
}

export function Card({ children, mt }: { children: React.ReactNode; mt?: string }) {
    return (
        <div
            style={{
                marginTop: mt === 'md' ? 18 : undefined,
                background: 'var(--paper-card)',
                border: '1px solid var(--line)',
                borderRadius: 10,
                padding: '16px 18px',
                boxShadow: 'var(--shadow-card)',
            }}
        >
            {children}
        </div>
    )
}
