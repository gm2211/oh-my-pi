import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import * as path from "node:path";
import rootManifest from "../../../package.json" with { type: "json" };
import packageManifest from "../package.json" with { type: "json" };
import { fastembedRuntimeInstallPlan, prepareWindowsFastembedRuntime } from "../src/core/fastembed-runtime";

// The fastembed peer is pinned as an exact version (not `catalog:`) because
// `core/fastembed-runtime.ts` reads it to `bun install` the on-demand embedding
// runtime — including from bundles where the inlined manifest would otherwise
// carry an uninstallable `catalog:` spec (#2389). The runtime cache must keep
// fastembed's own ORT dependency intact because its native addon links against
// that exact bundled library name (#3054).
describe("fastembed runtime version pins", () => {
	const catalog = rootManifest.workspaces.catalog;

	test("fastembed peer pin matches the workspace catalog", () => {
		expect(packageManifest.peerDependencies.fastembed).toBe(catalog.fastembed);
	});

	test("pins are exact installable versions, not catalog or range specs", () => {
		expect(packageManifest.peerDependencies.fastembed).toMatch(/^\d+\.\d+\.\d+$/);
		expect(packageManifest.peerDependencies["onnxruntime-node"]).toMatch(/^\d+\.\d+\.\d+$/);
	});

	test("onnxruntime peer pin matches fastembed's native ABI", () => {
		expect(packageManifest.peerDependencies["onnxruntime-node"]).toBe("1.21.0");
	});

	test("runtime install preserves fastembed's transitive onnxruntime pin", () => {
		const plan = fastembedRuntimeInstallPlan();
		expect(plan.install.dependencies).toEqual({
			fastembed: packageManifest.peerDependencies.fastembed,
		});
		expect(plan.install.overrides).not.toHaveProperty("onnxruntime-node");
		expect(plan.install.trustedDependencies).toEqual(["onnxruntime-node"]);
		expect(plan.versionKey).toContain("transitive-ort");
		expect(plan.versionKey).not.toContain("forced-ort");
	});

	// fastembed 2.1.0 declares the vulnerable `tar ^6.2.0`. The workspace forces
	// tar 7 and patches fastembed onto tar 7's named export; the runtime cache
	// (compiled binary, bundle) must get the same tar and the same patch, or it
	// either keeps tar 6 or crashes on `tar.default.x` at model extraction.
	test("runtime install forces the workspace's tar and applies the workspace's fastembed patch", async () => {
		const plan = fastembedRuntimeInstallPlan();
		const fastembedKey = `fastembed@${packageManifest.peerDependencies.fastembed}`;
		const rootPatches: Record<string, string> = rootManifest.patchedDependencies;
		const rootPatchPath = rootPatches[fastembedKey];
		expect(rootPatchPath).toBeDefined();
		const rootPatch = await Bun.file(path.join(import.meta.dir, "../../..", rootPatchPath)).text();

		expect(plan.install.overrides).toEqual({ tar: rootManifest.overrides.tar });
		expect(rootManifest.overrides.tar).toMatch(/^7\.\d+\.\d+$/);
		expect(plan.install.patchedDependencies).toEqual({ [fastembedKey]: rootPatch });
		// A new cache key so runtimes installed with tar 6 are not reused.
		expect(plan.versionKey).toContain(`tar-${rootManifest.overrides.tar}`);
	});

	test("Windows preload selects fastembed's ORT DLL before inherited paths", async () => {
		const requireTest = createRequire(import.meta.url);
		const fastembedManifest = requireTest.resolve("fastembed/package.json");
		const fastembedEntry = requireTest.resolve("fastembed");
		const inheritedPath = ["/stale-ort", "/system"].join(path.delimiter);
		const env: NodeJS.ProcessEnv = { PATH: inheritedPath };
		const { ortEntry, ortPackageDir, dllDir } = await prepareWindowsFastembedRuntime({
			fastembedEntry,
			fastembedPackageDir: path.dirname(fastembedManifest),
			arch: "x64",
			env,
		});
		const ortManifest: { version?: unknown } = requireTest(path.join(ortPackageDir, "package.json"));

		expect(ortManifest.version).toBe(packageManifest.peerDependencies["onnxruntime-node"]);
		expect(ortEntry.startsWith(`${ortPackageDir}${path.sep}`)).toBe(true);
		expect(await Bun.file(path.join(dllDir, "onnxruntime.dll")).exists()).toBe(true);
		expect(env.PATH).toBe(`${dllDir}${path.delimiter}${inheritedPath}`);
	});
});
