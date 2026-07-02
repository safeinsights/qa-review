import { Button, Tabs } from '@mantine/core'
import { useState } from 'react'
import { AutoDoctorModal } from './components/AutoDoctorModal'
import { ExploratoryTab } from './components/ExploratoryTab'
import { HelpDrawer } from './components/HelpDrawer'
import { KeyringAccessGate } from './components/KeyringAccessGate'
import { Logo } from './components/Logo'
import { ReportIssueButton } from './components/ReportIssueButton'
import { SettingsTab } from './components/SettingsTab'
import { SetupGate } from './components/SetupGate'
import { SuitesTab } from './components/SuitesTab'
import { SyncButton } from './components/SyncButton'

export function App() {
    const [tab, setTab] = useState<string | null>('suites')
    const [helpOpen, setHelpOpen] = useState(false)
    // Bumped after a successful sync so SuitesTab re-fetches the (possibly changed)
    // suite list — a pull that adds/removes suites now shows up without a restart.
    const [suitesRefresh, setSuitesRefresh] = useState(0)
    return (
        <SetupGate>
            <KeyringAccessGate>
                <AutoDoctorModal />
                <div style={{ maxWidth: 1500, margin: '0 auto', padding: '26px 32px' }}>
                    <header
                        style={{
                            display: 'flex',
                            alignItems: 'flex-start',
                            justifyContent: 'space-between',
                            gap: 24,
                            borderBottom: '2px solid var(--line-strong)',
                            paddingBottom: 14,
                        }}
                    >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                            <Logo size={40} />
                            <div>
                                <h1
                                    style={{
                                        fontFamily: '"Fraunces", serif',
                                        fontWeight: 600,
                                        fontSize: 27,
                                        letterSpacing: '-0.5px',
                                        margin: 0,
                                    }}
                                >
                                    SafeInsights QA Runner
                                </h1>
                                <div className="kicker" style={{ marginTop: 2 }}>
                                    test instrument
                                </div>
                            </div>
                        </div>
                        <SyncButton
                            onSynced={() => setSuitesRefresh(n => n + 1)}
                            extraActions={
                                <div style={{ display: 'flex', gap: 12 }}>
                                    <Button
                                        onClick={() => setHelpOpen(true)}
                                        variant="outline"
                                        color="dark"
                                        radius="md"
                                        size="sm"
                                        leftSection={<span aria-hidden>?</span>}
                                        styles={{
                                            root: {
                                                fontFamily: '"IBM Plex Mono", monospace',
                                                fontSize: 12,
                                            },
                                        }}
                                    >
                                        help
                                    </Button>
                                    <ReportIssueButton tab={tab} />
                                </div>
                            }
                        />
                    </header>

                    <HelpDrawer open={helpOpen} onClose={() => setHelpOpen(false)} />

                    <Tabs value={tab} onChange={setTab} mt="lg">
                        <Tabs.List>
                            <Tabs.Tab value="suites">Suites</Tabs.Tab>
                            <Tabs.Tab value="exploratory">Author a Suite</Tabs.Tab>
                            <Tabs.Tab value="settings">Settings</Tabs.Tab>
                        </Tabs.List>

                        {/* keepMounted: the Suites tab owns a live run (process + global
                    stdout-line/proc-exit listeners + run state). Unmounting it on a
                    tab switch tore that down — losing `running`, detaching the
                    listeners, then RE-attaching on return mid-stream — which let an
                    in-flight run look stopped and interleaved a second run's steps.
                    Keeping panels mounted preserves the run across tab switches. */}
                        <Tabs.Panel value="suites" pt="lg" keepMounted>
                            <SuitesTab refreshKey={suitesRefresh} />
                        </Tabs.Panel>
                        <Tabs.Panel value="exploratory" pt="lg" keepMounted>
                            <ExploratoryTab />
                        </Tabs.Panel>
                        <Tabs.Panel value="settings" pt="lg" keepMounted>
                            <SettingsTab />
                        </Tabs.Panel>
                    </Tabs>
                </div>
            </KeyringAccessGate>
        </SetupGate>
    )
}
