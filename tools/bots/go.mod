module github.com/GFenzoR/RPG_Project/tools/bots

go 1.24.0

require github.com/GFenzoR/RPG_Project/server v0.0.0

require (
	github.com/coder/websocket v1.8.14 // indirect
	google.golang.org/protobuf v1.36.12 // indirect
)

// The bot client lives in the server module (server/pkg/bot) next to the protocol code.
replace github.com/GFenzoR/RPG_Project/server => ../../server
