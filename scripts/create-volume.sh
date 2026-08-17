#!/bin/bash
# Creates a fixed-size volume for the drop, mounted through /etc/fstab.
#
# The bounded size is the point: a massive upload cannot fill the host disk, and
# so cannot take down whatever else runs on the machine.
#
#   ./create-volume.sh /srv/depot.img /srv/depot 100G
set -euo pipefail

IMG="${1:?image path, e.g. /srv/depot.img}"
MNT="${2:?mount point, e.g. /srv/depot}"
SIZE="${3:-100G}"

[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }

if [ ! -f "$IMG" ]; then
  fallocate -l "$SIZE" "$IMG"
  mkfs.ext4 -q -m 0 -L depot "$IMG"
  echo "image created: $IMG ($SIZE)"
fi

mkdir -p "$MNT"
if ! grep -q " $MNT " /etc/fstab; then
  echo "$IMG $MNT ext4 loop,defaults,nosuid,nodev,noexec 0 2" >> /etc/fstab
  echo "entry added to /etc/fstab"
fi
mountpoint -q "$MNT" || mount "$MNT"
df -h "$MNT"

cat <<'NOTE'

To grow it later (service stopped, volume unmounted):
  truncate -s 200G <image>
  e2fsck -f <image> && resize2fs <image>
NOTE
