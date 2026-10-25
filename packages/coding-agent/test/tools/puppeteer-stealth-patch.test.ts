import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { DEBUG_PREFIXES, debug } from "puppeteer-core/lib/puppeteer/common/Debug.js";
import rootManifest from "../../../../package.json" with { type: "json" };

const puppeteerVersion = rootManifest.workspaces.catalog["puppeteer-core"];
const patchPath = resolve(import.meta.dir, `../../../../patches/puppeteer-core@${puppeteerVersion}.patch`);

describe("Puppeteer stealth patch", () => {
	it("uses the instance-logger catch handler for all added rejection paths", async () => {
		const patch = await Bun.file(patchPath).text();
		const addedLines = patch
			.split("\n")
			.filter(line => line.startsWith("+") && !line.startsWith("+++"))
			// Comments may name the removed helpers; only code references matter.
			.filter(line => !/^\+\s*\/\//.test(line));

		// puppeteer-core 25.13+ removed the module-level `debugError` /
		// `debugCatchError` helpers from common/util.js in favour of a
		// per-instance logger, so a bare reference in added code is a
		// ReferenceError on the first CDP failure (cf. #5296).
		expect(addedLines.filter(line => /(?<![#.\w])debugError\b/.test(line))).toEqual([]);
		expect(addedLines.filter(line => /(?<![#.\w])debugCatchError\b/.test(line))).toEqual([]);
		expect(addedLines.some(line => line.includes(".catch(this.#debugCatchError)"))).toBe(true);
		expect(addedLines.some(line => line.includes("this.#debugCatchError(error)"))).toBe(true);
	});

	it("keeps CDP failures non-throwing when Puppeteer debug logging is disabled", () => {
		// The default logger (`debug`) returns no sink when the puppeteer:error
		// channel is off, which is why every call site must optional-call it.
		expect(debug(DEBUG_PREFIXES.error)).toBeUndefined();
	});
});
