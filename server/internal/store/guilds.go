package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/GFenzoR/RPG_Project/server/internal/store/db"
)

// Guilds (T5.1). The game loop owns them: LoadGuilds reads everything once at start and
// ApplyGuild writes each change the loop decided, in order, from the admin goroutine.
// The unique indexes (a character in one guild, one leader per guild, names ignoring
// case) are the safety net; a change that breaks one is a bug, reported as a permanent
// error.

// GuildOp is the kind of a GuildChange.
type GuildOp uint8

// Guild changes.
const (
	// GuildCreate inserts guild GuildID named Name with CharacterID as its leader and
	// drops the founder's pending invitations.
	GuildCreate GuildOp = iota + 1
	// GuildRename renames GuildID to Name (GM command).
	GuildRename
	// GuildMotd sets GuildID's message of the day to Text.
	GuildMotd
	// GuildDisband deletes GuildID: its members and invitations go with it.
	GuildDisband
	// GuildJoin adds CharacterID to GuildID with Rank and drops every pending
	// invitation of the character.
	GuildJoin
	// GuildRemove takes CharacterID out of GuildID (leave or kick).
	GuildRemove
	// GuildRank sets the Rank of CharacterID in GuildID.
	GuildRank
	// GuildTransfer makes OtherID the leader of GuildID and gives CharacterID (the old
	// leader) Rank (vice, or member when the guild has no room for another vice).
	GuildTransfer
	// GuildInvite stores (or renews) the invitation of CharacterID to GuildID by
	// InvitedBy until Expires.
	GuildInvite
	// GuildUninvite deletes the invitation of CharacterID to GuildID (declined, revoked
	// or expired).
	GuildUninvite
	// GuildWarDeclare inserts war WarID of GuildID on EnemyID, declared at At, that
	// expires at Expires unless accepted, with KillLimit (T5.2).
	GuildWarDeclare
	// GuildWarStart makes the declared war WarID active from At until Expires.
	GuildWarStart
	// GuildWarKills sets the kills of the active war WarID: Kills for its GuildID (the
	// declaring guild) and EnemyKills for its enemy.
	GuildWarKills
	// GuildWarEnd ends the open war WarID at At with Reason (WarEnd*) and WinnerID (0:
	// none or a draw).
	GuildWarEnd
)

// Guild war end reasons (guild_wars.end_reason).
const (
	WarEndDeclined = iota + 1
	WarEndExpired
	WarEndSurrender
	WarEndKillLimit
	WarEndTime
	WarEndDisbanded
)

// Guild ranks as stored (guild.Rank).
const (
	GuildRankMember = 1
	GuildRankVice   = 2
	GuildRankLeader = 3
)

// GuildChange is one change of a guild decided by the game loop.
type GuildChange struct {
	Op          GuildOp
	GuildID     int64
	CharacterID int64
	OtherID     int64
	InvitedBy   int64
	Name        string
	Text        string
	Rank        int
	At          time.Time
	Expires     time.Time
	// Guild wars (T5.2).
	WarID      int64
	EnemyID    int64
	KillLimit  int
	Kills      int
	EnemyKills int
	Reason     int
	WinnerID   int64
}

// ErrGuildConflict means a change broke a guild constraint (the loop and the database
// disagree). It is permanent: retrying cannot fix it.
var ErrGuildConflict = errors.New("store: guild change conflicts with the database")

// ApplyGuild writes c, and audit if not nil (GM commands), in one transaction. A
// change that finds nothing to update (a row already gone) is not an error: the loop's
// state is what counts.
func (s *Store) ApplyGuild(ctx context.Context, c GuildChange, audit *AuditEntry) error {
	err := s.inTx(ctx, func(q *db.Queries) error {
		if err := applyGuild(ctx, q, c); err != nil {
			return err
		}
		if audit != nil {
			return appendAudit(ctx, q, *audit)
		}
		return nil
	})
	if err != nil {
		return fmt.Errorf("guild change %d of guild %d: %w", c.Op, c.GuildID, err)
	}
	return nil
}

