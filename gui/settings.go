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

// envList is the set of stable envs that carry per-env account secrets. Kept in
// sync with PRIVATE_KEY_ENVS in config/environments.ts.
var envList = []string{"qa", "staging", "production"}

// accountGroups maps each account's display group to its var prefix.
var accountGroups = []struct{ group, prefix string }{
	{"Admin", "ADMIN"},
	{"Researcher", "RESEARCHER"},
	{"Reviewer", "REVIEWER"},
}

// secretVars are the var names whose values must be encrypted when committed to the
// project tier. Kept in sync with secretVarNames() in src/engine/settings.ts: every
// account field is per-env and secret (email, password, results private key, MFA
// code, MFA seed). Built from accountGroups x envList so it can't drift.
var secretVars = buildSecretVars()

func buildSecretVars() map[string]bool {
	m := map[string]bool{}
	for _, ag := range accountGroups {
		for _, env := range envList {
			e := strings.ToUpper(env)
			m[ag.prefix+"_EMAIL_"+e] = true
			m[ag.prefix+"_PASSWORD_"+e] = true
			m[ag.prefix+"_RESULTS_PRIVATE_KEY_"+e] = true
			m[ag.prefix+"_MFA_CODE_"+e] = true
			m[ag.prefix+"_MFA_SEED_"+e] = true
		}
	}
	return m
}

// knownVars is the ordered list of fields the panel shows: per-env base URLs, the
// Jira config, then each account's per-env fields. `Group` renders account sections
// (shown in the Accounts tab); `Env`/`Section` mark the per-env variants the panel
// groups into sub-tabs — the "Account" section holds email/password/MFA code/seed
// (short inputs), the "Results private key" section holds the PEM (Multiline). Kept
// in sync with knownVarNames()/secretVarNames() in src/engine/settings.ts.
var knownVars = buildKnownVars()

func buildKnownVars() []SettingField {
	fields := []SettingField{
		// Jira MCP config for the Validation tab. LocalOnly (gitignored, never
		// encrypted) — a personal, per-user site/email/token. Not in secretVars:
		// local-tier values are always plaintext. The token is still Secret for masking.
		{Key: "JIRA_URL", Label: "Jira site URL", Secret: false, Group: "Jira", LocalOnly: true},
		{Key: "JIRA_USERNAME", Label: "Jira email", Secret: false, Group: "Jira", LocalOnly: true},
		{Key: "JIRA_API_TOKEN", Label: "Jira API token", Secret: true, Group: "Jira", LocalOnly: true},
	}
	// The per-env base URL. Tagged with its Env (like the account fields) so the
	// panel can file it under the selected env rather than as a separate list of
	// three. The label needs no env prefix — the env tab already supplies that.
	for _, env := range envList {
		fields = append(fields, SettingField{
			Key: strings.ToUpper(env) + "_BASE_URL", Label: "Base URL",
			Secret: false, Group: "", Env: env, Section: "Environment",
		})
	}
	for _, ag := range accountGroups {
		// The core account fields — one env-tabbed "Account" section per account,
		// each env tab holding email + password + MFA code + TOTP seed (short inputs).
		for _, env := range envList {
			e := strings.ToUpper(env)
			fields = append(fields,
				SettingField{Key: ag.prefix + "_EMAIL_" + e, Label: "Email",
					Secret: true, Group: ag.group, Env: env, Section: "Account"},
				SettingField{Key: ag.prefix + "_PASSWORD_" + e, Label: "Password",
					Secret: true, Group: ag.group, Env: env, Section: "Account"},
				SettingField{Key: ag.prefix + "_MFA_CODE_" + e, Label: "MFA fixed code",
					Secret: true, Group: ag.group, Env: env, Section: "Account"},
				SettingField{Key: ag.prefix + "_MFA_SEED_" + e, Label: "MFA TOTP seed",
					Secret: true, Group: ag.group, Env: env, Section: "Account"},
			)
		}
		// Per-env results private key (its own env-tabbed section, PEM textarea).
		for _, env := range envList {
			e := strings.ToUpper(env)
			fields = append(fields, SettingField{
				Key: ag.prefix + "_RESULTS_PRIVATE_KEY_" + e, Label: "Results private key",
				Secret: true, Group: ag.group, Env: env, Section: "Results private key", Multiline: true,
			})
		}
	}
	return fields
}

// SettingField is one row in the Settings panel.
type SettingField struct {
	Key    string `json:"key"`
	Label  string `json:"label"`
	Secret bool   `json:"secret"`
	// Account this field belongs to ("Admin"/"Researcher"/"Reviewer"), "Jira" for
	// the Jira config, or "" for the account-less base URL.
	Group string `json:"group"`
	// The env this value is for ("qa"/"staging"/"production"). EVERY account field
	// is per-env (email, password, MFA code/seed, results key), as is the base URL.
	// "" only for the genuinely global Jira config. The panel selects one env at the
	// top and renders every field carrying that Env beneath it.
	Env string `json:"env"`
	// Label of the sub-section this field belongs to within its group ("Account",
	// "Results private key", "Environment"), letting several fields for one env
	// render together under one heading. "" for the Jira group's plain fields.
	Section string `json:"section"`
	// Multiline hints the panel to render a textarea instead of a one-line input —
	// true for the PEM results keys, false for short values (MFA code, TOTP seed).
	Multiline bool `json:"multiline"`
	// Where the current value comes from: "project", "secrets", "local", or ""
	// (unset). For secrets, the value itself is NOT returned to the UI.
	Tier string `json:"tier"`
	// Plaintext value for non-secret fields. Empty for secret fields (a tester
	// re-types a secret to change it) — `Set` says whether one already exists.
	Value string `json:"value"`
	Set   bool   `json:"set"`
	// LocalOnly forces this field to the "local" tier (gitignored). The panel hides
	// the tier selector and the backend rejects any non-local write — so a personal,
	// per-user value (e.g. the Jira config) can never be committed or encrypted.
	LocalOnly bool `json:"localOnly"`
}

