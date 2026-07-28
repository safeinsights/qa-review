import { Alert, Tabs } from '@mantine/core'
import { RequestAccessButton } from './RequestAccessButton'
import { SetupDoctorButton } from './SetupDoctorButton'
import { isEnvConfigured, toEnvCards } from './settingsGrouping'
import { Card, EnvCardBody, FieldRow, Section, useSettings } from './settingsShared'

// Cards for the account-less group ("" — the base URL) get this title; the account
// cards are titled by their group name.
const ENVIRONMENT_TITLE = 'Base URL'

// The env selector is the primary divider on this screen, so it gets the same
// Fraunces heading treatment as a Section title (a step up, at 20px) and tabs sized
// well above Mantine's default.
const ENV_HEADING: React.CSSProperties = {
    margin: 0,
    fontFamily: '"Fraunces", serif',
    fontWeight: 600,
    fontSize: 20,
}
const ENV_TAB: React.CSSProperties = { fontSize: 16, fontWeight: 600, padding: '10px 18px' }

export function SettingsTab() {
    const { fields, hasIdentity, error, setError, rowProps, env, setEnv, envs } = useSettings()

    // Jira is the one genuinely global setting (one site per user, never per-env), so
    // it sits above the env tabs. Everything else — the base URL and all three
    // accounts — is env-scoped and renders under the selected env.
    const jiraFields = fields.filter(f => f.group === 'Jira')
    const envCards = toEnvCards(fields, env)

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

            {jiraFields.length ? (
                <Section title="Jira" subtitle="shared across environments">
                    {jiraFields.map(f => (
                        <FieldRow key={f.key} field={f} {...rowProps} />
                    ))}
                </Section>
            ) : null}

            {/* One env selector for the whole panel — everything below it belongs to the
                selected env, so it's styled as a heading rather than a minor control.
                Only the selected env renders, so a hidden env holds no stale state. */}
            <div style={{ marginTop: 28 }}>
                <h3 style={ENV_HEADING}>Environment</h3>
                <div className="kicker" style={{ marginTop: 2, marginBottom: 8 }}>
                    the settings below apply to the selected environment
                </div>
                <Tabs value={env} onChange={v => setEnv(v ?? env)}>
                    <Tabs.List>
                        {envs.map(e => (
                            <Tabs.Tab key={e} value={e} style={ENV_TAB}>
                                {e}
                                {isEnvConfigured(fields, e) ? ' ✓' : ''}
                            </Tabs.Tab>
                        ))}
                    </Tabs.List>
                </Tabs>
            </div>

            {envCards.map(card => (
                <Section
                    key={card.group}
                    title={card.group || ENVIRONMENT_TITLE}
                    subtitle={card.group ? 'account' : undefined}
                >
                    <EnvCardBody card={card} {...rowProps} />
                </Section>
            ))}
        </div>
    )
}
