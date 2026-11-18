// Content-hash-tagged, skip-if-unchanged image builds.
//
// Pure logic (computeBuildHash, buildTag, latestTag, decideBuild) is unit-tested in
// tests/unit/build-if-changed.test.ts without touching git/AWS. main() below is the CI
// entry point - it shells out to `git ls-files` for the real build context and the
// AWS CLI for the real ECR check, then writes skip/tag/latest_tag to GITHUB_OUTPUT
// so the workflow can gate its build/push/deploy steps on the result.

import { createHash } from "node:crypto";
import { readFileSync, appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

export interface BuildContextFile {
  path: string;
  contents: Buffer;
}

// Tracked files only (via `git ls-files` in main()) so untracked/gitignored files
// (.env, node_modules, dist) never affect the hash.
export const BUILD_CONTEXT_GLOBS = [
  "src/**/*.ts",
  "Dockerfile",
  "package.json",
  "package-lock.json",
];

/**
 * Deterministic hash of a build context - order-independent (sorted by path) and
 * sensitive to both content changes and renames (the path is part of what's hashed,
 * not just the bytes).
 */
export function computeBuildHash(files: BuildContextFile[]): string {
  const hash = createHash("sha256");
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  for (const file of sorted) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(file.contents);
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 12);
}

export function buildTag(environment: string, hash: string): string {
  return `wanderlog-mcp-${environment}-${hash}`;
}

export function latestTag(environment: string): string {
  return `wanderlog-mcp-${environment}-latest`;
}

export type ImageExistsCheck = (params: {
  repositoryName: string;
  imageTag: string;
}) => boolean;

export interface DecideBuildParams {
  environment: string;
  hash: string;
  repositoryName: string;
  imageExists: ImageExistsCheck;
}

export interface BuildDecision {
  skip: boolean;
  tag: string;
  latestTag: string;
}

/** Skip the build entirely when an image already exists under this exact content hash. */
export function decideBuild(params: DecideBuildParams): BuildDecision {
  const tag = buildTag(params.environment, params.hash);
  const skip = params.imageExists({ repositoryName: params.repositoryName, imageTag: tag });
  return { skip, tag, latestTag: latestTag(params.environment) };
}

// ---- CI entry point below - not unit tested directly, requires real git/AWS CLI ----

function listBuildContextFiles(rootDir: string): BuildContextFile[] {
  const output = execFileSync("git", ["ls-files", ...BUILD_CONTEXT_GLOBS], {
    cwd: rootDir,
    encoding: "utf-8",
  });
  return output
    .split("\n")
    .filter(Boolean)
    .map((relPath) => ({
      path: relPath,
      contents: readFileSync(`${rootDir}/${relPath}`),
    }));
}

function imageExistsInEcr(params: {
  repositoryName: string;
  imageTag: string;
  region: string;
}): boolean {
  try {
    execFileSync(
      "aws",
      [
        "ecr",
        "describe-images",
        "--repository-name",
        params.repositoryName,
        "--image-ids",
        `imageTag=${params.imageTag}`,
        "--region",
        params.region,
      ],
      { stdio: "pipe" },
    );
    return true;
  } catch {
    // ImageNotFoundException (or any other describe-images failure) -> build it
    return false;
  }
}

async function main() {
  const environment = process.env.BUILD_ENV;
  const repositoryName = process.env.ECR_REPOSITORY;
  const region = process.env.AWS_REGION || "eu-west-1";

  if (!environment || !repositoryName) {
    throw new Error("BUILD_ENV and ECR_REPOSITORY environment variables are required");
  }

  const rootDir = process.cwd();
  const files = listBuildContextFiles(rootDir);
  const hash = computeBuildHash(files);
  const decision = decideBuild({
    environment,
    hash,
    repositoryName,
    imageExists: (p) => imageExistsInEcr({ ...p, region }),
  });

  console.log(`build hash: ${hash} (${files.length} files in build context)`);
  console.log(`image tag: ${decision.tag}`);
  console.log(decision.skip ? "SKIP: image already exists, nothing changed" : "BUILD: no matching image found");

  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) {
    appendFileSync(githubOutput, `skip=${decision.skip}\n`);
    appendFileSync(githubOutput, `tag=${decision.tag}\n`);
    appendFileSync(githubOutput, `latest_tag=${decision.latestTag}\n`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
