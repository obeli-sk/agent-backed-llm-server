const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const vm = require("node:vm");

async function loadWorkflow(filename, imports, globals = {}) {
    const context = vm.createContext({ console: { log() {} }, ...globals });
    async function load(filename) {
        const source = await fs.readFile(filename, "utf8");
        return new vm.SourceTextModule(source, { context, identifier: filename });
    }
    const module = await load(path.join(__dirname, filename));
    await module.link(async (specifier, parent) => {
        if (specifier.startsWith(".")) return load(path.resolve(path.dirname(parent.identifier), specifier));
        const exports = imports[specifier];
        assert.ok(exports, `unexpected import: ${specifier}`);
        return new vm.SyntheticModule(Object.keys(exports), function () {
            for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
        }, { context });
    });
    await module.evaluate();
    return module.namespace.default;
}

module.exports = { loadWorkflow };
