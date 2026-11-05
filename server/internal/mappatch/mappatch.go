// Package mappatch checks an uploaded map patch (.rpgpatch.json, docs/04-map-editor-and-ai.md
// "Map patches") as untrusted input before the server stores it (T4.5). It is a first
// gate, not the full validation: the merge, the map schemas and the community plots are
// checked later by the map PR check, with the same TypeScript code as mapcli.
//
// The rules follow parsePatch of packages/map-format, and are stricter where Go and
// JavaScript could read the same bytes differently: only format 2 (the base travels in the
// patch), no unknown or repeated keys, valid UTF-8, and no U+FFFD (what Go's decoder makes
// of a lone surrogate escape that JavaScript would keep).
package mappatch

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"regexp"
	"slices"
	"strconv"
	"unicode/utf8"
)

// Kind and Format are the only kind and format the portal accepts.
const (
	Kind   = "rpg-map-patch"
	Format = 2
)

// Actions of a file in a patch.
const (
	ActionCreate = "create"
	ActionModify = "modify"
	ActionDelete = "delete"
)

// File is one file a patch touches.
type File struct {
	Path   string `json:"path"`
	Action string `json:"action"`
}

// Summary is what a valid patch touches.
type Summary struct {
	BaseRef string
	Files   []File
	// SHA256 is the hex sha256 of the patch bytes as uploaded.
	SHA256 string
	Size   int
}

// Error is why a patch was rejected: a stable code the client turns into a text. It never
// carries text from the patch.
type Error struct {
	Code string
	// File is the index of the offending file, or -1.
	File int
}

func (e *Error) Error() string {
	if e.File >= 0 {
		return "map patch: " + e.Code + " (file " + strconv.Itoa(e.File) + ")"
	}
	return "map patch: " + e.Code
}

// Error codes.
const (
	CodeTooLarge        = "too_large"
	CodeNotUTF8         = "not_utf8"
	CodeNotJSON         = "not_json"
	CodeDuplicateKey    = "duplicate_key"
	CodeUnknownField    = "unknown_field"
	CodeNotPatch        = "not_patch"
	CodeFormat          = "format"
	CodeBaseRef         = "base_ref"
	CodeNoFiles         = "no_files"
	CodeTooManyFiles    = "too_many_files"
	CodePath            = "path"
	CodeDuplicatePath   = "duplicate_path"
	CodeBase            = "base"
	CodeContent         = "content"
	CodeEmptyFile       = "empty_file"
	CodeMissingBaseText = "missing_base_text"
	CodeBaseMismatch    = "base_mismatch"
	CodeForbiddenChar   = "forbidden_char"
	CodeUnchanged       = "unchanged"
)

func fail(code string, file int) error { return &Error{Code: code, File: file} }

// The paths a patch may touch: the same as patchPath of packages/map-format.
const maxPathLen = 200

var (
	id      = `[a-z][a-z0-9_]*`
	chunkRe = regexp.MustCompile(`^world/islands/` + id + `/chunks/z(\d{2})/c\d{4}_\d{4}\.json$`)
	listRe  = regexp.MustCompile(`^world/islands/` + id + `/(island|spawns|npcs|zones|portals|texts)\.yaml$`)
	prefab  = regexp.MustCompile(`^world/prefabs/` + id + `\.yaml$`)
	refRe   = regexp.MustCompile(`^[A-Za-z0-9._/@{}~^-]{1,200}$`)
	baseRe  = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
)

// maxFloor is MAX_FLOOR of packages/map-format.
const maxFloor = 15

// AllowedPath reports whether a patch may touch path.
func AllowedPath(path string) bool {
	if len(path) > maxPathLen {
		return false
	}
	if path == "world/world.yaml" || listRe.MatchString(path) || prefab.MatchString(path) {
		return true
	}
	m := chunkRe.FindStringSubmatch(path)
	if m == nil {
		return false
	}
	z, err := strconv.Atoi(m[1])
	return err == nil && z <= maxFloor
}

