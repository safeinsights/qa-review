package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
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

// ageArmorHeader is the PEM header of an armored age blob — used to tell an
// encrypted value from a plaintext one. Must match AGE_ARMOR_HEADER /
// isEncryptedValue() in src/engine/settings.ts.
const ageArmorHeader = "-----BEGIN AGE ENCRYPTED FILE-----"

// isEncryptedValue reports whether a settings value is an armored age blob.
// Mirrors isEncryptedValue() in src/engine/settings.ts.
func isEncryptedValue(v string) bool {
	return strings.HasPrefix(strings.TrimSpace(v), ageArmorHeader)
}

// secretVars are the var names whose values must be encrypted when committed to
// the project tier. Kept in sync with secretVarNames() in src/engine/settings.ts
// (each account's password + MFA code + results private key).
var secretVars = map[string]bool{
	"ADMIN_PASSWORD":                         true,
	"ADMIN_MFA_CODE":                         true,
	"ADMIN_RESULTS_PRIVATE_KEY_QA":           true,
	"ADMIN_RESULTS_PRIVATE_KEY_STAGING":      true,
	"RESEARCHER_PASSWORD":                    true,
	"RESEARCHER_MFA_CODE":                    true,
	"RESEARCHER_RESULTS_PRIVATE_KEY_QA":      true,
	"RESEARCHER_RESULTS_PRIVATE_KEY_STAGING": true,
	"REVIEWER_PASSWORD":                      true,
	"REVIEWER_MFA_CODE":                      true,
	"REVIEWER_RESULTS_PRIVATE_KEY_QA":        true,
	"REVIEWER_RESULTS_PRIVATE_KEY_STAGING":   true,
}

// knownVars is the ordered list of fields the Settings panel shows: per-env base
// URLs, then each account's email + password + MFA code + per-env results private
// keys. `Group` renders account sections; `Env` marks the qa/staging key variants
// the panel groups into sub-tabs. Kept in sync with knownVarNames()/secretVarNames()
// in src/engine/settings.ts (derived there from SHARED_ACCOUNTS x PRIVATE_KEY_ENVS).
var knownVars = []SettingField{
	{Key: "QA_BASE_URL", Label: "QA base URL", Secret: false, Group: ""},
	{Key: "STAGING_BASE_URL", Label: "Staging base URL", Secret: false, Group: ""},
	{Key: "ADMIN_EMAIL", Label: "Email", Secret: false, Group: "Admin"},
	{Key: "ADMIN_PASSWORD", Label: "Password", Secret: true, Group: "Admin"},
	{Key: "ADMIN_MFA_CODE", Label: "MFA code", Secret: true, Group: "Admin"},
	{Key: "ADMIN_RESULTS_PRIVATE_KEY_QA", Label: "Results private key", Secret: true, Group: "Admin", Env: "qa"},
	{Key: "ADMIN_RESULTS_PRIVATE_KEY_STAGING", Label: "Results private key", Secret: true, Group: "Admin", Env: "staging"},
	{Key: "RESEARCHER_EMAIL", Label: "Email", Secret: false, Group: "Researcher"},
	{Key: "RESEARCHER_PASSWORD", Label: "Password", Secret: true, Group: "Researcher"},
	{Key: "RESEARCHER_MFA_CODE", Label: "MFA code", Secret: true, Group: "Researcher"},
	{Key: "RESEARCHER_RESULTS_PRIVATE_KEY_QA", Label: "Results private key", Secret: true, Group: "Researcher", Env: "qa"},
	{Key: "RESEARCHER_RESULTS_PRIVATE_KEY_STAGING", Label: "Results private key", Secret: true, Group: "Researcher", Env: "staging"},
	{Key: "REVIEWER_EMAIL", Label: "Email", Secret: false, Group: "Reviewer"},
	{Key: "REVIEWER_PASSWORD", Label: "Password", Secret: true, Group: "Reviewer"},
	{Key: "REVIEWER_MFA_CODE", Label: "MFA code", Secret: true, Group: "Reviewer"},
	{Key: "REVIEWER_RESULTS_PRIVATE_KEY_QA", Label: "Results private key", Secret: true, Group: "Reviewer", Env: "qa"},
	{Key: "REVIEWER_RESULTS_PRIVATE_KEY_STAGING", Label: "Results private key", Secret: true, Group: "Reviewer", Env: "staging"},
}

