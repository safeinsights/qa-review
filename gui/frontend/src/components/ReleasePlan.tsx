import { Alert, Badge, Button, Group, Modal, Switch } from '@mantine/core'
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
    runLive,
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
    runLive: boolean
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
            <GeneratingNote isVisible={!plan.exists} />
            <EditorPane
                isVisible={plan.exists}
                plan={plan}
                status={status}
                preview={preview}
                onPreview={setPreview}
                badge={badge}
                canSave={canSave}
                sessionLive={sessionLive}
                runLive={runLive}
                starting={starting}
                onRegenerate={onRegenerate}
                onStartSession={onStartSession}
                onRun={onRun}
                onStop={onStop}
            />
            <NoPlanRow
                isVisible={!plan.exists}
                sessionLive={sessionLive}
                canRetry={!sessionLive && !runLive && !starting}
                onRetry={onStartSession}
                onStop={onStop}
            />
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

type ReleasePlanState = ReturnType<typeof useReleasePlan>

// Mounting the editor before plan.md exists showed an empty box for the whole
// ~10 minutes Claude spends writing it.
function EditorPane({
    isVisible,
    plan,
    status,
    preview,
    onPreview,
    badge,
    canSave,
    sessionLive,
    runLive,
    starting,
    onRegenerate,
    onStartSession,
    onRun,
    onStop,
}: {
    isVisible: boolean
    plan: ReleasePlanState
    status: ReleaseStatus
    preview: boolean
    onPreview: (value: boolean) => void
    badge: { color: string; label: string }
    canSave: boolean
    sessionLive: boolean
    runLive: boolean
    starting: boolean
    onRegenerate: () => void
    onStartSession: () => void
    onRun: () => void
    onStop: () => void
}) {
    if (!isVisible) return null
    return (
        <>
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
                    onChange={e => onPreview(e.currentTarget.checked)}
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
                    isVisible={!sessionLive && !runLive}
                    disabled={starting}
                    label="Start session"
                    onStart={onStartSession}
                />
                <RegenerateButton
                    isVisible={!runLive}
                    disabled={starting}
                    onRegenerate={onRegenerate}
                />
                <RunLiveNote isVisible={runLive} />
                <RunBlockedNote isVisible={status.local.planDiffers} />
                <Button
                    onClick={onRun}
                    variant="outline"
                    color="dark"
                    radius="md"
                    disabled={sessionLive || status.local.planDiffers}
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
        </>
    )
}

function GeneratingNote({ isVisible }: { isVisible: boolean }) {
    if (!isVisible) return null
    return (
        <div
            className="st-dim"
            style={{
                border: '1px dashed var(--line)',
                borderRadius: 10,
                padding: '18px',
                fontStyle: 'italic',
            }}
        >
            Generating the plan — the editor opens when Claude writes plan.md.
        </div>
    )
}

// The full status row is hidden while generating, but the user must still be
// able to end the session, and to retry one that ended before plan.md existed
// (the retry reuses every pr-<n>.json already written).
function NoPlanRow({
    isVisible,
    sessionLive,
    canRetry,
    onRetry,
    onStop,
}: {
    isVisible: boolean
    sessionLive: boolean
    canRetry: boolean
    onRetry: () => void
    onStop: () => void
}) {
    if (!isVisible) return null
    return (
        <Group mt="sm">
            <StartSessionButton
                isVisible={!sessionLive}
                disabled={!canRetry}
                label="Retry"
                onStart={onRetry}
            />
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

// Shown only when the local file differs from the release asset. A discard cannot be
// undone, so it asks first.
function DiscardButton({ isVisible, onDiscard }: { isVisible: boolean; onDiscard: () => void }) {
    const [confirmOpen, setConfirmOpen] = useState(false)
    if (!isVisible) return null
    const confirm = () => {
        setConfirmOpen(false)
        onDiscard()
    }
    return (
        <>
            <Button
                onClick={() => setConfirmOpen(true)}
                variant="subtle"
                color="red"
                size="compact-sm"
            >
                Discard local edits
            </Button>
            <Modal
                opened={confirmOpen}
                onClose={() => setConfirmOpen(false)}
                title="Discard local edits?"
            >
                <p>Your Security section is kept.</p>
                <Group justify="flex-end" gap="sm">
                    <Button variant="subtle" onClick={() => setConfirmOpen(false)}>
                        Cancel
                    </Button>
                    <Button color="red" onClick={confirm}>
                        Discard
                    </Button>
                </Group>
            </Modal>
        </>
    )
}

function StartSessionButton({
    isVisible,
    disabled,
    label,
    onStart,
}: {
    isVisible: boolean
    disabled: boolean
    label: string
    onStart: () => void
}) {
    if (!isVisible) return null
    return (
        <Button onClick={onStart} disabled={disabled} color="teal" variant="outline" radius="md">
            {label}
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

function RegenerateButton({
    isVisible,
    disabled,
    onRegenerate,
}: {
    isVisible: boolean
    disabled: boolean
    onRegenerate: () => void
}) {
    if (!isVisible) return null
    return (
        <Button onClick={onRegenerate} variant="outline" radius="md" disabled={disabled}>
            Regenerate
        </Button>
    )
}

// A run uses the saved asset, so local edits would go untested.
function RunBlockedNote({ isVisible }: { isVisible: boolean }) {
    if (!isVisible) return null
    return (
        <span className="st-dim" style={{ fontSize: 12 }}>
            Save or discard the local edits before a run.
        </span>
    )
}

function RunLiveNote({ isVisible }: { isVisible: boolean }) {
    if (!isVisible) return null
    return (
        <span className="st-dim" style={{ fontSize: 12 }}>
            A run is live for this release — stop it from the Run phase first.
        </span>
    )
}
