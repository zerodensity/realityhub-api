import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import terser from '@rollup/plugin-terser';

export default {
  input: 'src/index.js',
  output: {
    file: 'dist/index.cjs',
    format: 'cjs',
    exports: 'named',
    sourcemap: true,
  },
  plugins: [resolve(), commonjs(), terser()],
  external: ['ws', 'uuid'],
};
