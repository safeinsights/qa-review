import { Alert } from '@mantine/core'
import { RequestAccessButton } from './RequestAccessButton'
import {
    Card,
    EnvTabbedSection,
    FieldRow,
    Section,
    toGroupCards,
    useSettings,
} from './settingsShared'

// The three test-account roles. Their credentials are fully per-env (email,
// password, MFA code, TOTP seed — all secret), so each account card renders an
// env-tabbed "Account" section plus the "Results private key" section.
const ACCOUNT_GROUPS = new Set(['Admin', 'Researcher', 'Reviewer'])

export function AccountsTab() {
    const { fields, hasIdentity, error, setError, rowProps } = useSettings()

    const accountCards = toGroupCards(fields.filter(f => ACCOUNT_GROUPS.has(f.group)))

    return (
        <div style={{ maxWidth: 760 }}>
            <div className="kicker" style={{ marginBottom: 4 }}>
                Per-environment test accounts. Each field is a secret — set it under the env tab (qa
                / staging / production). An MFA TOTP seed, when set, overrides the fixed code.
            </div>

            {!hasIdentity ? (
                <Card mt="md">
                    <RequestAccessButton />
                </Card>
            ) : null}

            {error ? (
                <Alert
                    color="red"
                    mt="md"
                    title="Accounts error"
                    onClose={() => setError('')}
                    withCloseButton
                >
                    {error}
                </Alert>
            ) : null}

            {accountCards.map(card => (
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
