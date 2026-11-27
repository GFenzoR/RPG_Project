package content

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The texts that explain shared experience quote two numbers of balance.yaml
// (party.level_gap_always and party.level_range_pct). They are written out in i18n, so
// this ties them: change the balance and the texts of both languages have to follow, or
// the party window would tell a rule that is not the one the server applies.
func TestPartyTextsQuoteTheBalance(t *testing.T) {
	root := filepath.Join("..", "..", "..")
	b, err := LoadBalance(filepath.Join(root, "data"))
	if err != nil {
		t.Fatal(err)
	}
	levels := map[string]string{"es": "niveles", "en": "levels"}
	for lang, word := range levels {
		gap := fmt.Sprintf("%d %s", b.Party.LevelGapAlways, word)
		pct := fmt.Sprintf("%d %%", b.Party.LevelRangePct)
		f, err := os.Open(filepath.Join(root, "i18n", lang, "client.yaml"))
		if err != nil {
			t.Fatal(err)
		}
		found := 0
		sc := bufio.NewScanner(f)
		sc.Buffer(make([]byte, 1<<20), 1<<20)
		for sc.Scan() {
			line := sc.Text()
			for _, key := range []string{"client.party.help:", "client.party.block_you.level:"} {
				if !strings.HasPrefix(line, key) {
					continue
				}
				found++
				if !strings.Contains(line, gap) || !strings.Contains(line, pct) {
					t.Errorf("%s %s does not quote %q and %q of balance.yaml party: %s", lang, key, gap, pct, line)
				}
			}
		}
		if err := sc.Err(); err != nil {
			t.Error(err)
		}
		_ = f.Close()
		if found != 2 {
			t.Errorf("%s: found %d of the 2 party texts", lang, found)
		}
	}
}
