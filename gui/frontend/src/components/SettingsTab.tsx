import { useEffect, useState } from 'react'
import { Button, PasswordInput, SegmentedControl, TextInput, Alert } from '@mantine/core'
import { readSettings, writeSetting, type SettingField } from '../lib/ipc'
import { RequestAccessButton } from './RequestAccessButton'
import { SetupDoctorButton } from './SetupDoctorButton'

// Per-field local edit state: the value being typed and the chosen tier.
interface Draft {
    value: string
    tier: 'project' | 'local'
}

export function SettingsTab() {
    const [fields, setFields] = useState<SettingField[]>([])
    const [drafts, setDrafts] = useState<Record<string, Draft>>({})
    const [hasIdentity, setHasIdentity] = useState(false)
    const [error, setError] = useState('')
    const [savedKey, setSavedKey] = useState('')

    const load = async () => {
        try {
            const view = await readSettings()
            setFields(view.fields)
            setHasIdentity(view.hasIdentity)
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

    const setDraft = (key: string, patch: Partial<Draft>) =>
        setDrafts((d) => ({ ...d, [key]: { ...d[key], ...patch } }))

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

    const rowProps = { drafts, setDraft, save, savedKey, hasIdentity }

    // Ungrouped fields (base URLs) render first; the rest group into account cards.
    const ungrouped = fields.filter((f) => !f.group)
    const groups = [...new Set(fields.filter((f) => f.group).map((f) => f.group))]

    return (
        <div style={{ maxWidth: 760 }}>
            <Card>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
                    <div>
                        <div style={{ fontWeight: 600 }}>Setup Doctor</div>
                        <div className="kicker" style={{ marginTop: 2 }}>
                            check every prerequisite app is installed and valid
                        </div>
                    </div>
                    <SetupDoctorButton />
                </div>
            </Card>

            {!hasIdentity ? (
                <Card mt="md">
                    <RequestAccessButton />
                </Card>
            ) : null}

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
    hasIdentity: boolean
}

function FieldRow({ field: f, drafts, setDraft, save, savedKey, hasIdentity }: RowProps) {
    const draft = drafts[f.key] ?? { value: '', tier: 'project' as const }
    const blocked = f.secret && draft.tier === 'project' && !hasIdentity
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
                    request access (Settings ▸ Request access) to get an identity before committing project secrets
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
