import { describe, expect, it } from "vitest";
import {
  buildTag,
  computeBuildHash,
  decideBuild,
  latestTag,
  type BuildContextFile,
} from "../../src/scripts/buildIfChanged.ts";

describe("computeBuildHash", () => {
  it("is deterministic regardless of input file order", () => {
    const a: BuildContextFile[] = [
      { path: "a.ts", contents: Buffer.from("one") },
      { path: "b.ts", contents: Buffer.from("two") },
    ];
    const b: BuildContextFile[] = [
      { path: "b.ts", contents: Buffer.from("two") },
      { path: "a.ts", contents: Buffer.from("one") },
    ];
    expect(computeBuildHash(a)).toBe(computeBuildHash(b));
  });

  it("changes when a file's contents change", () => {
    const before: BuildContextFile[] = [{ path: "a.ts", contents: Buffer.from("one") }];
    const after: BuildContextFile[] = [{ path: "a.ts", contents: Buffer.from("two") }];
    expect(computeBuildHash(before)).not.toBe(computeBuildHash(after));
  });

  it("changes on a pure rename, even with identical contents", () => {
    const before: BuildContextFile[] = [{ path: "a.ts", contents: Buffer.from("same") }];
    const after: BuildContextFile[] = [{ path: "b.ts", contents: Buffer.from("same") }];
    expect(computeBuildHash(before)).not.toBe(computeBuildHash(after));
  });
});

describe("buildTag / latestTag", () => {
  it("namespaces tags by app name and environment", () => {
    expect(buildTag("dev", "abc123")).toBe("wanderlog-mcp-dev-abc123");
    expect(latestTag("prod")).toBe("wanderlog-mcp-prod-latest");
  });
});

describe("decideBuild", () => {
  it("skips when an image already exists under the exact content hash", () => {
    const decision = decideBuild({
      environment: "dev",
      hash: "abc123",
      repositoryName: "moosasharieff-dev/app",
      imageExists: () => true,
    });
    expect(decision.skip).toBe(true);
    expect(decision.tag).toBe("wanderlog-mcp-dev-abc123");
    expect(decision.latestTag).toBe("wanderlog-mcp-dev-latest");
  });

  it("does not skip when no matching image is found", () => {
    const decision = decideBuild({
      environment: "dev",
      hash: "abc123",
      repositoryName: "moosasharieff-dev/app",
      imageExists: () => false,
    });
    expect(decision.skip).toBe(false);
  });
});
