// Every module that calls its entry point (`main()`) at its top level does so after its last top-level `const`, `let`,
// `var` or `class`. Run as a script, the call runs before anything below it is declared, so whatever it reaches there
// throws "Cannot access … before initialization": a tool can then crash when a workflow runs it as a command, though
// its tests, which import the module, pass. Function declarations below the call are fine.
// Standalone suite: precommit runs it (tools/run-tests.mjs).
//
//   node test/module-order.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIRS = ['tools', 'test'];   // add your own source directories; never node_modules
const ENTRY_CALL = /^(?:if \(.*\) )?(?:await )?main\(/;
const DECLARATION = /^(?:export\s+)?(?:const|let|var|class)\s/;
let passed = 0, failed = 0;

function check(name, ok, detail = '') {
	if (ok) passed++;
	else { failed++; console.log(`FAIL ${name}${detail ? `  ${detail}` : ''}`); }
}

/** Line numbers of the top-level declarations below a module's first top-level entry call ([] if none). */
function declaredAfterEntry(source) {
	const lines = source.split('\n');
	const call = lines.findIndex((line) => ENTRY_CALL.test(line));
	if (call < 0) return [];
	return lines.flatMap((line, i) => (i > call && DECLARATION.test(line) ? [i + 1] : []));
}

function modules(dir) {
	return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
		const rel = path.join(dir, e.name);
		if (e.isDirectory()) return e.name === 'node_modules' ? [] : modules(rel);
		return /\.m?js$/.test(e.name) ? [rel] : [];
	});
}

// the check itself: the bug as it was, and as it should be
check('a const below the call is caught', JSON.stringify(declaredAfterEntry('if (x) await main();\n\nfunction main() { return same(); }\nconst same = () => 1;\n')) === '[4]');
check('…and so are let, class and exported ones', declaredAfterEntry('await main();\nlet a;\nexport class B {}\nexport const c = 1;\n').length === 3);
check('function declarations and code inside functions below it are fine', declaredAfterEntry('const a = 1;\nmain();\nfunction main() {\n\tconst b = 2;\n}\n').length === 0);

const files = DIRS.flatMap(modules);
check('there are modules to check', files.length >= 20, String(files.length));
for (const file of files) {
	const after = declaredAfterEntry(fs.readFileSync(path.join(ROOT, file), 'utf8'));
	check(`${file}: nothing declared below its main() call`, after.length === 0, `line(s) ${after.join(', ')}`);
}

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
