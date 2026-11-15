/**
 * On Windows, `cmd.exe` and Node look for a bare program name in the current folder before PATH, so a
 * file planted in an agent's folder, such as `claude.cmd`, would run in place of the real program.
 * Every process that starts programs sets this, and passes it on to what it starts.
 */
export const noCwdLookupEnv = { NoDefaultCurrentDirectoryInExePath: "1" } as const;
