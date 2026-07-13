import globals from "globals";

import { base } from "./base.js";

/** @type {import("eslint").Linter.Config[]} */
export const node = [
  ...base,
  {
    languageOptions: {
      globals: globals.node,
    },
  },
];

export default node;