// isKnownVar reports whether a settings key is one the panel manages.
func isKnownVar(key string) bool {
	for _, f := range knownVars {
		if f.Key == key {
			return true
		}
	}
	return false
}

// isLocalOnlyVar reports whether a settings key is local-only (must never be
// committed/encrypted), derived from the LocalOnly flag on knownVars.
func isLocalOnlyVar(key string) bool {
	for _, f := range knownVars {
		if f.Key == key {
			return f.LocalOnly
		}
	}
	return false
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

// readJiraConfig resolves the Jira MCP config (URL/username/token) from the merged
// settings files, precedence local > secrets > project (same as ReadSettings). The
// values are plaintext (local tier / committed default), so no decryption is needed.
func (a *App) readJiraConfig() JiraCfg {
	get := func(key string) string {
		dir := configDirFor("")
		for _, f := range []string{localFile, secretsFile, projectFile} {
			m, err := readSettingsFile(filepath.Join(dir, f))
			if err != nil {
				continue
			}
			if v, ok := m[key]; ok {
				return v
			}
		}
		return ""
	}
	return JiraCfg{
		URL:      get("JIRA_URL"),
		Username: get("JIRA_USERNAME"),
		Token:    get("JIRA_API_TOKEN"),
	}
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

// RevealSecret returns the current plaintext value of one settings key, resolving
// it with the same precedence as ReadSettings (local > secrets > project). An
// encrypted committed value is decrypted with the local identity; a plaintext
// value (local tier, or a non-secret) is returned as-is. Used by the panel's
// reveal (eye) toggle so a tester can confirm what's stored without re-typing it.
// Errors if the key is unset, or if it's encrypted but the local identity can't
// decrypt it (not a recipient / no identity).
func (a *App) RevealSecret(cwd, key string) (string, error) {
	dir := configDirFor(cwd)
	local, err := readSettingsFile(filepath.Join(dir, localFile))
	if err != nil {
		return "", err
	}
	secrets, err := readSettingsFile(filepath.Join(dir, secretsFile))
	if err != nil {
		return "", err
	}
	project, err := readSettingsFile(filepath.Join(dir, projectFile))
	if err != nil {
		return "", err
	}

	// Match ReadSettings precedence: local > secrets > project. Only the secrets
	// tier can hold an encrypted (armored) value; local/project are plaintext.
	var val string
	switch {
	case has(local, key):
		val = local[key]
	case has(secrets, key):
		val = secrets[key]
	case has(project, key):
		val = project[key]
	default:
		return "", fmt.Errorf("%q is not set", key)
	}

	if !isEncryptedValue(val) {
		return val, nil
	}
	id, ok, err := loadIdentity(dir)
	if err != nil {
		return "", err
	}
	if !ok {
		return "", fmt.Errorf("no local identity — request access to reveal encrypted values")
	}
	plain, err := decryptWithIdentity(val, id)
	if err != nil {
		return "", fmt.Errorf("cannot decrypt %q: your key may not be a recipient yet", key)
	}
	return plain, nil
}

// has reports whether a settings map contains a key.
func has(m map[string]string, key string) bool {
	_, ok := m[key]
	return ok
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
	// A local-only field (e.g. the Jira config) must never be committed/encrypted —
	// reject any attempt to write it to the project tier, even if the UI is bypassed.
	if tier != "local" && isLocalOnlyVar(key) {
		return fmt.Errorf("%q is local-only and cannot be saved to the project tier", key)
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
	others := make([]string, 0, 2)
	for _, f := range []string{projectFile, secretsFile, localFile} {
		if f != targetFile {
			others = append(others, f)
		}
	}
	if _, err := deleteKeyFrom(dir, key, others); err != nil {
		return err
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

// deleteKeyFrom removes key from each of the named settings files under dir,
// rewriting only the ones that actually held it. Reports whether the key was
// removed from the encrypted secrets file, so the caller knows to refresh the
// keyring lock fingerprint.
func deleteKeyFrom(dir, key string, files []string) (touchedSecrets bool, err error) {
	for _, name := range files {
		path := filepath.Join(dir, name)
		m, err := readSettingsFile(path)
		if err != nil {
			return false, err
		}
		if _, ok := m[key]; !ok {
			continue
		}
		delete(m, key)
		if err := writeSettingsFile(path, m); err != nil {
			return false, err
		}
		if name == secretsFile {
			touchedSecrets = true
		}
	}
	return touchedSecrets, nil
}

// ClearSetting unsets one field entirely, removing it from ALL three tier files so
// no lower-precedence copy survives to be picked up. This is the only way to unset
// a value from the UI — WriteSetting always assigns, and the panel refuses to save
// an empty string. Clearing a committed secret refreshes the keyring lock, exactly
// as writing one does.
func (a *App) ClearSetting(cwd, key string) error {
	// Only fields the panel knows about — never let an arbitrary key be stripped
	// out of the settings JSON.
	if !isKnownVar(key) {
		return fmt.Errorf("unknown setting %q", key)
	}
	dir := configDirFor(cwd)
	touchedSecrets, err := deleteKeyFrom(dir, key, []string{projectFile, secretsFile, localFile})
	if err != nil {
		return err
	}
	if touchedSecrets {
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
