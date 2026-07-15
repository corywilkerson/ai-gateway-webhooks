import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const USAGE = `Usage: npx ai-gateway-webhooks secrets [options]

Generates the secrets this package needs, writes them to .dev.vars for local
development, and uploads them to your Worker with \`wrangler secret put\`:

  AI_WEBHOOK_SECRET   webhook signing secret (always)
  AI_ARTIFACT_SECRET  artifact URL signing secret (with --with-artifacts)

Running the command again generates fresh values, rotating the secrets.

Options:
  --with-artifacts  Also generate the artifact URL signing secret.
  --local-only      Write .dev.vars but skip \`wrangler secret put\`.
  --cwd DIR         Project directory. Defaults to the current directory.
  --help, -h        Show this message.
`;

interface SecretsOptions {
  cwd: string;
  withArtifacts: boolean;
  localOnly: boolean;
}

const args = process.argv.slice(2);
run(args);

function run(values: string[]): void {
  if (values[0] === "--help" || values[0] === "-h" || values[0] === undefined) {
    console.log(USAGE);
    return;
  }

  if (values[0] !== "secrets") {
    console.error(`Unknown command: ${values[0]}`);
    process.exitCode = 1;
    return;
  }

  if (values.includes("--help") || values.includes("-h")) {
    console.log(USAGE);
    return;
  }

  try {
    provisionSecrets(parseArgs(values.slice(1)));
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Secret provisioning failed";
    console.error(`\nai-gateway-webhooks secrets: ${message}`);
    console.error(
      "No secret values were printed. Fix the issue above and rerun the same command.",
    );
    process.exitCode = 1;
  }
}

function provisionSecrets(options: SecretsOptions): void {
  const names = ["AI_WEBHOOK_SECRET"];
  writeDevVariable(options.cwd, "AI_WEBHOOK_SECRET", createWebhookSecret());

  if (options.withArtifacts) {
    names.push("AI_ARTIFACT_SECRET");
    writeDevVariable(options.cwd, "AI_ARTIFACT_SECRET", createArtifactSecret());
  }

  console.log(`Wrote ${names.join(" and ")} to .dev.vars.`);

  if (options.localOnly) {
    console.log("Skipped `wrangler secret put` (--local-only).");
    return;
  }

  // Upload the same values that were written to .dev.vars, so local dev and
  // the deployed Worker agree on the signing keys.
  for (const name of names) {
    putSecret(options.cwd, name, readDevVariable(options.cwd, name));
  }

  console.log(`Uploaded ${names.join(" and ")} with wrangler.`);
}

function parseArgs(values: string[]): SecretsOptions {
  const options: SecretsOptions = {
    cwd: process.cwd(),
    withArtifacts: false,
    localOnly: false,
  };

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    switch (value) {
      case "--with-artifacts":
        options.withArtifacts = true;
        break;

      case "--local-only":
        options.localOnly = true;
        break;

      case "--cwd":
        options.cwd = resolve(requiredValue(values, ++index, "--cwd"));
        break;

      default:
        throw new Error(`Unknown option: ${String(value)}`);
    }
  }

  return options;
}

function requiredValue(values: string[], index: number, flag: string): string {
  const value = values[index];

  if (!value) {
    throw new Error(`${flag} requires a value`);
  }

  return value;
}

export function createWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString("base64")}`;
}

export function createArtifactSecret(): string {
  return randomBytes(32).toString("base64url");
}

function writeDevVariable(cwd: string, name: string, value: string): void {
  const path = join(cwd, ".dev.vars");
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  const assignment = `${name}=${value}`;
  const lines = current.split(/\r?\n/);
  const index = lines.findIndex((line) => line.startsWith(`${name}=`));

  if (index >= 0) {
    lines[index] = assignment;
  } else {
    lines.push(assignment);
  }

  writeFileSync(path, `${lines.filter(Boolean).join("\n")}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function readDevVariable(cwd: string, name: string): string {
  const content = readFileSync(join(cwd, ".dev.vars"), "utf8");
  const line = content
    .split(/\r?\n/)
    .find((candidate) => candidate.startsWith(`${name}=`));

  if (!line) {
    throw new Error(`${name} is missing from .dev.vars`);
  }

  return line.slice(name.length + 1);
}

function putSecret(cwd: string, name: string, secret: string): void {
  const result = spawnSync("npx", ["wrangler", "secret", "put", name], {
    cwd,
    input: `${secret}\n`,
    stdio: ["pipe", "inherit", "inherit"],
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(
      `wrangler secret put ${name} failed; .dev.vars is ready, so ` +
        "authenticate with `npx wrangler login` if needed and rerun secrets",
    );
  }
}
