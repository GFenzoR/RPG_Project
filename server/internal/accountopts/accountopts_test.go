package accountopts_test

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/accountopts"
)

// full is a document with every field, as the client writes it.
const full = `{"v":1,"lang":"es",
 "audio":{"volume":{"master":0.8,"music":0.5,"sfx":0.9,"ui":0.7,"ambient":0.6},
          "muted":{"master":false,"music":true,"sfx":false,"ui":false,"ambient":false}},
 "controls":"classic","reduced_motion":true,"ui_scale":1.25,"text_scale":0.9,
 "camera_shake":false,"chat_bubbles":true,"name_size":"large","chat_opacity":65,
 "hotkeys":{"guardian":["spell.strike",null,"heal_light"]},
 "track":{"Ana de la O'Hara-Ñandú":"quest.first_steps"},
 "devices":{"desktop":{"touch_pad":false,"zoom":3,"minimap":{"open":true,"scale":2},
   "windows":{"v":3,"z":["battle","container-backpack-2"],
     "win":{"battle":{"open":true,"collapsed":false,"x":10,"y":-4,"w":220,"h":300}},
     "others":{"container-backpack-2":{"collapsed":true}}}},
  "touch":{"touch_pad":true}}}`

func TestParseAcceptsTheWholeDocumentAndIsStable(t *testing.T) {
	d, err := accountopts.Parse([]byte(full))
	if err != nil {
		t.Fatal(err)
	}
	canon, err := d.Canonical()
	if err != nil {
		t.Fatal(err)
	}
	// Nothing is lost: the canonical form says the same as the input.
	var want, got any
	if err := json.Unmarshal([]byte(full), &want); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(canon, &got); err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(want) != fmt.Sprint(got) {
		t.Errorf("canonical form differs:\n got %v\nwant %v", got, want)
	}
	// And it is a fixed point.
	again, err := accountopts.Parse(canon)
	if err != nil {
		t.Fatal(err)
	}
	if c2, _ := again.Canonical(); string(c2) != string(canon) {
		t.Errorf("canonical form is not stable:\n%s\n%s", canon, c2)
	}
	if e, _ := accountopts.Empty().Canonical(); string(e) != `{"v":1}` {
		t.Errorf("empty document = %s", e)
	}
}

