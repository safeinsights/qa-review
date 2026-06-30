import { useEffect, useState } from 'react'
import { Button, PasswordInput, SegmentedControl, TextInput, Alert } from '@mantine/core'
import { readSettings, writeSetting, setPassphrase, type SettingField } from '../lib/ipc'

const REPO_ROOT = '..'

// Per-field local edit state: the value being typed and the chosen tier.
interface Draft {
    value: string
    tier: 'project' | 'local'
}

export function SettingsTab() {
    const [fields, setFields] = useState<SettingField[]>([])
    const [drafts, setDrafts] = useState<Record<string, Draft>>({})
    const [pass, setPass] = useState('')
    const [passSet, setPassSet] = useState(false)
    const [error, setError] = useState('')
    const [savedKey, setSavedKey] = useState('')

    const load = async () => {
        try {
            const view = await readSettings(REPO_ROOT)
            setFields(view.fields)
            setPassSet(view.hasPassphrase)
            // Seed drafts from current non-secret values; secrets start blank.
            const next: Record<string, Draft> = {}
            for (const f of view.fields) {
                const tier = f.tier === 'local' ? 'local' : 'project'
                next[f.key] = { value: f.secret ? '' : f.value, tier }
            }
            setDrafts(next)
        } catch (e) {
            setError((e as Error).message)
        }
    }

    useEffect(() => {
        void load()
    }, [])

    const applyPassphrase = async () => {
        setError('')
        try {
            await setPassphrase(pass)
            setPassSet(pass !== '')
            await load()
        } catch (e) {
            setError((e as Error).message)
        }
    }

    const setDraft = (key: string, patch: Partial<Draft>) =>
        setDrafts((d) => ({ ...d, [key]: { ...d[key], ...patch } }))

    const save = async (f: SettingField) => {
        setError('')
        setSavedKey('')
        const draft = drafts[f.key]
        try {
            await writeSetting(REPO_ROOT, f.key, draft.value, draft.tier)
            setSavedKey(f.key)
            await load()
        } catch (e) {
            setError((e as Error).message)
        }
    }

    const rowProps = { drafts, setDraft, save, savedKey, passSet }

    // Ungrouped fields (base URLs) render first; the rest group into account cards.
    const ungrouped = fields.filter((f) => !f.group)
    const groups = [...new Set(fields.filter((f) => f.group).map((f) => f.group))]

    return (
        <div style={{ maxWidth: 760 }}>
            <Card>
                <div className="kicker" style={{ marginBottom: 8 }}>
                    Unlock passphrase
                </div>
                <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--ink-soft, #555)' }}>
                    Required to view or save shared (committed) secrets. Held in memory for this session only — never
                    written to disk. The same passphrase is passed to runs so they can decrypt the shared accounts.
                </p>
                <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end' }}>
                    <PasswordInput
                        value={pass}
                        onChange={(e) => setPass(e.currentTarget.value)}
                        placeholder="passphrase"
                        style={{ flex: 1 }}
                    />
                    <Button onClick={applyPassphrase} variant="light" color="teal">
                        {passSet ? 'Update' : 'Unlock'}
                    </Button>
                </div>
                {passSet ? (
                    <div className="kicker" style={{ marginTop: 8, color: 'var(--teal, #0c6b5e)' }}>
                        ✓ passphrase set for this session
                    </div>
                ) : null}
            </Card>

            {error ? (
                <Alert color="red" mt="md" title="Settings error" onClose={() => setError('')} withCloseButton>
                    {error}
                </Alert>
            ) : null}

            {ungrouped.length ? (
                <Section title="Environment">
                    {ungrouped.map((f) => (
                        <FieldRow key={f.key} field={f} {...rowProps} />
                    ))}
                </Section>
            ) : null}

            {groups.map((group) => (
                <Section key={group} title={group} subtitle="account">
                    {fields
                        .filter((f) => f.group === group)
                        .map((f) => (
                            <FieldRow key={f.key} field={f} {...rowProps} />
                        ))}
                </Section>
            ))}
        </div>
    )
}

interface RowProps {
    field: SettingField
    drafts: Record<string, Draft>
    setDraft: (key: string, patch: Partial<Draft>) => void
    save: (f: SettingField) => void
    savedKey: string
    passSet: boolean
}

function FieldRow({ field: f, drafts, setDraft, save, savedKey, passSet }: RowProps) {
    const draft = drafts[f.key] ?? { value: '', tier: 'project' as const }
    const blocked = f.secret && draft.tier === 'project' && !passSet
    return (
        <div style={{ borderTop: '1px solid var(--line)', paddingTop: 12, marginTop: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <label style={{ fontWeight: 600 }}>{f.label}</label>
                <span className="kicker">
                    {f.set ? `current: ${tierLabel(f.tier)}` : 'not set'}
                    {f.secret ? ' · secret' : ''}
                </span>
            </div>
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', marginTop: 8 }}>
                {f.secret ? (
                    <PasswordInput
                        style={{ flex: 1 }}
                        value={draft.value}
                        onChange={(e) => setDraft(f.key, { value: e.currentTarget.value })}
                        placeholder={f.set ? '•••••• (set — type to replace)' : 'enter a value'}
                    />
                ) : (
                    <TextInput
                        style={{ flex: 1 }}
                        value={draft.value}
                        onChange={(e) => setDraft(f.key, { value: e.currentTarget.value })}
                        placeholder="enter a value"
                    />
                )}
                <SegmentedControl
                    value={draft.tier}
                    onChange={(v) => setDraft(f.key, { tier: v as Draft['tier'] })}
                    data={[
                        { label: f.secret ? 'Project (encrypted)' : 'Project', value: 'project' },
                        { label: 'Local', value: 'local' },
                    ]}
                    size="xs"
                />
                <Button
                    onClick={() => save(f)}
                    disabled={blocked || draft.value === ''}
                    color="teal"
                    variant={savedKey === f.key ? 'filled' : 'light'}
                >
                    {savedKey === f.key ? 'Saved' : 'Save'}
                </Button>
            </div>
            {blocked ? (
                <div className="kicker" style={{ marginTop: 6, color: '#b04a3a' }}>
                    set the unlock passphrase above to commit this secret project-wide
                </div>
            ) : null}
        </div>
    )
}

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
    return (
        <Card mt="md">
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <h3 style={{ margin: 0, fontFamily: '"Fraunces", serif', fontWeight: 600, fontSize: 18 }}>{title}</h3>
                {subtitle ? <span className="kicker">{subtitle}</span> : null}
            </div>
            {children}
        </Card>
    )
}

function tierLabel(tier: string): string {
    if (tier === 'project') return 'project (committed)'
    if (tier === 'secrets') return 'project (encrypted)'
    if (tier === 'local') return 'local override'
    return tier
}

function Card({ children, mt }: { children: React.ReactNode; mt?: string }) {
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
