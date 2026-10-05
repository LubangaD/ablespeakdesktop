// Parse and link one page with the files it imports, without building the
// whole app: node scripts/check-page.mjs src/pages/Home.jsx
import { rolldown } from 'rolldown';

const input = process.argv[2];
if (!input) {
  console.error('Usage: node scripts/check-page.mjs <file.jsx>');
  process.exit(1);
}
const isPackage = id => !id.startsWith('.') && !id.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(id);
const problems = [];
try {
  const bundle = await rolldown({
    input,
    external: isPackage,
    // A name imported from a file that doesn't export it is a mistake here.
    onLog(level, log) {
      if (level === 'warn' && /MISSING_EXPORT|UNRESOLVED_IMPORT/.test(log.code || '')) problems.push(log.message);
    },
  });
  await bundle.generate({ format: 'esm' });
  if (problems.length) throw new Error(problems.join('\n'));
  console.log(`ok ${input}`);
} catch (err) {
  console.error(err.message || err);
  process.exit(1);
}