func TestParseRejects(t *testing.T) {
	many := func(n int, f func(i int) string) string {
		parts := make([]string, n)
		for i := range parts {
			parts[i] = f(i)
		}
		return strings.Join(parts, ",")
	}
	cases := map[string]string{
		"not json":              `nope`,
		"an array":              `[1]`,
		"no version":            `{}`,
		"another version":       `{"v":2}`,
		"trailing data":         `{"v":1}{"v":1}`,
		"unknown key":           `{"v":1,"motd":"hi"}`,
		"unknown nested key":    `{"v":1,"audio":{"volume":{"voice":1}}}`,
		"unknown device key":    `{"v":1,"devices":{"desktop":{"theme":"x"}}}`,
		"unknown place key":     `{"v":1,"devices":{"desktop":{"windows":{"v":3,"z":[],"win":{"battle":{"dock":true}},"others":{}}}}}`,
		"wrong type":            `{"v":1,"reduced_motion":"yes"}`,
		"html as a language":    `{"v":1,"lang":"<script>alert(1)</script>"}`,
		"controls enum":         `{"v":1,"controls":"<img src=x>"}`,
		"name size enum":        `{"v":1,"name_size":"huge"}`,
		"ui scale range":        `{"v":1,"ui_scale":50}`,
		"text scale range":      `{"v":1,"text_scale":0}`,
		"chat opacity range":    `{"v":1,"chat_opacity":101}`,
		"chat opacity fraction": `{"v":1,"chat_opacity":50.5}`,
		"volume range":          `{"v":1,"audio":{"volume":{"music":1.5}}}`,
		"negative volume":       `{"v":1,"audio":{"volume":{"music":-0.1}}}`,
		"hotkey vocation id":    `{"v":1,"hotkeys":{"<b>":[]}}`,
		"hotkey spell id":       `{"v":1,"hotkeys":{"guardian":["javascript:alert(1)"]}}`,
		"13 hotkeys":            `{"v":1,"hotkeys":{"guardian":[` + many(13, func(int) string { return "null" }) + `]}}`,
		"17 hotkey bars":        `{"v":1,"hotkeys":{` + many(17, func(i int) string { return fmt.Sprintf(`"v%d":[]`, i) }) + `}}`,
		"track name":            `{"v":1,"track":{"<b>Ana</b>":"quest.a"}}`,
		"track long name":       `{"v":1,"track":{"` + strings.Repeat("a", 33) + `":"quest.a"}}`,
		"track quest id":        `{"v":1,"track":{"Ana":"Quest A"}}`,
		"33 tracked":            `{"v":1,"track":{` + many(33, func(i int) string { return fmt.Sprintf(`"A%s":"q"`, strings.Repeat("b", i)) }) + `}}`,
		"device class":          `{"v":1,"devices":{"fridge":{}}}`,
		"null device":           `{"v":1,"devices":{"desktop":null}}`,
		"zoom range":            `{"v":1,"devices":{"touch":{"zoom":0}}}`,
		"minimap scale":         `{"v":1,"devices":{"touch":{"minimap":{"open":true,"scale":99}}}}`,
		"windows version":       `{"v":1,"devices":{"desktop":{"windows":{"v":2,"z":[],"win":{},"others":{}}}}}`,
		"window id":             `{"v":1,"devices":{"desktop":{"windows":{"v":3,"z":["<x>"],"win":{},"others":{}}}}}`,
		"window key":            `{"v":1,"devices":{"desktop":{"windows":{"v":3,"z":[],"win":{"A B":{}},"others":{}}}}}`,
		"window far away":       `{"v":1,"devices":{"desktop":{"windows":{"v":3,"z":[],"win":{"battle":{"x":1e9}},"others":{}}}}}`,
		"65 windows": `{"v":1,"devices":{"desktop":{"windows":{"v":3,"z":[],"win":{},"others":{` +
			many(65, func(i int) string { return fmt.Sprintf(`"container-c%d":{}`, i) }) + `}}}}}`,
		"too large":    `{"v":1,"lang":"es"` + strings.Repeat(" ", accountopts.MaxBytes) + `}`,
		"invalid utf8": "{\"v\":1,\"track\":{\"A\xff\":\"q\"}}",
	}
	for name, raw := range cases {
		if _, err := accountopts.Parse([]byte(raw)); !errors.Is(err, accountopts.ErrInvalid) {
			t.Errorf("%s: err = %v, want ErrInvalid", name, err)
		}
	}
}

// Whatever is accepted, the stored bytes hold no markup character outside JSON's own
// escapes: Go's encoder writes <, > and & as <, > and &.
func TestCanonicalNeverCarriesMarkup(t *testing.T) {
	d, err := accountopts.Parse([]byte(full))
	if err != nil {
		t.Fatal(err)
	}
	canon, _ := d.Canonical()
	if strings.ContainsAny(string(canon), "<>&") {
		t.Errorf("markup characters in %s", canon)
	}
}

func FuzzParse(f *testing.F) {
	f.Add([]byte(full))
	f.Add([]byte(`{"v":1}`))
	f.Fuzz(func(t *testing.T, raw []byte) {
		d, err := accountopts.Parse(raw)
		if err != nil {
			return
		}
		canon, err := d.Canonical()
		if err != nil {
			return // larger encoded than sent: refused, never stored
		}
		if _, err := accountopts.Parse(canon); err != nil {
			t.Fatalf("canonical form of an accepted document is refused: %v\n%s", err, canon)
		}
	})
}
