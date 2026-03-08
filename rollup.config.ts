import * as path from "node:path";
import commonjs from "@rollup/plugin-commonjs";
import json from "@rollup/plugin-json";
import nodeResolve from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";
import license from "rollup-plugin-license";

const config = {
  input: "src/index.ts",
  output: {
    file: "dist/index.js",
    format: "es",
    sourcemap: true,
  },
  plugins: [
    typescript(),
    nodeResolve({ preferBuiltins: true }),
    commonjs({
      transformMixedEsModules: true,
    }),
    json(),
    license({
      thirdParty: {
        output: path.join("dist", "licenses.txt"),
      },
    }),
  ],
};

export default config;
