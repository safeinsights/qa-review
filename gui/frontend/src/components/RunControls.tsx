import { Select, TextInput, Button } from '@mantine/core'

const ENVS = ['qa', 'staging']
const ALL_ROLES = ['admin', 'researcher', 'reviewer']

export interface RunControlsProps {
    env: string
    setEnv: (v: string) => void
    pr: string
    setPr: (v: string) => void
    role: string
    setRole: (v: string) => void
    // Roles the selected suite permits. Empty = unknown (suites not loaded yet) →
    // fall back to all roles. One = fixed (shown read-only). Many = constrained.
    allowedRoles?: string[]
    // Suite selector is optional (Exploratory has no suite picker).
    suite?: string
    setSuite?: (v: string) => void
    suites?: { name: string; description: string; roles: string[] }[]
    onRun: () => void
    runDisabled?: boolean
    runLabel?: string
}

// The shared editorial control bar: labeled mono fields + a teal Run button.
// The Role is governed by the selected Suite (a suite declares which role it runs
// as), so we show Suite first and adapt the Role field to avoid invalid combos.
export function RunControls(p: RunControlsProps) {
    const showSuite = p.suite !== undefined && p.setSuite
    const suiteData = (p.suites && p.suites.length > 0 ? p.suites.map((s) => s.name) : ['signin']).map((name) => ({
        value: name,
        label: name,
    }))
    const allowed = p.allowedRoles ?? []
    const roleOptions = allowed.length > 0 ? allowed : ALL_ROLES
    const roleFixed = allowed.length === 1

    return (
        <div
            style={{
                display: 'flex',
                gap: 18,
                alignItems: 'flex-end',
                flexWrap: 'wrap',
                background: 'var(--paper-card)',
                border: '1px solid var(--line)',
                borderRadius: 10,
                padding: '14px 16px',
                boxShadow: 'var(--shadow-card)',
            }}
        >
            <Field label="Env">
                <Select
                    data={ENVS}
                    value={p.env}
                    onChange={(v) => v && p.setEnv(v)}
                    disabled={!!p.pr}
                    allowDeselect={false}
                    w={110}
                    comboboxProps={{ withinPortal: true }}
                />
            </Field>
            <Field label="PR #">
                <TextInput value={p.pr} onChange={(e) => p.setPr(e.currentTarget.value)} placeholder="optional" w={90} />
            </Field>
            {showSuite ? (
                <Field label="Suite">
                    <Select
                        data={suiteData}
                        value={p.suite}
                        onChange={(v) => v && p.setSuite!(v)}
                        allowDeselect={false}
                        w={200}
                        comboboxProps={{ withinPortal: true }}
                    />
                </Field>
            ) : null}
            <Field label={roleFixed ? 'Role (from suite)' : 'Role'}>
                {roleFixed ? (
                    // Single valid role: show it read-only — no footgun.
                    <div
                        className="mono"
                        style={{
                            border: '1px solid var(--line)',
                            background: 'var(--paper-sunken)',
                            borderRadius: 8,
                            padding: '7px 11px',
                            color: 'var(--ink-dim)',
                            fontSize: 13,
                            width: 150,
                        }}
                        title="This suite always runs as this role"
                    >
                        {p.role}
                    </div>
                ) : (
                    <Select
                        data={roleOptions}
                        value={p.role}
                        onChange={(v) => v && p.setRole(v)}
                        allowDeselect={false}
                        w={150}
                        comboboxProps={{ withinPortal: true }}
                    />
                )}
            </Field>
            <Button
                onClick={p.onRun}
                disabled={p.runDisabled}
                color="teal"
                radius="md"
                size="md"
                style={{ marginLeft: 'auto', boxShadow: '0 6px 18px rgba(12,107,94,0.22)' }}
                leftSection={<span aria-hidden>▶</span>}
            >
                {p.runLabel ?? 'Run'}
            </Button>
        </div>
    )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <span className="kicker">{label}</span>
            {children}
        </div>
    )
}
