import { importedFile, importsOf, isTest } from "./source.js";

/** The folder for helpers that tests in two or more folders share. */
const TEST_SHARED = "test-shared";

/** The imports of a `test-shared` folder from code that isn't a test. */
export function testSharedProblems(sources: Record<string, string>): string[] {
  const problems: string[] = [];
  for (const [file, text] of Object.entries(sources)) {
    if (isTest(file)) continue;
    for (const { specifier } of importsOf(text)) {
      const target = importedFile(file, specifier);
      if (target?.split("/").includes(TEST_SHARED)) problems.push(`${file}: imports ${specifier}, and only tests may use ${TEST_SHARED}`);
    }
  }
  return problems;
}
