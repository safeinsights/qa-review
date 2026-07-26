import { Alert } from '@mantine/core'
import { RequestAccessButton } from './RequestAccessButton'
import { SetupDoctorButton } from './SetupDoctorButton'
import { Card, FieldRow, Section, useSettings } from './settingsShared'

// The account groups (Admin/Researcher/Reviewer) live in the Accounts tab. Settings
// keeps everything else: base URLs, the Jira config, and the keyring/doctor actions.
export function SettingsTab() {
    const { fields, hasIdentity, error, setError, rowProps } = useSettings()

    // Ungrouped fields (base URLs), then the Jira group. Account groups are excluded.
    const ungrouped = fields.filter(f => !f.group)
    const jira = fields.filter(f => f.group === 'Jira')

    return (
        <div style={{ maxWidth: 760 }}>
            <Card>
                <div
                    style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: 12,
                    }}
                >
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
                <Alert
                    color="red"
                    mt="md"
                    title="Settings error"
                    onClose={() => setError('')}
                    withCloseButton
                >
                    {error}
                </Alert>
            ) : null}

            {ungrouped.length ? (
                <Section title="Environment">
                    {ungrouped.map(f => (
                        <FieldRow key={f.key} field={f} {...rowProps} />
                    ))}
                </Section>
            ) : null}

            {jira.length ? (
                <Section title="Jira" subtitle="validation">
                    {jira.map(f => (
                        <FieldRow key={f.key} field={f} {...rowProps} />
                    ))}
                </Section>
            ) : null}
        </div>
    )
}
