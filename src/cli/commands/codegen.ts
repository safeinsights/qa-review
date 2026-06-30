import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { parseTrace } from '@/codegen/action-trace'
import { generateSuite } from '@/codegen/generate-suite'

// Read a trace file, generate a Suite .ts, write it, and typecheck the project.
// On typecheck failure, remove the generated file and exit non-zero so callers
// (the GUI) never commit/push code that does not compile.
export async function codegenCommand(opts: Record<string, string>): Promise<void> {
    const raw = fs.readFileSync(opts.trace, 'utf8')
    const trace = parseTrace(raw)
    const outPath = opts.out ?? path.join('src', 'suites', `${trace.name}.ts`)

    fs.writeFileSync(outPath, generateSuite(trace))
    console.log(`wrote ${outPath}`)

    try {
        execFileSync('pnpm', ['typecheck'], { stdio: 'pipe' })
    } catch (e) {
        fs.rmSync(outPath, { force: true })
        const out = (e as { stdout?: Buffer }).stdout?.toString() ?? ''
        console.error('Generated suite failed typecheck; removed it.\n' + out)
        process.exit(1)
    }
    console.log(`ok: ${outPath} typechecks`)
}
