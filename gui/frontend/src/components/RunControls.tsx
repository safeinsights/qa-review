import { Button, Select, TextInput } from '@mantine/core'
import type { ReactNode } from 'react'
import { ENVS } from '../lib/ipc'
import { type RunActionKind, runActionKind } from './runAction'

const ALL_ROLES = ['admin', 'researcher', 'reviewer']

// The Mantine props each action state renders with.
interface ActionSpec {
    onClick: (() => void) | undefined
    disabled: boolean | undefined
    loading: boolean
    color: string
    shadow: string
    icon: ReactNode
    label: string
}

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
    suites?: { name: string; description: string; roles: string[]; steps: string[] }[]
    onRun: () => void
    runDisabled?: boolean
    runLabel?: string
    // Opens the selected suite's source in the user's editor. When provided (and a
    // suite is selected), a secondary "Edit Suite" button sits left of Run.
    onEditSuite?: () => void
    // When running, the action button becomes a red Stop that calls onStop.
    running?: boolean
    onStop?: () => void
    // True while the run tears down after Stop or Give up — disables the button so
    // it doesn't look dead or invite a repeat click. Teardown is not instant (test
    // data cleanup, trace/video save, then the screencast's viewing grace), and a
    // Stop pressed in that window exits the process before the result line, losing
    // the verdict the run had already reached.
    stopping?: boolean
    // Verb for that state, since Give up tears down through the same flag but is not
    // a stop. Defaults to 'Stopping…'.
    stoppingLabel?: string
    // When the run is halted at a paused step, the button becomes a Resume that
    // calls onResume (takes precedence over the Stop state).
    paused?: boolean
    onResume?: () => void
    // When a step failed and the browser is held open for retry, the controls show
    // Retry step (re-run the failed step against the live browser, picking up any
    // suite edit) + a quiet Give up. Takes precedence over paused/running/run.
    stepFailed?: boolean
    onRetryStep?: () => void
    onGiveUp?: () => void
}

// Env/PR/Suite/Role describe WHAT to run — editing them mid-run would desync the
// controls from the run in progress, so they're locked while a run is active
// (running or paused).

// The shared editorial control bar: labeled mono fields + a teal Run button.
// The Role is governed by the selected Suite (a suite declares which role it runs
// as), so we show Suite first and adapt the Role field to avoid invalid combos.
export function RunControls(p: RunControlsProps) {
    const showSuite = p.suite !== undefined && p.setSuite
    const suiteData = (
        p.suites && p.suites.length > 0 ? p.suites.map(s => s.name) : ['signin']
    ).map(name => ({
        value: name,
        label: name,
    }))
    const allowed = p.allowedRoles ?? []
    const roleOptions = allowed.length > 0 ? allowed : ALL_ROLES
    const roleFixed = allowed.length === 1
    const fieldsLocked = !!p.running || !!p.paused || !!p.stepFailed
    // The Edit Suite button (when visible) owns marginLeft:auto to right-align the
    // group; otherwise the action button carries it so it still pins to the right.
    const editVisible = showSuite && !!p.onEditSuite && !fieldsLocked
    const actionMargin = editVisible ? {} : { marginLeft: 'auto' as const }
    // The action button's state, in precedence order: teardown (Stop or Give up
    // pressed), then Retry step (a step failed, held for retry), then Resume (paused
    // / error-hold), then Stop (running), else Run. Resolved once so the JSX renders
    // a single button instead of a nested ternary with duplicated Mantine props. A
    // step-failed hold also renders a quiet Give up beside it (below).
    //
    // Teardown outranks the rest because once the run is finishing there is no valid
    // action left, and a stale step-failed envelope arriving mid-teardown must not
    // put an actionable Retry step back under the cursor.
    const GO = '0 6px 18px rgba(12,107,94,0.22)'
    const HALT = '0 6px 18px rgba(176,74,58,0.22)'
    const play = <span aria-hidden>▶</span>
    const actions: Record<RunActionKind, ActionSpec> = {
        teardown: {
            onClick: undefined,
            disabled: true,
            loading: true,
            color: 'red',
            shadow: HALT,
            icon: undefined,
            label: p.stoppingLabel ?? 'Stopping…',
        },
        retryStep: {
            onClick: p.onRetryStep,
            disabled: undefined,
            loading: false,
            color: 'teal',
            shadow: GO,
            icon: play,
            label: 'Retry step',
        },
        resume: {
            onClick: p.onResume,
            disabled: undefined,
            loading: false,
            color: 'teal',
            shadow: GO,
            icon: play,
            label: 'Resume',
        },
        stop: {
            onClick: p.onStop,
            disabled: undefined,
            loading: false,
            color: 'red',
            shadow: HALT,
            icon: <span aria-hidden>■</span>,
            label: 'Stop',
        },
        run: {
            onClick: p.onRun,
            disabled: p.runDisabled,
            loading: false,
            color: 'teal',
            shadow: GO,
            icon: play,
            label: p.runLabel ?? 'Run',
        },
    }
    const action = actions[runActionKind(p)]

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
                    onChange={v => v && p.setEnv(v)}
                    disabled={!!p.pr || fieldsLocked}
                    allowDeselect={false}
                    w={110}
                    comboboxProps={{ withinPortal: true }}
                />
            </Field>
            <Field label="PR #">
                <TextInput
                    value={p.pr}
                    onChange={e => p.setPr(e.currentTarget.value)}
                    placeholder="optional"
                    disabled={fieldsLocked}
                    w={90}
                />
            </Field>
            {showSuite ? (
                <Field label="Suite">
                    <Select
                        data={suiteData}
                        value={p.suite}
                        onChange={v => v && p.setSuite?.(v)}
                        disabled={fieldsLocked}
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
                        onChange={v => v && p.setRole(v)}
                        disabled={fieldsLocked}
                        allowDeselect={false}
                        w={150}
                        comboboxProps={{ withinPortal: true }}
                    />
                )}
            </Field>
            {/* Secondary, deliberately quiet: edit the selected suite's source in
                the user's editor. Sits left of the action button and carries the
                marginLeft:auto so the whole button group stays right-aligned.
                Hidden while a run is active — the source shouldn't change mid-run. */}
            {editVisible ? (
                <Button
                    onClick={p.onEditSuite}
                    variant="default"
                    radius="md"
                    size="md"
                    style={{ marginLeft: 'auto' }}
                >
                    Edit Suite
                </Button>
            ) : null}
            {/* On a step-failed hold, a quiet Give up sits left of Retry step and
                carries the marginLeft:auto so the pair stays right-aligned. */}
            {p.stepFailed ? (
                <Button
                    onClick={p.onGiveUp}
                    variant="default"
                    color="red"
                    radius="md"
                    size="md"
                    style={{ marginLeft: 'auto' }}
                >
                    Give up
                </Button>
            ) : null}
            <Button
                onClick={action.onClick}
                disabled={action.disabled}
                loading={action.loading}
                color={action.color}
                radius="md"
                size="md"
                style={{ ...(p.stepFailed ? {} : actionMargin), boxShadow: action.shadow }}
                leftSection={action.icon}
            >
                {action.label}
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
