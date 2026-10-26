import { Alert, Badge, Button, Group, Switch } from '@mantine/core'
import { useState } from 'react'
import type { PlanLinesCheck, ReleaseStatus } from '../lib/ipc'
import { PlanEditor } from './PlanEditor'
import { Terminal } from './Terminal'
import { useReleasePlan } from './useReleasePlan'

// Editor on top, Claude below, status row between. `sessionLive` gates Save and
// Regenerate: both are instructions to the session.
export function ReleasePlan({
    tag,
    status,
    sessionLive,
    starting,
    onRegenerate,
    onStartSession,
    onStatusStale,
    onRun,
    onStop,
}: {
    tag: string
    status: ReleaseStatus
    sessionLive: boolean
    starting: boolean
    onRegenerate: () => void
    onStartSession: () => void
    onStatusStale: () => void
    onRun: () => void
    onStop: () => void
}) {
    const plan = useReleasePlan(tag, true, onStatusStale)
    const [preview, setPreview] = useState(false)
    const badge = planBadge(plan.dirty, plan.uploaded, status)
    const canSave =
        sessionLive &&
        status.canUpload &&
        !plan.dirty &&
        !plan.conflict &&
        plan.lineCheck?.ok === true

    return (
        <div>
            <PlanEditor value={plan.text} onChange={plan.setText} preview={preview} />
            <ConflictBanner
                isVisible={plan.conflict}
                onReload={plan.reload}
                onKeep={plan.keepMine}
            />
            <Group mt="sm" gap="sm">
                <Switch
                    label="Preview"
                    checked={preview}
                    onChange={e => setPreview(e.currentTarget.checked)}
                />
                <Badge variant="light" color={badge.color}>
                    {badge.label}
                </Badge>
                <LineCheck check={plan.lineCheck} />
                <UploadWarning isVisible={!status.canUpload} />
                <DiscardButton isVisible={status.local.planDiffers} onDiscard={plan.discard} />
                <Button
                    onClick={plan.save}
                    disabled={!canSave}
                    color="teal"
                    radius="md"
                    style={{ marginLeft: 'auto' }}
                >
                    Save to release
                </Button>
                <StartSessionButton
                    isVisible={!sessionLive}
                    disabled={starting}
                    onStart={onStartSession}
                />
                <Button onClick={onRegenerate} variant="outline" radius="md" disabled={starting}>
                    Regenerate
                </Button>
                <Button
                    onClick={onRun}
                    variant="outline"
                    color="dark"
                    radius="md"
                    disabled={sessionLive}
                >
                    Run…
                </Button>
                <Button
                    onClick={onStop}
                    variant="outline"
                    color="red"
                    radius="md"
                    disabled={!sessionLive}
                >
                    Stop session
                </Button>
            </Group>
            <PlanError message={plan.error} />
            <section
                style={{
                    background: '#0f1419',
                    border: '1px solid var(--line)',
                    borderRadius: 10,
                    overflow: 'hidden',
                    height: 'min(40vh, 480px)',
                    padding: 8,
                    marginTop: 12,
                }}
            >
                <Terminal />
            </section>
        </div>
    )
}

function planBadge(dirty: boolean, uploaded: boolean, status: ReleaseStatus) {
    if (dirty) return { color: 'yellow', label: 'typing…' }
    if (uploaded) return { color: 'teal', label: 'saved to release' }
    if (status.local.planDiffers) return { color: 'orange', label: 'unsaved edits' }
    return { color: 'gray', label: 'local' }
}

function ConflictBanner({
    isVisible,
    onReload,
    onKeep,
}: {
    isVisible: boolean
    onReload: () => void
    onKeep: () => void
}) {
    if (!isVisible) return null
    return (
        <Alert color="orange" mt="sm" title="Claude changed the plan while you were typing">
            <Group gap="sm">
                <Button size="xs" onClick={onReload}>
                    Reload
                </Button>
                <Button size="xs" variant="outline" onClick={onKeep}>
                    Keep mine
                </Button>
            </Group>
        </Alert>
    )
}

function UploadWarning({ isVisible }: { isVisible: boolean }) {
    if (!isVisible) return null
    return (
        <span className="st-dim" style={{ fontSize: 12 }}>
            gh has no push right on management-app — Save is disabled
        </span>
    )
}

// The plan-lines result for the current file: a count when it parses, the
// problems when it does not. Save stays disabled until it is green.
function LineCheck({ check }: { check: PlanLinesCheck | null }) {
    if (!check) return null
    return (
        <span
            className="mono"
            style={{
                fontSize: 12,
                color: check.ok ? 'var(--ink-dim)' : 'var(--danger, #c0392b)',
                whiteSpace: 'pre-wrap',
            }}
        >
            {check.summary}
        </span>
    )
}

// Shown only when the local file differs from the release asset.
function DiscardButton({ isVisible, onDiscard }: { isVisible: boolean; onDiscard: () => void }) {
    if (!isVisible) return null
    return (
        <Button onClick={onDiscard} variant="subtle" color="red" size="compact-sm">
            Discard local edits
        </Button>
    )
}

function StartSessionButton({
    isVisible,
    disabled,
    onStart,
}: {
    isVisible: boolean
    disabled: boolean
    onStart: () => void
}) {
    if (!isVisible) return null
    return (
        <Button onClick={onStart} disabled={disabled} color="teal" variant="outline" radius="md">
            Start session
        </Button>
    )
}

function PlanError({ message }: { message: string }) {
    if (!message) return null
    return (
        <Alert color="red" mt="sm" style={{ whiteSpace: 'pre-wrap' }}>
            {message}
        </Alert>
    )
}
