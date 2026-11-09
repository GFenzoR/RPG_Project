package httpapi

import (
	"context"
	"net/http"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/store"
)

// Public house list (T5.4): GET /api/houses lists every house of the map by town with
// its rent, size and whether it is free or whose it is. Only public data: the owner's
// character name (nobody of a staff, disabled or banned account shows: like the
// highscores), never guests, items or when the rent is paid until. The houses come
// from the map (Config.Houses); the owners from the database, in a cache of its own
// with the highscores' TTL, rate limit and query slots (a change shows within the TTL).

// PublicHouses is the source of the owners of the public house list. *store.Store
// implements it.
type PublicHouses interface {
	PublicHouses(ctx context.Context, now time.Time) ([]store.PublicHouseOwner, error)
}

var _ PublicHouses = (*store.Store)(nil)

// HouseInfo is one house of the map as the list shows it.
type HouseInfo struct {
	ID     string `json:"id"`
	Name   string `json:"name"` // i18n key
	Island string `json:"island"`
	Rent   uint32 `json:"rent"`
	Size   int    `json:"size"`
}

type houseEntry struct {
	HouseInfo
	Owner string `json:"owner"` // "" = free
}

type houseListResponse struct {
	Houses []houseEntry `json:"houses"`
}

// houseList serves GET /api/houses.
func (a *api) houseList(w http.ResponseWriter, r *http.Request) {
	body, err := a.houseListC.get(r.Context(), "list", a.guildQuery(r, func(ctx context.Context) (any, error) {
		owners, err := a.cfg.HouseOwners.PublicHouses(ctx, a.cfg.Clock.Now())
		if err != nil {
			return nil, err
		}
		by := make(map[string]string, len(owners))
		for _, o := range owners {
			by[o.HouseID] = o.Name
		}
		out := houseListResponse{Houses: make([]houseEntry, len(a.cfg.Houses))}
		for i, h := range a.cfg.Houses {
			out.Houses[i] = houseEntry{HouseInfo: h, Owner: by[h.ID]}
		}
		return out, nil
	}))
	a.writeGuildJSON(w, r, body, err)
}
