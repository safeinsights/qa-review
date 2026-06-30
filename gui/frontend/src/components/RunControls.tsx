import { Select, TextInput, Button } from '@mantine/core'

const ENVS = ['qa', 'staging']
const ROLES = ['admin', 'researcher', 'reviewer']

export interface RunControlsProps {
    env: string
    setEnv: (v: string) => void
    pr: string
    setPr: (v: string) => void
    role: string
    setRole: (v: string) => void
    // Suite selector is optional (Exploratory has no suite picker).
    suite?: string
    setSuite?: (v: string) => void
    suites?: { name: string; description: string }[]
    onRun: () => void
    runDisabled?: boolean
    runLabel?: string
}

// The shared editorial control bar: labeled mono fields + a teal Run button.
// Used by both the Suites and Exploratory tabs so the cockpit reads consistently.
export function RunControls(p: RunControlsProps) {
    const showSuite = p.suite !== undefined && p.setSuite
    const suiteData = (p.suites && p.suites.length > 0 ? p.suites.map((s) => s.name) : ['signin']).map((name) => ({
        value: name,
        label: name,
    }))

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
                <TextInput
                    value={p.pr}
                    onChange={(e) => p.setPr(e.currentTarget.value)}
                    placeholder="optional"
                    w={90}
                />
            </Field>
            <Field label="Role">
                <Select
                    data={ROLES}
                    value={p.role}
                    onChange={(v) => v && p.setRole(v)}
                    allowDeselect={false}
                    w={150}
                    comboboxProps={{ withinPortal: true }}
                />
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