// ForbiddenRune reports the code points no map file may contain: C0 controls except tab,
// LF and CR; DEL; C1 controls; U+FFFE and U+FFFF (FORBIDDEN_CHARS of packages/map-format),
// plus U+FFFD.
func ForbiddenRune(r rune) bool {
	switch {
	case r <= 0x08, r == 0x0b, r == 0x0c, r >= 0x0e && r <= 0x1f, r >= 0x7f && r <= 0x9f:
		return true
	case r == 0xfffd, r == 0xfffe, r == 0xffff:
		return true
	}
	return false
}

func hasForbidden(s string) bool {
	for _, r := range s {
		if ForbiddenRune(r) {
			return true
		}
	}
	return false
}

// Validate checks a patch of at most maxBytes bytes and maxFiles files and summarizes it.
func Validate(patch []byte, maxBytes, maxFiles int) (Summary, error) {
	if len(patch) > maxBytes {
		return Summary{}, fail(CodeTooLarge, -1)
	}
	if !utf8.Valid(patch) {
		return Summary{}, fail(CodeNotUTF8, -1)
	}
	if err := checkJSON(patch); err != nil {
		return Summary{}, err
	}
	var top map[string]json.RawMessage
	if json.Unmarshal(patch, &top) != nil {
		return Summary{}, fail(CodeNotPatch, -1)
	}
	if err := keysOf(top, -1, []string{"format", "kind", "base_ref", "files"}); err != nil {
		return Summary{}, err
	}
	var kind string
	if json.Unmarshal(top["kind"], &kind) != nil || kind != Kind {
		return Summary{}, fail(CodeNotPatch, -1)
	}
	if string(bytes.TrimSpace(top["format"])) != strconv.Itoa(Format) {
		return Summary{}, fail(CodeFormat, -1)
	}
	var baseRef string
	if json.Unmarshal(top["base_ref"], &baseRef) != nil || !refRe.MatchString(baseRef) || baseRef[0] == '-' {
		return Summary{}, fail(CodeBaseRef, -1)
	}
	var files []map[string]json.RawMessage
	if json.Unmarshal(top["files"], &files) != nil {
		return Summary{}, fail(CodeNotPatch, -1)
	}
	if len(files) == 0 {
		return Summary{}, fail(CodeNoFiles, -1)
	}
	if len(files) > maxFiles {
		return Summary{}, fail(CodeTooManyFiles, -1)
	}
	out := Summary{BaseRef: baseRef, Size: len(patch), Files: make([]File, 0, len(files))}
	seen := make(map[string]bool, len(files))
	for i, f := range files {
		file, err := checkFile(f, i)
		if err != nil {
			return Summary{}, err
		}
		if seen[file.Path] {
			return Summary{}, fail(CodeDuplicatePath, i)
		}
		seen[file.Path] = true
		out.Files = append(out.Files, file)
	}
	sum := sha256.Sum256(patch)
	out.SHA256 = hex.EncodeToString(sum[:])
	return out, nil
}

