#!/usr/bin/env node
// Entry point: node tools/mapcli/src/cli.ts <command> ... (Node >= 22.18 strips types).
import { run } from "./index.ts";

process.exitCode = run(process.argv.slice(2));
