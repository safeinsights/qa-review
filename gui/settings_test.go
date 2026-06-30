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

const testPass = "correct-horse-battery-staple"

// decryptString is the inverse of encryptString, used only by tests to confirm
// the round-trip (the engine does decryption in production via the TS library).
func decryptString(armored, passphrase string) (string, error) {
	id, err := age.NewScryptIdentity(passphrase)
	if err != nil {
		return "", err
	}
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
	enc, err := encryptString("s3cret", testPass)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(strings.TrimSpace(enc), ageArmorHeader) {
		t.Fatalf("expected armored age blob, got: %q", enc)
	}
	got, err := decryptString(enc, testPass)
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
	if err := os.MkdirAll(filepath.Join(dir, "config"), 0o755); err != nil {
		t.Fatal(err)
	}
	app := &App{passphrase: testPass}

	// Non-secret to project -> plaintext in settings.json.
	if err := app.WriteSetting(dir, "QA_BASE_URL", "https://qa.example", "project"); err != nil {
		t.Fatal(err)
	}
	proj := readJSON(t, filepath.Join(dir, "config", projectFile))
	if proj["QA_BASE_URL"] != "https://qa.example" {
		t.Fatalf("project file: got %v", proj)
	}

	// Secret to project -> encrypted in settings.secrets.json.
	if err := app.WriteSetting(dir, "ADMIN_PASSWORD", "pw-admin", "project"); err != nil {
		t.Fatal(err)
	}
	secrets := readJSON(t, filepath.Join(dir, "config", secretsFile))
	enc := secrets["ADMIN_PASSWORD"]
	if !strings.HasPrefix(strings.TrimSpace(enc), ageArmorHeader) {
		t.Fatalf("expected encrypted ADMIN_PASSWORD, got: %q", enc)
	}
	if dec, err := decryptString(enc, testPass); err != nil || dec != "pw-admin" {
		t.Fatalf("decrypt secret: got %q err %v", dec, err)
	}

	// Secret to local -> plaintext in settings.local.json.
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
	if err := os.MkdirAll(filepath.Join(dir, "config"), 0o755); err != nil {
		t.Fatal(err)
	}
	app := &App{passphrase: testPass}

	// Save to project, then re-save to local: the project copy must be removed.
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

func TestWriteSecretToProjectRequiresPassphrase(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "config"), 0o755); err != nil {
		t.Fatal(err)
	}
	app := &App{} // no passphrase
	err := app.WriteSetting(dir, "ADMIN_PASSWORD", "pw", "project")
	if err == nil || !strings.Contains(err.Error(), "passphrase") {
		t.Fatalf("expected passphrase error, got: %v", err)
	}
}

func TestReadSettingsMasksSecrets(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "config"), 0o755); err != nil {
		t.Fatal(err)
	}
	app := &App{passphrase: testPass}
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
	if !view.HasPassphrase {
		t.Fatal("expected HasPassphrase true")
	}
}
