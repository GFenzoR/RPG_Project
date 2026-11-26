// Package accountopts is the interface options document of an account (docs/05 "Opciones
// de la cuenta", owner decision 2026-11-26): what the player picked in the client's
// Options (language, volumes, sizes, the action bar, where the windows are) follows the
// account to another browser or device.
//
// The document is untrusted input that the server stores and serves back, so nothing of
// it is kept as sent: Parse decodes it into the closed set of fields below (an unknown
// key anywhere is an error), checks every value against its enum, range or id pattern,
// bounds every list and map, and Canonical re-encodes what was understood. No free text
// exists in it: every string is an enum or an id (lower-case letters, digits and
// "_.-"), or a character name (letters, spaces, "'" and "-"), so nothing in it can be
// markup whatever a client does with it.
package accountopts

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"regexp"
	"unicode"
	"unicode/utf8"
)

// Version is the document version this server reads and writes.
const Version = 1

// MaxBytes bounds the document, as sent and as stored.
const MaxBytes = 16 << 10

// Bounds of the lists and maps.
const (
	HotkeySlots   = 12 // F1..F12
	MaxHotkeyBars = 16 // one per vocation
	MaxTracked    = 32 // one per character
	MaxWindows    = 64 // the toolbar's, the server's and the remembered containers
	maxIDLen      = 64
	maxNameLen    = 32
	maxCoord      = 100000
)

// ErrInvalid is returned (wrapped) for a document that is not acceptable.
var ErrInvalid = errors.New("invalid account options")

// Doc is the document. A nil field is an option the account never saved (the client
// keeps its own value for it: "local fills what the server lacks").
type Doc struct {
	V             int                  `json:"v"`
	Lang          *string              `json:"lang,omitempty"`
	Audio         *Audio               `json:"audio,omitempty"`
	Controls      *string              `json:"controls,omitempty"`
	ReducedMotion *bool                `json:"reduced_motion,omitempty"`
	UIScale       *float64             `json:"ui_scale,omitempty"`
	TextScale     *float64             `json:"text_scale,omitempty"`
	CameraShake   *bool                `json:"camera_shake,omitempty"`
	ChatBubbles   *bool                `json:"chat_bubbles,omitempty"`
	NameSize      *string              `json:"name_size,omitempty"`
	ChatOpacity   *int                 `json:"chat_opacity,omitempty"`
	Hotkeys       map[string][]*string `json:"hotkeys,omitempty"`
	Track         map[string]string    `json:"track,omitempty"`
	// Devices holds what only makes sense on one kind of screen (window places in
	// pixels, the zoom, the direction pad), per device class: DeviceClasses.
	Devices map[string]*Device `json:"devices,omitempty"`
}

// Audio is the volume (0..1) and mute of each channel.
type Audio struct {
	Volume *Channels[float64] `json:"volume,omitempty"`
	Muted  *Channels[bool]    `json:"muted,omitempty"`
}

// Channels is one value per audio channel of the client.
type Channels[T any] struct {
	Master  *T `json:"master,omitempty"`
	Music   *T `json:"music,omitempty"`
	Sfx     *T `json:"sfx,omitempty"`
	UI      *T `json:"ui,omitempty"`
	Ambient *T `json:"ambient,omitempty"`
}

func (c *Channels[T]) all() []*T { return []*T{c.Master, c.Music, c.Sfx, c.UI, c.Ambient} }

// Device is the options of one device class.
type Device struct {
	TouchPad *bool    `json:"touch_pad,omitempty"`
	Zoom     *int     `json:"zoom,omitempty"`
	Minimap  *Minimap `json:"minimap,omitempty"`
	Windows  *Windows `json:"windows,omitempty"`
}

// Minimap is the minimap's state: shown or folded, and its scale.
type Minimap struct {
	Open  bool `json:"open"`
	Scale int  `json:"scale"`
}

// Windows is the client's window layout (client/src/ui/windows.ts, version 3).
type Windows struct {
	V      int              `json:"v"`
	Z      []string         `json:"z"`
	Win    map[string]Place `json:"win"`
	Others map[string]Place `json:"others"`
}

// Place is where a window is: CSS pixels, unset = its default place or size.
type Place struct {
	Open      *bool `json:"open,omitempty"`
	Collapsed *bool `json:"collapsed,omitempty"`
	X         *int  `json:"x,omitempty"`
	Y         *int  `json:"y,omitempty"`
	W         *int  `json:"w,omitempty"`
	H         *int  `json:"h,omitempty"`
}

// DeviceClasses are the keys of Doc.Devices: a screen driven by a mouse, and one driven
// by a finger (phone or tablet).
var DeviceClasses = []string{"desktop", "touch"}

var (
	idRE     = regexp.MustCompile(`^[a-z0-9][a-z0-9_.-]*$`)
	langRE   = regexp.MustCompile(`^[a-z]{2,3}(-[A-Z]{2})?$`)
	controls = []string{"menu", "classic"}
	names    = []string{"normal", "large"}
)

