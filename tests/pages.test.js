import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import vm from 'node:vm';

const workflow = await readFile(new URL('../.github/workflows/pages.yml', import.meta.url), 'utf8');
test('Pages stages every public module, excludes server and CSV, and checks the uploaded artifact ID', async () => {
  const files = workflow.match(/^\s+cp (.+) _site\/$/m)?.[1].split(' ');
  assert.ok(files);
  assert.ok(!files.some(f => f.endsWith('.csv') || ['server.js', 'kraken-api.js'].includes(f)));
  for (const file of files) {
    await access(new URL(`../${file}`, import.meta.url));
    if (!file.endsWith('.js')) continue;
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    for (const match of source.matchAll(/from ['"]\.\/([^'"]+)['"]/g)) assert.ok(files.includes(match[1]), `${file} dependency ${match[1]} is deployed`);
  }
  assert.match(workflow, /actions: read/);
  assert.match(workflow, /EXPECTED_ARTIFACT_ID: \$\{\{ steps\.upload\.outputs\.artifact_id \}\}/);
  assert.match(workflow, /artifact_name: github-pages/);
});

const script = workflow.split('          script: |\n')[1]?.split('\n      - name: Deploy')[0].split('\n').map(line => line.slice(12)).join('\n');
assert.ok(script);
function runVisibilityCheck(artifactsForAttempt, id = '42') {
  let attempts = 0, waits = 0;
  const sandbox = {
    process: { env: { EXPECTED_ARTIFACT_ID: id } },
    context: { repo: { owner: 'test', repo: 'test' }, runId: 1 },
    core: { info() {} },
    github: { rest: { actions: { listWorkflowRunArtifacts: {} } }, paginate: async () => artifactsForAttempt(++attempts) },
    setTimeout: resolve => { waits++; resolve(); },
  };
  const result = vm.runInNewContext(`(async () => { ${script} })()`, sandbox, { timeout: 1000 });
  return { result, counts: () => ({ attempts, waits }) };
}
test('Pages waits for metadata visibility instead of deploying immediately after upload', async () => {
  const run = runVisibilityCheck(attempt => attempt < 3 ? [] : [{ id: 42, name: 'github-pages', expired: false }]);
  await run.result;
  assert.deepEqual(run.counts(), { attempts: 3, waits: 2 });
});
test('Pages fails explicitly after bounded retries and rejects a mismatched or expired artifact', async () => {
  const run = runVisibilityCheck(() => [{ id: 41, name: 'github-pages', expired: false }, { id: 42, name: 'github-pages', expired: true }]);
  await assert.rejects(run.result, /not visible after retries/);
  assert.deepEqual(run.counts(), { attempts: 12, waits: 11 });
  const invalid = runVisibilityCheck(() => [], 'missing');
  await assert.rejects(invalid.result, /artifact ID/);
  assert.equal(invalid.counts().attempts, 0);
});
