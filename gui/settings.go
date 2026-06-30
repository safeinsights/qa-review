package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"filippo.io/age"
	"filippo.io/age/armor"
)

// Settings file names under the repo-root config/ dir. Mirrors src/engine/settings.ts.
const (
	projectFile = "settings.json"
	secretsFile = "settings.secrets.json"
	localFile   = "settings.local.json"
)

const ageArmorHeader = "-----BEGIN AGE ENCRYPTED FILE-----"

// secretVars are the var names whose values must be encrypted when committed to
// the project tier. Kept in sync with secretVarNames() in src/engine/settings.ts
// (each account's password + MFA code).
var secretVars = map[string]bool{
	"ADMIN_PASSWORD":      true,
	"ADMIN_MFA_CODE":      true,
	"RESEARCHER_PASSWORD": true,
	"RESEARCHER_MFA_CODE": true,
	"REVIEWER_PASSWORD":   true,
	"REVIEWER_MFA_CODE":   true,
}

// knownVars is the ordered list of fields the Settings panel shows: per-env base
// URLs, then each account's email + password + MFA code. `Group` lets the panel
// render account sections (empty for the un-grouped base URLs).
var knownVars = []SettingField{
	{Key: "QA_BASE_URL", Label: "QA base URL", Secret: false, Group: ""},
	{Key: "STAGING_BASE_URL", Label: "Staging base URL", Secret: false, Group: ""},
	{Key: "ADMIN_EMAIL", Label: "Email", Secret: false, Group: "Admin"},
	{Key: "ADMIN_PASSWORD", Label: "Password", Secret: true, Group: "Admin"},
	{Key: "ADMIN_MFA_CODE", Label: "MFA code", Secret: true, Group: "Admin"},
	{Key: "RESEARCHER_EMAIL", Label: "Email", Secret: false, Group: "Researcher"},
	{Key: "RESEARCHER_PASSWORD", Label: "Password", Secret: true, Group: "Researcher"},
	{Key: "RESEARCHER_MFA_CODE", Label: "MFA code", Secret: true, Group: "Researcher"},
	{Key: "REVIEWER_EMAIL", Label: "Email", Secret: false, Group: "Reviewer"},
	{Key: "REVIEWER_PASSWORD", Label: "Password", Secret: true, Group: "Reviewer"},
	{Key: "REVIEWER_MFA_CODE", Label: "MFA code", Secret: true, Group: "Reviewer"},
}

// SettingField is one row in the Settings panel.
type SettingField struct {
	Key    string `json:"key"`
	Label  string `json:"label"`
	Secret bool   `json:"secret"`
	// Account section this field belongs to ("Admin"/"Researcher"/"Reviewer"),
	// or "" for ungrouped fields (the base URLs).
	Group string `json:"group"`
	// Where the current value comes from: "project", "secrets", "local", or ""
	// (unset). For secrets, the value itself is NOT returned to the UI.
	Tier string `json:"tier"`
	// Plaintext value for non-secret fields. Empty for secret fields (a tester
	// re-types a secret to change it) — `Set` says whether one already exists.
	Value string `json:"value"`
	Set   bool   `json:"set"`
}

// SettingsView is the merged settings state returned to the panel.
type SettingsView struct {
	Fields []SettingField `json:"fields"`
	// HasPassphrase reports whether the session passphrase is set (so the UI can
	// gate encrypted saves / show a lock prompt).
	HasPassphrase bool `json:"hasPassphrase"`
}

func configDirFor(cwd string) string {
	return filepath.Join(resolveCwd(cwd), "config")
}

// readSettingsFile reads one JSON settings file into a string map. A missing or
// empty file yields an empty map (not an error).
func readSettingsFile(path string) (map[string]string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]string{}, nil
		}
		return nil, err
	}
	trimmed := strings.TrimSpace(string(data))
	if trimmed == "" {
		return map[string]string{}, nil
	}
	out := map[string]string{}
	if err := json.Unmarshal([]byte(trimmed), &out); err != nil {
		return nil, fmt.Errorf("%s: %w", filepath.Base(path), err)
	}
	return out, nil
}

// writeSettingsFile writes a string map to one JSON settings file, sorted-key,
// indented for clean git diffs.
func writeSettingsFile(path string, m map[string]string) error {
	data, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	return os.WriteFile(path, data, 0o644)
}

