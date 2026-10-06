import { nodeConfig } from './eslint/index.mjs';

// The shared config file itself is plain JS outside the TS project; lint only the typed sources.
export default [...nodeConfig({ tsconfigRootDir: import.meta.dirname }), { ignores: ['eslint/**'] }];
