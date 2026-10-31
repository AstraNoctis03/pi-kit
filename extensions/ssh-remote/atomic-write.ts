import { createHash } from "node:crypto";
import { quoteShell, type SshClient } from "./transport.ts";

// EOF alone does not prove that SSH delivered the complete payload. Stage in a
// private sibling directory and verify the bytes before a same-filesystem rename.
// This is atomic visibility, not a distributed transaction or an fsync guarantee.
const WRITE_SCRIPT = `set -euo pipefail
fail() { printf 'SSH atomic write: %s\\n' "$*" >&2; exit 1; }
for utility in realpath stat mktemp cat wc sha256sum cp mv rm rmdir; do
  command -v "$utility" >/dev/null || fail "Required remote utility missing: $utility"
done
requested=$1
expected_size=$2
expected_hash=$3
[[ "$requested" = /* ]] || fail 'Expected an absolute remote path'
# A marker preserves even trailing newlines in a filename through $(...).
canonical() { realpath -m -- "$requested" && printf '.'; }
marked=$(canonical)
target=\${marked%$'\\n.'}
parent=\${target%/*}
[[ -n "$parent" ]] || parent=/
snapshot() { stat -c '%d:%i:%f:%u:%g:%h:%s:%y:%z' -- "$target"; }
existed=0
if [[ -e "$target" || -L "$target" ]]; then
  [[ -f "$target" && ! -L "$target" ]] || fail 'Refusing a non-regular file'
  [[ -w "$target" ]] || fail 'Target is not writable'
  [[ -r "$target" ]] || fail 'Target must be readable to preserve attributes atomically'
  before=$(snapshot)
  [[ $(stat -c '%h' -- "$target") = 1 ]] || fail 'Refusing a hard-linked file: atomic replacement would break its links'
  existed=1
fi
stage=$(mktemp -d -- "$parent/.pi-write-XXXXXXXXXX")
temp=$stage/data
cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  if ! rm -f -- "$temp" || ! rmdir -- "$stage"; then
    printf 'SSH atomic write: staging cleanup failed (the file may already be committed): %s\\n' "$stage" >&2
    status=1
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
# mktemp's directory is private; the file retains normal creation/umask semantics.
cat > "$temp"
[[ $(wc -c < "$temp") -eq "$expected_size" ]] || fail 'Incomplete input: size mismatch'
actual_hash=$(sha256sum < "$temp")
[[ \${actual_hash%% *} = "$expected_hash" ]] || fail 'Input integrity checksum mismatch'
[[ $(canonical) = "$marked" ]] || fail 'Target symlink/path changed during upload'
if [[ "$existed" = 1 ]]; then
  [[ $(snapshot) = "$before" ]] || fail 'Target changed during upload'
  # Do not preserve old timestamps: builds must see this as a new modification.
  # Explicit xattr preservation reports failures rather than silently dropping them.
  cp --attributes-only --preserve=mode,ownership,xattr -- "$target" "$temp"
  [[ $(stat -c '%a:%u:%g' -- "$target") = $(stat -c '%a:%u:%g' -- "$temp") ]] || fail 'Cannot preserve target permissions/ownership'
  [[ $(canonical) = "$marked" && $(snapshot) = "$before" ]] || fail 'Target changed before commit'
  mv -T -- "$temp" "$target"
else
  [[ ! -e "$target" && ! -L "$target" ]] || fail 'Target appeared during upload'
  mv -T -n -- "$temp" "$target"
  [[ ! -e "$temp" ]] || fail 'Target appeared before commit; not overwritten'
fi
`;

export async function writeRemoteFile(
	client: SshClient,
	remotePath: string,
	content: string,
	signal?: AbortSignal,
): Promise<void> {
	const input = Buffer.from(content, "utf8");
	const hash = createHash("sha256").update(input).digest("hex");
	await client.run(`bash -c ${quoteShell(WRITE_SCRIPT)} -- ${quoteShell(remotePath)} ${quoteShell(String(input.length))} ${quoteShell(hash)}`, {
		input,
		signal,
	});
}
