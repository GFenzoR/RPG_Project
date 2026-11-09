package httpapi_test

import (
	"context"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/httpapi"
	"github.com/GFenzoR/RPG_Project/server/internal/store"
)

type fakeHouses struct{ n atomic.Int32 }

func (f *fakeHouses) PublicHouses(context.Context, time.Time) ([]store.PublicHouseOwner, error) {
	f.n.Add(1)
	return []store.PublicHouseOwner{{HouseID: "puerto_house_net", Name: "Ana"}}, nil
}

// The public house list (T5.4): every house of the map with its owner's name (or free),
// from a cache: one query for many requests.
func TestPublicHouses(t *testing.T) {
	f := &fakeHouses{}
	h := newHarness(t, func(c *httpapi.Config) {
		c.HouseOwners = f
		c.Houses = []httpapi.HouseInfo{
			{ID: "puerto_house_net", Name: "house.puerto_house_net.name", Island: "puerto", Rent: 800, Size: 32},
			{ID: "bosque_house_moss", Name: "house.bosque_house_moss.name", Island: "bosque", Rent: 500, Size: 21},
		}
	})
	for range 3 {
		w := h.do(req{method: "GET", path: "/api/houses"})
		body := w.Body.String()
		if w.Code != http.StatusOK ||
			!strings.Contains(body, `{"id":"puerto_house_net","name":"house.puerto_house_net.name","island":"puerto","rent":800,"size":32,"owner":"Ana"}`) ||
			!strings.Contains(body, `"id":"bosque_house_moss"`) || !strings.Contains(body, `"owner":""`) {
			t.Fatalf("list = %d %s", w.Code, body)
		}
	}
	if f.n.Load() != 1 {
		t.Fatalf("queries = %d, want 1 (cached)", f.n.Load())
	}
}

// Without houses the list does not exist.
func TestPublicHousesOff(t *testing.T) {
	h := newHarness(t, func(*httpapi.Config) {})
	if w := h.do(req{method: "GET", path: "/api/houses"}); w.Code != http.StatusNotFound {
		t.Fatalf("GET /api/houses without houses = %d", w.Code)
	}
}