// SettingField is one row in the Settings panel.
type SettingField struct {
	Key    string `json:"key"`
	Label  string `json:"label"`
	Secret bool   `json:"secret"`
	// Account section this field belongs to ("Admin"/"Researcher"/"Reviewer"),
	// or "" for ungrouped fields (the base URLs).
	Group string `json:"group"`
	// For per-environment fields (the results private keys), the env this value
	// is for ("qa"/"staging") — the panel renders these as sub-tabs within the
	// account. "" for env-agnostic fields (email/password/MFA, base URLs).
	Env string `json:"env"`
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
	// HasIdentity reports whether this user has an age identity file
	// (config/age-identity.txt), so the UI can prompt to generate one if missing.
	HasIdentity bool `json:"hasIdentity"`
}

// configDirFor returns the cloned repo's config/ dir. The cwd param is vestigial
// (kept for the existing bound-method signatures) — config lives in the user-writable
// clone, not at a cwd-relative offset.
func configDirFor(cwd string) string {
	return filepath.Join(repoDir(), "config")
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

// parseKeyringRecipients extracts the recipient public keys from a keyring.json
// byte blob. Empty input yields no recipients (not an error).
func parseKeyringRecipients(data []byte) ([]string, error) {
	if len(bytes.TrimSpace(data)) == 0 {
		return nil, nil
	}
	var members []struct {
		PublicKey string `json:"publicKey"`
	}
	if err := json.Unmarshal(data, &members); err != nil {
		return nil, err
	}
	keys := make([]string, 0, len(members))
	for _, m := range members {
		keys = append(keys, m.PublicKey)
	}
	return keys, nil
}

// readKeyringRecipients reads the recipient public keys from config/keyring.json.
// A missing file yields no recipients (not an error).
func readKeyringRecipients(dir string) ([]string, error) {
	data, err := os.ReadFile(filepath.Join(dir, "keyring.json"))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	return parseKeyringRecipients(data)
}

// loadIdentity reads config/age-identity.txt (dir is the config dir) and parses the
// age X25519 secret key. The bool is false with no error when the file is absent, so
// callers can distinguish "no identity" from a malformed/unusable one.
func loadIdentity(dir string) (*age.X25519Identity, bool, error) {
	data, err := os.ReadFile(filepath.Join(dir, "age-identity.txt"))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, false, nil
		}
		return nil, false, err
	}
	// Standard age identity format: skip comment (#) and blank lines; the secret
	// key is the first remaining line.
	var secret string
	for _, line := range strings.Split(string(data), "\n") {
		s := strings.TrimSpace(line)
		if s == "" || strings.HasPrefix(s, "#") {
			continue
		}
		secret = s
		break
	}
	if secret == "" {
		return nil, false, fmt.Errorf("age-identity.txt has no key line")
	}
	id, err := age.ParseX25519Identity(secret)
	if err != nil {
		return nil, false, err
	}
	return id, true, nil
}

// identityPublicKey returns the local identity's public recipient string (age1...).
// The second return is false with no error when the identity file is absent.
// Mirrors publicKeyFromIdentity() in src/engine/settings.ts.
func identityPublicKey(dir string) (string, bool, error) {
	id, has, err := loadIdentity(dir)
	if err != nil || !has {
		return "", has, err
	}
	return id.Recipient().String(), true, nil
}

// identityInKeyring reports whether the local identity exists and whether its
// public key is a recipient in config/keyring.json (dir is the config dir). A
// missing keyring yields isRecipient=false (not an error).
func identityInKeyring(dir string) (hasIdentity, isRecipient bool, err error) {
	pub, has, err := identityPublicKey(dir)
	if err != nil || !has {
		return false, false, err
	}
	recipients, err := readKeyringRecipients(dir)
	if err != nil {
		return true, false, err
	}
	for _, r := range recipients {
		if r == pub {
			return true, true, nil
		}
	}
	return true, false, nil
}