func applyGuild(ctx context.Context, q *db.Queries, c GuildChange) error {
	var err error
	switch c.Op {
	case GuildCreate:
		if err = q.InsertGuild(ctx, db.InsertGuildParams{ID: c.GuildID, Name: c.Name, CreatedAt: ts(c.At)}); err != nil {
			return guildErr("insert guild", err)
		}
		if err = q.RaiseGuildIDHigh(ctx, c.GuildID); err != nil {
			return guildErr("guild id", err)
		}
		err = q.InsertGuildMember(ctx, db.InsertGuildMemberParams{CharacterID: c.CharacterID, GuildID: c.GuildID,
			Rank: GuildRankLeader, JoinedAt: ts(c.At)})
		if err == nil {
			err = q.DeleteCharacterGuildInvites(ctx, c.CharacterID)
		}
	case GuildRename:
		_, err = q.RenameGuild(ctx, db.RenameGuildParams{ID: c.GuildID, Name: c.Name})
	case GuildMotd:
		_, err = q.SetGuildMotd(ctx, db.SetGuildMotdParams{ID: c.GuildID, Motd: c.Text})
	case GuildDisband:
		_, err = q.DeleteGuild(ctx, c.GuildID)
	case GuildJoin:
		err = q.InsertGuildMember(ctx, db.InsertGuildMemberParams{CharacterID: c.CharacterID, GuildID: c.GuildID,
			Rank: int16(c.Rank), JoinedAt: ts(c.At)})
		if err == nil {
			err = q.DeleteCharacterGuildInvites(ctx, c.CharacterID)
		}
	case GuildRemove:
		_, err = q.DeleteGuildMember(ctx, db.DeleteGuildMemberParams{GuildID: c.GuildID, CharacterID: c.CharacterID})
	case GuildRank:
		_, err = q.SetGuildMemberRank(ctx, db.SetGuildMemberRankParams{GuildID: c.GuildID, CharacterID: c.CharacterID,
			Rank: int16(c.Rank)})
	case GuildTransfer:
		// Demote first: one leader per guild is a unique index checked per statement. The
		// old leader's new rank is the loop's (a member when there is no room for a vice).
		old := int16(c.Rank)
		if old != GuildRankMember && old != GuildRankVice {
			return fmt.Errorf("%w: transfer leaves the old leader with rank %d", ErrGuildConflict, c.Rank)
		}
		_, err = q.SetGuildMemberRank(ctx, db.SetGuildMemberRankParams{GuildID: c.GuildID, CharacterID: c.CharacterID,
			Rank: old})
		if err == nil {
			_, err = q.SetGuildMemberRank(ctx, db.SetGuildMemberRankParams{GuildID: c.GuildID, CharacterID: c.OtherID,
				Rank: GuildRankLeader})
		}
	case GuildInvite:
		var by pgtype.Int8
		if c.InvitedBy != 0 {
			by = pgtype.Int8{Int64: c.InvitedBy, Valid: true}
		}
		err = q.UpsertGuildInvite(ctx, db.UpsertGuildInviteParams{GuildID: c.GuildID, CharacterID: c.CharacterID,
			InvitedBy: by, CreatedAt: ts(c.At), ExpiresAt: ts(c.Expires)})
	case GuildUninvite:
		err = q.DeleteGuildInvite(ctx, db.DeleteGuildInviteParams{GuildID: c.GuildID, CharacterID: c.CharacterID})
	case GuildWarDeclare:
		err = q.InsertGuildWar(ctx, db.InsertGuildWarParams{ID: c.WarID, GuildID: c.GuildID, EnemyID: c.EnemyID,
			DeclaredAt: ts(c.At), ExpiresAt: ts(c.Expires), KillLimit: int32(c.KillLimit)})
		if err == nil {
			err = q.RaiseGuildWarHigh(ctx, c.WarID)
		}
	case GuildWarStart:
		_, err = q.StartGuildWar(ctx, db.StartGuildWarParams{ID: c.WarID, StartedAt: ts(c.At), ExpiresAt: ts(c.Expires)})
	case GuildWarKills:
		_, err = q.SetGuildWarKills(ctx, db.SetGuildWarKillsParams{ID: c.WarID, GuildKills: int32(c.Kills),
			EnemyKills: int32(c.EnemyKills)})
	case GuildWarEnd:
		var winner pgtype.Int8
		if c.WinnerID != 0 {
			winner = pgtype.Int8{Int64: c.WinnerID, Valid: true}
		}
		if c.Reason < WarEndDeclined || c.Reason > WarEndDisbanded {
			return fmt.Errorf("%w: war end reason %d", ErrGuildConflict, c.Reason)
		}
		_, err = q.EndGuildWar(ctx, db.EndGuildWarParams{ID: c.WarID, EndedAt: ts(c.At), EndReason: int16(c.Reason),
			WinnerID: winner})
	default:
		return fmt.Errorf("%w: unknown op %d", ErrGuildConflict, c.Op)
	}
	return guildErr("apply", err)
}

