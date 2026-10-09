---
name: vhd-disk-images
description: Use when inspecting, mounting, copying, or editing virtual disk images (VHD, VHDX, VMDK, VDI, QCOW2, raw .img) or files inside them, including BlueStacks instance disks (Data.vhdx, Root.vhd, bluestacks.conf), on Windows (with WSL) or Linux. Covers safe backup, read-only inspection, in-place file edits, verification, and swapping the edited image back.
---

# Virtual Disk Images (VHD / VHDX / VMDK / VDI / QCOW2 / raw)

General workflow for reading or changing files that live inside a virtual disk image. It is host-agnostic (Windows with WSL2, or native Linux) and not tied to any one application. BlueStacks specifics are in a separate section at the end.

## Golden rules

1. Never write into the original image. Work on a copy and swap it in only after verification.
2. Make sure nothing has the image open. A running VM or emulator keeps writing, and helper processes can rewrite config files on exit.
3. Keep a rollback copy until the user confirms the result. Delete backups only when asked.
4. Check free disk space first. Copying a dynamic image costs its full file size.
5. Use hashes (MD5/SHA256) to prove that a copy equals its source and that what you wrote is what you read back.
6. Ask before force-killing processes, replacing the original image, or deleting backups.

## 1. Identify the image

- `qemu-img info <file>` reports format, virtual size, and file size. Format names in qemu: `vpc` (VHD), `vhdx`, `vmdk`, `vdi`, `qcow2`, `raw`.
- Differencing or snapshot images need their parent chain. Do not copy a child without its parent.
- A virtual disk usually holds a partition table (MBR or GPT), and a filesystem inside a partition. Check both before looking for files.
- Read the partition table without mounting, for example `fdisk -l /dev/nbd0` after connecting, or parse the MBR/GPT directly.

## 2. Safe preparation checklist

1. Confirm the owner process is closed. On Windows: `Get-Process | Where-Object Name -match '<name>'`. Ask the user to quit normally first; force-kill only leftover helpers, and only with their consent.
2. Confirm the file is stable: same size and `LastWriteTime` across a few seconds.
3. Copy to a backup name and compare hashes. Then copy that backup to a separate working copy.
4. Work only on the working copy. Do not edit a file you are reading from.

## 3. Pick a tool for the host

### Read-only inspection (no root, no mount)

- 7-Zip can list and extract from VHD, VHDX, VMDK, and several filesystems: `7z l -slt <image>`, `7z x <image> "-o<dir>" "<path-in-image>"`. This is quick, but it can fail on images with unreplayed journals. Observed error: `non-empty LOG was not replayed` on a VHDX with a pending log. If that happens, use qemu-nbd instead.

### Mounting with Linux tools (native Linux or WSL2)

`qemu-nbd` maps any qemu-supported format to a block device:

```bash
modprobe nbd max_part=8
qemu-nbd --connect=/dev/nbd0 --format=vhdx /path/to/image        # add -r for read-only
mkdir -p /mnt/img && mount -t ext4 -o rw,noatime /dev/nbd0p1 /mnt/img
# ... work ...
umount /mnt/img && qemu-nbd -d /dev/nbd0
```

- Install with `apt install qemu-utils`.
- For raw images, `losetup -fP <file>` can replace qemu-nbd.
- libguestfs (`guestmount`) is an alternative when available.

### Windows-only caveats

- Windows can attach VHD/VHDX with `Mount-DiskImage` or `diskpart`, which needs elevation. It cannot read ext4 and other Linux filesystems natively, so Linux-formatted disks still need WSL or 7-Zip.
- WSL2 can mount a physical or attached disk with `wsl --mount`. This was not tested during the session that produced this skill. Verify before relying on it.

## 4. WSL2 pitfalls (all observed)

- Kernel module state does not persist across separate `wsl` calls. `/dev/nbd0` may be missing in a later call. Put `modprobe`, connect, mount, edit, umount, and disconnect in one script.
- Do not pass complex commands through `wsl ... bash -c "<string>"` from PowerShell. `$` and quotes get mangled. Write a bash script file with LF line endings, then run `wsl -d <distro> -u root -- bash /mnt/c/path/script.sh`.
- Distros may need root. `wsl -u root` works without a password. Plain `sudo` may ask for one.
- Files on `/mnt/c` are reachable from both sides, so scripts and data can be exchanged there.
- Always `umount` and `qemu-nbd -d` at the end, and also on failure paths, so the working copy is not left attached.

## 5. Filesystem notes (ext4 inside the image)

