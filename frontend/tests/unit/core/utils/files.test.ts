import { expect, test } from "@rstest/core";

import { checkCodeFile } from "@/core/utils/files";

// `extensionMap` maps a file extension to a language name. Both halves of that
// direction matter: `checkCodeFile` tests extension membership, and the language
// is what the editor and previewers receive.
test("resolves a language from its extension", () => {
  expect(checkCodeFile("script.hs")).toEqual({
    isCodeFile: true,
    language: "haskell",
  });
  expect(checkCodeFile("deploy.ex")).toEqual({
    isCodeFile: true,
    language: "elixir",
  });
  expect(checkCodeFile("analysis.jl")).toEqual({
    isCodeFile: true,
    language: "julia",
  });
});

test("values the language name, never the extension it came from", () => {
  expect(checkCodeFile("notes.julia")).toEqual({
    isCodeFile: true,
    language: "julia",
  });
});
