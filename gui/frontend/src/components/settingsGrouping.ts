import type { SettingField } from '../lib/ipc'

// Pure grouping helpers for the Settings panel. Kept out of the .tsx so they can be
// unit-tested from the root tsconfig (which has no --jsx and so can't import a .tsx).

// The fields of ONE env, grouped into cards. A card is an account ("Admin") or the
// account-less "" group holding that env's base URL; each card's fields are split
// into labelled sections ("Account", "Results private key"). Order is first-seen at
// every level, so the backend's knownVars order drives the layout.
export interface EnvCard {
    group: string
    sections: { section: string; fields: SettingField[] }[]
}

export function toEnvCards(fields: SettingField[], env: string): EnvCard[] {
    const envFields = fields.filter(f => f.env === env)
    const groups = [...new Set(envFields.map(f => f.group))]
    return groups.map(group => {
        const groupFields = envFields.filter(f => f.group === group)
        const sectionLabels = [...new Set(groupFields.map(f => f.section))]
        return {
            group,
            sections: sectionLabels.map(section => ({
                section,
                fields: groupFields.filter(f => f.section === section),
            })),
        }
    })
}

// Whether any field of the given env has a value set — drives the ✓ on its tab.
export function isEnvConfigured(fields: SettingField[], env: string): boolean {
    return fields.some(f => f.env === env && f.set)
}