- If the superblock has `needs_recovery`, the journal has not been replayed. A read-write mount replays it, which changes the image. For forensic reading use `qemu-nbd -r` with `mount -o ro,noload`.
- `e2fsck -fn <dev>` checks without modifying. Without `-n` it can fix things.
- Android data partitions carry numeric UIDs (for example 10103) that the host cannot resolve. Ownership will show as unknown, which is normal.
- Also preserve SELinux labels and permissions. To change a file, overwrite its contents in place (`cat new > target`) rather than `mv` or `cp` over it, so the inode, owner, mode, and label stay the same.

## 6. Editing a file inside the image

1. Mount the working copy read-write.
2. Check that the target file equals what you expect (compare hash against your earlier extraction). Abort if it differs.
3. Copy the target out, change it on the host, and keep the original for diffing.
4. Write it back in place and `sync`.
5. Unmount, run `e2fsck -fn`, and disconnect.

## 7. Verify before swapping

Do at least these checks, using a tool independent of the one that wrote the file:

- Re-extract the file from the working copy with a different method (for example 7-Zip) and compare its hash with what you intended to write.
- `qemu-img check -f <fmt> <image>` reports `No errors were found on the image.` when healthy.
- Diff the old and new file content and confirm that only the intended lines changed.
- If the format has structural fields (length headers, checksums), recompute and re-check them.

## 8. Swap in

1. Confirm the original is unchanged since your backup (hash again).
2. Rename the original to a rollback name, then move the verified working copy to the original name.
3. Report rollback names and the new hash to the user. Keep rollback files until the user says to delete them.

## 9. Windows scripting hygiene

- Long commands can hang the shell. Wrap external tools with a timeout, for example `Start-Process ... -PassThru` then `WaitForExit(<ms>)` and `Kill()`, or `Start-Job` with `Wait-Job -Timeout`.
- Never run a long-lived daemon (like `adb start-server`) while capturing its output through redirected pipes. It can keep the pipe open and hang the call. Start it detached.
- Redirect large outputs to files instead of printing them.

## BlueStacks specifics (BlueStacks 5, Windows)

Layout under `C:\ProgramData\BlueStacks_nxt\`:

- `bluestacks.conf`: per-instance settings. Keys are `bst.instance.<InstanceName>.<key>`. Useful ones: `display_name`, `adb_port`, `enable_root_access`. Global ones include `bst.enable_adb_access` and `bst.feature.rooting`.
- `Engine\<InstanceName>\Data.vhdx`: dynamic VHDX holding the Android `/data` partition (single MBR partition, ext4). Inside it, the partition root contains `data/<package>` (this is Android `/data/data/<package>`), `app/`, `user/`, `media/`, and more.
- `Engine\<InstanceName>\Root.vhd`: system image.
- Instance names map to Android versions, for example `Tiramisu64` is Android 13 and `Pie64` is Android 9. Check `display_name` in the conf to match what the user calls an instance.
- Edit `bluestacks.conf` only when BlueStacks is fully closed. The manager rewrites it on exit and reverts your change. Close `HD-Player`, `HD-MultiInstanceManager`, and the background services first.
- The emulator keeps `Data.vhdx` open and appends to it. Never copy or hash it while it runs.

Live access via ADB:

- ADB must be enabled in the instance's Advanced settings. The bundled `HD-Adb.exe` is old (1.0.36). A current platform-tools `adb` also connects.
- Connect with `adb connect 127.0.0.1:<adb_port>`. If `devices` shows `offline`, Android airplane mode is a known cause. Turn it off, reconnect, and retry.
- A BlueStacks `adb shell` is the unprivileged `shell` user. The bundled `/system/xbin/su` is a gated wrapper (signature and allow-list checks), so it may refuse ordinary commands even when root options are enabled. `adb root` and `run-as` may also fail.
- `adb backup` returns an empty archive for apps targeting recent SDKs (non-debuggable apps targeting API 31 or newer). Do not expect it to work for modern apps.
- When live root is unavailable, offline editing of `Data.vhdx` (sections 2 to 8) is the practical route. Do not try to defeat the emulator's own protections unless the user explicitly asks for that.
- Network: if the user needs the Android side offline (for example to stop an app syncing), use airplane mode in the instance. That can also take ADB offline, so use it only when ADB is not needed.

Typical safe edit of an app's local file in a BlueStacks instance:

1. Ask the user to close BlueStacks fully. Remove leftover helpers only with consent.
2. Backup `Data.vhdx` and make a working copy, comparing hashes.
3. `qemu-nbd` the working copy, mount `nbd0p1`, and edit `data/<package>/files/<file>` in place.
4. Verify (section 7), swap (section 8), and tell the user to start BlueStacks and test with a network-isolated session first.
5. If `bluestacks.conf` was changed for ADB or root, restore it when done, using the saved copy.

## What to report to the user

- Which image and which working copy were used, with the hashes.
- Exactly which files and lines changed, and the final values.
- What verification passed, and what was not verified.
- Rollback file names and sizes, and how to restore.
