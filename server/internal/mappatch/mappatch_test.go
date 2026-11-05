package mappatch

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const (
	limit    = 2 << 20
	maxFiles = 64
)

func hash(s string) string {
	h := sha256.Sum256([]byte(s))
	return "sha256:" + hex.EncodeToString(h[:])
}

const chunk = "world/islands/puerto/chunks/z07/c0100_0196.json"

// patchJSON builds a patch from files given as maps (marshaled as JSON).
func patchJSON(t *testing.T, files ...map[string]any) []byte {
	t.Helper()
	b, err := json.Marshal(map[string]any{"format": 2, "kind": Kind, "base_ref": "HEAD", "files": files})
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func modify(path, base, content string) map[string]any {
	return map[string]any{"path": path, "base": hash(base), "base_text": base, "content": content}
}

func code(t *testing.T, err error) string {
	t.Helper()
	var e *Error
	if !errors.As(err, &e) {
		t.Fatalf("err = %v, want *Error", err)
	}
	return e.Code
}

func TestValidateSummarizes(t *testing.T) {
	p := patchJSON(t,
		modify(chunk, "{\"a\":1}\n", "{\"a\":2}\n"),
		map[string]any{"path": "world/islands/puerto/spawns.yaml", "base": nil, "content": "- id: x\n"},
		map[string]any{"path": "world/prefabs/hut.yaml", "base": hash("x: 1\n"), "base_text": "x: 1\n", "content": nil},
	)
	s, err := Validate(p, limit, maxFiles)
	if err != nil {
		t.Fatal(err)
	}
	want := []File{{chunk, ActionModify}, {"world/islands/puerto/spawns.yaml", ActionCreate}, {"world/prefabs/hut.yaml", ActionDelete}}
	if len(s.Files) != len(want) {
		t.Fatalf("files = %v", s.Files)
	}
	for i := range want {
		if s.Files[i] != want[i] {
			t.Errorf("file %d = %v, want %v", i, s.Files[i], want[i])
		}
	}
	sum := sha256.Sum256(p)
	if s.SHA256 != hex.EncodeToString(sum[:]) || s.Size != len(p) || s.BaseRef != "HEAD" {
		t.Errorf("summary = %+v", s)
	}
}

func TestValidateRejects(t *testing.T) {
	ok := modify(chunk, "a\n", "b\n")
	cases := []struct {
		name  string
		patch string
		code  string
	}{
		{"empty", ``, CodeNotJSON},
		{"not json", `{"format":2,`, CodeNotJSON},
		{"two values", `{} {}`, CodeNotJSON},
		{"trailing", `{"format":2}]`, CodeNotJSON},
		{"array", `[]`, CodeNotPatch},
		{"null", `null`, CodeNotPatch},
		{"bom", "\ufeff" + string(patchJSON(t, ok)), CodeNotJSON},
		{"invalid utf8", "{\"kind\":\"\xff\"}", CodeNotUTF8},
		{"duplicate key", `{"format":2,"format":2,"kind":"rpg-map-patch","base_ref":"HEAD","files":[]}`, CodeDuplicateKey},
		{"duplicate nested key", `{"format":2,"kind":"rpg-map-patch","base_ref":"HEAD","files":[{"path":"world/world.yaml","path":"x","base":null,"content":"a"}]}`, CodeDuplicateKey},
		{"case-folded key", `{"Format":2,"kind":"rpg-map-patch","base_ref":"HEAD","files":[]}`, CodeUnknownField},
		{"unknown key", `{"format":2,"kind":"rpg-map-patch","base_ref":"HEAD","files":[],"x":1}`, CodeUnknownField},
		{"missing key", `{"format":2,"kind":"rpg-map-patch","files":[]}`, CodeNotPatch},
		{"kind", `{"format":2,"kind":"other","base_ref":"HEAD","files":[]}`, CodeNotPatch},
		{"format 1", `{"format":1,"kind":"rpg-map-patch","base_ref":"HEAD","files":[]}`, CodeFormat},
		{"format string", `{"format":"2","kind":"rpg-map-patch","base_ref":"HEAD","files":[]}`, CodeFormat},
		{"format float", `{"format":2.0,"kind":"rpg-map-patch","base_ref":"HEAD","files":[]}`, CodeFormat},
		{"ref option", `{"format":2,"kind":"rpg-map-patch","base_ref":"--upload-pack=x","files":[]}`, CodeBaseRef},
		{"ref space", `{"format":2,"kind":"rpg-map-patch","base_ref":"a b","files":[]}`, CodeBaseRef},
		{"no files", `{"format":2,"kind":"rpg-map-patch","base_ref":"HEAD","files":[]}`, CodeNoFiles},
		{"files not array", `{"format":2,"kind":"rpg-map-patch","base_ref":"HEAD","files":{}}`, CodeNotPatch},
		{"file not object", `{"format":2,"kind":"rpg-map-patch","base_ref":"HEAD","files":[1]}`, CodeNotPatch},
		{"file null", `{"format":2,"kind":"rpg-map-patch","base_ref":"HEAD","files":[null]}`, CodeNotPatch},
		{"deep", `{"format":2,"kind":"rpg-map-patch","base_ref":"HEAD","files":[[[[[[[[[]]]]]]]]]}`, CodeNotPatch},
		{"path outside world", string(patchJSON(t, map[string]any{"path": "data/items.yaml", "base": nil, "content": "x"})), CodePath},
		{"path traversal", string(patchJSON(t, map[string]any{"path": "world/islands/../../.github/x.yaml", "base": nil, "content": "x"})), CodePath},
		{"path number", `{"format":2,"kind":"rpg-map-patch","base_ref":"HEAD","files":[{"path":1,"base":null,"content":"x"}]}`, CodePath},
		{"duplicate path", string(patchJSON(t, ok, ok)), CodeDuplicatePath},
		{"base not hash", string(patchJSON(t, map[string]any{"path": chunk, "base": "abc", "base_text": "a", "content": "x"})), CodeBase},
		{"base_text without base", string(patchJSON(t, map[string]any{"path": chunk, "base": nil, "base_text": "a", "content": "x"})), CodeBase},
		{"no base_text", string(patchJSON(t, map[string]any{"path": chunk, "base": hash("a"), "content": "x"})), CodeMissingBaseText},
		{"base_text null", string(patchJSON(t, map[string]any{"path": chunk, "base": hash(""), "base_text": nil, "content": "x"})), CodeMissingBaseText},
		{"base_text number", string(patchJSON(t, map[string]any{"path": chunk, "base": hash(""), "base_text": 1, "content": "x"})), CodeMissingBaseText},
		{"base_text mismatch", string(patchJSON(t, map[string]any{"path": chunk, "base": hash("a"), "base_text": "b", "content": "x"})), CodeBaseMismatch},
		{"content number", string(patchJSON(t, map[string]any{"path": chunk, "base": nil, "content": 3})), CodeContent},
		{"content missing", `{"format":2,"kind":"rpg-map-patch","base_ref":"HEAD","files":[{"path":"world/world.yaml","base":null}]}`, CodeNotPatch},
		{"nothing", string(patchJSON(t, map[string]any{"path": chunk, "base": nil, "content": nil})), CodeEmptyFile},
		{"unchanged", string(patchJSON(t, modify(chunk, "a", "a"))), CodeUnchanged},
		{"control in content", string(patchJSON(t, modify(chunk, "a", "notes: \x1b[31m"))), CodeForbiddenChar},
		{"escaped NUL", `{"format":2,"kind":"rpg-map-patch","base_ref":"HEAD","files":[{"path":"world/world.yaml","base":null,"content":"a\u0000"}]}`, CodeForbiddenChar},
		{"C1 in base_text", string(patchJSON(t, modify(chunk, "a\u0085", "b"))), CodeForbiddenChar},
		{"lone surrogate", `{"format":2,"kind":"rpg-map-patch","base_ref":"HEAD","files":[{"path":"world/world.yaml","base":null,"content":"a\ud800"}]}`, CodeForbiddenChar},
		{"noncharacter", string(patchJSON(t, modify(chunk, "a", "b\uffff"))), CodeForbiddenChar},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := Validate([]byte(c.patch), limit, maxFiles)
			if got := code(t, err); got != c.code {
				t.Errorf("code = %s, want %s", got, c.code)
			}
			if strings.Contains(err.Error(), "\x1b") || strings.Contains(err.Error(), "github") {
				t.Errorf("error echoes the patch: %q", err)
			}
		})
	}
}

