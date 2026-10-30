package net_test

import (
	"bytes"
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	gamev1 "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
)

// The golden fixtures are shared with packages/protocol (TypeScript). Each <name>.json
// is the canonical proto3 JSON of a message; client_*.json hold a ClientMessage and
// server_*.json a ServerBatch. <name>.go.bin is Go's encoding of it and <name>.ts.bin
// the TypeScript one. Each language checks that its own encoding is stable and that
// it decodes both files back to the fixture. The bytes may differ between languages
// (protobuf-go writes oneof fields last), so only the meaning is compared across them.
//
// Regenerate the .go.bin files after changing a fixture: go test ./internal/net -update
var update = flag.Bool("update", false, "rewrite the golden .go.bin files from the .json fixtures")

const goldenDir = "../../../proto/testdata/golden"

func newMessage(t *testing.T, name string) proto.Message {
	t.Helper()
	switch {
	case strings.HasPrefix(name, "client_"):
		return &gamev1.ClientMessage{}
	case strings.HasPrefix(name, "server_"):
		return &gamev1.ServerBatch{}
	default:
		t.Fatalf("fixture %s: name must start with client_ or server_", name)
		return nil
	}
}

func TestGoldenRoundTrip(t *testing.T) {
	fixtures, err := filepath.Glob(filepath.Join(goldenDir, "*.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(fixtures) == 0 {
		t.Fatalf("no fixtures found in %s", goldenDir)
	}
	for _, jsonPath := range fixtures {
		name := strings.TrimSuffix(filepath.Base(jsonPath), ".json")
		t.Run(name, func(t *testing.T) {
			base := strings.TrimSuffix(jsonPath, ".json")
			binPath := base + ".go.bin"
			jsonData, err := os.ReadFile(jsonPath)
			if err != nil {
				t.Fatal(err)
			}

			// JSON fixture -> binary must equal the golden bytes.
			fromJSON := newMessage(t, name)
			if err := protojson.Unmarshal(jsonData, fromJSON); err != nil {
				t.Fatalf("parse fixture: %v", err)
			}
			encoded, err := proto.MarshalOptions{Deterministic: true}.Marshal(fromJSON)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			if *update {
				if err := os.WriteFile(binPath, encoded, 0o644); err != nil {
					t.Fatal(err)
				}
			}
			golden, err := os.ReadFile(binPath)
			if err != nil {
				t.Fatalf("read golden (run with -update to create it): %v", err)
			}
			if !bytes.Equal(encoded, golden) {
				t.Fatalf("encoding differs from %s (run with -update if the fixture changed on purpose)\ngot  %x\nwant %x", binPath, encoded, golden)
			}

			// Go's and TypeScript's bytes -> JSON must be the fixture as written.
			for _, path := range []string{binPath, base + ".ts.bin"} {
				data, err := os.ReadFile(path)
				if err != nil {
					t.Fatalf("read golden (the .ts.bin files come from UPDATE_GOLDEN=1 pnpm --filter @rpg/protocol test): %v", err)
				}
				decoded := newMessage(t, name)
				if err := proto.Unmarshal(data, decoded); err != nil {
					t.Fatalf("unmarshal %s: %v", path, err)
				}
				if len(decoded.ProtoReflect().GetUnknown()) > 0 {
					t.Fatalf("%s has unknown fields", path)
				}
				assertJSON(t, decoded, jsonData)
			}
		})
	}
}

// assertJSON fails unless msg marshals to the same JSON value as want. Comparing
// decoded values (not text) ignores the randomized whitespace of protojson.
func assertJSON(t *testing.T, msg proto.Message, want []byte) {
	t.Helper()
	out, err := protojson.Marshal(msg)
	if err != nil {
		t.Fatalf("marshal json: %v", err)
	}
	var gotValue, wantValue any
	if err := json.Unmarshal(out, &gotValue); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(want, &wantValue); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(gotValue, wantValue) {
		t.Fatalf("decoded message differs from the fixture (or the fixture is not canonical proto3 JSON):\ngot  %s\nwant %s", out, want)
	}
}