// SetPassphrase stores the session age passphrase in memory (never persisted).
func (a *App) SetPassphrase(p string) {
	a.passphrase = p
}

// ReadSettings reads the three settings files under cwd/config and returns a
// merged view for the panel. Secret values are reported as "set" but never
// returned in plaintext.
func (a *App) ReadSettings(cwd string) (SettingsView, error) {
	dir := configDirFor(cwd)
	project, err := readSettingsFile(filepath.Join(dir, projectFile))
	if err != nil {
		return SettingsView{}, err
	}
	secrets, err := readSettingsFile(filepath.Join(dir, secretsFile))
	if err != nil {
		return SettingsView{}, err
	}
	local, err := readSettingsFile(filepath.Join(dir, localFile))
	if err != nil {
		return SettingsView{}, err
	}

	view := SettingsView{HasPassphrase: a.passphrase != ""}
	for _, f := range knownVars {
		field := f // copy template (Key/Label/Secret)
		// Precedence for display matches load order: local > secrets > project.
		if v, ok := local[f.Key]; ok {
			field.Tier, field.Set = "local", true
			if !f.Secret {
				field.Value = v
			}
		} else if v, ok := secrets[f.Key]; ok {
			field.Tier, field.Set = "secrets", true
			if !f.Secret {
				field.Value = v
			}
		} else if v, ok := project[f.Key]; ok {
			field.Tier, field.Set = "project", true
			if !f.Secret {
				field.Value = v
			}
		}
		view.Fields = append(view.Fields, field)
	}
	return view, nil
}

// WriteSetting writes one field to the chosen tier ("project" or "local").
//
// A secret field saved to "project" is age-encrypted with the session passphrase
// and stored in settings.secrets.json. A secret saved to "local", or any
// non-secret field, is written in plaintext to its tier's file. Writing a field
// to one tier removes any stale copy of the same key from the other writable
// tiers, so the precedence is unambiguous.
func (a *App) WriteSetting(cwd, key, value, tier string) error {
	if tier != "project" && tier != "local" {
		return fmt.Errorf("invalid tier %q (want project or local)", tier)
	}
	dir := configDirFor(cwd)
	isSecret := secretVars[key]

	// Resolve the target file for this (tier, secret) combination.
	var targetFile string
	switch {
	case tier == "local":
		targetFile = localFile
	case isSecret: // tier == project, secret -> encrypted secrets file
		targetFile = secretsFile
	default: // tier == project, non-secret -> plaintext project file
		targetFile = projectFile
	}

	stored := value
	if targetFile == secretsFile {
		if a.passphrase == "" {
			return fmt.Errorf("set a passphrase before saving a secret to the project (encrypted) tier")
		}
		enc, err := encryptString(value, a.passphrase)
		if err != nil {
			return err
		}
		stored = enc
	}

	// Write the value into its target file (read-modify-write).
	target := filepath.Join(dir, targetFile)
	m, err := readSettingsFile(target)
	if err != nil {
		return err
	}
	m[key] = stored
	if err := writeSettingsFile(target, m); err != nil {
		return err
	}

	// Remove any copy of this key from the OTHER writable files so the field has
	// exactly one home (avoids a stale lower-precedence value lingering).
	for _, other := range []string{projectFile, secretsFile, localFile} {
		if other == targetFile {
			continue
		}
		path := filepath.Join(dir, other)
		om, err := readSettingsFile(path)
		if err != nil {
			return err
		}
		if _, ok := om[key]; ok {
			delete(om, key)
			if err := writeSettingsFile(path, om); err != nil {
				return err
			}
		}
	}
	return nil
}

// encryptString encrypts a value to an ASCII-armored age blob using a scrypt
// (passphrase) recipient. Interoperable with the TS age-encryption decryptValue.
func encryptString(plaintext, passphrase string) (string, error) {
	r, err := age.NewScryptRecipient(passphrase)
	if err != nil {
		return "", err
	}
	buf := &bytes.Buffer{}
	aw := armor.NewWriter(buf)
	w, err := age.Encrypt(aw, r)
	if err != nil {
		return "", err
	}
	if _, err := io.WriteString(w, plaintext); err != nil {
		return "", err
	}
	if err := w.Close(); err != nil {
		return "", err
	}
	if err := aw.Close(); err != nil {
		return "", err
	}
	return buf.String(), nil
}
