import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const repoRoot = join(import.meta.dir, "..");

const SOURCE_REPO_URL = "https://github.com/terion-name/terrarium";
const OAUTH2_PROXY_DIGEST = "sha256:8f4e89762735e7ec7c3f1bbdd5da4dcd55358db8c3278bfbc2e46a7f86ab7d9e";
const OAUTH2_PROXY_TARGET_DIGEST = "sha256:e9e04c1aec93e395897ad62625f088bbb8230c440244a4561c76df1305f9b461";
const POSTGRES_DIGEST = "sha256:a8da88e1ff62d2764fc63b0f1b0f912ff06fc629d964a260d876be615bd0857b";
const POSTGRES_TARGET_DIGEST = "sha256:9de93f210670e25bad3dd650ac435067c7628700cc7485fa0d4fe72b8e9d765d";
const OAUTH2_PROXY_DESCRIPTION =
  "Mirror of Docker Hardened Image dhi.io/oauth2-proxy:7.15.2-debian13 for pulling without Docker authentication. Original: https://hub.docker.com/hardened-images/catalog/dhi/oauth2-proxy";
const POSTGRES_DESCRIPTION =
  "Mirror of Docker Hardened Image dhi.io/postgres:17.10-alpine3.22 for pulling without Docker authentication. Original: https://hub.docker.com/hardened-images/catalog/dhi/postgres";

const workflowPath = join(repoRoot, ".github/workflows/mirror-hardened-images.yml");
const scriptPath = join(repoRoot, ".github/scripts/mirror-dhi-image.sh");

const readWorkflow = () => readFileSync(workflowPath, "utf8");
const readScript = () => readFileSync(scriptPath, "utf8");

const requiredAnnotationKeys = [
  "org.opencontainers.image.description",
  "org.opencontainers.image.source",
  "org.opencontainers.image.url",
  "io.terrarium.dhi.original-ref",
  "io.terrarium.dhi.original-url",
] as const;

