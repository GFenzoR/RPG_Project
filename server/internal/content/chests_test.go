package content

import (
	"path/filepath"
	"strings"
	"testing"
)

const goodChests = `
- {id: coin, kind: currency, stackable: true, max_stack: 100, currency: {worth: 1}}
- {id: sword, kind: weapon, weapon: {type: sword, attack: 10}, requires: {level: 1}}
- {id: amber, kind: material, stackable: true, max_stack: 100}
- {id: arc_rune, kind: rune, rune: {spell: arc_bolt, charges: 5}}
- {id: old_axe, kind: weapon, weapon: {type: axe, attack: 9}, requires: {level: 1}, retired: true}
- {id: chest_a, kind: decoration, pickupable: false, blocks_movement: true, chest: {id: a, rewards: [{item: coin, count: 100}, {item: sword, count: 1}]}}
- {id: chest_b, kind: decoration, pickupable: false, chest: {id: b, rewards: [{item: amber, count: 3}]}}
`

// A chest is a fixed map item with a unique id that gives existing, current items in
// counts of one stack at most, never the forge's protection.
func TestCheckChests(t *testing.T) {
	if err := CheckChests(doorItems(t, goodChests), "other"); err != nil {
		t.Fatalf("good chests: %v", err)
	}
	if err := CheckChests(doorItems(t, goodChests), ""); err != nil {
		t.Fatalf("good chests, no forge: %v", err)
	}
	if err := CheckChests(doorItems(t, goodChests), "amber"); err == nil || !strings.Contains(err.Error(), "protection") {
		t.Fatalf("a chest that gives the forge's protection: %v", err)
	}
	bad := map[string]string{
		"pickupable":   `- {id: c, kind: decoration, chest: {id: a, rewards: [{item: coin, count: 1}]}}`,
		"needs an id":  `- {id: c, kind: decoration, pickupable: false, chest: {rewards: [{item: coin, count: 1}]}}`,
		"also the one": `- {id: c, kind: decoration, pickupable: false, chest: {id: a, rewards: [{item: coin, count: 1}]}}`,
		"nothing":      `- {id: c, kind: decoration, pickupable: false, chest: {id: c}}`,
		"not an item":  `- {id: c, kind: decoration, pickupable: false, chest: {id: c, rewards: [{item: nope, count: 1}]}}`,
		"picked up":    `- {id: c, kind: decoration, pickupable: false, chest: {id: c, rewards: [{item: chest_b, count: 1}]}}`,
		"retired":      `- {id: c, kind: decoration, pickupable: false, chest: {id: c, rewards: [{item: old_axe, count: 1}]}}`,
		"count 0":      `- {id: c, kind: decoration, pickupable: false, chest: {id: c, rewards: [{item: coin, count: 0}]}}`,
		"count 101":    `- {id: c, kind: decoration, pickupable: false, chest: {id: c, rewards: [{item: coin, count: 101}]}}`,
		"count 2":      `- {id: c, kind: decoration, pickupable: false, chest: {id: c, rewards: [{item: sword, count: 2}]}}`,
	}
	// A rune that does not stack is one unit, whatever its charges: the error says 1.
	runeChest := doorItems(t, goodChests+`- {id: c, kind: decoration, pickupable: false, chest: {id: c, rewards: [{item: arc_rune, count: 3}]}}`)
	if err := CheckChests(runeChest, ""); err == nil || !strings.Contains(err.Error(), "count 3 must be 1 to one stack (1)") {
		t.Errorf("three runes of 5 charges: %v", err)
	}
	for name, src := range bad {
		items := doorItems(t, goodChests+src)
		err := CheckChests(items, "")
		if err == nil {
			t.Errorf("%s: accepted", name)
			continue
		}
		want := name
		if strings.HasPrefix(name, "count") {
			want = "count"
		}
		if !strings.Contains(err.Error(), want) {
			t.Errorf("%s: %v", name, err)
		}
	}
}

// A book needs a title and pages.
func TestBookCheck(t *testing.T) {
	ok := doorItems(t, `- {id: b, kind: decoration, book: {title: book.b.title, pages: [book.b.page_1]}}`)
	if err := ok["b"].check(); err != nil {
		t.Fatal(err)
	}
	for _, src := range []string{
		`- {id: b, kind: decoration, book: {pages: [book.b.page_1]}}`,
		`- {id: b, kind: decoration, book: {title: book.b.title}}`,
		`- {id: b, kind: decoration, book: {title: book.b.title, pages: [""]}}`,
	} {
		if err := doorItems(t, src)["b"].check(); err == nil {
			t.Errorf("accepted %s", src)
		}
	}
}

// The chests and books of data/ (docs/02 "Libros y cofres"): 4 to 6 chests on the real
// islands plus the sandbox's, none giving the forge's protection, and every book with pages.
func TestDataChestsAndBooks(t *testing.T) {
	data := filepath.Join("..", "..", "..", "data")
	items, err := LoadItems(data)
	if err != nil {
		t.Fatal(err)
	}
	b, err := LoadBalance(data)
	if err != nil {
		t.Fatal(err)
	}
	if err := CheckChests(items, b.Forge.Protection); err != nil {
		t.Fatal(err)
	}
	chests, books := 0, 0
	for _, it := range items {
		if it.Chest != nil {
			chests++
		}
		if it.Book != nil {
			books++
		}
	}
	if chests < 5 || chests > 7 || books < 6 || books > 10 {
		t.Fatalf("%d chests (4-6 and the sandbox's), %d books (6-10)", chests, books)
	}
}
