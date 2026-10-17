import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const workflowPath = join(root, '.github/workflows/verify.yml');
const sha = 'a'.repeat(40);
const plugin = 'plugins/astra-project-forge';
const gates = [
  ['configuration', 'node --test tests/ci-workflow.test.mjs', '.'],
  ['check', 'npm run check', plugin],
  ['tests', 'npm test', plugin],
  ['benchmark', 'npm run benchmark:efficiency', plugin],
];

function run(step, env = {}, prefix = '') {
  const temporary = mkdtempSync(join(tmpdir(), 'forge-ci-test-'));
  try {
    mkdirSync(join(temporary, 'forge-verification'));
    const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', `${prefix}\n${step.run}`], {
      cwd: root,
      env: { PATH: process.env.PATH, RUNNER_TEMP: temporary, CANDIDATE_SHA: sha, ...env },
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.ifError(result.error);
    const directory = join(temporary, 'forge-verification');
    const logs = existsSync(directory) ? Object.fromEntries(readdirSync(directory).map(name =>
      [name, readFileSync(join(directory, name), 'utf8')])) : {};
    return { ...result, logs };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

test('native verification workflow exists and enforces its execution contract', async t => {
  assert.ok(existsSync(workflowPath), 'repository-root native workflow must exist');
  const workflow = JSON.parse(readFileSync(workflowPath, 'utf8'));
  const job = workflow.jobs.verify;
  const steps = job.steps;
  const step = id => {
    const found = steps.find(value => value.id === id);
    assert.ok(found, `missing ${id} step`);
    return found;
  };

  await t.test('manual-only read-only bounded native runner', () => {
    assert.deepEqual(Object.keys(workflow).sort(), ['jobs', 'name', 'on', 'permissions']);
    assert.equal(workflow.name, 'Native Verification');
    assert.deepEqual(workflow.on, { workflow_dispatch: { inputs: {
      candidate_sha: { description: 'Same-repository full commit SHA (empty uses dispatch SHA)', required: false, type: 'string', default: '' },
    } } });
    assert.deepEqual(workflow.permissions, { contents: 'read' });
    assert.deepEqual(Object.keys(workflow.jobs), ['verify']);
    assert.deepEqual(Object.keys(job).sort(), ['env', 'runs-on', 'steps', 'timeout-minutes']);
    assert.equal(job['runs-on'], 'ubuntu-24.04');
    assert.equal(job['timeout-minutes'], 20);
    assert.deepEqual(job.env, { CANDIDATE_SHA: '${{ inputs.candidate_sha || github.sha }}' });
    assert.deepEqual(steps.map(value => value.id), ['validate', 'checkout', 'node', 'source', ...gates.map(([id]) => id), 'clean', 'artifact']);
  });

  await t.test('validates SHA before checkout and never interpolates shell expressions', () => {
    assert.ok(steps.indexOf(step('validate')) < steps.indexOf(step('checkout')));
    for (const value of steps) {
      assert.equal(value['continue-on-error'], undefined);
      if (value.run) {
        assert.equal(value.shell, 'bash');
        assert.doesNotMatch(value.run, /\$\{\{|\|\|\s*true/);
      }
    }
    for (const candidate of [sha, '', 'main', 'A'.repeat(40), 'a'.repeat(39), 'a'.repeat(41), `${sha}\n`, '$(touch injected)']) {
      const result = run(step('validate'), { CANDIDATE_SHA: candidate });
      assert.equal(result.status, candidate === sha ? 0 : 1, JSON.stringify(candidate));
    }
  });

  await t.test('pins only approved actions and checkout settings', () => {
    assert.equal(step('checkout').uses, 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262');
    assert.deepEqual(step('checkout').with, { ref: '${{ env.CANDIDATE_SHA }}', 'persist-credentials': false, 'fetch-depth': 1, 'set-safe-directory': false });
    assert.equal(step('node').uses, 'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020');
    assert.deepEqual(step('node').with, { 'node-version': '22' });
    assert.equal(step('artifact').uses, 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02');
    assert.equal(steps.filter(value => value.uses).length, 3);
  });

  await t.test('retains exact gate commands, directories and failure-independent conditions', () => {
    for (const [id, command, directory] of gates) {
      assert.equal(step(id)['working-directory'], directory);
      assert.equal(step(id).if, "${{ always() && steps.source.outcome == 'success' }}");
      assert.ok(step(id).run.split('\n').includes(command));
    }
    assert.ok(steps.indexOf(step('source')) < steps.indexOf(step('configuration')));
    assert.ok(steps.indexOf(step('clean')) > steps.indexOf(step('benchmark')));
    assert.equal(step('clean').if, "${{ always() && steps.source.outcome == 'success' }}");
  });

  await t.test('gate shells preserve success and failure exit codes and separate full logs', () => {
    for (const [id] of gates) {
      for (const status of [0, 7]) {
        const result = run(step(id), { COMMAND_EXIT: String(status) },
          'node() { printf "stdout-marker\\n"; printf "stderr-marker\\n" >&2; return "$COMMAND_EXIT"; }; npm() { node "$@"; }');
        assert.equal(result.status, status, `${id}: ${result.stderr}`);
        assert.equal(result.logs[`${id}.stdout.log`], 'stdout-marker\n');
        assert.equal(result.logs[`${id}.stderr.log`], 'stderr-marker\n');
        assert.equal(result.logs[`${id}.exit-code`], `${status}\n`);
        assert.match(result.stdout, /stdout-marker/);
        assert.match(result.stdout, /stderr-marker/);
        assert.match(step(id).run, /tail -n 40/);
      }
    }
  });

  const gitFixture = 'git() { case "$*" in "rev-parse HEAD") printf "%s\\n" "$ACTUAL_SHA";; "diff --exit-code") return "$WORKTREE_EXIT";; "diff --cached --exit-code") return "$INDEX_EXIT";; *) return 99;; esac; }';

  await t.test('source identity rejects mismatched SHA and dirty tracked bytes before gates', () => {
    for (const [actual, worktree, index, status] of [[sha, 0, 0, 0], ['b'.repeat(40), 0, 0, 1], [sha, 1, 0, 1], [sha, 0, 1, 1]]) {
      const result = run(step('source'), { ACTUAL_SHA: actual, WORKTREE_EXIT: String(worktree), INDEX_EXIT: String(index) }, gitFixture);
      assert.equal(result.status, status, result.stderr);
      assert.equal(result.logs['source.exit-code'], `${status}\n`);
      if (status === 0) {
        assert.match(result.logs['source.stdout.log'], new RegExp(sha));
        assert.match(result.logs['source.stdout.log'], /linux|darwin/);
        for (const file of ['LICENSE', 'NOTICE.md', 'ATTRIBUTION.md']) assert.ok(result.logs['source.stdout.log'].includes(file));
      }
    }
  });

  await t.test('final tracked-source check fails closed with retained logs', () => {
    for (const [worktree, index, status] of [[0, 0, 0], [1, 0, 1], [0, 1, 1]]) {
      const result = run(step('clean'), { WORKTREE_EXIT: String(worktree), INDEX_EXIT: String(index) }, gitFixture);
      assert.equal(result.status, status);
      assert.equal(result.logs['clean.exit-code'], `${status}\n`);
      assert.ok(Object.hasOwn(result.logs, 'clean.stdout.log'));
      assert.ok(Object.hasOwn(result.logs, 'clean.stderr.log'));
    }
  });

  await t.test('always uploads only dedicated verification artifacts for seven days', () => {
    assert.equal(step('artifact').if, '${{ always() }}');
    assert.deepEqual(step('artifact').with, { name: 'native-verification', path: '${{ runner.temp }}/forge-verification/', 'retention-days': 7, 'if-no-files-found': 'error' });
  });
});