// guildErr wraps a constraint violation as ErrGuildConflict too, keeping the pg error
// (Permanent still sees it).
func guildErr(what string, err error) error {
	if err == nil {
		return nil
	}
	if Permanent(err) {
		return fmt.Errorf("%s: %w: %w", what, ErrGuildConflict, err)
	}
	return fmt.Errorf("%s: %w", what, err)
}

// GuildRow is a guild as LoadGuilds reads it.
type GuildRow struct {
	ID        int64
	Name      string
	Motd      string
	CreatedAt time.Time
}

// GuildMemberRow is a member with its character's name.
type GuildMemberRow struct {
	GuildID     int64
	CharacterID int64
	Name        string
	Rank        int
	JoinedAt    time.Time
}

// GuildInviteRow is a pending invitation with the invited character's name.
type GuildInviteRow struct {
	GuildID     int64
	CharacterID int64
	Name        string
	Expires     time.Time
}

// GuildWarRow is an open (declared or active) guild war (T5.2).
type GuildWarRow struct {
	ID         int64
	GuildID    int64
	EnemyID    int64
	Active     bool
	DeclaredAt time.Time
	StartedAt  time.Time // zero while declared
	Expires    time.Time
	KillLimit  int
	Kills      int
	EnemyKills int
}

// GuildRows is every guild, member and pending invitation, the open wars, and the
// highest guild and war ids ever issued (a new one must get a higher one).
type GuildRows struct {
	IDHigh    int64
	WarIDHigh int64
	Guilds    []GuildRow
	Members   []GuildMemberRow
	Invites   []GuildInviteRow
	Wars      []GuildWarRow
}

// LoadGuilds deletes the invitations expired at now and reads every guild, member and
// invitation (members by guild, highest rank first). Called once at start, before the
// game loop runs.
func (s *Store) LoadGuilds(ctx context.Context, now time.Time) (GuildRows, error) {
	var out GuildRows
	err := s.inTx(ctx, func(q *db.Queries) error {
		if err := q.DeleteExpiredGuildInvites(ctx, ts(now)); err != nil {
			return err
		}
		high, err := q.GuildIDHigh(ctx)
		if err != nil {
			return err
		}
		out.IDHigh = high
		gs, err := q.ListGuilds(ctx)
		if err != nil {
			return err
		}
		for _, g := range gs {
			out.Guilds = append(out.Guilds, GuildRow{ID: g.ID, Name: g.Name, Motd: g.Motd, CreatedAt: g.CreatedAt.Time})
		}
		ms, err := q.ListGuildMembers(ctx)
		if err != nil {
			return err
		}
		for _, m := range ms {
			out.Members = append(out.Members, GuildMemberRow{GuildID: m.GuildID, CharacterID: m.CharacterID, Name: m.Name,
				Rank: int(m.Rank), JoinedAt: m.JoinedAt.Time})
		}
		is, err := q.ListGuildInvites(ctx)
		if err != nil {
			return err
		}
		for _, i := range is {
			out.Invites = append(out.Invites, GuildInviteRow{GuildID: i.GuildID, CharacterID: i.CharacterID, Name: i.Name,
				Expires: i.ExpiresAt.Time})
		}
		if out.WarIDHigh, err = q.GuildWarHigh(ctx); err != nil {
			return err
		}
		ws, err := q.ListOpenGuildWars(ctx)
		if err != nil {
			return err
		}
		for _, w := range ws {
			out.Wars = append(out.Wars, GuildWarRow{ID: w.ID, GuildID: w.GuildID, EnemyID: w.EnemyID, Active: w.State == 2,
				DeclaredAt: w.DeclaredAt.Time, StartedAt: w.StartedAt.Time, Expires: w.ExpiresAt.Time,
				KillLimit: int(w.KillLimit), Kills: int(w.GuildKills), EnemyKills: int(w.EnemyKills)})
		}
		return nil
	})
	if err != nil {
		return GuildRows{}, fmt.Errorf("load guilds: %w", err)
	}
	return out, nil
}

