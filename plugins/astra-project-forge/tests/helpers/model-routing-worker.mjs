import { ProjectStore } from '../../server/state-store.mjs';
import fs from 'node:fs/promises';
import { once } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';

const [root] = process.argv.slice(2);
process.send({ ready: true });
const [{ args, runtime, fail }] = await once(process, 'message');
const originalRename = fs.rename;
let injection = null;
if (fail) fs.rename = async source => {
  const pending = JSON.parse(await fs.readFile(source, 'utf8'));
  injection = { ownedTemporaryFile: source.endsWith('.tmp'), decisions: pending.modelRouting.decisions.length };
  throw new Error('injected rename failure');
};
syncBuiltinESMExports();
try {
  const response = await new ProjectStore(root).routeProjectWithModelAdvice('p', args, runtime);
  process.send({ response });
} catch (error) {
  process.send({ error: { message: error.message, code: error.code ?? null }, injection });
} finally {
  fs.rename = originalRename;
  process.disconnect();
}