// identityDecryptsSecrets is the AUTHORITATIVE access check: it tries to actually
// decrypt a committed secret with the local identity. Membership in the working-tree
// keyring.json is not enough — `request-access` writes your key there locally before
// the access PR is opened/merged, so a key that never landed on main (and thus was
// never rekeyed into the committed secrets) still "looks" present. A real decrypt
// only succeeds when your key is a recipient of the secrets as committed.
//
// hasIdentity mirrors identityInKeyring. canDecrypt is true only when EVERY
// encrypted secret decrypts — matching the engine's loadSettings(), which throws on
// the first secret it can't decrypt. A single undecryptable secret (e.g. one rotated
// via `set-secret` from a checkout whose keyring predated this user) fails a real
// run, so reporting "can decrypt" off just one success would be a false green.
// checkable is false when there's nothing to test against (no secrets file / no
// encrypted values yet) — the caller then treats it as "can't tell" rather than a
// failure.
func identityDecryptsSecrets(configDir string) (hasIdentity, canDecrypt, checkable bool, err error) {
	id, has, err := loadIdentity(configDir)
	if err != nil || !has {
		return false, false, true, err
	}
	secrets, err := readSettingsFile(filepath.Join(configDir, secretsFile))
	if err != nil {
		return true, false, false, err
	}
	tried := false
	for _, val := range secrets {
		// Match loadSettings(): it decrypts EVERY encrypted value in the secrets
		// tier, not just known secretVars — so an encrypted value under an unknown
		// key still fails a real run. Test the same set here.
		if !isEncryptedValue(val) {
			continue
		}
		tried = true
		if _, decErr := decryptWithIdentity(val, id); decErr != nil {
			// Any secret we can't decrypt means a real run would fail here.
			return true, false, true, nil
		}
	}
	if !tried {
		// No encrypted secrets to test against — can't confirm or deny access.
		return true, false, false, nil
	}
	return true, true, true, nil
}

// decryptWithIdentity decrypts an armored age blob with a single X25519 identity.
func decryptWithIdentity(armored string, id *age.X25519Identity) (string, error) {
	ar := armor.NewReader(strings.NewReader(armored))
	r, err := age.Decrypt(ar, id)
	if err != nil {
		return "", err
	}
	buf := &bytes.Buffer{}
	if _, err := io.Copy(buf, r); err != nil {
		return "", err
	}
	return buf.String(), nil
}

// writeLock writes config/keyring.lock with a stable fingerprint of the recipient
// set: sha256 hex of the recipient keys, sorted ascending, joined with "\n". Must
// match src/engine/keyring.ts fingerprint() byte-for-byte.
func writeLock(dir string, recipients []string) error {
	sorted := append([]string(nil), recipients...)
	sort.Strings(sorted)
	sum := sha256.Sum256([]byte(strings.Join(sorted, "\n")))
	return os.WriteFile(filepath.Join(dir, "keyring.lock"), []byte(hex.EncodeToString(sum[:])+"\n"), 0o644)
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

	_, idErr := os.Stat(filepath.Join(dir, "age-identity.txt"))
	view := SettingsView{HasIdentity: idErr == nil}
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
// A secret field saved to "project" is age-encrypted to every recipient in
// config/keyring.json and stored in settings.secrets.json (refreshing the
// keyring.lock fingerprint). A secret saved to "local", or any non-secret field,
// is written in plaintext to its tier's file. Writing a field to one tier removes
// any stale copy of the same key from the other writable tiers, so the precedence
// is unambiguous.
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
		recipients, err := readKeyringRecipients(dir)
		if err != nil {
			return err
		}
		enc, err := encryptToRecipients(value, recipients)
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

	// After encrypting a secret to the keyring, refresh the lock fingerprint so the
	// engine can tell the committed secrets match the current recipient set.
	if targetFile == secretsFile {
		recipients, _ := readKeyringRecipients(dir)
		if err := writeLock(dir, recipients); err != nil {
			return err
		}
	}
	return nil
}

// encryptToRecipients encrypts to one or more age X25519 recipients (age1...).
func encryptToRecipients(plaintext string, recipientKeys []string) (string, error) {
	if len(recipientKeys) == 0 {
		return "", fmt.Errorf("keyring is empty — add a recipient before saving a secret")
	}
	recs := make([]age.Recipient, 0, len(recipientKeys))
	for _, k := range recipientKeys {
		r, err := age.ParseX25519Recipient(k)
		if err != nil {
			return "", err
		}
		recs = append(recs, r)
	}
	buf := &bytes.Buffer{}
	aw := armor.NewWriter(buf)
	w, err := age.Encrypt(aw, recs...)
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
