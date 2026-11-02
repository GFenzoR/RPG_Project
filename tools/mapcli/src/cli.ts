#!/usr/bin/env node
// Entry point: node --experimental-strip-types tools/mapcli/src/cli.ts <command> ...
// (the flag is needed on Node 22.13–22.17; from 22.18 types are stripped without it).
import { run } from "./index.ts";

process.exitCode = run(process.argv.slice(2));
