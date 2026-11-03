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

// The bytes stripSecurity removes: the heading through the line before the next
// `## ` heading. Empty when the plan has no Security section.
export function extractSecurity(plan: string): string {
    let inside = false
    const kept: string[] = []
    for (const line of linesWithEndings(plan)) {
        const text = bare(line)
        if (SECURITY_HEADING.test(text)) inside = true
        else if (inside && ANY_SECTION.test(text)) break
        if (inside) kept.push(line)
    }
    return kept.join('')
}

// Puts a Security section back where the plan format has it: at the end of
// `## Changes`, which is right before `## Technical appendix`. So stripSecurity of
// the result is the plan again, byte for byte.
export function spliceSecurity(plan: string, section: string): string {
    if (!section) return plan
    const lines = linesWithEndings(plan)
    const eol = plan.includes('\r\n') ? '\r\n' : '\n'
    const ending = /\n$/.test(section) ? section : `${section}${eol}`
    const changes = lines.findIndex(l => /^## Changes\s*$/.test(bare(l)))
    let at = -1
    if (changes >= 0) {
        const next = lines.findIndex((l, i) => i > changes && ANY_SECTION.test(bare(l)))
        at = next >= 0 ? next : lines.length
    } else {
        at = lines.findIndex(l => /^## Technical appendix\s*$/.test(bare(l)))
    }
    if (at < 0 || at === lines.length) {
        const head = plan === '' || /\n$/.test(plan) ? plan : `${plan}${eol}`
        return `${head}${section}`
    }
    return [...lines.slice(0, at), ending, ...lines.slice(at)].join('')
}

// The upload guard. Any S- id, an S- bullet under any list marker or indent, a
// Security heading at any depth, or a results row for an S- line each mean the file
// holds security content that must not go public. An S- id in prose counts too: a
// false refusal costs an edit, a false pass publishes a probe.
const SECURITY_CONTENT = [
    /\bS-\d+\b/,
    /^[ \t]*[-*+][ \t]+\[S-\d+\]/m,
    /^[ \t]*#{1,6}[ \t]*security\b/im,
    /^\|\s*S-\d+\s*\|/m,
]

export function hasSecurityContent(text: string): boolean {
    return SECURITY_CONTENT.some(re => re.test(text))
}
