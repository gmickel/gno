/** Native test executable: preserve argv without shell quoting on Windows. */
if (
  process.env.FAKE_GNO_MODE === "timeout" &&
  process.argv[2] !== "--version"
) {
  // Keep the timeout in this process so killing the launcher leaves no child.
  await Bun.sleep(30_000);
}
const child = Bun.spawn(
  [
    process.env.FAKE_GNO_PYTHON!,
    process.env.FAKE_GNO_SCRIPT!,
    ...process.argv.slice(2),
  ],
  { stdin: "inherit", stdout: "inherit", stderr: "inherit" }
);
process.exit(await child.exited);
