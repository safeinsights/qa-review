package main

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"filippo.io/age"
	"filippo.io/age/armor"
)

// writeTestKeyring writes a config/keyring.json with the given recipients.
func writeTestKeyring(t *testing.T, dir string, recipients ...string) {
	t.Helper()
	type member struct {
		Name      string `json:"name"`
		PublicKey string `json:"publicKey"`
		Email     string `json:"email"`
		AddedDate string `json:"addedDate"`
	}
	members := make([]member, 0, len(recipients))
	for i, r := range recipients {
		members = append(members, member{Name: "u" + string(rune('A'+i)), PublicKey: r, Email: "e", AddedDate: "2026-06-30"})
	}
	data, _ := json.Marshal(members)
	if err := os.WriteFile(filepath.Join(dir, "config", "keyring.json"), data, 0o644); err != nil {
		t.Fatal(err)
	}
}

// decryptString decrypts an armored X25519 blob with the given identity.
func decryptString(armored string, id *age.X25519Identity) (string, error) {
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

func TestEncryptRoundTrip(t *testing.T) {
	id, err := age.GenerateX25519Identity()
	if err != nil {
		t.Fatal(err)
	}
	enc, err := encryptToRecipients("s3cret", []string{id.Recipient().String()})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(strings.TrimSpace(enc), "-----BEGIN AGE ENCRYPTED FILE-----") {
		t.Fatalf("expected armored age blob, got: %q", enc)
	}
	got, err := decryptString(enc, id)
	if err != nil {
		t.Fatal(err)
	}
	if got != "s3cret" {
		t.Fatalf("round-trip mismatch: got %q", got)
	}
}

func readJSON(t *testing.T, path string) map[string]string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		return map[string]string{}
	}
	m := map[string]string{}
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatalf("bad JSON in %s: %v", path, err)
	}
	return m
}

func TestWriteSettingRouting(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("QAR_REPO_DIR", dir)
	if err := os.MkdirAll(filepath.Join(dir, "config"), 0o755); err != nil {
		t.Fatal(err)
	}
	id, _ := age.GenerateX25519Identity()
	writeTestKeyring(t, dir, id.Recipient().String())
	app := &App{}

	if err := app.WriteSetting(dir, "QA_BASE_URL", "https://qa.example", "project"); err != nil {
		t.Fatal(err)
	}
	proj := readJSON(t, filepath.Join(dir, "config", projectFile))
	if proj["QA_BASE_URL"] != "https://qa.example" {
		t.Fatalf("project file: got %v", proj)
	}

	if err := app.WriteSetting(dir, "ADMIN_PASSWORD", "pw-admin", "project"); err != nil {
		t.Fatal(err)
	}
	secrets := readJSON(t, filepath.Join(dir, "config", secretsFile))
	enc := secrets["ADMIN_PASSWORD"]
	if !strings.HasPrefix(strings.TrimSpace(enc), "-----BEGIN AGE ENCRYPTED FILE-----") {
		t.Fatalf("expected encrypted ADMIN_PASSWORD, got: %q", enc)
	}
	if dec, err := decryptString(enc, id); err != nil || dec != "pw-admin" {
		t.Fatalf("decrypt secret: got %q err %v", dec, err)
	}

	if err := app.WriteSetting(dir, "MFA_CODE", "424242", "local"); err != nil {
		t.Fatal(err)
	}
	local := readJSON(t, filepath.Join(dir, "config", localFile))
	if local["MFA_CODE"] != "424242" {
		t.Fatalf("local file: got %v", local)
	}
}

func TestWriteSettingMovesBetweenTiers(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("QAR_REPO_DIR", dir)
	if err := os.MkdirAll(filepath.Join(dir, "config"), 0o755); err != nil {
		t.Fatal(err)
	}
	app := &App{}

	if err := app.WriteSetting(dir, "QA_BASE_URL", "https://qa.example", "project"); err != nil {
		t.Fatal(err)
	}
	if err := app.WriteSetting(dir, "QA_BASE_URL", "https://my.example", "local"); err != nil {
		t.Fatal(err)
	}
	if _, ok := readJSON(t, filepath.Join(dir, "config", projectFile))["QA_BASE_URL"]; ok {
		t.Fatal("expected QA_BASE_URL removed from project file after move to local")
	}
	if readJSON(t, filepath.Join(dir, "config", localFile))["QA_BASE_URL"] != "https://my.example" {
		t.Fatal("expected QA_BASE_URL in local file")
	}
}

