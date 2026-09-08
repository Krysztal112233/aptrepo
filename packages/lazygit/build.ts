#!/usr/bin/env -S deno run --allow-env=HOME,XDG_CACHE_HOME --allow-read --allow-write --allow-net --allow-run

import { parseBuildArgs } from "../../scripts/build-targets.ts";
import { buildPackage } from "../../scripts/package-build.ts";

const { suite, selection } = parseBuildArgs(Deno.args);
await buildPackage(import.meta.url, suite, selection);
