import { useState } from 'react'
import { Tabs } from '@mantine/core'
import { SuitesTab } from './components/SuitesTab'
import { ExploratoryTab } from './components/ExploratoryTab'
import { SyncButton } from './components/SyncButton'

export function App() {
    const [tab, setTab] = useState<string | null>('suites')
    return (
        <div style={{ maxWidth: 1500, margin: '0 auto', padding: '26px 32px' }}>
            <header
                style={{
                    display: 'flex',
                    alignItems: 'baseline',
                    justifyContent: 'space-between',
                    borderBottom: '2px solid var(--line-strong)',
                    paddingBottom: 14,
                }}
            >
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
                <SyncButton cwd=".." />
            </header>

            <Tabs value={tab} onChange={setTab} mt="lg">
                <Tabs.List>
                    <Tabs.Tab value="suites">Suites</Tabs.Tab>
                    <Tabs.Tab value="exploratory">Exploratory</Tabs.Tab>
                </Tabs.List>

                <Tabs.Panel value="suites" pt="lg">
                    <SuitesTab />
                </Tabs.Panel>
                <Tabs.Panel value="exploratory" pt="lg">
                    <ExploratoryTab />
                </Tabs.Panel>
            </Tabs>
        </div>
    )
}