func TestWriteSecretToProjectRequiresKeyring(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("QAR_REPO_DIR", dir)
	if err := os.MkdirAll(filepath.Join(dir, "config"), 0o755); err != nil {
		t.Fatal(err)
	}
	app := &App{} // no keyring written
	err := app.WriteSetting(dir, "ADMIN_PASSWORD", "pw", "project")
	if err == nil || !strings.Contains(err.Error(), "keyring is empty") {
		t.Fatalf("expected keyring-empty error, got: %v", err)
	}
}

// writeTestIdentity writes config/age-identity.txt for the given identity in the
// standard age file format (a "# public key:" comment + the secret key line).
func writeTestIdentity(t *testing.T, dir string, id *age.X25519Identity) {
	t.Helper()
	body := "# public key: " + id.Recipient().String() + "\n" + id.String() + "\n"
	if err := os.WriteFile(filepath.Join(dir, "config", "age-identity.txt"), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestIdentityInKeyring(t *testing.T) {
	me, _ := age.GenerateX25519Identity()
	other, _ := age.GenerateX25519Identity()

	t.Run("no identity file", func(t *testing.T) {
		dir := t.TempDir()
		if err := os.MkdirAll(filepath.Join(dir, "config"), 0o755); err != nil {
			t.Fatal(err)
		}
		writeTestKeyring(t, dir, me.Recipient().String())
		has, isRecipient, err := identityInKeyring(filepath.Join(dir, "config"))
		if err != nil || has || isRecipient {
			t.Fatalf("no identity: got has=%v recipient=%v err=%v", has, isRecipient, err)
		}
	})

	t.Run("identity present but not a recipient", func(t *testing.T) {
		dir := t.TempDir()
		if err := os.MkdirAll(filepath.Join(dir, "config"), 0o755); err != nil {
			t.Fatal(err)
		}
		writeTestIdentity(t, dir, me)
		writeTestKeyring(t, dir, other.Recipient().String())
		has, isRecipient, err := identityInKeyring(filepath.Join(dir, "config"))
		if err != nil || !has || isRecipient {
			t.Fatalf("not a recipient: got has=%v recipient=%v err=%v", has, isRecipient, err)
		}
	})

	t.Run("identity is a recipient", func(t *testing.T) {
		dir := t.TempDir()
		if err := os.MkdirAll(filepath.Join(dir, "config"), 0o755); err != nil {
			t.Fatal(err)
		}
		writeTestIdentity(t, dir, me)
		writeTestKeyring(t, dir, other.Recipient().String(), me.Recipient().String())
		has, isRecipient, err := identityInKeyring(filepath.Join(dir, "config"))
		if err != nil || !has || !isRecipient {
			t.Fatalf("recipient: got has=%v recipient=%v err=%v", has, isRecipient, err)
		}
	})
}

// writeTestSecrets writes a settings.secrets.json under dir/config with one
// encrypted secret (ADMIN_PASSWORD) encrypted to the given recipients.
func writeTestSecrets(t *testing.T, dir string, recipients ...string) {
	t.Helper()
	enc, err := encryptToRecipients("s3cret", recipients)
	if err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(map[string]string{"ADMIN_PASSWORD": enc})
	if err := os.WriteFile(filepath.Join(dir, "config", secretsFile), data, 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestIdentityDecryptsSecrets(t *testing.T) {
	me, _ := age.GenerateX25519Identity()
	other, _ := age.GenerateX25519Identity()

	newConfig := func(t *testing.T, id *age.X25519Identity) (root, cfg string) {
		t.Helper()
		root = t.TempDir()
		if err := os.MkdirAll(filepath.Join(root, "config"), 0o755); err != nil {
			t.Fatal(err)
		}
		if id != nil {
			writeTestIdentity(t, root, id)
		}
		return root, filepath.Join(root, "config")
	}

	t.Run("no identity file", func(t *testing.T) {
		_, cfg := newConfig(t, nil)
		has, canDecrypt, checkable, err := identityDecryptsSecrets(cfg)
		if err != nil || has || canDecrypt || !checkable {
			t.Fatalf("no identity: has=%v canDecrypt=%v checkable=%v err=%v", has, canDecrypt, checkable, err)
		}
	})

	t.Run("key is a recipient — decrypts", func(t *testing.T) {
		root, cfg := newConfig(t, me)
		writeTestSecrets(t, root, other.Recipient().String(), me.Recipient().String())
		has, canDecrypt, checkable, err := identityDecryptsSecrets(cfg)
		if err != nil || !has || !canDecrypt || !checkable {
			t.Fatalf("recipient: has=%v canDecrypt=%v checkable=%v err=%v", has, canDecrypt, checkable, err)
		}
	})

	// The bug: identity exists (request-access wrote it locally) but the access PR
	// never merged, so the committed secrets were never rekeyed to this key.
	t.Run("key present but not a recipient — cannot decrypt", func(t *testing.T) {
		root, cfg := newConfig(t, me)
		writeTestSecrets(t, root, other.Recipient().String())
		has, canDecrypt, checkable, err := identityDecryptsSecrets(cfg)
		if err != nil || !has || canDecrypt || !checkable {
			t.Fatalf("not recipient: has=%v canDecrypt=%v checkable=%v err=%v", has, canDecrypt, checkable, err)
		}
	})

	t.Run("no encrypted secrets — uncheckable, not a failure", func(t *testing.T) {
		_, cfg := newConfig(t, me)
		has, canDecrypt, checkable, err := identityDecryptsSecrets(cfg)
		if err != nil || !has || canDecrypt || checkable {
			t.Fatalf("uncheckable: has=%v canDecrypt=%v checkable=%v err=%v", has, canDecrypt, checkable, err)
		}
	})

	// Partial-rekey: one secret decrypts, another (e.g. rotated via set-secret from a
	// stale keyring) does not. loadSettings() would throw on the undecryptable one, so
	// the check must report canDecrypt=false — not true off the one that works.
	t.Run("one secret undecryptable — cannot decrypt", func(t *testing.T) {
		_, cfg := newConfig(t, me)
		mine, err := encryptToRecipients("ok", []string{me.Recipient().String()})
		if err != nil {
			t.Fatal(err)
		}
		theirs, err := encryptToRecipients("nope", []string{other.Recipient().String()})
		if err != nil {
			t.Fatal(err)
		}
		data, _ := json.Marshal(map[string]string{"ADMIN_PASSWORD": mine, "ADMIN_MFA_CODE": theirs})
		if err := os.WriteFile(filepath.Join(cfg, secretsFile), data, 0o644); err != nil {
			t.Fatal(err)
		}
		has, canDecrypt, checkable, err := identityDecryptsSecrets(cfg)
		if err != nil || !has || canDecrypt || !checkable {
			t.Fatalf("partial: has=%v canDecrypt=%v checkable=%v err=%v", has, canDecrypt, checkable, err)
		}
	})
}

func TestReadSettingsReportsIdentityAndMasksSecrets(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("QAR_REPO_DIR", dir)
	if err := os.MkdirAll(filepath.Join(dir, "config"), 0o755); err != nil {
		t.Fatal(err)
	}
	id, _ := age.GenerateX25519Identity()
	writeTestKeyring(t, dir, id.Recipient().String())
	// Presence of an identity file -> HasIdentity true.
	if err := os.WriteFile(filepath.Join(dir, "config", "age-identity.txt"), []byte("# public key: x\n"+id.String()+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	app := &App{}
	_ = app.WriteSetting(dir, "QA_BASE_URL", "https://qa.example", "project")
	_ = app.WriteSetting(dir, "ADMIN_PASSWORD", "pw-admin", "project")

	view, err := app.ReadSettings(dir)
	if err != nil {
		t.Fatal(err)
	}
	byKey := map[string]SettingField{}
	for _, f := range view.Fields {
		byKey[f.Key] = f
	}
	if byKey["QA_BASE_URL"].Value != "https://qa.example" {
		t.Fatalf("non-secret value should be visible: %+v", byKey["QA_BASE_URL"])
	}
	pw := byKey["ADMIN_PASSWORD"]
	if pw.Value != "" {
		t.Fatalf("secret value must be masked, got %q", pw.Value)
	}
	if !pw.Set || pw.Tier != "secrets" {
		t.Fatalf("secret should be reported set in secrets tier: %+v", pw)
	}
	if !view.HasIdentity {
		t.Fatal("expected HasIdentity true")
	}
}
