import { Alert } from '@mantine/core'
import { RequestAccessButton } from './RequestAccessButton'
import { SetupDoctorButton } from './SetupDoctorButton'
import {
    Card,
    EnvTabbedSection,
    FieldRow,
    Section,
    toGroupCards,
    useSettings,
} from './settingsShared'

export function SettingsTab() {
    const { fields, hasIdentity, error, setError, rowProps } = useSettings()

    // Ungrouped fields (base URLs) render first, then each grouped card (the test
    // accounts + Jira). Account fields are per-env and secret, so each account card
    // holds env-tabbed sections (email/password/MFA under "Account", the PEM under
    // "Results private key").
    const ungrouped = fields.filter(f => !f.group)
    const groupCards = toGroupCards(fields)

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

            {groupCards.map(card => (
                <Section key={card.group} title={card.group} subtitle="account">
                    {card.plain.map(f => (
                        <FieldRow key={f.key} field={f} {...rowProps} />
                    ))}
                    {card.sections.map(s => (
                        <EnvTabbedSection
                            key={`${card.group}:${s.section}`}
                            label={s.section}
                            envs={s.envs}
                            {...rowProps}
                        />
                    ))}
                </Section>
            ))}
        </div>
    )
}
