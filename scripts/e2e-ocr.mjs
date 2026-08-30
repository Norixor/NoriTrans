import { spawnSync } from "node:child_process";
import process from "node:process";

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const strictEnvironment = {
  ...process.env,
  NORITRANS_OCR_CAPTURE_E2E: "1",
};
if (!process.env.NORITRANS_OCR_RUNTIME_DIR?.trim()) {
  process.stdout.write(
    "OCR headed E2E skipped: set NORITRANS_OCR_RUNTIME_DIR to the directory containing the three pinned English runtime files.\n",
  );
  process.exit(0);
}
const productionEnvironment = { ...process.env };
delete productionEnvironment.NORITRANS_OCR_CAPTURE_E2E;

function run(args, environment) {
  const result = spawnSync(pnpm, args, {
    env: environment,
    stdio: "inherit",
  });
  return result.status ?? 1;
}

let exitCode = run(["build"], strictEnvironment);
if (exitCode === 0) {
  exitCode = run(
    [
      "exec",
      "playwright",
      "test",
      "tests/e2e/extension.spec.ts",
      "-g",
      "recognizes burned-in subtitles inside a canvas-player iframe",
    ],
    strictEnvironment,
  );
}

// The strict OCR manifest is automation-only; always restore the production build.
const restoreExitCode = run(["build"], productionEnvironment);
if (exitCode === 0 && restoreExitCode !== 0) exitCode = restoreExitCode;

process.exit(exitCode);
