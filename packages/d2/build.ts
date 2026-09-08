#!/usr/bin/env -S deno run --allow-env=HOME,XDG_CACHE_HOME --allow-read --allow-write --allow-net --allow-run

import { buildPackage } from "../../scripts/package-build.ts";

await buildPackage(import.meta.url);
