// The part of a new management-app release body that is not the plan's Summary: the
// "Related Releases" list versionista wrote. The Summary goes after it, in the
// regression-summary block release-summary maintains. There is no PR table: the
// changelog replaces it, and full PR bodies passed GitHub's 125,000-character limit.

export interface RelatedRelease {
    label: string
    repo: string
    tag: string
}

// `owner/repo=Label` pairs, comma separated, in display order.
export function parseRelatedRepos(raw: string): { repo: string; label: string }[] {
    return raw
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
        .map(pair => {
            const [repo, label] = pair.split('=').map(s => s.trim())
            if (!repo || !label || !repo.includes('/')) {
                throw new Error(`RELATED_RELEASE_REPOS: "${pair}" is not owner/repo=Label`)
            }
            return { repo, label }
        })
}

export function relatedReleasesSection(related: RelatedRelease[]): string {
    const links = related.map(
        r => `- [${r.label} ${r.tag}](https://github.com/${r.repo}/releases/tag/${r.tag})`
    )
    return ['## Related Releases', '', ...links, ''].join('\n')
}
