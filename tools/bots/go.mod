module github.com/GFenzoR/RPG_Project/tools/bots

go 1.26.0

toolchain go1.27.4

require github.com/GFenzoR/RPG_Project/server v0.0.0

require (
	github.com/coder/websocket v1.8.14 // indirect
	go.yaml.in/yaml/v3 v3.0.4 // indirect
	google.golang.org/protobuf v1.36.12 // indirect
)

// The bot client lives in the server module (server/pkg/bot) next to the protocol code.
replace github.com/GFenzoR/RPG_Project/server => ../../server

// The server requires the living world module through its own replace (livingworld/README.md),
// which a dependency's go.mod does not carry over: repeat it here.
replace github.com/GFenzoR/RPG_Project/livingworld/server => ../../livingworld/server