func checkFile(f map[string]json.RawMessage, i int) (File, error) {
	if f == nil {
		return File{}, fail(CodeNotPatch, i)
	}
	if err := keysOf(f, i, []string{"path", "base", "content"}, "base_text"); err != nil {
		return File{}, err
	}
	var path string
	if json.Unmarshal(f["path"], &path) != nil || !AllowedPath(path) {
		return File{}, fail(CodePath, i)
	}
	base, ok := optString(f["base"])
	if !ok || (base != nil && !baseRe.MatchString(*base)) {
		return File{}, fail(CodeBase, i)
	}
	content, ok := optString(f["content"])
	if !ok {
		return File{}, fail(CodeContent, i)
	}
	if base == nil && content == nil {
		return File{}, fail(CodeEmptyFile, i)
	}
	if content != nil && hasForbidden(*content) {
		return File{}, fail(CodeForbiddenChar, i)
	}
	raw, hasText := f["base_text"]
	switch {
	case base == nil && hasText:
		return File{}, fail(CodeBase, i)
	case base != nil && !hasText:
		return File{}, fail(CodeMissingBaseText, i)
	case base != nil:
		var text string
		if json.Unmarshal(raw, &text) != nil {
			return File{}, fail(CodeMissingBaseText, i)
		}
		if hasForbidden(text) {
			return File{}, fail(CodeForbiddenChar, i)
		}
		sum := sha256.Sum256([]byte(text))
		if "sha256:"+hex.EncodeToString(sum[:]) != *base {
			return File{}, fail(CodeBaseMismatch, i)
		}
		if content != nil && *content == text {
			return File{}, fail(CodeUnchanged, i)
		}
	}
	action := ActionModify
	switch {
	case base == nil:
		action = ActionCreate
	case content == nil:
		action = ActionDelete
	}
	return File{Path: path, Action: action}, nil
}

// optString decodes a JSON string or null (nil). ok is false for anything else.
func optString(raw json.RawMessage) (s *string, ok bool) {
	if raw == nil {
		return nil, false
	}
	if string(bytes.TrimSpace(raw)) == "null" {
		return nil, true
	}
	var v string
	if json.Unmarshal(raw, &v) != nil {
		return nil, false
	}
	return &v, true
}

// keysOf fails unless obj has every required key and no key outside required and
// optional. encoding/json matches field names without case, so keys are compared here,
// byte for byte, before decoding.
func keysOf(obj map[string]json.RawMessage, file int, required []string, optional ...string) error {
	for k := range obj {
		if !slices.Contains(required, k) && !slices.Contains(optional, k) {
			return fail(CodeUnknownField, file)
		}
	}
	for _, k := range required {
		if _, ok := obj[k]; !ok {
			return fail(CodeNotPatch, file)
		}
	}
	return nil
}

// maxDepth bounds the nesting of the JSON (a patch needs 3 levels).
const maxDepth = 8

type frame struct {
	obj     bool
	keys    map[string]bool
	wantKey bool // in an object: the next token is a key or '}'
}

// checkJSON fails unless b is exactly one JSON value with no repeated key in any object
// and at most maxDepth levels deep. Go and JavaScript keep different copies of a repeated
// key, so a patch with one could read differently in the server and in the PR check.
func checkJSON(b []byte) error {
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.UseNumber()
	var stack []frame
	done := false
	// ended marks that a value ended: an enclosing object expects a key again.
	ended := func() {
		if n := len(stack); n == 0 {
			done = true
		} else if stack[n-1].obj {
			stack[n-1].wantKey = true
		}
	}
	for {
		tok, err := dec.Token()
		if errors.Is(err, io.EOF) {
			if !done {
				return fail(CodeNotJSON, -1)
			}
			return nil
		}
		if err != nil || done {
			return fail(CodeNotJSON, -1)
		}
		if n := len(stack); n > 0 && stack[n-1].obj && stack[n-1].wantKey {
			key, ok := tok.(string)
			if !ok { // the closing '}'
				stack = stack[:n-1]
				ended()
				continue
			}
			if stack[n-1].keys[key] {
				return fail(CodeDuplicateKey, -1)
			}
			stack[n-1].keys[key] = true
			stack[n-1].wantKey = false
			continue
		}
		switch tok {
		case json.Delim('{'), json.Delim('['):
			if len(stack) >= maxDepth {
				return fail(CodeNotPatch, -1)
			}
			obj := tok == json.Delim('{')
			f := frame{obj: obj, wantKey: obj}
			if obj {
				f.keys = map[string]bool{}
			}
			stack = append(stack, f)
		case json.Delim(']'):
			stack = stack[:len(stack)-1]
			ended()
		default:
			ended()
		}
	}
}