// Parse decodes and validates a document. The error wraps ErrInvalid and says which
// field was refused (for the log and the tests; the API answers a fixed code).
func Parse(raw []byte) (*Doc, error) {
	if len(raw) > MaxBytes {
		return nil, fmt.Errorf("%w: %d bytes, at most %d", ErrInvalid, len(raw), MaxBytes)
	}
	if !utf8.Valid(raw) {
		return nil, fmt.Errorf("%w: not UTF-8", ErrInvalid)
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	var d Doc
	if err := dec.Decode(&d); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalid, err) //nolint:errorlint // the decoder's text only
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return nil, fmt.Errorf("%w: data after the document", ErrInvalid)
	}
	if err := d.validate(); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalid, err) //nolint:errorlint // a field name only
	}
	return &d, nil
}

// Canonical is the document as stored and served: only the fields Parse understood, in
// a fixed order. It fails for a document that would not parse back (too large).
func (d *Doc) Canonical() ([]byte, error) {
	out, err := json.Marshal(d)
	if err != nil {
		return nil, fmt.Errorf("encode account options: %w", err)
	}
	if len(out) > MaxBytes {
		return nil, fmt.Errorf("%w: %d bytes encoded, at most %d", ErrInvalid, len(out), MaxBytes)
	}
	return out, nil
}

// Empty is the document of an account that never saved one.
func Empty() *Doc { return &Doc{V: Version} }

func oneOf(v *string, allowed []string) bool {
	if v == nil {
		return true
	}
	for _, a := range allowed {
		if *v == a {
			return true
		}
	}
	return false
}

func isID(s string) bool { return len(s) <= maxIDLen && idRE.MatchString(s) }

// isName accepts what a character name may look like: letters, spaces, "'" and "-".
func isName(s string) bool {
	n := 0
	for _, r := range s {
		n++
		if !unicode.IsLetter(r) && r != ' ' && r != '\'' && r != '-' {
			return false
		}
	}
	return n >= 1 && n <= maxNameLen
}

func inRange(v *float64, lo, hi float64) bool {
	return v == nil || (!math.IsNaN(*v) && *v >= lo && *v <= hi)
}

func intIn(v *int, lo, hi int) bool { return v == nil || (*v >= lo && *v <= hi) }

func (d *Doc) validate() error {
	switch {
	case d.V != Version:
		return fmt.Errorf("v %d, want %d", d.V, Version)
	case d.Lang != nil && !langRE.MatchString(*d.Lang):
		return errors.New("lang")
	case !oneOf(d.Controls, controls):
		return errors.New("controls")
	case !oneOf(d.NameSize, names):
		return errors.New("name_size")
	case !inRange(d.UIScale, 0.5, 2):
		return errors.New("ui_scale")
	case !inRange(d.TextScale, 0.5, 2):
		return errors.New("text_scale")
	case !intIn(d.ChatOpacity, 0, 100):
		return errors.New("chat_opacity")
	}
	if a := d.Audio; a != nil && a.Volume != nil {
		for _, v := range a.Volume.all() {
			if !inRange(v, 0, 1) {
				return errors.New("audio.volume")
			}
		}
	}
	if len(d.Hotkeys) > MaxHotkeyBars {
		return errors.New("hotkeys: too many bars")
	}
	for voc, bar := range d.Hotkeys {
		if !isID(voc) || len(bar) > HotkeySlots {
			return errors.New("hotkeys")
		}
		for _, spell := range bar {
			if spell != nil && !isID(*spell) {
				return errors.New("hotkeys: spell id")
			}
		}
	}
	if len(d.Track) > MaxTracked {
		return errors.New("track: too many characters")
	}
	for name, quest := range d.Track {
		if !isName(name) || !isID(quest) {
			return errors.New("track")
		}
	}
	for class, dev := range d.Devices {
		if !oneOf(&class, DeviceClasses) || dev == nil {
			return errors.New("devices")
		}
		if err := dev.validate(); err != nil {
			return fmt.Errorf("devices.%s.%w", class, err)
		}
	}
	return nil
}

func (v *Device) validate() error {
	if !intIn(v.Zoom, 1, 32) {
		return errors.New("zoom")
	}
	if m := v.Minimap; m != nil && (m.Scale < 1 || m.Scale > 16) {
		return errors.New("minimap.scale")
	}
	w := v.Windows
	if w == nil {
		return nil
	}
	if w.V != 3 {
		return errors.New("windows.v")
	}
	if len(w.Z) > MaxWindows || len(w.Win) > MaxWindows || len(w.Others) > MaxWindows {
		return errors.New("windows: too many")
	}
	for _, id := range w.Z {
		if !isID(id) {
			return errors.New("windows.z")
		}
	}
	for _, places := range []map[string]Place{w.Win, w.Others} {
		for id, p := range places {
			if !isID(id) {
				return errors.New("windows: id")
			}
			for _, c := range []*int{p.X, p.Y, p.W, p.H} {
				if !intIn(c, -maxCoord, maxCoord) {
					return errors.New("windows: place")
				}
			}
		}
	}
	return nil
}
