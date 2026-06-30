import { useState } from 'react'
import { Select, TextInput, Textarea, Button } from '@mantine/core'
import { RunScreen, type RunSpec } from './RunScreen'
import { SaveAsSuite } from './SaveAsSuite'
import type { ResultEnvelope } from '../lib/stepStream'

const REPO_ROOT = '..'
const ENVS = ['qa', 'staging']
const ROLES = ['admin', 'researcher', 'reviewer']

export function ExploratoryTab() {
    const [env, setEnv] = useState('qa')
    const [pr, setPr] = useState('')
    const [role, setRole] = useState('admin')
    const [instruction, setInstruction] = useState('')
    const [spec, setSpec] = useState<RunSpec | null>(null)
    const [result, setResult] = useState<ResultEnvelope | null>(null)

    const run = () => {
        setResult(null)
        // `claude` takes the prompt as a positional arg; skills resolve via
        // /skill-name IN the prompt, and context must be embedded in the prompt
        // text (claude rejects unknown --flags). So build one prompt string that
        // invokes the qa-explore skill with the env/role/instruction baked in.
        const target = pr ? `--pr ${pr}` : `--env ${env}`
        const prompt = `/qa-explore Run this against ${target} as role ${role}. Instruction: ${instruction}`
        // --dangerously-skip-permissions so the headless run can drive the browser
        // + shell qatest without interactive permission prompts.
        const args = ['-p', '--dangerously-skip-permissions', prompt]
        setSpec({ program: 'claude', args, cwd: REPO_ROOT })
    }

    return (
        <div>
            <div
                style={{
                    background: 'var(--paper-card)',
                    border: '1px solid var(--line)',
                    borderRadius: 10,
                    padding: '16px 18px',
                    boxShadow: 'var(--shadow-card)',
                }}
            >
                <div className="kicker" style={{ marginBottom: 8 }}>
                    Describe the test in plain English
                </div>
                <Textarea
                    value={instruction}
                    onChange={(e) => setInstruction(e.currentTarget.value)}
                    placeholder="e.g. log in as admin and confirm the dashboard shows pending studies"
                    autosize
                    minRows={2}
                    maxRows={5}
                    styles={{ input: { fontFamily: '"Newsreader", serif', fontSize: 15 } }}
                />

                <div style={{ display: 'flex', gap: 18, alignItems: 'flex-end', flexWrap: 'wrap', marginTop: 14 }}>
                    <Field label="Env">
                        <Select
                            data={ENVS}
                            value={env}
                            onChange={(v) => v && setEnv(v)}
                            disabled={!!pr}
                            allowDeselect={false}
                            w={110}
                            comboboxProps={{ withinPortal: true }}
                        />
                    </Field>
                    <Field label="PR #">
                        <TextInput value={pr} onChange={(e) => setPr(e.currentTarget.value)} placeholder="optional" w={90} />
                    </Field>
                    <Field label="Role">
                        <Select
                            data={ROLES}
                            value={role}
                            onChange={(v) => v && setRole(v)}
                            allowDeselect={false}
                            w={150}
                            comboboxProps={{ withinPortal: true }}
                        />
                    </Field>
                    <Button
                        onClick={run}
                        disabled={!instruction.trim()}
                        color="teal"
                        radius="md"
                        size="md"
                        style={{ marginLeft: 'auto', boxShadow: '0 6px 18px rgba(12,107,94,0.22)' }}
                        leftSection={<span aria-hidden>▶</span>}
                    >
                        Run
                    </Button>
                </div>
            </div>

            <RunScreen spec={spec} onDone={setResult} />
            {result?.ok ? <SaveAsSuite cwd={REPO_ROOT} result={result} /> : null}
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
