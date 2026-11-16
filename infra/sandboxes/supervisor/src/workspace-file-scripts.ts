/**
 * The Python the supervisor runs inside a computer to read and write one workspace file.
 *
 * The path is confined lexically before it gets here (`normalizeWorkspaceRelative`), which says
 * nothing about symlinks: a link planted in the workspace by an earlier writer would let a
 * read-only profile — one with no shell of its own — read or write outside it. So each script
 * resolves the path and refuses anything that does not land under the workspace root.
 *
 * Containment is judged on the resolved path, so a link that stays inside the workspace still
 * works. The final open is `O_NOFOLLOW` on the resolved path, which refuses a last-component
 * link swapped in after the check.
 *
 * The root is an argument rather than a constant so the tests can run these against a scratch
 * directory; the routes always pass the computer's workspace root.
 */

/** Exit status of a refusal, so the route can answer 400 rather than a misleading 404. */
export const WORKSPACE_ESCAPE_EXIT = 43;

/** The message both scripts and `normalizeWorkspaceRelative` use for the same refusal. */
export const WORKSPACE_ESCAPE_MESSAGE = "path escapes the computer workspace";

/**
 * Shared Python: resolve a path, require it to be the root or beneath it, and open it with
 * `O_NOFOLLOW` on what was resolved.
 */
const containment = `import base64, errno, os, sys

ESCAPE = 43
MESSAGE = ${JSON.stringify(WORKSPACE_ESCAPE_MESSAGE)}


def escape():
  sys.stderr.write(MESSAGE + "\\n")
  sys.exit(ESCAPE)


def contained(root, value):
  """The resolved path, when it is the root itself or beneath it."""
  resolved = os.path.realpath(value)
  if resolved != root and not resolved.startswith(root + os.sep):
    escape()
  return resolved


def open_no_follow(resolved, flags):
  """Open what was resolved; a link swapped in at the end is refused rather than followed."""
  if hasattr(os, "O_NOFOLLOW"):
    flags |= os.O_NOFOLLOW
  try:
    return os.open(resolved, flags, 0o600)
  except OSError as error:
    if error.errno in (errno.ELOOP, errno.EMLINK):
      escape()
    raise`;

/** `python3 -c readScript root target limit`, base64 of the file on stdout. */
export function workspaceReadScript(): string {
  return `${containment}


root = os.path.realpath(sys.argv[1])
target = contained(root, sys.argv[2])
limit = int(sys.argv[3])
handle = open_no_follow(target, os.O_RDONLY)
with os.fdopen(handle, "rb") as source:
  content = source.read() if limit < 0 else source.read(limit + 1)
if limit >= 0 and len(content) > limit:
  sys.exit(42)
sys.stdout.write(base64.b64encode(content).decode())`;
}

/**
 * `python3 -c writeScript root target executable`, the bytes to write on stdin.
 *
 * The parent is resolved and checked before it is created as well as after: `makedirs` would
 * otherwise build directories through a symlinked component, outside the workspace, before any
 * check could object.
 */
export function workspaceWriteScript(): string {
  return `${containment}


root = os.path.realpath(sys.argv[1])
target = sys.argv[2]
executable = sys.argv[3] == "1"
parent = os.path.dirname(target)
contained(root, parent)
os.makedirs(parent, exist_ok=True)
# Again once it exists: a component could have been swapped while the directories were made.
contained(root, parent)
resolved = contained(root, target)
handle = open_no_follow(resolved, os.O_WRONLY | os.O_CREAT | os.O_TRUNC)
with os.fdopen(handle, "wb") as sink:
  sink.write(sys.stdin.buffer.read())
os.chmod(resolved, 0o700 if executable else 0o600)`;
}
