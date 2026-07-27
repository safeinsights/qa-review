import { ActionIcon, Button, SegmentedControl, Textarea, TextInput } from '@mantine/core'
import { useCallback, useEffect, useState } from 'react'
import {
    clearSetting,
    readSettings,
    revealSecret,
    type SettingField,
    writeSetting,
} from '../lib/ipc'
import type { EnvCard } from './settingsGrouping'

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
    // The one env selection driving the whole panel. Every env-scoped field (all
    // account fields + the base URL) renders under it, so switching env swaps them
    // together instead of per account.
    const [selectedEnv, setEnv] = useState('qa')

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

    // Unset a field entirely (every tier). load() re-seeds the drafts, so the row
    // comes back as "not set" with an empty input.
    const clear = async (f: SettingField) => {
        setError('')
        setSavedKey('')
        try {
            await clearSetting(f.key)
            await load()
        } catch (e) {
            setError((e as Error).message)
        }
    }

    // The envs present in the loaded fields, in first-seen order. Fall back to the
    // first one if the selection isn't among them — on the first render `fields` is
    // still empty, and the backend's env list shouldn't be assumed to contain "qa".
    const envs = [...new Set(fields.filter(f => f.env).map(f => f.env))]
    const env = envs.includes(selectedEnv) ? selectedEnv : (envs[0] ?? selectedEnv)
    const rowProps: RowProps = { drafts, setDraft, save, clear, savedKey, hasIdentity }
    return { fields, hasIdentity, error, setError, rowProps, env, setEnv, envs }
}

export interface RowProps {
    drafts: Record<string, Draft>
    setDraft: (key: string, patch: Partial<Draft>) => void
    save: (f: SettingField) => void
    clear: (f: SettingField) => void
    savedKey: string
    hasIdentity: boolean
}

// One card's body for the selected env: each section renders as an optional label
// followed by its fields. The env itself is chosen once, above — this only ever
// renders the fields it was handed.
export function EnvCardBody({ card, ...rowProps }: { card: EnvCard } & RowProps) {
    return (
        <>
            {card.sections.map((s, i) => {
                if (!s.fields.length) return null
                // The first section sits directly under the card title — no divider
                // there. Later sections keep a top border to separate them.
                return (
                    <div
                        key={s.section}
                        style={
                            i === 0
                                ? undefined
                                : {
                                      borderTop: '1px solid var(--line)',
                                      paddingTop: 12,
                                      marginTop: 12,
                                  }
                        }
                    >
                        {/* The "Account" section heading is redundant with the card's own
                            "<Role> account" title, so only label multi-purpose sections
                            (e.g. "Results private key"). */}
                        {s.section !== 'Account' && s.section !== 'Environment' ? (
                            <span style={{ fontWeight: 600 }}>{s.section}</span>
                        ) : null}
                        {s.fields.map(f => (
                            <FieldRow
                                key={f.key}
                                field={f}
                                {...rowProps}
                                // A single-field section (Results private key) is already
                                // named by the heading above — don't repeat the label.
                                hideLabel={s.fields.length === 1 && s.section !== 'Environment'}
                            />
                        ))}
                    </div>
                )
            })}
        </>
    )
}

export function FieldRow({
    field: f,
    drafts,
    setDraft,
    save,
    clear,
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
    // Clearing is destructive and may be removing the only copy of a secret, so the
    // button arms on the first click and only clears on the second.
    const [confirmingClear, setConfirmingClear] = useState(false)
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
    // Only offer reveal for a secret that actually has a stored value. The eye
    // sits inside the input (rightSection) so it reads as "reveal THIS field".
    const canReveal = f.secret && f.set
    const eyeIcon = canReveal ? (
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
    // Only offer Clear for a field that actually holds a value. onBlur disarms, so
    // clicking away cancels rather than leaving a primed destructive button.
    const clearButton = f.set ? (
        <Button
            onClick={() => {
                if (!confirmingClear) {
                    setConfirmingClear(true)
                    return
                }
                setConfirmingClear(false)
                clear(f)
            }}
            onBlur={() => setConfirmingClear(false)}
            color="red"
            variant={confirmingClear ? 'filled' : 'subtle'}
            title={`Remove ${f.label} from every settings file`}
        >
            {confirmingClear ? 'Confirm?' : 'Clear'}
        </Button>
    ) : null
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
                <span className="kicker">
                    {f.set ? `current: ${tierLabel(f.tier, f.localOnly)}` : 'not set'}
                    {f.secret ? ' · secret' : ''}
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
                        // Eye pinned to the top-right corner of the textarea.
                        rightSection={eyeIcon}
                        rightSectionProps={{ style: { alignItems: 'flex-start', paddingTop: 6 } }}
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
                        {clearButton}
                    </div>
                </div>
            ) : (
                <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', marginTop: 8 }}>
                    {revealed !== null ? (
                        // Show the decrypted stored value read-only; the eye (rightSection) toggles it off.
                        <TextInput
                            style={{ flex: 1 }}
                            value={revealed}
                            readOnly
                            rightSection={eyeIcon}
                        />
                    ) : (
                        // A secret's draft input is masked (type=password) with OUR eye in the
                        // rightSection — not Mantine's PasswordInput, whose built-in toggle only
                        // un-masks the (blank) draft and reads as "reveal shows nothing".
                        <TextInput
                            style={{ flex: 1 }}
                            type={f.secret ? 'password' : undefined}
                            value={draft.value}
                            onChange={e => setDraft(f.key, { value: e.currentTarget.value })}
                            placeholder={
                                f.secret && f.set
                                    ? '•••••• (set — type to replace)'
                                    : 'enter a value'
                            }
                            rightSection={eyeIcon}
                        />
                    )}
                    {tierControl}
                    {saveButton}
                    {clearButton}
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
