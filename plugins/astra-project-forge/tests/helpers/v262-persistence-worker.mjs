import { ProjectStore } from '../../server/state-store.mjs';

const [mode, root, target, count = '10'] = process.argv.slice(2);
if (mode === 'observe') {
  const store = new ProjectStore(root);
  process.send?.({ ready: true });
  await new Promise(resolve => process.once('message', resolve));
  const revisions = [];
  for (let i = 0; i < Number(count); i++) {
    const record = await store.addObservation('p', { observation: `${target}:${i}` });
    revisions.push(record.revision);
  }
  process.send?.({ revisions });
} else {
  const { withProjectLock, atomicWriteJSON } = await import('../../server/project-persistence.mjs');
  await withProjectLock(target, async () => {
    process.send?.({ acquired: true });
    await new Promise(resolve => process.once('message', resolve));
    if (mode === 'write') {
      const project = await new ProjectStore(root).getProject('p');
      project.observations.push({ id: 'interrupted', observation: 'uncommitted work' });
      process.send?.({ working: true });
      await new Promise(resolve => process.once('message', resolve));
      await atomicWriteJSON(target, project);
    }
  });
}
process.disconnect?.();
