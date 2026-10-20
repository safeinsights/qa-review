import fs from 'node:fs'
import path from 'node:path'
import { addMark, formatClock, type Mark } from '@/engine/clock'

// `qar clock --file <path.json> --mark <phase>` appends a timestamp;
// `qar clock --file <path.json> --report` prints the phase durations as one line
// for the report summary. The file is `{"marks":[{"phase","at"}]}`.
export async function clockCommand(opts: Record<string, string>): Promise<void> {
    const file = (opts.file ?? '').trim()
    if (!file || file === 'true') throw new Error('clock requires --file <path.json>')
    const mark = (opts.mark ?? '').trim()
    const report = opts.report === 'true'
    if (!mark && !report) throw new Error('clock requires --mark <phase> or --report')

    const marks: Mark[] = fs.existsSync(file)
        ? ((JSON.parse(fs.readFileSync(file, 'utf8')) as { marks?: Mark[] }).marks ?? [])
        : []

    if (mark) {
        const next = addMark(marks, mark)
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, `${JSON.stringify({ marks: next }, null, 1)}\n`)
        process.stdout.write(`${JSON.stringify({ file, marks: next.length, phase: mark })}\n`)
        return
    }
    process.stdout.write(`${formatClock(marks, Date.now())}\n`)
}
