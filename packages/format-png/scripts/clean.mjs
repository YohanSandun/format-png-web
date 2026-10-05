// Removes the build output, so files left from an older build never get published.
import { rmSync } from "node:fs";

rmSync(new URL("../dist", import.meta.url), { recursive: true, force: true });