func TestValidateLimits(t *testing.T) {
	p := patchJSON(t, modify(chunk, "a", "b"))
	if _, err := Validate(p, len(p)-1, maxFiles); code(t, err) != CodeTooLarge {
		t.Errorf("size: %v", err)
	}
	if _, err := Validate(p, len(p), maxFiles); err != nil {
		t.Errorf("at the size limit: %v", err)
	}
	two := patchJSON(t, modify(chunk, "a", "b"), modify("world/world.yaml", "a", "b"))
	if _, err := Validate(two, limit, 1); code(t, err) != CodeTooManyFiles {
		t.Errorf("files: %v", err)
	}
}

func TestAccentsPass(t *testing.T) {
	p := patchJSON(t, modify("world/islands/puerto/texts.yaml", "- id: a\n", "- id: a\n  notes: \"Señal del muelle, ñandú\\tok\"\n"))
	if _, err := Validate(p, limit, maxFiles); err != nil {
		t.Fatal(err)
	}
}

// TestPathsShared reads the fixture packages/map-format tests too (patch/paths.test.ts).
func TestPathsShared(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "packages", "map-format", "src", "patch", "testdata", "paths.json"))
	if err != nil {
		t.Fatal(err)
	}
	var f struct{ Allowed, Rejected []string }
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	if len(f.Allowed) == 0 || len(f.Rejected) == 0 {
		t.Fatal("empty fixture")
	}
	for _, p := range f.Allowed {
		if !AllowedPath(p) {
			t.Errorf("rejects %q", p)
		}
	}
	for _, p := range f.Rejected {
		if AllowedPath(p) {
			t.Errorf("allows %q", p)
		}
	}
}

func FuzzValidate(f *testing.F) {
	f.Add([]byte(`{"format":2,"kind":"rpg-map-patch","base_ref":"HEAD","files":[{"path":"world/world.yaml","base":null,"content":"a"}]}`))
	f.Add([]byte(`{"a":{"a":1,"a":2}}`))
	f.Fuzz(func(t *testing.T, b []byte) {
		s, err := Validate(b, limit, maxFiles)
		if err != nil {
			return
		}
		for _, file := range s.Files {
			if !AllowedPath(file.Path) {
				t.Fatalf("accepted path %q", file.Path)
			}
		}
	})
}