// PublicGuildSummary is a guild of the public list (GET /api/guilds).
type PublicGuildSummary struct {
	ID        int64
	Name      string
	Leader    string
	Members   int
	CreatedAt time.Time
}

// PublicGuildMember is a member on the public detail page.
type PublicGuildMember struct {
	Name     string
	Vocation string
	Level    int
	Rank     int
}

// PublicGuildDetail is a guild's public page (GET /api/guilds/{id}).
type PublicGuildDetail struct {
	ID        int64
	Name      string
	CreatedAt time.Time
	Members   []PublicGuildMember
}

// PublicGuildList is the public guild list and the highest guild id ever issued (a
// larger id cannot exist: the site answers 404 for it without a query).
type PublicGuildList struct {
	Guilds []PublicGuildSummary
	IDHigh int64
}

// PublicGuilds returns up to n guilds by name, with their leader and member count. Like
// the highscores, characters of staff, disabled or banned (at now) accounts are left out.
func (s *Store) PublicGuilds(ctx context.Context, n int, now time.Time) (PublicGuildList, error) {
	rows, err := s.q.PublicGuilds(ctx, db.PublicGuildsParams{Now: ts(now), MaxRows: int32(min(max(n, 1), 10000))})
	if err != nil {
		return PublicGuildList{}, fmt.Errorf("public guilds: %w", err)
	}
	high, err := s.q.GuildIDHigh(ctx)
	if err != nil {
		return PublicGuildList{}, fmt.Errorf("guild id high: %w", err)
	}
	out := PublicGuildList{IDHigh: high, Guilds: make([]PublicGuildSummary, len(rows))}
	for i, r := range rows {
		out.Guilds[i] = PublicGuildSummary{ID: r.ID, Name: r.Name, Leader: r.Leader, Members: int(r.Members), CreatedAt: r.CreatedAt.Time}
	}
	return out, nil
}

// PublicGuild returns a guild's public page, or ErrNotFound. The message of the day is
// for the members only: it is not part of it.
func (s *Store) PublicGuild(ctx context.Context, id int64, now time.Time) (PublicGuildDetail, error) {
	g, err := s.q.PublicGuild(ctx, id)
	if err != nil {
		return PublicGuildDetail{}, notFound(err)
	}
	ms, err := s.q.PublicGuildMembers(ctx, db.PublicGuildMembersParams{GuildID: id, Now: ts(now)})
	if err != nil {
		return PublicGuildDetail{}, fmt.Errorf("public guild members: %w", err)
	}
	out := PublicGuildDetail{ID: g.ID, Name: g.Name, CreatedAt: g.CreatedAt.Time,
		Members: make([]PublicGuildMember, len(ms))}
	for i, m := range ms {
		out.Members[i] = PublicGuildMember{Name: m.Name, Vocation: m.Vocation, Level: int(m.Level), Rank: int(m.Rank)}
	}
	return out, nil
}
