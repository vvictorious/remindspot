import { evaluateMatchingScenarios, formatMatchingReport } from './evaluate';
import { MATCHING_EVALUATION_SCENARIOS } from './scenarios';

function usage(): never {
  throw new Error('Usage: npm run eval:matching -- [--json]');
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--json')) {
    usage();
  }

  const report = await evaluateMatchingScenarios(MATCHING_EVALUATION_SCENARIOS);
  if (args.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(formatMatchingReport(report));
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
