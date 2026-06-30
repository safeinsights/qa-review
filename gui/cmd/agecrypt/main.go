// Command agecrypt is a tiny age X25519 encrypt/decrypt helper used to verify
// cross-language interop between the Go GUI (filippo.io/age) and the TS engine
// (age-encryption). Reads plaintext/ciphertext from stdin.
//
//	agecrypt encrypt <recipient>   # stdin: plaintext  -> stdout: armored age
//	agecrypt decrypt <identity>    # stdin: armored age -> stdout: plaintext
package main

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"strings"

	"filippo.io/age"
	"filippo.io/age/armor"
)

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "usage: agecrypt <encrypt|decrypt> <recipient-or-identity>")
		os.Exit(2)
	}
	mode, arg := os.Args[1], os.Args[2]
	in, err := io.ReadAll(os.Stdin)
	if err != nil {
		fail(err)
	}

	switch mode {
	case "encrypt":
		// arg is an age1... recipient public key.
		r, err := age.ParseX25519Recipient(arg)
		if err != nil {
			fail(err)
		}
		buf := &bytes.Buffer{}
		aw := armor.NewWriter(buf)
		w, err := age.Encrypt(aw, r)
		if err != nil {
			fail(err)
		}
		if _, err := w.Write(in); err != nil {
			fail(err)
		}
		if err := w.Close(); err != nil {
			fail(err)
		}
		if err := aw.Close(); err != nil {
			fail(err)
		}
		os.Stdout.Write(buf.Bytes())
	case "decrypt":
		// arg is an AGE-SECRET-KEY-1... identity.
		id, err := age.ParseX25519Identity(arg)
		if err != nil {
			fail(err)
		}
		r, err := age.Decrypt(armor.NewReader(strings.NewReader(string(in))), id)
		if err != nil {
			fail(err)
		}
		if _, err := io.Copy(os.Stdout, r); err != nil {
			fail(err)
		}
	default:
		fmt.Fprintf(os.Stderr, "unknown mode %q\n", mode)
		os.Exit(2)
	}
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
