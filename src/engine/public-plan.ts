// management-app is a public repo, so its release assets are public too. The plan's
// Security section names probes against the live app and stays in the local
// plan.md; only the rest of the plan is uploaded.

const SECURITY_HEADING = /^## Security\s*$/
const ANY_SECTION = /^## /

// Lines with their own endings, so a CRLF file comes back CRLF.
function linesWithEndings(text: string): string[] {
    return text.match(/[^\n]*\n|[^\n]+$/g) ?? []
}

function bare(line: string): string {
    return line.replace(/\r?\n$/, '')
}

// Removes the `## Security` section: its heading through the line before the next
// `## ` heading (or the end of the file). Every other byte is kept as it was.
export function stripSecurity(plan: string): string {
    let skipping = false
    const kept: string[] = []
    for (const line of linesWithEndings(plan)) {
        const text = bare(line)
        if (SECURITY_HEADING.test(text)) {
            skipping = true
            continue
        }
        if (skipping && ANY_SECTION.test(text)) skipping = false
        if (!skipping) kept.push(line)
    }
    return kept.join('')
}

// The upload guard. A plan bullet, a Security heading, or a results table row for an
// S- line each mean the file holds security content that must not go public.
const SECURITY_CONTENT = [/^- \[S-\d+\]/m, /^## Security\s*$/m, /^\|\s*S-\d+\s*\|/m]

export function hasSecurityContent(text: string): boolean {
    return SECURITY_CONTENT.some(re => re.test(text))
}