describe("Docker Hardened Image mirror workflow", () => {
  test("mirrors pinned multi-arch DHI indexes to GHCR with digest checks", () => {
    const workflow = readWorkflow();
    const script = readScript();

    expect(workflow).toContain("packages: write");
    expect(workflow).toContain("DOCKERHUB_USERNAME");
    expect(workflow).toContain("DOCKERHUB_TOKEN");
    expect(workflow).toContain("HAS_DOCKERHUB_CREDS");
    expect(workflow).toContain("workflow_dispatch");
    expect(workflow).toContain("skopeo login dhi.io");
    expect(workflow).toContain("skopeo login ghcr.io");
    expect(workflow).toContain("docker login ghcr.io");
    expect(workflow).toContain("/user/packages/container/${PACKAGE_NAME}/visibility");
    expect(workflow).toContain("/orgs/${GITHUB_REPOSITORY_OWNER}/packages/container/${PACKAGE_NAME}/visibility");
    expect(workflow).toContain(`source: dhi.io/oauth2-proxy@${OAUTH2_PROXY_DIGEST}`);
    expect(workflow).not.toContain(`source: dhi.io/oauth2-proxy:7.15.2-debian13@${OAUTH2_PROXY_DIGEST}`);
    expect(workflow).toContain("target: ghcr.io/terion-labs/terrarium-dhi-oauth2-proxy:7.15.2-debian13");
    expect(workflow).toContain(`source_digest: ${OAUTH2_PROXY_DIGEST}`);
    expect(workflow).toContain(`target_digest: ${OAUTH2_PROXY_TARGET_DIGEST}`);
    expect(workflow).toContain(`source: dhi.io/postgres@${POSTGRES_DIGEST}`);
    expect(workflow).not.toContain("17.9-alpine3.22-fips");
    expect(workflow).not.toContain("target: ghcr.io/terion-labs/terrarium-dhi-postgres:17.9-alpine3.22");
    expect(workflow).toContain("target: ghcr.io/terion-labs/terrarium-dhi-postgres:17.10-alpine3.22");
    expect(workflow).toContain(`source_digest: ${POSTGRES_DIGEST}`);
    expect(workflow).toContain(`target_digest: ${POSTGRES_TARGET_DIGEST}`);
    expect(workflow).not.toContain("target_digest: auto");
    expect(workflow.match(/arches: amd64,arm64/g)).toHaveLength(2);

    expect(script).toContain("skopeo inspect --raw");
    expect(script).toContain("skopeo copy --retry-times 3 --all");
    expect(script).not.toContain("--preserve-digests");
    expect(script).toContain("sha256sum");
    expect(script).toContain("target digest mismatch");
    expect(script).toContain("source_arch_digest");
    expect(script).toContain("target_arch_digest");
    expect(script).toContain("platform manifests match source");
    expect(script).toContain('(.platform.os // "") == "linux"');
    expect(script).toContain('(.platform.architecture // "") == $arch');
  });

  test("defines explicit GHCR package metadata for each mirrored DHI image", () => {
    const workflow = readWorkflow();
    const descriptions = [...workflow.matchAll(/description: "([^"]+)"/g)].map((match) => match[1]);

    expect(workflow).toContain(`description: "${OAUTH2_PROXY_DESCRIPTION}"`);
    expect(workflow).toContain(`original_ref: dhi.io/oauth2-proxy:7.15.2-debian13@${OAUTH2_PROXY_DIGEST}`);
    expect(workflow).toContain("original_url: https://hub.docker.com/hardened-images/catalog/dhi/oauth2-proxy");
    expect(workflow).toContain(`source_repo_url: ${SOURCE_REPO_URL}`);
    expect(workflow).toContain(`description: "${POSTGRES_DESCRIPTION}"`);
    expect(workflow).toContain(`original_ref: dhi.io/postgres:17.10-alpine3.22@${POSTGRES_DIGEST}`);
    expect(workflow).toContain("original_url: https://hub.docker.com/hardened-images/catalog/dhi/postgres");
    expect(workflow.match(new RegExp(`source_repo_url: ${SOURCE_REPO_URL}`, "g"))).toHaveLength(2);

    expect(descriptions).toHaveLength(2);
    for (const description of descriptions) {
      expect(description.length).toBeLessThan(512);
      expect(description).toContain("Mirror of Docker Hardened Image");
      expect(description).toContain("for pulling without Docker authentication");
      expect(description).toContain("Original: https://hub.docker.com/hardened-images/catalog/dhi/");
    }
  });

  test("sets up Buildx and passes the metadata contract to the mirror helper", () => {
    const workflow = readWorkflow();
    const invocation = workflow.match(/\.github\/scripts\/mirror-dhi-image\.sh[\s\S]*?\n\n      - name: Make GHCR package public when permitted/)?.[0] ?? "";

    expect(workflow).toContain("uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0");
    expect(workflow).toContain("uses: docker/setup-buildx-action@8d2750c68a42422c14e847fe6c8ac0403b4cbd6f # v3.12.0");
    expect(workflow).not.toMatch(/uses: (?:actions\/checkout|docker\/setup-buildx-action)@v\d/);
    expect(invocation.match(/\$\{\{ matrix\./g)).toHaveLength(10);
    expect(invocation).toContain('"${{ matrix.name }}"');
    expect(invocation).toContain('"${{ matrix.source }}"');
    expect(invocation).toContain('"${{ matrix.target }}"');
    expect(invocation).toContain('"${{ matrix.source_digest }}"');
    expect(invocation).toContain('"${{ matrix.target_digest }}"');
    expect(invocation).toContain('"${{ matrix.arches }}"');
    expect(invocation).toContain('"${{ matrix.description }}"');
    expect(invocation).toContain('"${{ matrix.original_ref }}"');
    expect(invocation).toContain('"${{ matrix.original_url }}"');
    expect(invocation).toContain('"${{ matrix.source_repo_url }}"');
  });

  test("annotates the final GHCR index and verifies annotation metadata", () => {
    const script = readScript();

    expect(script).toContain('if [ "$#" -ne 10 ]; then');
    expect(script).toContain("<description> <original-ref> <original-url> <source-repo-url>");
    expect(script).toContain("docker buildx imagetools create");
    expect(script).toContain('--tag "${target_ref}"');
    expect(script).toContain('"${target_ref}"');
    expect(script).toContain("skopeo inspect --raw \"docker://${target_ref}\" >\"$target_raw\"");
    expect(script).toContain("jq -e");
    for (const key of requiredAnnotationKeys) {
      expect(script).toContain(`index:${key}`);
      expect(script).toContain(`.annotations["${key}"]`);
    }
  });

  test("reports auto target digests without failing and writes a summary", () => {
    const script = readScript();

    expect(script).toContain('if [ "$expected_target_digest" != "auto" ]');
    expect(script).toContain('if [ "$expected_target_digest" = "auto" ]; then');
    expect(script).toContain("::notice title=Final annotated GHCR digest::");
    expect(script).toContain("GITHUB_STEP_SUMMARY");
    expect(script).toContain("| Image | Tag | Final annotated digest |");
    expect(script).toContain("| ${name} | ${target_ref} | ${target_digest} |");
  });

  test("keeps the mirror helper executable for GitHub Actions", () => {
    const mode = statSync(scriptPath).mode;

    expect(mode & 0o111).not.toBe(0);
  });
});
